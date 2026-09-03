/**
 * The terminal bridge: a websocket on one side, a pty running tmux on the
 * other. Ported unchanged in behavior from `claude-board`'s
 * `server/src/ws.ts`, adapted only for board's own session shape
 * (`SessionView.tmuxName` in place of Di's `session.tmux`).
 *
 * Detach is the whole design point and it is deliberately unremarkable — when
 * the socket closes, the pty is killed, the tmux client dies with it, and the
 * SESSION keeps running. Nothing has to be preserved because tmux is already
 * doing the preserving. What this module owes is the other half: reaping the
 * pty and the grouped view, so a browser tab that goes away does not leave a
 * tmux client behind holding the session at its size.
 *
 * Cross-panel dependency, not yet resolvable in this branch: `./lifecycle.ts`
 * and `./auth.ts` are Panel A's files (board/src/{lifecycle,auth}.ts) and do
 * not exist here — Stage 2 runs as three panels on disjoint branches off
 * `board/stage1-foundation`, and this branch never sees Panel A's commits
 * until its PR merges. `npm run typecheck` therefore fails on these two
 * imports today; that is expected, and is the same "write to contract,
 * pending a sibling PR" treatment `smoke/prompt.mts` and `smoke/ui.mts`
 * already carry for Panel A's `prompt.ts` and Panel B's CSS respectively.
 * `parseTarget`, `ensureView`, `hasSession`, `runTmux`, `disableMouseCommand`,
 * `cancelCopyModeCommand`, `scrollCommands` and `closeViewCommand` are ported
 * unchanged from the reference (see the plan's "port unchanged" list), and
 * `tokenFrom` / `tokenMatches` / `originAllowed` keep the signatures already
 * verified against `claude-board`'s `auth.ts`. This file was verified
 * end-to-end locally (`smoke/e2e.mts`) against those exact reference
 * implementations before this PR was opened — see the PR body.
 */
import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import { originAllowed, tokenFrom, tokenMatches } from "./auth.ts";
import {
  closeViewCommand,
  cancelCopyModeCommand,
  disableMouseCommand,
  ensureView,
  hasSession,
  parseTarget,
  runTmux,
  scrollCommands,
  type TmuxTarget,
} from "./lifecycle.ts";
import { findSession } from "./sessions.ts";

/** Terminal traffic is bursty and small; this only bounds a pathological
 *  paste. */
const MAX_MESSAGE = 1 << 20;

export interface WsOptions {
  token: string | null;
  /** Injected for tests; the real one spawns node-pty. */
  spawnPty?: typeof spawnTmuxPty;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: () => void): void;
}

/**
 * A pty running `tmux attach-session -t <view>`.
 *
 * node-pty is loaded lazily so the rest of the server — discovery, the
 * dashboard, the API — still runs on a machine where the native module
 * failed to build. A missing terminal is a degraded tool; a server that will
 * not start is a broken one.
 */
export async function spawnTmuxPty(view: string, cols: number, rows: number): Promise<PtyHandle> {
  const pty = await import("node-pty");
  const proc = pty.spawn("tmux", ["attach-session", "-t", view], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  return {
    write: (d) => proc.write(d),
    resize: (c, r) => {
      try {
        proc.resize(c, r);
      } catch {
        /* the pty went away between a resize and its ack */
      }
    },
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit(() => cb()),
  };
}

/**
 * `/ws/term/<tmux-session-name>` or `/ws/tmux/<tmux-session>` -> what to
 * attach to.
 *
 * The second form exists for a session board has just resumed: the resumed
 * conversation gets a BRAND NEW Claude session id which nobody knows yet —
 * not the caller, not the registry until it registers — but its tmux session
 * name is known the moment it is created. Without this, resume put you in a
 * terminal you had no way to open.
 */
export function parseTermPath(pathname: string): { kind: "session" | "tmux"; id: string } | null {
  const session = pathname.match(/^\/ws\/term\/([^/]+)$/);
  if (session) return { kind: "session", id: decodeURIComponent(session[1]) };
  const tmux = pathname.match(/^\/ws\/tmux\/([^/]+)$/);
  if (tmux) return { kind: "tmux", id: decodeURIComponent(tmux[1]) };
  return null;
}

function refuse(socket: Duplex, code: number, reason: string): void {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function attachWebSocket(server: Server, opts: WsOptions): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const spawn = opts.spawnPty ?? spawnTmuxPty;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const target = parseTermPath(url.pathname);
    if (!target) return refuse(socket, 404, "Not Found");

    // Cookies ride along on a cross-site websocket handshake, so without this
    // any page could open a terminal in the background using the victim's
    // own cookie.
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      return refuse(socket, 403, "Forbidden");
    }
    if (opts.token !== null && !tokenMatches(opts.token, tokenFrom(req.headers as Record<string, string>, req.url ?? "/"))) {
      return refuse(socket, 401, "Unauthorized");
    }

    wss.handleUpgrade(req, socket, head, (ws) => void serve(ws, target, spawn));
  });

  return wss;
}

/** Send a framed control message. Terminal output is sent raw, so control
 *  traffic is JSON on a separate prefix that raw output cannot collide with. */
function control(ws: WebSocket, payload: object): void {
  if (ws.readyState === ws.OPEN) ws.send("\x00" + JSON.stringify(payload));
}

async function serve(
  ws: WebSocket,
  want: { kind: "session" | "tmux"; id: string },
  spawn: typeof spawnTmuxPty,
): Promise<void> {
  // Attaching to a tmux session by name: no registry lookup, because the
  // whole point is that this session is not in the registry yet.
  if (want.kind === "tmux") {
    if (!(await hasSession(want.id))) {
      control(ws, { type: "error", message: `no tmux session named ${want.id}` });
      ws.close();
      return;
    }
    return attachTo(ws, { session: want.id, window: null, pane: null }, want.id, spawn, true);
  }

  // Board's own view model addresses a session by its tmux session name
  // directly (`SessionView.tmuxName`), unlike Di's model which carried a
  // composite `session:window.pane` string on `session.tmux`. `findSession`
  // already resolves through the same cached listing every other route
  // reads, so this stays in agreement with what the board is showing.
  const tmuxName = want.id;
  const session = await findSession(tmuxName);
  if (!session) {
    control(ws, { type: "error", message: "no such session" });
    ws.close();
    return;
  }
  const target = parseTarget(session.tmuxName);
  if (!target) {
    // Reported as data rather than an error code so the page can explain it,
    // which matters: this is the permanent state of every session with a
    // malformed tmux name, not a transient failure.
    control(ws, {
      type: "error",
      message: "This session's tmux name could not be parsed, so no terminal can attach to it.",
    });
    ws.close();
    return;
  }

  return attachTo(ws, target, tmuxName, spawn, false);
}

/**
 * Open a pty on a grouped view of `target` and pump it both ways.
 *
 * `direct` skips the grouped view: a session board created for a resume has
 * exactly one viewer, so there is no other client whose size it could clamp,
 * and a grouped view would just be a second session to clean up.
 */
async function attachTo(
  ws: WebSocket,
  target: TmuxTarget,
  label: string,
  spawn: typeof spawnTmuxPty,
  direct: boolean,
): Promise<void> {
  const sessionLabel = label;
  const view = direct
    ? { ok: true as const, view: target.session, error: undefined }
    : await ensureView(target, sessionLabel);
  if (!view.ok) {
    control(ws, { type: "error", message: view.error ?? "could not open a view" });
    ws.close();
    return;
  }

  // Selection depends on this, so it is set on every attach rather than
  // trusted: mouse reporting makes xterm forward drags to tmux instead of
  // selecting text.
  await runTmux(disableMouseCommand(view.view));

  // Leave copy-mode on attach. A pane left scrolled back — by an earlier tab,
  // or by a scroll whose connection went away before anyone typed — swallows
  // every keystroke as a copy-mode command, so the terminal opens looking
  // alive and refusing to type. Tracking a flag per connection cannot fix
  // that: a NEW connection's flag starts false while the pane is still in
  // copy-mode from before.
  await runTmux(cancelCopyModeCommand(view.view));

  let pty: PtyHandle;
  try {
    pty = await spawn(view.view, 120, 32);
  } catch (e) {
    control(ws, { type: "error", message: `no pty: ${e instanceof Error ? e.message : String(e)}` });
    ws.close();
    return;
  }

  control(ws, { type: "ready", view: view.view, session: target.session });

  /**
   * Whether a scroll has left the pane in copy-mode.
   *
   * Scrolling enters copy-mode and tmux STAYS there: keys become copy-mode
   * commands, so arrows move a cursor and ordinary typing does nothing at
   * all. That reads exactly as "the terminal has locked up in some
   * selection state", which is how it was reported. Typing must therefore
   * leave copy-mode first — and the flag is tracked here rather than asked
   * of tmux, because asking would be a subprocess per keystroke.
   */
  let scrolledBack = false;
  // Never log the bytes: they carry whatever is typed, including secrets.
  console.log(`term open   ${sessionLabel.slice(0, 24)} -> ${view.view}`);

  pty.onData((chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk);
  });
  pty.onExit(() => {
    control(ws, { type: "exit" });
    ws.close();
  });

  ws.on("message", (raw, isBinary) => {
    const text = isBinary ? raw.toString() : String(raw);
    if (text.length > MAX_MESSAGE) return;
    if (text[0] === "\x00") {
      try {
        const msg = JSON.parse(text.slice(1)) as {
          type?: string; cols?: number; rows?: number; lines?: number;
        };
        if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          pty.resize(Math.max(20, msg.cols!), Math.max(5, msg.rows!));
        }
        // Scrolling is a COMMAND, not a keystroke. tmux owns the scrollback,
        // and without this xterm turns the wheel into arrow keys — which
        // Claude Code reads as "previous prompt", so the wheel walked the
        // command history instead of the history.
        if (msg.type === "scroll" && Number.isInteger(msg.lines)) {
          if (!scrolledBack) {
            scrolledBack = true;
            control(ws, { type: "scrolled", back: true });
          }
          // Sequential, but not awaited by the handler: the socket must keep
          // reading input while a scroll is in flight.
          void scrollCommands(view.view, msg.lines!).reduce(
            (chain, cmd) => chain.then(() => runTmux(cmd).then(() => undefined)),
            Promise.resolve(),
          );
        }
      } catch {
        /* malformed control frame — ignore rather than kill the terminal */
      }
      return;
    }
    // Ordinary input. If a scroll left the pane in copy-mode, leave it first,
    // or the keystroke is swallowed as a copy-mode command.
    if (scrolledBack) {
      scrolledBack = false;
      control(ws, { type: "scrolled", back: false });
      void runTmux(cancelCopyModeCommand(view.view)).then(() => pty.write(text));
      return;
    }
    pty.write(text);
  });

  const teardown = () => {
    pty.kill();
    // Kill the VIEW, never the session. Leaving it behind would hold a tmux
    // client against the user's real session and clamp its size to a
    // browser tab that is no longer there. When attaching directly there is
    // no view to kill — `view.view` IS the session, and killing it would end
    // the work.
    if (!direct) void runTmux(closeViewCommand(view.view));
    console.log(`term detach ${sessionLabel.slice(0, 24)} -> ${view.view} (session keeps running)`);
  };
  ws.on("close", teardown);
  ws.on("error", teardown);
}

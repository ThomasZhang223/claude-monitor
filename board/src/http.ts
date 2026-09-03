/**
 * The HTTP surface: a small JSON API plus the static files.
 *
 * Deliberately hand-rolled on `node:http` rather than a framework. The whole
 * API is a couple dozen routes, and a dependency that ships middleware, a
 * router and a body parser to serve them is a dependency to audit for no
 * gain — this server hands out terminals, so its dependency list is a
 * security surface, not a convenience.
 *
 * Ported from the reference implementation's server/src/http.ts (route table,
 * `safeResolve`, the POST-only rule, `MAX_BODY`), re-addressed for
 * claude-monitor's own session model:
 *
 *  - A pane is addressed as (tmuxName, windowIndex, paneIndex) — a session
 *    can have more than one pane (a WORK session's plan | implement panes),
 *    so a pane index alone is not unique across windows. Every route that
 *    names a pane therefore carries all three, as
 *    `/api/sessions/:tmux/panes/:windowIndex/:paneIndex/<verb>`, and drives
 *    tmux through core/src/tmux.ts's `paneTarget` — no lookup through
 *    board's own listing is needed to build that target, so these routes
 *    work for ANY tmux pane, board-tracked or not (the same bypass
 *    board/src/ws.ts's `/ws/tmux/<name>` already uses).
 *  - `GET /api/config` is new: it hands board/web the box palette
 *    (core/src/config.ts's `loadConfig().boxes`) so a card can resolve its
 *    box id to a colour, since that palette is user configuration and
 *    cannot be hardcoded in CSS.
 *  - The server binds 127.0.0.1 only, and there is no `--host` flag — see
 *    `HOST` below.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { fileURLToPath } from "url";
import { collectSessions as collectSessionsReal } from "../../core/src/collect.ts";
import { readClaudeSessions as readClaudeSessionsReal, transcriptDirPathForCwd } from "../../core/src/claude.ts";
import { loadConfig } from "../../core/src/config.ts";
import { paneTarget } from "../../core/src/tmux.ts";
import type { ClaudeSession, SessionRecord, Status } from "../../core/src/model.ts";
import { identityMatches, tokenFrom, tokenMatches, type IdentityGate } from "./auth.ts";
import {
  closeSessionCommand,
  closeViewCommand,
  cycleModeCommand,
  groupedName,
  hasSession,
  interruptCommand,
  PASTE_SETTLE_MS,
  resumeCommands,
  runTmux,
  sendTextCommands,
  submitCommand,
  type TmuxRunner,
} from "./lifecycle.ts";
import {
  answerKeys,
  capturePane,
  capturePrompt,
  captureMode,
  captureActivity,
  forgetPrompt,
  inputHolds,
  mayHavePrompt,
  REDRAW_MS,
} from "./prompt.ts";
import { readBefore, readPage } from "./messages.ts";
import { endedSessions, transcriptFor, PAGE_SIZE } from "./history.ts";
import { findSession, getSessionListing, type SessionsDeps } from "./sessions.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
export const WEB_DIR = path.join(ROOT, "web");

/**
 * The only address this server ever binds.
 *
 * A security invariant, not a default: it hands out a terminal, and remote
 * reach is meant to come from whatever tunnel the user puts in front of it —
 * board never learns that a tunnel exists (see the plan's Settled item 8).
 * There is deliberately no flag to change it.
 *
 * Declared here rather than in main.ts so it can be asserted without
 * importing an entry point that starts listening on import.
 */
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 7788;

/**
 * Content types for the files we actually serve.
 *
 * `.mjs` is not optional trivia: xterm ships its ES modules under that
 * extension, and a browser REFUSES to execute a module served as
 * application/octet-stream — the symptom is a blank terminal page with no
 * server-side error at all.
 */
export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/** The tmux operations the API performs, injectable so route behaviour can
 *  be tested without a live tmux server. */
export interface TmuxOps {
  run: TmuxRunner;
  has: (name: string) => Promise<boolean>;
}

/** Where the raw, uncached session facts come from — used only by the two
 *  helpers below that need a Claude session id or cwd the listing's own
 *  view model (board/src/sessions.ts) does not carry. Reuses sessions.ts's
 *  own dependency shape rather than inventing a second one. */
export type RawDeps = SessionsDeps;

export interface ServerOptions {
  /** The bearer token. Mandatory — see auth.ts's module doc — so this is
   *  never null; a caller that wants no auth has no supported way to ask
   *  for that. */
  token: string;
  /** Off when null or omitted. See auth.ts's resolveIdentityGate. */
  identityGate?: IdentityGate | null;
  /** Defaults to the real tmux. */
  tmux?: TmuxOps;
  /** Extra roots static files may be served from — used for xterm's assets
   *  in node_modules, which live outside web/. */
  assetRoots?: Record<string, string>;
  /** Overrides `getSessionListing`/`findSession`'s own dependencies, so
   *  route tests never depend on a real tmux or a real config.json. */
  sessionsDeps?: SessionsDeps;
  /** Overrides the raw `collectSessions`/`readClaudeSessions` calls the pane
   *  and resume routes make directly (see `resolvePaneClaude`,
   *  `currentLiveIds`) — same reason as `sessionsDeps`, for the facts
   *  board/src/sessions.ts's own view model does not carry. */
  rawDeps?: RawDeps;
  /** Overrides `GET /api/config`'s own `loadConfig()` call — same reason as
   *  `sessionsDeps`/`rawDeps`: core/src/config.ts's own test convention is an
   *  explicit path, not an env var (`CONFIG_PATH` is frozen at import time,
   *  so an env var set after the process starts has no effect). Defaults to
   *  `loadConfig`'s own default (`CONFIG_PATH`). */
  configPath?: string;
}

/**
 * Read a JSON request body, capped.
 *
 * A message goes in the BODY rather than the query string: it is arbitrary
 * user text, it can be long, and a URL ends up in logs and history in a way
 * a body does not.
 */
const MAX_BODY = 64 * 1024;
async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("message too long");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** A year. Long enough that a bookmark keeps working; the token is rotatable. */
export const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * What a browser gets instead of raw JSON when its token is missing.
 *
 * Deliberately self-contained and styleless — it has to render before any
 * stylesheet is authorised. No mention of any particular tunnel: board
 * never learns whether one is in front of it (plan Settled items 7-8).
 */
const UNAUTHORIZED_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>board — needs your token</title>
<body style="font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0e1116;color:#d6deeb;padding:2rem">
<h1 style="font-size:1rem;color:#7fffd4">board needs your token</h1>
<p>This board hands out terminals, so it never serves anyone without one.</p>
<p>Open the link <code>board</code> printed when it started — the one ending in
<code>?t=&hellip;</code>. It sets a cookie, so you only need it once per browser.</p>
<p style="color:#8b98a9">Lost it? Run <code>board</code> again, or read
the token file its startup message names. Rotate it with
<code>bin/board --rotate-token</code>.</p>
</body>`;

function json(res: http.ServerResponse, code: number, body: unknown): undefined {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

/**
 * Serve one file from a directory, refusing to escape it.
 *
 * The resolve-then-prefix-check is the whole defence against `../` in a URL.
 * `path.join` alone would happily walk out of the web root.
 */
export function safeResolve(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    // Malformed percent-encoding (e.g. `/%%%`) must fail closed like any
    // other invalid path, not escape as an uncaught exception.
    rel = decodeURIComponent(urlPath.replace(/^\/+/, ""));
  } catch {
    return null;
  }
  const abs = path.resolve(root, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return abs === root || abs.startsWith(prefix) ? abs : null;
}

function serveFile(res: http.ServerResponse, file: string): void {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    // The UI is served from disk and changes when the tool is updated; never
    // let a browser pin an old build.
    "cache-control": "no-cache",
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// Facts board/src/sessions.ts's view model does not carry.
//
// SessionView/PaneView (sessions.ts) deliberately drop each pane's own Claude
// session id and cwd — nothing else in board needs them. Two things do: the
// per-pane transcript (a boxed session's own Claude sessionId + cwd resolve
// to `transcriptDirPathForCwd(cwd)/<sessionId>.jsonl`) and telling an ended
// session apart from one that is secretly still live. Both read the raw,
// UNCACHED facts directly — going through sessions.ts's own 900ms cache
// would save nothing here, since neither call sits on the hot listing poll.
// ---------------------------------------------------------------------------

async function rawRecords(
  deps: RawDeps = {},
): Promise<{ records: SessionRecord[]; claudeSessions: ClaudeSession[] }> {
  const collect = deps.collectSessions ?? collectSessionsReal;
  const readClaude = deps.readClaudeSessions ?? readClaudeSessionsReal;
  const boxIds = deps.boxIds ?? loadConfig().boxes.map((b) => b.id);
  const [records, claudeSessions] = await Promise.all([collect(boxIds), readClaude()]);
  return { records, claudeSessions };
}

async function resolvePaneClaude(
  tmuxName: string,
  windowIndex: number,
  paneIndex: number,
  deps: RawDeps = {},
): Promise<{ sessionId: string; cwd: string; status: Status } | null> {
  const { records } = await rawRecords(deps);
  const record = records.find((r) => r.tmuxName === tmuxName);
  const pane = record?.panes.find((p) => p.windowIndex === windowIndex && p.paneIndex === paneIndex);
  return pane?.claude ? { sessionId: pane.claude.sessionId, cwd: pane.claude.cwd, status: pane.status } : null;
}

/** Every Claude session id board currently knows to be live, boxed or not. */
async function currentLiveIds(deps: RawDeps = {}): Promise<Set<string>> {
  const { records, claudeSessions } = await rawRecords(deps);
  const ids = new Set<string>();
  for (const r of records) for (const p of r.panes) if (p.claude) ids.add(p.claude.sessionId);
  for (const c of claudeSessions) ids.add(c.sessionId);
  return ids;
}

/**
 * The cwd an ended session actually ran in, read from its transcript's own
 * first row rather than decoded from the project-folder slug.
 *
 * history.ts's own `projectSlug` is explicit that it is lossy — Claude Code
 * replaces path separators with `-`, which a real `-` in a path is
 * indistinguishable from — so it is "a display hint only, never a path to
 * act on". Resuming into the wrong directory is exactly the kind of thing
 * that hint must never drive, so this reads the one field a transcript
 * always opens with instead. Only the first few KB are read: the row is
 * always near the start of the file, and transcripts run to tens of
 * megabytes.
 */
function firstRowCwd(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    const line = (nl < 0 ? buf.subarray(0, n) : buf.subarray(0, nl)).toString("utf8");
    const row = JSON.parse(line) as { cwd?: unknown };
    return typeof row.cwd === "string" ? row.cwd : null;
  } catch {
    // A truncated or unparsable first line means "no reliable cwd", not an
    // error worth failing the resume over — the caller falls back to no -c.
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function createServer(opts: ServerOptions): http.Server {
  const tmux: TmuxOps = opts.tmux ?? { run: runTmux, has: (name) => hasSession(name) };

  return http.createServer(async (req, res) => {
    let url: URL;
    try {
      // A malformed request line or Host header must not crash the process —
      // an async request handler that throws synchronously becomes an
      // unhandled rejection, which can take the whole server down over one
      // bad request.
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      json(res, 400, { error: "bad request" });
      return;
    }
    const headers = req.headers as Record<string, string | string[] | undefined>;

    // The mandatory control. Everything below this point — including static
    // assets — needs it; a browser gets a page saying so, a fetch gets JSON.
    if (!tokenMatches(opts.token, tokenFrom(headers, req.url ?? "/"))) {
      if ((req.headers.accept ?? "").includes("text/html")) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(UNAUTHORIZED_PAGE);
      } else {
        json(res, 401, { error: "unauthorized" });
      }
      return;
    }
    // Promote a ?t= link into a cookie so subsequent navigation carries it.
    const q = url.searchParams.get("t");
    if (q) {
      res.setHeader(
        "set-cookie",
        `board_token=${encodeURIComponent(q)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict`,
      );
    }

    // The optional, on-top-of-the-token gate. Off entirely when
    // `opts.identityGate` is null/undefined — see auth.ts's module doc.
    if (!identityMatches(opts.identityGate ?? null, headers)) {
      json(res, 403, { error: "identity header did not match" });
      return;
    }

    try {
      // --- configuration ---------------------------------------------------
      if (url.pathname === "/api/config" && req.method === "GET") {
        json(res, 200, { boxes: loadConfig(opts.configPath).boxes });
        return;
      }

      // --- the listing -------------------------------------------------------
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const listing = await getSessionListing(opts.sessionsDeps);
        // Attach any pending prompt to each pane, so a blocked pane can be
        // answered from the dashboard without opening its terminal. Building
        // a NEW object per pane rather than mutating the listing: it is
        // served from sessions.ts's own 900ms cache, and writing into a
        // cached object would leak this request's prompt read into the next
        // poll's response.
        const boxed = await Promise.all(
          listing.boxed.map(async (s) => ({
            ...s,
            panes: await Promise.all(
              s.panes.map(async (p) => {
                if (!mayHavePrompt(p.status, s.tmuxName)) return { ...p, prompt: null };
                const target = paneTarget(s.tmuxName, p.windowIndex, p.paneIndex);
                return { ...p, prompt: await capturePrompt(target, tmux.run) };
              }),
            ),
          })),
        );
        json(res, 200, { boxed, unboxed: listing.unboxed });
        return;
      }

      // --- ended / resumable sessions ---------------------------------------
      if (url.pathname === "/api/sessions/ended" && req.method === "GET") {
        const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
        const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE) || PAGE_SIZE;
        const liveIds = await currentLiveIds(opts.rawDeps);
        json(res, 200, endedSessions(liveIds, { offset, limit }));
        return;
      }

      const resume = url.pathname.match(/^\/api\/sessions\/ended\/([^/]+)\/resume$/);
      if (resume && req.method === "POST") {
        const sessionId = decodeURIComponent(resume[1]);
        const liveIds = await currentLiveIds(opts.rawDeps);
        if (liveIds.has(sessionId)) {
          return json(res, 409, {
            error: "That session is running right now — resume is for ended sessions.",
          });
        }
        const file = transcriptFor(sessionId);
        if (!file) return json(res, 404, { error: "no such session" });
        const cwd = firstRowCwd(file);
        const fork = url.searchParams.get("fork") !== "false";
        const { create, name } = resumeCommands(sessionId, { cwd, fork });
        // Resuming the same session twice used to fail with a raw tmux
        // "duplicate session" error, since the name is derived from the
        // session id. Reuse is the right answer: you already have this
        // conversation open, and what you want is to get back to it.
        if (await tmux.has(name)) {
          console.log(`resume      ${sessionId.slice(0, 8)} -> ${name} (already open)`);
          return json(res, 200, { ok: true, tmux: name, existing: true });
        }
        const out = await tmux.run(create);
        console.log(`resume      ${sessionId.slice(0, 8)} -> ${name} fork=${fork} ok=${out.ok}`);
        return json(res, out.ok ? 200 : 500, {
          ok: out.ok, tmux: name, existing: false, error: out.ok ? undefined : out.stderr.trim(),
        });
      }

      const unboxedMessages = url.pathname.match(/^\/api\/sessions\/unboxed\/([^/]+)\/messages$/);
      if (unboxedMessages && req.method === "GET") {
        const sessionId = decodeURIComponent(unboxedMessages[1]);
        const { claudeSessions } = await rawRecords(opts.rawDeps);
        const claude = claudeSessions.find((c) => c.sessionId === sessionId);
        if (!claude) return json(res, 404, { error: "no such session" });
        const file = path.join(transcriptDirPathForCwd(claude.cwd), `${claude.sessionId}.jsonl`);
        // No known tmux target for an unboxed session (it may not even run
        // in tmux at all), so there is no `activity` to capture — this is
        // read-only transcript viewing, not a live terminal signal.
        json(res, 200, { ...readMessagesPage(file, url), live: null, status: claude.rawStatus, activity: null });
        return;
      }

      // --- one boxed session's own facts -------------------------------------
      const detail = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (detail && req.method === "GET") {
        const session = await findSession(decodeURIComponent(detail[1]), opts.sessionsDeps);
        if (!session) return json(res, 404, { error: "no such session" });
        json(res, 200, session);
        return;
      }

      // --- the conversation itself --------------------------------------------
      const paneMessages = url.pathname.match(/^\/api\/sessions\/([^/]+)\/panes\/(\d+)\/(\d+)\/messages$/);
      if (paneMessages && req.method === "GET") {
        const tmuxName = decodeURIComponent(paneMessages[1]);
        const windowIndex = Number(paneMessages[2]);
        const paneIndex = Number(paneMessages[3]);
        const claude = await resolvePaneClaude(tmuxName, windowIndex, paneIndex, opts.rawDeps);
        if (!claude) return json(res, 404, { error: "no Claude session resolved in that pane" });
        const file = path.join(transcriptDirPathForCwd(claude.cwd), `${claude.sessionId}.jsonl`);
        // What the terminal is doing that the status file does not say.
        // During a compaction the status can stay quiet the whole minute it
        // takes, so without this the page shows nothing and looks stalled.
        const target = paneTarget(tmuxName, windowIndex, paneIndex);
        const activity = await captureActivity(target, tmux.run);
        json(res, 200, { ...readMessagesPage(file, url), live: claude.status !== "dead", status: claude.status, activity });
        return;
      }

      // --- steering a pane -----------------------------------------------------
      const interrupt = url.pathname.match(/^\/api\/sessions\/([^/]+)\/panes\/(\d+)\/(\d+)\/interrupt$/);
      if (interrupt && req.method === "POST") {
        const tmuxName = decodeURIComponent(interrupt[1]);
        if (!(await tmux.has(tmuxName))) return json(res, 404, { error: "no such session" });
        const target = paneTarget(tmuxName, Number(interrupt[2]), Number(interrupt[3]));
        const out = await tmux.run(interruptCommand(target));
        console.log(`interrupt   ${target} ok=${out.ok}`);
        return json(res, out.ok ? 200 : 500, { ok: out.ok, error: out.ok ? undefined : out.stderr.trim() });
      }

      const modeRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/panes\/(\d+)\/(\d+)\/mode$/);
      if (modeRoute && req.method === "POST") {
        const tmuxName = decodeURIComponent(modeRoute[1]);
        if (!(await tmux.has(tmuxName))) return json(res, 404, { error: "no such session" });
        const target = paneTarget(tmuxName, Number(modeRoute[2]), Number(modeRoute[3]));
        const out = await tmux.run(cycleModeCommand(target));
        if (!out.ok) return json(res, 500, { ok: false, error: out.stderr.trim() });
        // Read back rather than assume: the cycle order is the terminal's,
        // not board's, and a mode board merely guessed would be a lie.
        forgetPrompt(target);
        await new Promise((r) => setTimeout(r, REDRAW_MS));
        const after = await captureMode(target, tmux.run);
        console.log(`mode        ${target} -> ${after ?? "?"}`);
        return json(res, 200, { ok: true, permissionMode: after });
      }

      const say = url.pathname.match(/^\/api\/sessions\/([^/]+)\/panes\/(\d+)\/(\d+)\/say$/);
      if (say && req.method === "POST") {
        const tmuxName = decodeURIComponent(say[1]);
        if (!(await tmux.has(tmuxName))) return json(res, 404, { error: "no such session" });
        const target = paneTarget(tmuxName, Number(say[2]), Number(say[3]));
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) return json(res, 400, { error: "nothing to send" });
        for (const cmd of sendTextCommands(target, text)) {
          const out = await tmux.run(cmd);
          if (!out.ok) return json(res, 500, { ok: false, error: out.stderr.trim() });
        }
        // The paste has landed, which is the part that can fail in a way the
        // caller can do something about. Submitting is deliberately NOT
        // awaited — the retry below is self-healing either way, and waiting
        // for it put a redraw delay plus a pane read on the path of every
        // message.
        void (async () => {
          try {
            await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
            await tmux.run(submitCommand(target));
            forgetPrompt(target);
            await new Promise((r) => setTimeout(r, REDRAW_MS));
            const pane = await capturePane(target, tmux.run, Date.now());
            if (pane && inputHolds(pane, text)) {
              await tmux.run(submitCommand(target));
              forgetPrompt(target);
            }
          } catch {
            // The message is already in the terminal; a failed check is not
            // worth an error the caller cannot act on.
          }
        })();
        // Length only, never the text: this is the user's own words.
        console.log(`say         ${target} ${text.length} chars`);
        return json(res, 200, { ok: true });
      }

      // --- interactive prompts ---------------------------------------------
      const promptRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/panes\/(\d+)\/(\d+)\/prompt$/);
      if (promptRoute && req.method === "GET") {
        const tmuxName = decodeURIComponent(promptRoute[1]);
        if (!(await tmux.has(tmuxName))) return json(res, 404, { error: "no such session" });
        const target = paneTarget(tmuxName, Number(promptRoute[2]), Number(promptRoute[3]));
        return json(res, 200, { prompt: await capturePrompt(target, tmux.run) });
      }

      const answer = url.pathname.match(/^\/api\/sessions\/([^/]+)\/panes\/(\d+)\/(\d+)\/answer$/);
      if (answer && req.method === "POST") {
        const tmuxName = decodeURIComponent(answer[1]);
        if (!(await tmux.has(tmuxName))) return json(res, 404, { error: "no such session" });
        const target = paneTarget(tmuxName, Number(answer[2]), Number(answer[3]));

        const index = Number(url.searchParams.get("index"));
        const seen = url.searchParams.get("fingerprint") ?? "";

        // Re-read the pane immediately before sending. This is the whole
        // safety property, not ceremony: you may have answered in the
        // terminal a second ago, and a stale "2" sent into a dismissed menu
        // types a literal 2 into the chat box.
        const now = await capturePrompt(target, tmux.run);
        if (!now) return json(res, 409, { error: "That prompt is no longer on screen." });
        if (now.fingerprint !== seen) {
          return json(res, 409, { error: "That prompt changed before this could be sent. Re-read it and choose again." });
        }
        const choice = now.options.find((o) => o.index === index);
        if (!choice) return json(res, 400, { error: `no option ${index || "(none)"} in this prompt` });
        if (!choice.drivable) return json(res, 400, { error: choice.reason });

        for (const cmd of answerKeys(now, index, target)) {
          const out = await tmux.run(cmd);
          if (!out.ok) return json(res, 500, { ok: false, error: out.stderr.trim() });
        }
        // Confirm against a FRESH read: the cache still holds the capture
        // taken before the keystroke, and the TUI has not redrawn yet.
        forgetPrompt(target);
        await new Promise((r) => setTimeout(r, REDRAW_MS));
        const after = await capturePrompt(target, tmux.run);
        // Never log the option text: a permission prompt quotes the command
        // it is about, and that is the user's content.
        console.log(`answer      ${target} option=${index}`);
        return json(res, 200, { ok: true, cleared: after === null || after.fingerprint !== now.fingerprint });
      }

      // --- lifecycle ---------------------------------------------------------
      // POST, not GET: both end a session and close a view, and neither may
      // be reachable by a link or a prefetch.
      const close = url.pathname.match(/^\/api\/sessions\/([^/]+)\/close$/);
      if (close && req.method === "POST") {
        const tmuxName = decodeURIComponent(close[1]);
        if (!(await tmux.has(tmuxName))) return json(res, 404, { error: "no such session" });
        const out = await tmux.run(closeSessionCommand(tmuxName));
        console.log(`close       ${tmuxName} ok=${out.ok}`);
        return json(res, out.ok ? 200 : 500, { ok: out.ok, error: out.ok ? undefined : out.stderr.trim() });
      }

      // Detach: close the terminal VIEW and leave the session running. The
      // ordinary way to detach is to close the browser tab, but a tab that
      // crashed leaves a view behind holding a client against the session,
      // and this is how the dashboard clears one.
      const detach = url.pathname.match(/^\/api\/sessions\/([^/]+)\/detach$/);
      if (detach && req.method === "POST") {
        const tmuxName = decodeURIComponent(detach[1]);
        const view = groupedName(tmuxName, tmuxName);
        const out = await tmux.run(closeViewCommand(view));
        console.log(`detach      ${tmuxName} -> ${view} ok=${out.ok}`);
        // Not found is success here: the goal is "no view open", and a view
        // that already went away satisfies it.
        return json(res, 200, { ok: true, view });
      }

      // --- Static --------------------------------------------------------
      const assetRoots = opts.assetRoots ?? {};
      for (const [prefix, root] of Object.entries(assetRoots)) {
        if (url.pathname.startsWith(prefix)) {
          const file = safeResolve(root, url.pathname.slice(prefix.length));
          if (!file) {
            res.writeHead(403).end("forbidden");
            return;
          }
          serveFile(res, file);
          return;
        }
      }
      const rel = url.pathname === "/" ? "index.html" : url.pathname;
      const file = safeResolve(WEB_DIR, rel);
      if (!file) {
        res.writeHead(403).end("forbidden");
        return;
      }
      serveFile(res, file);
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * A page of one transcript.
 *
 * Shared by the boxed-pane and unboxed-session `/messages` routes — both
 * resolve to a transcript file some other way, and read the same page shape
 * from there. Each caller layers its own `live`/`status`/`activity` on top,
 * since board only has a live terminal signal for a boxed pane.
 */
function readMessagesPage(file: string, url: URL): ReturnType<typeof readPage> {
  const num = (name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    return raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
  };
  // `before` walks into the past for "load earlier"; `after` follows the
  // conversation forward. They are different directions, not variants.
  const before = num("before");
  return before !== undefined ? readBefore(file, before) : readPage(file, num("after"));
}

/**
 * attach / detach / close / resume — the four verbs, all of them tmux.
 *
 * tmux is what makes the other three possible: a session inside it survives
 * its viewer going away, which is exactly what "detach and keep running"
 * means. Detach is therefore not a feature to build — it is what happens when
 * the websocket closes and the tmux client dies. What this module has to get
 * right is everything around that.
 *
 * Ported unchanged from the reference implementation's server/src/lifecycle.ts —
 * it is tmux argv construction and execution only, and carries no dependency
 * on any particular session model. board/src/ws.ts (Panel C) and
 * board/src/http.ts (this PR) both import from here directly by name.
 *
 * A caller addresses a specific pane with core/src/tmux.ts's `paneTarget`
 * (`session:windowIndex.paneIndex`) rather than a bare session name — see
 * that function's own comment for why a bare pane index is wrong the moment
 * a session has more than one window. Every function below that takes a
 * `session: string` accepts either a plain session name or a full
 * `session:window.pane` target — tmux's own `-t` resolves both.
 *
 * ceiling: `spawnCommands`/`spawnSlug` (start a brand-new session from the
 * board) and `tmuxSnapshot`/`isAttached`/`parentOfResume` (Di's own presence
 * and fork-lineage tracking) are not ported. Starting new work from the
 * board is out of this port's scope — board/src/repos.ts is not ported
 * either, and there is no /api/spawn route (see http.ts) — and presence /
 * lineage are display-only facts claude-monitor's own SessionRecord does not
 * carry. Upgrade path: port them from the reference alongside whichever
 * feature first needs them, unchanged.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Prefix for the sessions board creates for itself — a grouped VIEW of a
 *  session, or a resumed/spawned session — so its own are recognisable and a
 *  grouped view can never be mistaken for real work. Unrelated to
 *  claude-monitor's own `cc-` session-naming convention (model.ts's
 *  SESSION_PREFIX), which addresses a different concern: which sessions the
 *  dashboard groups into boxes, not which sessions board itself created. */
export const BOARD_PREFIX = "board";

export interface TmuxTarget {
  session: string;
  window: string | null;
  pane: string | null;
}

/**
 * Split `session:window.pane`.
 *
 * A tmux session name may itself contain `.` (it may not contain `:`), so the
 * split is on the FIRST colon and then the LAST dot of the remainder — doing
 * it the other way round mangles any session whose name has a dot in it.
 */
export function parseTarget(target: string): TmuxTarget | null {
  if (!target) return null;
  const colon = target.indexOf(":");
  if (colon < 0) return { session: target, window: null, pane: null };
  const session = target.slice(0, colon);
  if (!session) return null;
  const rest = target.slice(colon + 1);
  const dot = rest.lastIndexOf(".");
  return dot < 0
    ? { session, window: rest || null, pane: null }
    : { session, window: rest.slice(0, dot) || null, pane: rest.slice(dot + 1) || null };
}

/** The name of the throwaway grouped session used to view `session`. */
export function groupedName(session: string, viewKey: string): string {
  return `${BOARD_PREFIX}-${viewKey.slice(0, 8)}`;
}

/**
 * Commands to open a viewing session, as argv arrays.
 *
 * A grouped session (`new-session -t`) rather than a plain `attach`, and this
 * is the important part: **tmux clamps a session to its smallest attached
 * client**. Attaching a browser tab directly to the session you also have open
 * in a terminal would shrink both to whichever is narrower — your real window
 * would visibly resize because someone opened a web page. A grouped session
 * shares the windows but sizes independently, so neither viewer disturbs the
 * other.
 *
 * `-d` so creating it does not try to attach from a process with no terminal.
 */
export function openViewCommands(target: TmuxTarget, viewKey: string): {
  create: string[];
  attach: string[];
  view: string;
} {
  const view = groupedName(target.session, viewKey);
  return {
    // `new-session -A` would attach-if-exists, but it also fails differently
    // when the group is gone; creating explicitly and tolerating "duplicate
    // session" is clearer about which case happened.
    create: ["new-session", "-d", "-t", target.session, "-s", view],
    attach: ["attach-session", "-t", view],
    view,
  };
}

/**
 * Turn tmux's mouse reporting OFF on a session board attaches to.
 *
 * Asserted rather than assumed, because it is the difference between being
 * able to select text and not. When tmux reports mouse, xterm hands every
 * click and drag to the application instead of making a selection — so a drag
 * selects nothing at all. That is not theory: an earlier attempt at scrolling
 * turned mouse reporting ON, and text selection stopped working until it came
 * back off.
 *
 * Scrolling does not need it (see `scrollCommands`), so there is nothing to
 * trade away. Applied only to sessions board owns — a view, or one it created.
 */
export function disableMouseCommand(session: string): string[] {
  return ["set-option", "-t", session, "mouse", "off"];
}

/**
 * Scroll a session's history, by driving tmux's copy-mode directly.
 *
 * The obvious route is `set-option mouse on`, and it does not work here. tmux
 * duly offers mouse reporting (it sends `?1000h ?1002h ?1006h`, verified), but
 * the wheel never came back from the browser, so the pane never entered
 * copy-mode. Meanwhile mouse mode has a real cost: tmux takes drag-select too,
 * and selecting text in the browser then needs shift.
 *
 * Sending the scroll as a command avoids both problems. `-X scroll-up` is
 * tmux's own copy-mode scroll, so this is the same motion a keyboard user
 * gets, and mouse mode stays off so selection behaves normally.
 *
 * `copy-mode` first is harmless when already in it, and is what makes the
 * first wheel notch work rather than being swallowed.
 */
export function cancelCopyModeCommand(session: string): string[] {
  return ["send-keys", "-t", session, "-X", "cancel"];
}

export function scrollCommands(session: string, lines: number): string[][] {
  const up = lines > 0;
  const n = Math.min(Math.abs(lines), 500);
  return [
    ["copy-mode", "-t", session],
    ["send-keys", "-t", session, "-X", "-N", String(n), up ? "scroll-up" : "scroll-down"],
  ];
}

/** Killing the VIEW, not the session — this is detach, and it must never take
 *  the user's work with it. */
export function closeViewCommand(view: string): string[] {
  return ["kill-session", "-t", view];
}

/** Killing the real session. This ends the Claude process; the transcript
 *  survives, so the session remains resumable afterwards. */
export function closeSessionCommand(session: string): string[] {
  return ["kill-session", "-t", session];
}

/**
 * Commands to resume a session into a terminal of its own.
 *
 * `--fork-session` is the default on purpose. Resuming a session that is still
 * running would put two processes on one transcript; forking gives a new
 * session id and leaves the original untouched. True resume is available, but
 * only by asking for it, and the caller is expected to have confirmed.
 */
export function resumeCommands(
  sessionId: string,
  opts: { cwd?: string | null; fork?: boolean; claudeBin?: string } = {},
): { create: string[]; name: string } {
  const name = `${BOARD_PREFIX}-resume-${sessionId.slice(0, 8)}`;
  const claude = opts.claudeBin ?? "claude";
  const argv = [claude, "--resume", sessionId];
  if (opts.fork !== false) argv.push("--fork-session");
  const create = ["new-session", "-d", "-s", name];
  if (opts.cwd) create.push("-c", opts.cwd);
  create.push(...argv);
  return { create, name };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type TmuxRunner = (args: readonly string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export const runTmux: TmuxRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileAsync("tmux", [...args], { timeout: 10_000 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "tmux failed" };
  }
};

export async function hasSession(session: string, run: TmuxRunner = runTmux): Promise<boolean> {
  return (await run(["has-session", "-t", session])).ok;
}

/**
 * Ensure a grouped view exists for this session, and return its name.
 *
 * "already exists" is a success, not an error: two browser tabs on one session
 * share the view rather than racing to create it.
 */
export async function ensureView(
  target: TmuxTarget,
  viewKey: string,
  run: TmuxRunner = runTmux,
): Promise<{ ok: boolean; view: string; error?: string }> {
  const { create, view } = openViewCommands(target, viewKey);
  if (await hasSession(view, run)) return { ok: true, view };
  const res = await run(create);
  if (!res.ok && !/duplicate session/i.test(res.stderr)) {
    return { ok: false, view, error: res.stderr.trim() || "could not open a view" };
  }
  return { ok: true, view };
}

/**
 * Stop whatever the session is doing, the way the terminal does it.
 *
 * Escape is the key Claude Code binds to interrupt, so this is not board
 * implementing a stop — it is board pressing the same key you would. The turn
 * ends with "Interrupted · What should Claude do instead?" and the session
 * stays alive and ready for the correction.
 */
export function interruptCommand(session: string): string[] {
  return ["send-keys", "-t", session, "Escape"];
}

/** Board's own tmux paste buffer. Named so it cannot clobber yours. */
const BUFFER = "board-msg";

/**
 * Put text in the session's prompt, and optionally submit it.
 *
 * Delivered as a BRACKETED PASTE rather than typed characters, which is what
 * makes arbitrary text safe: `set-buffer -- <text>` takes the message as a
 * single argv element, so quotes, `$HOME`, a leading `--flag` and embedded
 * newlines all arrive verbatim. Typing the same text with `send-keys` would
 * hand tmux a string it may read as its own flags, and a newline mid-message
 * would submit half of it.
 *
 * WHY NOT the messaging socket, which can also deliver a message: it frames
 * what it delivers as "Another Claude session sent a message:" and attaches a
 * warning about peers not being able to grant permissions. That is correct for
 * a peer and wrong for board, which is the USER's own front door. A message you
 * send from the board must arrive as yours.
 *
 * Submitting while the session is busy needs nothing special: Claude Code
 * queues it and shows it under the running turn, which is exactly what the
 * terminal does with anything you type mid-turn.
 */
export function sendTextCommands(session: string, text: string): string[][] {
  // One tmux invocation, not three. `;` as a standalone argument is tmux's own
  // command separator, and each process spawn costs tens of milliseconds —
  // which is the difference between a send that feels immediate and one that
  // does not.
  return [[
    "set-buffer", "-b", BUFFER, "--", text, ";",
    "paste-buffer", "-p", "-b", BUFFER, "-t", session, ";",
    "delete-buffer", "-b", BUFFER,
  ]];
}

/**
 * Submit whatever is in the composer.
 *
 * Deliberately NOT part of `sendTextCommands`. Sending Enter in the same breath
 * as the paste works on an idle session and is LOST on a busy one — the message
 * stays in the box looking unsent, which is exactly how this was reported. The
 * caller has to leave a gap and then check.
 */
export function submitCommand(session: string): string[] {
  return ["send-keys", "-t", session, "Enter"];
}

/** How long to let a bracketed paste land before submitting it. */
export const PASTE_SETTLE_MS = 250;

/**
 * Cycle the session's permission mode.
 *
 * Shift+Tab is what the terminal binds — its own footer says
 * "(shift+tab to cycle)" — and there is no one-shot way to set a mode: the
 * `/permissions` command opens a dialog, and `--permission-mode` only applies
 * at launch. So this cycles, exactly as pressing the key does, and the caller
 * reads back which mode it landed on rather than assuming.
 *
 * Not to be confused with claude-monitor's own `Mode` (model.ts) — that is
 * the session's CLASS (work/quick/q/research), fixed at spawn time and
 * encoded in the tmux session name. This is Claude Code's own interactive
 * permission mode (plan/auto/manual/accept edits), a live, per-pane, runtime
 * setting with no relation to the session class.
 */
export function cycleModeCommand(session: string): string[] {
  return ["send-keys", "-t", session, "BTab"];
}

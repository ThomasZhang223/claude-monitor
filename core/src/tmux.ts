/**
 * Every tmux call the monitor makes, plus the pure parsers for their output.
 *
 * The design constraint here is the whole point of the module: shelling out and
 * parsing are separated behind the `Exec` seam, rather than fused the way a
 * naive wrapper around the tmux CLI usually is — which is why that shape has
 * no tests: you cannot reach the parsing without a live tmux server. Here
 * every function takes an optional `exec`, and the parsers are plain
 * string -> data functions the tests drive with fixture output.
 *
 * The second constraint is call volume. The main tick runs at POLL_MS, so the
 * snapshot is exactly two tmux invocations: one `list-sessions` (user options
 * folded into the same format string) and one `list-panes -a`. No per-session
 * `has-session` probe, no per-option `show-options`.
 */
import { execAsync, shellQuote, type Exec, type ExecResult } from "./exec.ts";
import {
  ALL_OPTS,
  parseSessionName,
  type BoxId,
  type Mode,
  type PaneInfo,
} from "./model.ts";

// ---------------------------------------------------------------------------
// The exec seam
//
// Lives in exec.ts so every module shells out through one place. Re-exported
// here because callers of this module reasonably expect the seam alongside
// the functions that use it.
// ---------------------------------------------------------------------------

export { execAsync, shellQuote, type Exec, type ExecResult };

/** tmux answers a poll in milliseconds; anything slower means the server is
 *  wedged and the tick should move on rather than stall the UI. */
const TMUX_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// tmux binary
// ---------------------------------------------------------------------------

/** The in-flight or settled lookup, not just its result. Caching the promise
 *  rather than the string matters because a tick fires `listSessions` and
 *  `listAllPanes` concurrently: caching only the result lets both miss and
 *  spawn their own `command -v`, which is a wasted process on every cold
 *  start. */
let tmuxBinPromise: Promise<string | null> | undefined;

/** Memoized `command -v tmux`, null when tmux is not installed. Goes through
 *  the same seam as everything else so tests never touch a real PATH. */
export function getTmuxBin(execFn: Exec = execAsync): Promise<string | null> {
  if (tmuxBinPromise === undefined) {
    tmuxBinPromise = execFn("command -v tmux", TMUX_TIMEOUT_MS).then((res) =>
      res.ok && res.stdout.trim() ? res.stdout.trim() : null,
    );
  }
  return tmuxBinPromise;
}

/** Forget the memoized lookup. Only tests need this. */
export function resetTmuxBin(): void {
  tmuxBinPromise = undefined;
}

// ---------------------------------------------------------------------------
// Format strings and parsing
// ---------------------------------------------------------------------------

/** Field separator for every `-F` format. It cannot be `:`, which is what the
 *  prior art used: `pane_current_path` may legitimately contain a colon (a
 *  directory literally named `weird:dir` renders verbatim on tmux 3.7b), so
 *  colon-splitting silently truncates the path. A literal tab in the format
 *  string passes through tmux unchanged and cannot occur in a session name. */
const SEP = "\t";

export type TmuxOpt = (typeof ALL_OPTS)[number];

/** Verified on tmux 3.7b: `#{@cc_label}` DOES interpolate inside a `-F`
 *  format, and an unset user option renders as the empty string. That is what
 *  lets one `list-sessions` carry all five options — no `show-options` fan-out
 *  and no `show-options -A` batch fallback. */
export const SESSIONS_FORMAT = ["#{session_name}", ...ALL_OPTS.map((o) => `#{${o}}`)].join(SEP);

export const PANES_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_pid}",
  "#{pane_current_command}",
  "#{pane_current_path}",
].join(SEP);

/** One of our tmux sessions as the single snapshot sees it. */
export interface SessionRow {
  /** tmux session name, already known to parse as ours. */
  name: string;
  box: BoxId;
  mode: Mode;
  slug: string;
  /** Only the options that are actually set — empty `-F` fields are dropped
   *  so a consumer can `?? fallback` instead of testing for "". */
  options: Partial<Record<TmuxOpt, string>>;
}

/** Parse `list-sessions -F SESSIONS_FORMAT`, keeping only sessions whose name
 *  `parseSessionName` accepts AND whose box is one of `boxIds` — a session
 *  belonging to a box that has since been removed from config.json is
 *  invisible here, which is deliberate: see config.ts's module doc. Unrelated
 *  local sessions (devbox_localstack, the localstack tool's monitor-*
 *  sessions) are dropped by the shape check; this is the only place either
 *  kind of filtering happens. */
export function parseSessionsOutput(stdout: string, boxIds: readonly string[]): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const fields = line.split(SEP);
    const name = fields[0] ?? "";
    const parsed = parseSessionName(name);
    if (!parsed) continue;
    if (!boxIds.includes(parsed.box)) continue;
    const options: Partial<Record<TmuxOpt, string>> = {};
    ALL_OPTS.forEach((opt, i) => {
      const value = fields[i + 1] ?? "";
      if (value) options[opt] = value;
    });
    rows.push({ name, ...parsed, options });
  }
  return rows;
}

/** Parse one `list-panes -a -F PANES_FORMAT` line, or null if it is malformed.
 *  The path is last and re-joined from the tail, so even a tab inside it (as
 *  well as the far more likely colon) survives intact. */
export function parsePaneLine(line: string): PaneInfo | null {
  if (!line) return null;
  const fields = line.split(SEP);
  if (fields.length < 6) return null;
  const [session, windowIndex, paneIndex, panePid, currentCommand] = fields;
  const currentPath = fields.slice(5).join(SEP);
  if (!session || !currentPath) return null;
  const nums = [windowIndex, paneIndex, panePid].map((f) => Number(f));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  return {
    session,
    windowIndex: nums[0],
    paneIndex: nums[1],
    panePid: nums[2],
    currentCommand: currentCommand ?? "",
    currentPath,
  };
}

const SHELLS = new Set(["bash", "zsh", "sh", "fish"]);

/** Is this pane running Claude Code? Claude Code reports its own semver (e.g.
 *  "2.1.132") as `pane_current_command` rather than "claude", so a bare semver
 *  counts. Shells never do. */
export function isClaudeCommand(cmd: string): boolean {
  const lc = cmd.trim().toLowerCase();
  if (!lc || SHELLS.has(lc)) return false;
  return lc === "claude" || /^\d+\.\d+\.\d+$/.test(lc);
}

/** Does the captured pane text show a permission / question prompt rather than
 *  the free-form input prompt? Permission and question prompts end with
 *  "Esc to cancel"; the free-form prompt never contains it.
 *
 *  This sentinel is English-locale and Claude-Code-version specific, so it is
 *  the LAST-RESORT layer only — used to break the awaiting/idle tie after the
 *  hook status files and the process tree have both come up empty. */
export function looksLikePrompt(capturedText: string): boolean {
  return capturedText.includes("Esc to cancel");
}

/** The composer's prompt marker as 2.1.220 draws it. */
const COMPOSER_PROMPT = "❯";

/**
 * What is sitting in the pane's input composer row, or null when no composer
 * row is on screen at all.
 *
 * NOT an emptiness test. An idle composer draws ghost placeholder text, so a
 * cleared one reads back as `Try "how does <filepath> work?"` rather than "".
 * This answers "is exactly X staged", which is decidable; "is it empty" is not.
 *
 * Scanned bottom-up. Transcript output above the composer can contain the same
 * glyph — a pasted shell prompt, a quoted diff — while the rows below it never
 * do; they are the rule, the model line, the context bars and the mode hint. A
 * draft long enough to wrap marks only its first row, which is the row worth
 * reading: if the composer was cleared, what was typed next is alone on it.
 *
 * Version and locale specific, like looksLikePrompt, so callers must treat
 * null as "could not tell" and not as "empty". A release that changes the
 * glyph should cost a check, not a feature.
 */
export function composerText(capturedText: string): string | null {
  const lines = capturedText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trimStart();
    if (line.startsWith(COMPOSER_PROMPT)) {
      return line.slice(COMPOSER_PROMPT.length).trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** ONE `list-sessions`, options included. Empty when tmux is missing or no
 *  server is running (tmux exits non-zero in that case). */
export async function listSessions(
  boxIds: readonly string[],
  execFn: Exec = execAsync,
): Promise<SessionRow[]> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return [];
  const res = await execFn(
    `${tmux} list-sessions -F '${SESSIONS_FORMAT}' 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  if (!res.ok) return [];
  return parseSessionsOutput(res.stdout, boxIds);
}

/** ONE `list-panes -a` for the whole server. Panes of unrelated sessions come
 *  back too — the caller joins on session name, which is cheaper than asking
 *  tmux per session. */
export async function listAllPanes(execFn: Exec = execAsync): Promise<PaneInfo[]> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return [];
  const res = await execFn(
    `${tmux} list-panes -a -F '${PANES_FORMAT}' 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  if (!res.ok) return [];
  const panes: PaneInfo[] = [];
  for (const line of res.stdout.split("\n")) {
    const pane = parsePaneLine(line);
    if (pane) panes.push(pane);
  }
  return panes;
}

/** A single user option. Only for the write-then-read-back paths — the poll
 *  loop gets its options from listSessions. Null when unset: tmux exits 1 with
 *  "invalid option" for an option that was never set. */
export async function getOption(
  session: string,
  name: string,
  execFn: Exec = execAsync,
): Promise<string | null> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return null;
  const res = await execFn(
    `${tmux} show-options -t ${shellQuote(session)} -v ${shellQuote(name)} 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  if (!res.ok) return null;
  const value = res.stdout.replace(/\n$/, "");
  return value || null;
}

/** Capture the tail of a pane. Used for the preview box and for the
 *  awaiting/idle tiebreak, nothing else — it is the one call whose cost scales
 *  with the pane's scrollback. */
export async function capturePane(
  target: string,
  lines: number,
  execFn: Exec = execAsync,
): Promise<string | null> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return null;
  const n = Math.max(1, Math.floor(lines));
  const res = await execFn(
    `${tmux} capture-pane -t ${shellQuote(target)} -p 2>/dev/null | grep -v '^$' | tail -${n}`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok ? res.stdout : null;
}

export async function hasSession(name: string, execFn: Exec = execAsync): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(
    `${tmux} has-session -t ${shellQuote(name)} 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Tab and newline are the `-F` field and record separators, so a value
 *  carrying either would corrupt the batched listSessions read. These are
 *  one-line display values, so collapsing to a space loses nothing real. */
function flattenOptionValue(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ");
}

export async function setOption(
  session: string,
  name: string,
  value: string,
  execFn: Exec = execAsync,
): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(
    `${tmux} set-option -t ${shellQuote(session)} ${shellQuote(name)} ` +
      `${shellQuote(flattenOptionValue(value))} 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok;
}

/** Remove a user option, so it reads as unset rather than as an empty value.
 *  Only the options a session outlives need this — most die with the session. */
export async function unsetOption(
  session: string,
  name: string,
  execFn: Exec = execAsync,
): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(
    `${tmux} set-option -t ${shellQuote(session)} -u ${shellQuote(name)} 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok;
}

/**
 * Clear whatever is currently sitting in a pane's input composer, so text
 * typed next lands alone on the line rather than appended after a stale draft.
 *
 * Double `Esc` is Claude Code's own "clear the draft" binding, and one batched
 * `send-keys` delivers it correctly — measured, because the opposite was
 * assumed for a while: three of three trials cleared a real draft. What the
 * clear needs is a SETTLE AFTER IT, before anything is typed. With no gap the
 * escapes and the text land in the same read and the clear is lost entirely,
 * which is what turned a wrap into `sho/wrap`. Callers must wait; see
 * CLEAR_GAP_MS in send.ts, which owns that timing for every caller.
 *
 * Called unconditionally on the wrap path, whatever the pane's status. On a
 * `working` pane the first Esc interrupts the turn, and on one blocked at a
 * permission prompt it dismisses the prompt ("Esc to cancel"). Both are
 * acceptable where this is used — a session being wrapped is a session being
 * retired, and neither outcome destroys work the wrap is about to write down.
 * Gating on status instead is what left a busy pane's draft in place before.
 */
export async function clearDraft(target: string, execFn: Exec = execAsync): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(
    `${tmux} send-keys -t ${shellQuote(target)} Escape Escape 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok;
}

/**
 * Type text into a live pane, literally.
 *
 * `-l` matters: without it tmux interprets the argument as key names, so a
 * command containing anything resembling a key ("Enter", "C-c") would be sent as
 * that key rather than as characters.
 *
 * Text and submit are separate calls on purpose — see sendEnter.
 */
export async function sendText(
  target: string,
  text: string,
  execFn: Exec = execAsync,
): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(
    `${tmux} send-keys -t ${shellQuote(target)} -l ${shellQuote(text)} 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok;
}

/** Submit what was typed. Always a separate call after a short gap: Claude's
 *  input needs the line to land before the newline, and sending both in one
 *  command is what makes a delivered prompt arrive half-typed. */
export async function sendEnter(target: string, execFn: Exec = execAsync): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(
    `${tmux} send-keys -t ${shellQuote(target)} Enter 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok;
}

export async function killSession(name: string, execFn: Exec = execAsync): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(
    `${tmux} kill-session -t ${shellQuote(name)} 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok;
}

/** tmux resolves `session.pane` against the session's ACTIVE window, not
 *  window 0, so a bare pane index sends to the wrong pane the moment a
 *  session has two windows. Always qualify with the window. */
export function paneTarget(tmuxName: string, windowIndex: number, paneIndex: number): string {
  return `${tmuxName}:${windowIndex}.${paneIndex}`;
}

export interface CreateSessionSpec {
  /** tmux session name — already formatted by formatSessionName. */
  name: string;
  /** Working directory of the first pane. */
  cwd: string;
  /** Program the pane runs. Passed as one shell word, so it may itself be a
   *  command line ("claude 'read .claude/session-packet.md'"). */
  command: string;
  windowName?: string;
}

export interface SplitWindowSpec {
  /** `session`, `session:window`, or `session:window.pane`. */
  target: string;
  cwd: string;
  command: string;
  /** Side-by-side (tmux `-h`) is the default: a work session reads as
   *  plan | implement, left to right. */
  horizontal?: boolean;
}

/** Pure builder, so the argv is testable without a tmux server. */
export function buildCreateSessionCmd(tmux: string, spec: CreateSessionSpec): string {
  const parts = [tmux, "new-session", "-d", "-s", shellQuote(spec.name), "-c", shellQuote(spec.cwd)];
  if (spec.windowName) parts.push("-n", shellQuote(spec.windowName));
  parts.push(shellQuote(spec.command));
  return parts.join(" ");
}

export function buildSplitWindowCmd(tmux: string, spec: SplitWindowSpec): string {
  const orientation = spec.horizontal === false ? "-v" : "-h";
  return [
    tmux,
    "split-window",
    orientation,
    "-t",
    shellQuote(spec.target),
    "-c",
    shellQuote(spec.cwd),
    shellQuote(spec.command),
  ].join(" ");
}

export async function createSession(
  spec: CreateSessionSpec,
  execFn: Exec = execAsync,
): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(buildCreateSessionCmd(tmux, spec), TMUX_TIMEOUT_MS);
  return res.ok;
}

export async function splitWindow(
  spec: SplitWindowSpec,
  execFn: Exec = execAsync,
): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(buildSplitWindowCmd(tmux, spec), TMUX_TIMEOUT_MS);
  return res.ok;
}

/** Pass modifier-key sequences (Shift+Enter, Ctrl+Enter, …) through to the
 *  pane, so REPLs like Claude Code can tell newline from submit. Server-level
 *  (`-g`), so every session we create inherits it.
 *
 *  Safe to call on every startup: `extended-keys on` is a plain set, and while
 *  `-gas terminal-features` does append a duplicate array entry on a repeat
 *  call (verified on 3.7b), tmux merges features per terminal glob so the
 *  duplicate has no effect. */
export async function setExtendedKeys(execFn: Exec = execAsync): Promise<boolean> {
  const tmux = await getTmuxBin(execFn);
  if (!tmux) return false;
  const res = await execFn(
    `${tmux} set-option -g extended-keys on 2>/dev/null && ` +
      `${tmux} set-option -gas terminal-features 'xterm*:extkeys' 2>/dev/null && ` +
      // Claude Code prints "tmux focus-events off - add 'set -g focus-events on'"
      // in every pane it starts in without this, so every session this tool
      // creates opened with a warning about the tool's own tmux setup.
      `${tmux} set-option -g focus-events on 2>/dev/null`,
    TMUX_TIMEOUT_MS,
  );
  return res.ok;
}

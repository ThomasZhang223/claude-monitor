/**
 * Opening a session in a NEW terminal window, leaving the dashboard where it is.
 *
 * The original attach gave the dashboard's own terminal away to tmux until you
 * detached, so watching the board and working in a session were mutually
 * exclusive. Spawning a second window instead means the board stays up on one
 * screen while the session runs on another, and closing that window changes
 * nothing about the session or the dashboard.
 *
 * Two platforms are driven, and each needs its own launch syntax:
 *
 *   - macOS: Terminal.app via `osascript`. It ships with the system, so there is
 *     nothing to detect beyond the platform itself.
 *   - Linux: the first known emulator found on PATH (see `LINUX_TERMINALS`),
 *     or whatever `$CLAUDE_MONITOR_TERMINAL` names. There is no system-wide
 *     "the terminal" here, so this is a search rather than a constant.
 *
 * Anything else falls back to the in-place attach rather than guessing — a wrong
 * guess would open a window that silently is not attached to anything.
 */
import * as fs from "fs";
import * as path from "path";
import { parseClientTty } from "./attach.ts";
import { execAsync, shellQuote, type Exec } from "./exec.ts";
import { getTmuxBin } from "./tmux.ts";

export type TerminalKind = "apple" | "linux" | "unsupported";

export const TERMINAL_APP = "/System/Applications/Utilities/Terminal.app";

/**
 * How each known Linux emulator is told to run one command in a new window.
 *
 * Ordered by preference, not alphabetically: the first entry found on PATH
 * wins. `x-terminal-emulator` is last on purpose — it is Debian's alternatives
 * symlink, so it resolves to one of the others and is only useful when none of
 * them were matched by name.
 *
 * `run` receives an already-shell-quoted command string and returns the full
 * command line to run. Emulators split into two families: those that take the
 * rest of argv verbatim after a separator (`--`, `-e`) and those that want a
 * single string. Both are handled by running `sh -c '<command>'`, which is one
 * shape that every one of them accepts.
 */
export interface LinuxTerminal {
  bin: string;
  run: (quotedCommand: string) => string;
}

export const LINUX_TERMINALS: readonly LinuxTerminal[] = [
  { bin: "ghostty", run: (c) => `ghostty -e sh -c ${c}` },
  { bin: "wezterm", run: (c) => `wezterm start -- sh -c ${c}` },
  { bin: "kitty", run: (c) => `kitty sh -c ${c}` },
  { bin: "alacritty", run: (c) => `alacritty -e sh -c ${c}` },
  { bin: "gnome-terminal", run: (c) => `gnome-terminal -- sh -c ${c}` },
  { bin: "konsole", run: (c) => `konsole -e sh -c ${c}` },
  { bin: "xfce4-terminal", run: (c) => `xfce4-terminal -e sh -c ${c}` },
  { bin: "xterm", run: (c) => `xterm -e sh -c ${c}` },
  { bin: "x-terminal-emulator", run: (c) => `x-terminal-emulator -e sh -c ${c}` },
];

export interface DetectDeps {
  platform?: string;
  exists?: (p: string) => boolean;
  /** PATH, already split. Injected so the emulator search is testable without
   *  installing an emulator. */
  pathDirs?: string[];
  /** `$CLAUDE_MONITOR_TERMINAL` — an explicit override, for a machine whose
   *  emulator this table does not know. */
  override?: string;
}

function pathDirsFrom(deps: DetectDeps): string[] {
  if (deps.pathDirs) return deps.pathDirs;
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

/**
 * Whether a window can be opened, and with what.
 *
 * Deliberately NOT based on `TERM_PROGRAM`. That names the emulator you are in,
 * and tmux overwrites it with `tmux` — which is the situation the dashboard is
 * always in, so keying off it reported "unsupported" every single time. What
 * matters is not what we are running inside, it is what we can open: on macOS
 * that is Terminal.app, which ships with the system; on Linux it is whichever
 * emulator is installed.
 */
export function detectTerminal(deps: DetectDeps = {}): TerminalKind {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  if (platform === "darwin") return exists(TERMINAL_APP) ? "apple" : "unsupported";
  if (platform === "linux") return findLinuxTerminal(deps) ? "linux" : "unsupported";
  return "unsupported";
}

/**
 * The emulator to drive on this machine, or null if none is installed.
 *
 * An override containing `{}` is a full command template — the placeholder is
 * replaced with the shell-quoted command — so a machine running something this
 * table has never heard of is still one env var away from working. An override
 * without `{}` names an entry in the table, which is the common case (two known
 * emulators installed, and a preference between them).
 */
export function findLinuxTerminal(deps: DetectDeps = {}): LinuxTerminal | null {
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const dirs = pathDirsFrom(deps);
  const onPath = (bin: string) => dirs.some((d) => exists(path.join(d, bin)));

  const override = deps.override ?? process.env.CLAUDE_MONITOR_TERMINAL;
  if (override && override.trim()) {
    const spec = override.trim();
    if (spec.includes("{}")) {
      return { bin: spec, run: (c) => spec.split("{}").join(c) };
    }
    const known = LINUX_TERMINALS.find((t) => t.bin === spec);
    if (known) return onPath(known.bin) ? known : null;
    // An unknown bare binary: run it with `-e`, the flag the great majority of
    // emulators accept. Better than refusing outright, and `{}` is documented
    // for the ones where it is wrong.
    return onPath(spec) ? { bin: spec, run: (c) => `${spec} -e sh -c ${c}` } : null;
  }

  return LINUX_TERMINALS.find((t) => onPath(t.bin)) ?? null;
}

/** Escape a string for embedding in an AppleScript double-quoted literal. */
export function appleScriptEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * `osascript` argv that opens a new window running the attach.
 *
 * `do script` with no target window opens a new window rather than a tab, which
 * is what makes this a second place to work rather than a hidden tab behind the
 * dashboard. The `activate` is separate and second: raising Terminal before the
 * window exists focuses whatever was last in front instead.
 */
export function openWindowArgs(tmuxBin: string, sessionName: string): string[] {
  const command = appleScriptEscape(`${tmuxBin} attach -t ${shellSingleQuote(sessionName)}`);
  return [
    "-e",
    `tell application "Terminal" to do script "${command}"`,
    "-e",
    'tell application "Terminal" to activate',
  ];
}

/** Session names are sanitised before they reach tmux, but the quoting is here
 *  anyway: this string ends up inside a shell command inside an AppleScript
 *  string, and two layers of quoting is where things go wrong quietly. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

/**
 * The window title a Linux attach window is given.
 *
 * macOS raises a window by looking up its tty through Terminal.app's scripting
 * dictionary. X11 has no equivalent — there is no portable tty-to-window map —
 * so the window is instead *labelled* on the way out and found again by that
 * label. Prefixed so it can never collide with an unrelated window that happens
 * to be named after a tmux session.
 */
export function linuxWindowTitle(sessionName: string): string {
  return `claude-monitor: ${sessionName}`;
}

/**
 * The shell command a Linux emulator is asked to run.
 *
 * The OSC 0 sequence sets the title *before* tmux takes the terminal over.
 * tmux's own `set-titles` is off by default, so a title set here survives for
 * the life of the window, which is what makes `raiseLinuxWindowCommand` able to
 * find it later. `exec` replaces the shell so the window closes on detach
 * rather than dropping to a bare prompt.
 */
export function linuxAttachCommand(tmuxBin: string, sessionName: string): string {
  const title = linuxWindowTitle(sessionName);
  return `printf '\\033]0;%s\\007' ${shellQuote(title)}; exec ${tmuxBin} attach -t ${shellQuote(sessionName)}`;
}

/** `xdotool` invocation that raises the window opened for this session, and
 *  prints nothing unless it found one — the caller reads the exit status. */
export function raiseLinuxWindowCommand(sessionName: string): string {
  const title = linuxWindowTitle(sessionName);
  return `xdotool search --name ${shellQuote(`^${escapeRegex(title)}$`)} windowactivate %1`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface OpenResult {
  ok: boolean;
  /** Worth showing even on success — notably that a window is already attached. */
  note?: string;
  error?: string;
}

export interface OpenDeps {
  exec?: Exec;
  detect?: DetectDeps;
}

/**
 * Open the session in its own terminal window — or, if one is already
 * attached, raise that window instead of opening a duplicate.
 *
 * A duplicate is worse than it sounds: tmux clamps a shared session to the
 * smallest attached client's size, so a second window on the same session
 * shrinks both. Raising the existing one avoids that entirely rather than
 * just reporting it.
 */
export async function openInNewTerminal(
  sessionName: string,
  deps: OpenDeps = {},
): Promise<OpenResult> {
  const exec = deps.exec ?? execAsync;
  const kind = detectTerminal(deps.detect);

  if (kind === "unsupported") {
    return {
      ok: false,
      error: "cannot open a terminal window here - press a to attach in place instead",
    };
  }

  const tmux = await getTmuxBin(exec);
  if (!tmux) return { ok: false, error: "tmux is not installed" };

  const clients = await exec(
    `${tmux} list-clients -t ${shellSingleQuote(sessionName)} -F '#{client_tty}' 2>/dev/null`,
    2000,
  );
  const tty = clients.ok ? parseClientTty(clients.stdout) : null;

  if (kind === "linux") return openLinux(sessionName, tmux, Boolean(tty), exec, deps.detect ?? {});

  if (tty) {
    const raiseArgs = raiseWindowArgs(tty).map((a) => shellSingleQuote(a)).join(" ");
    const raised = await exec(`osascript ${raiseArgs}`, 10_000);
    if (raised.ok && raised.stdout.trim() === "true") {
      return { ok: true, note: "already open - switched to it" };
    }
    // Stale tty (the window closed without detaching) or the raise itself
    // failed: fall through to opening a new window, same as the never-attached
    // case below.
  }

  const args = openWindowArgs(tmux, sessionName).map((a) => shellSingleQuote(a)).join(" ");
  const res = await exec(`osascript ${args}`, 10_000);
  if (!res.ok) {
    return { ok: false, error: `could not open a terminal window: ${firstLine(res.stderr)}` };
  }
  return { ok: true };
}

/**
 * The Linux half of `openInNewTerminal`.
 *
 * Split out because the "already attached" branch differs in kind, not just in
 * syntax: `xdotool` is optional and X11-only, so a raise here is best-effort.
 * When it is unavailable the window is NOT re-opened — reporting "already open"
 * and leaving the user to switch windows themselves is strictly better than
 * opening a duplicate client and shrinking the session for both.
 */
async function openLinux(
  sessionName: string,
  tmux: string,
  attached: boolean,
  exec: Exec,
  detect: DetectDeps,
): Promise<OpenResult> {
  if (attached) {
    const raised = await exec(raiseLinuxWindowCommand(sessionName), 5000);
    if (raised.ok) return { ok: true, note: "already open - switched to it" };
    return { ok: true, note: "already open in another window" };
  }

  const term = findLinuxTerminal(detect);
  if (!term) {
    return {
      ok: false,
      error: "cannot open a terminal window here - press a to attach in place instead",
    };
  }

  const command = shellQuote(linuxAttachCommand(tmux, sessionName));
  // `setsid` and not merely `&`: a bare background job stays in this process's
  // process group, and the dashboard's own exit (or a tsx/npx wrapper's) takes
  // the group with it — the window opened, attached, and vanished a second
  // later. Redirecting all three streams matters too, since several emulators
  // hold the parent's stdio open until the window closes, which would otherwise
  // hang the exec for as long as the session is being used.
  const res = await exec(`setsid ${term.run(command)} </dev/null >/dev/null 2>&1 &`, 10_000);
  if (!res.ok) {
    return { ok: false, error: `could not open a terminal window: ${firstLine(res.stderr)}` };
  }
  return { ok: true };
}

/**
 * `osascript` argv that raises an already-attached Terminal window by tty,
 * so re-attaching switches to whatever Space it's already on instead of
 * opening a duplicate.
 *
 * Order matters, confirmed by live testing: two other orderings were tried
 * and rejected first. `set index of w to 1` then `activate` double-jumps —
 * `activate` acts on the application, not a specific window, so if Terminal's
 * current key window differs from the one just reordered, activating visibly
 * hops there first, then to the real target. `set frontmost of w to true`
 * alone fixes the double-hop but only orders the window within Terminal's own
 * stack, leaving it hidden if another app is system-wide frontmost. Doing
 * both, in this order — frontmost first, activate second — switches Spaces,
 * un-minimizes, and comes in front of other apps with no detour, and needs no
 * System Events/Accessibility permission.
 */
export function raiseWindowArgs(tty: string): string[] {
  const escaped = appleScriptEscape(tty);
  const lines = [
    'tell application "Terminal"',
    "set found to false",
    "repeat with w in windows",
    "repeat with t in tabs of w",
    `if tty of t is "${escaped}" then`,
    "set frontmost of w to true",
    "set found to true",
    "exit repeat",
    "end if",
    "end repeat",
    "if found then exit repeat",
    "end repeat",
    "if found then activate",
    "return found",
    "end tell",
  ];
  return lines.flatMap((line) => ["-e", line]);
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "unknown error";
}

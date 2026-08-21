/**
 * Opening a session in a NEW terminal window, leaving the dashboard where it is.
 *
 * The original attach gave the dashboard's own terminal away to tmux until you
 * detached, so watching the board and working in a session were mutually
 * exclusive. Spawning a second window instead means the board stays up on one
 * screen while the session runs on another, and closing that window changes
 * nothing about the session or the dashboard.
 *
 * This is macOS Terminal.app only, on purpose: it is what is installed here, and
 * every emulator needs its own launch syntax. Anything else falls back to the
 * in-place attach rather than guessing — a wrong guess would open a window that
 * silently is not attached to anything.
 */
import * as fs from "fs";
import { parseClientTty } from "./attach.ts";
import { execAsync, type Exec } from "./exec.ts";
import { getTmuxBin } from "./tmux.ts";

export type TerminalKind = "apple" | "unsupported";

export const TERMINAL_APP = "/System/Applications/Utilities/Terminal.app";

export interface DetectDeps {
  platform?: string;
  exists?: (p: string) => boolean;
}

/**
 * Whether a window can be opened, and with what.
 *
 * Deliberately NOT based on `TERM_PROGRAM`. That names the emulator you are in,
 * and tmux overwrites it with `tmux` — which is the situation the dashboard is
 * always in, so keying off it reported "unsupported" every single time. What
 * matters is not what we are running inside, it is what we can open: on macOS
 * that is Terminal.app, which ships with the system.
 */
export function detectTerminal(deps: DetectDeps = {}): TerminalKind {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  if (platform !== "darwin") return "unsupported";
  return exists(TERMINAL_APP) ? "apple" : "unsupported";
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

  if (detectTerminal(deps.detect) !== "apple") {
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

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "unknown error";
}

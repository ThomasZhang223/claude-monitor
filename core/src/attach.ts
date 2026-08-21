/**
 * Handing the terminal to tmux and taking it back, and tearing a session down.
 *
 * Attaching from inside a TUI that already owns the terminal is not just a
 * keybinding: Ink is holding the alternate screen and raw mode, and tmux needs
 * both back. The sequence below is the one pattern in the prior art known to
 * work, and the `finally` is what stops a failed attach from leaving the
 * terminal unusable.
 */
import { spawnSync } from "child_process";
import { execAsync, shellQuote, type Exec } from "./exec.ts";
import { append as appendHistory, type HistoryEntry } from "./history.ts";
import { clearRecap } from "./recap.ts";
import { getTmuxBin } from "./tmux.ts";

const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

/** First `client_tty` in `list-clients -F` output, or null when nothing is
 *  attached. */
export function parseClientTty(stdout: string): string | null {
  const first = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first ?? null;
}

/**
 * The terminal this monitor is being watched through.
 *
 * `switch-client` with no `-c` moves tmux's *best guess* at the current client,
 * and when the monitor's own session has no client attached — a detached session,
 * as in the smoke test — that guess is somebody else's terminal. Observed doing
 * exactly that: two unrelated attached clients were yanked onto a session the
 * monitor had just created. So the client is always named explicitly, and when
 * there is no client of our own we refuse rather than move one at random.
 */
async function ourClientTty(tmux: string, exec: Exec): Promise<string | null> {
  const pane = process.env.TMUX_PANE;
  if (!pane) return null;
  const session = await exec(
    `${tmux} display-message -p -t ${shellQuote(pane)} '#{session_name}' 2>/dev/null`,
    2000,
  );
  const name = session.ok ? session.stdout.trim() : "";
  if (!name) return null;
  const clients = await exec(
    `${tmux} list-clients -t ${shellQuote(name)} -F '#{client_tty}' 2>/dev/null`,
    2000,
  );
  return clients.ok ? parseClientTty(clients.stdout) : null;
}

/**
 * Attach, blocking until the user detaches.
 *
 * When the dashboard is itself running inside tmux, `attach-session` fails with
 * "sessions should be nested with care" and refuses. `switch-client` is the
 * correct call there, and it returns immediately rather than blocking — the
 * outer tmux is already attached, we are only moving it.
 */
export async function attachSession(
  name: string,
  exec: Exec = execAsync,
): Promise<string | null> {
  const tmux = await getTmuxBin(exec);
  if (!tmux) return "tmux is not installed";

  const nested = Boolean(process.env.TMUX);

  if (nested) {
    // No terminal handoff needed: the client stays where it is, we only point it
    // at another session — and only ever the client watching us.
    const client = await ourClientTty(tmux, exec);
    if (!client) {
      return "no terminal is attached to this dashboard's tmux session, so there is nothing to switch";
    }
    const res = spawnSync(tmux, ["switch-client", "-c", client, "-t", name], {
      stdio: "inherit",
    });
    return res.status === 0 ? null : `could not switch to ${name}`;
  }

  process.stdout.write(CURSOR_SHOW);
  process.stdout.write(ALT_LEAVE);
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);

  let err: string | null = null;
  try {
    const res = spawnSync(tmux, ["attach-session", "-t", name], { stdio: "inherit" });
    if (res.status !== 0 && res.error) err = res.error.message;
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  } finally {
    // Always restore, even on a failed attach: leaving raw mode off and the
    // alternate screen exited would leave the dashboard unusable.
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
    process.stdout.write(ALT_ENTER);
    process.stdout.write(CURSOR_HIDE);
  }
  return err;
}

/**
 * Kill a session's tmux side only.
 *
 * The worktree and branch are deliberately left alone. Removing a worktree that
 * has uncommitted work in it is unrecoverable, and git cleanup already has a
 * dedicated flow; conflating the two would make a single keystroke capable of
 * destroying work.
 */
export async function killSession(
  name: string,
  journal: Omit<HistoryEntry, "at" | "event">,
  exec: Exec = execAsync,
): Promise<string | null> {
  const tmux = await getTmuxBin(exec);
  if (!tmux) return "tmux is not installed";
  const res = await exec(`${tmux} kill-session -t ${shellQuote(name)}`, 5000);
  if (!res.ok) return `could not kill ${name}`;
  appendHistory({ ...journal, at: Date.now(), event: "killed" });
  // The recap file has no owner once the session is gone. A stale one is already
  // ignored on read, so this is hygiene rather than correctness.
  clearRecap(name);
  return null;
}

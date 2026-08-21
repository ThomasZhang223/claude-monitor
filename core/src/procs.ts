/**
 * The process tree, and the pid-based mapping from a tmux pane to the Claude
 * process running inside it.
 *
 * One `ps` per tick serves every pane on the dashboard. Shelling out per pane
 * would multiply the cost of the cheapest poll in the loop by the number of
 * sessions, for no new information.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { ClaudeSession } from "./model.ts";

const execFileAsync = promisify(execFile);

/** pid -> ppid, the whole machine's process table. */
export type PidMap = Map<number, number>;
/** ppid -> its direct children. */
export type ProcTree = Map<number, number[]>;

/** Seam for the one command this module runs. */
/** argv-based, deliberately distinct from exec.ts's shell-string `Exec`: `ps` takes
 *  fixed arguments and never needs a shell, so there is nothing to quote. */
export type PsExec = (cmd: string, args: readonly string[]) => Promise<string>;

const realExec: PsExec = async (cmd, args) => {
  // maxBuffer default is comfortable for ~1000 processes at two columns, but
  // raise it so a busy machine cannot make the whole tick throw.
  const { stdout } = await execFileAsync(cmd, [...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

/**
 * Parse `ps -ax -o pid,ppid`.
 *
 * Both columns are right-aligned and therefore arrive with leading whitespace,
 * and the first line is the `PID PPID` header. Splitting on runs of whitespace
 * after trimming handles both; unparseable lines are dropped rather than
 * throwing, since a truncated final line must not lose the other 1000 rows.
 */
export function parsePsOutput(stdout: string): PidMap {
  const map: PidMap = new Map();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    // Rejects the header row ("PID"/"PPID" are NaN) with no string matching.
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    map.set(pid, ppid);
  }
  return map;
}

/** Invert pid->ppid into ppid->children for downward traversal. */
export function buildTree(pidToPpid: PidMap): ProcTree {
  const tree: ProcTree = new Map();
  for (const [pid, ppid] of pidToPpid) {
    const kids = tree.get(ppid);
    if (kids) kids.push(pid);
    else tree.set(ppid, [pid]);
  }
  return tree;
}

/**
 * Every transitive descendant of `pid`, breadth-first so nearer processes come
 * first.
 *
 * `ps` output is a non-atomic snapshot: pids recycle and a parent can be
 * recorded after its child was reparented, which can produce a cycle that does
 * not exist on the real machine. The visited set makes that a truncated walk
 * instead of a hung dashboard.
 */
export function descendantsOf(pid: number, tree: ProcTree): number[] {
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  const queue: number[] = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of tree.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * The Claude process belonging to a tmux pane, or null.
 *
 * A pane's `pane_pid` is the pane's *shell*, never Claude, so the pane pid
 * itself is checked first and then all of its descendants — Claude is typically
 * a grandchild (shell -> launcher/node wrapper -> claude).
 *
 * This is pid-based and not cwd-based on purpose. Matching on cwd cannot work:
 * a work session's plan pane and implement pane sit in the SAME worktree, so
 * they share one cwd and one transcript directory. Only the process tree tells
 * the two apart, which makes this function the thing that gives each pane its
 * own status and its own recap.
 *
 * Breadth-first order means the nearest matching Claude wins, so a pane that
 * spawned a nested `claude` reports the one the user is actually talking to.
 */
export function resolvePaneClaude(
  panePid: number,
  claudeSessionsByPid: Map<number, ClaudeSession>,
  tree: ProcTree,
): ClaudeSession | null {
  const direct = claudeSessionsByPid.get(panePid);
  if (direct) return direct;
  for (const pid of descendantsOf(panePid, tree)) {
    const found = claudeSessionsByPid.get(pid);
    if (found) return found;
  }
  return null;
}

/** One `ps` for the whole tick. Returns an empty map rather than throwing, so a
 *  transient failure degrades to "no Claude resolved" for a single frame. */
export async function snapshotPs(exec: PsExec = realExec): Promise<PidMap> {
  try {
    return parsePsOutput(await exec("ps", ["-ax", "-o", "pid,ppid"]));
  } catch {
    return new Map();
  }
}

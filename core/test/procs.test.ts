import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTree,
  descendantsOf,
  parsePsOutput,
  resolvePaneClaude,
  snapshotPs,
  type ProcTree,
} from "../src/procs.ts";
import type { ClaudeSession } from "../src/model.ts";

/** Verbatim shape of `ps -ax -o pid,ppid` on macOS: a header line and
 *  right-aligned, space-padded columns. */
const REAL_PS = [
  "  PID  PPID",
  "    1     0",
  "  380     1",
  "21563   380",
  "21598 21563",
  "21636 21563",
  "10198 85646",
  "10199 10198",
  "",
].join("\n");

function tree(pairs: [number, number][]): ProcTree {
  return buildTree(new Map(pairs));
}

function claude(pid: number, over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid,
    sessionId: `session-${pid}`,
    cwd: "/Users/you/Documents/code/myrepo",
    rawStatus: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    name: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// parsePsOutput
// ---------------------------------------------------------------------------

test("parsePsOutput: handles the header and the right-aligned padding of real ps output", () => {
  const map = parsePsOutput(REAL_PS);
  assert.equal(map.size, 7, "header and trailing blank line are not entries");
  assert.equal(map.get(1), 0);
  assert.equal(map.get(380), 1);
  assert.equal(map.get(21598), 21563);
  assert.equal(map.get(10199), 10198);
  assert.equal(map.has(NaN), false);
});

test("parsePsOutput: drops junk lines rather than throwing", () => {
  // A snapshot can be truncated mid-line; losing one row must not lose the
  // other thousand.
  const map = parsePsOutput(["  PID  PPID", "  100     1", "  gar bage", "  20", "  2", "  101   10"].join("\n"));
  assert.deepEqual([...map.entries()], [
    [100, 1],
    [101, 10],
  ]);
});

test("parsePsOutput: empty input is an empty map", () => {
  assert.equal(parsePsOutput("").size, 0);
});

// ---------------------------------------------------------------------------
// buildTree / descendantsOf
// ---------------------------------------------------------------------------

test("buildTree: inverts pid->ppid into ppid->children", () => {
  const t = tree([
    [2, 1],
    [3, 1],
    [4, 2],
  ]);
  assert.deepEqual(t.get(1), [2, 3]);
  assert.deepEqual(t.get(2), [4]);
  assert.equal(t.get(4), undefined);
});

test("descendantsOf: walks a multi-level tree breadth-first", () => {
  //   100 -> 200 -> 300 -> 400
  //       -> 201
  const t = tree([
    [200, 100],
    [201, 100],
    [300, 200],
    [400, 300],
    [999, 1],
  ]);
  assert.deepEqual(descendantsOf(100, t), [200, 201, 300, 400]);
  assert.deepEqual(descendantsOf(300, t), [400]);
  assert.deepEqual(descendantsOf(400, t), [], "a leaf has no descendants");
  assert.deepEqual(descendantsOf(12345, t), [], "an unknown pid has no descendants");
});

test("descendantsOf: a cycle in the snapshot truncates instead of hanging", () => {
  // `ps` is not atomic: pids recycle and a reparented child can be recorded
  // against an older parent, producing a loop that does not exist for real.
  const t = tree([
    [200, 100],
    [300, 200],
    [100, 300], // closes the loop back to the starting pid
    [400, 300],
  ]);
  const found = descendantsOf(100, t);
  assert.deepEqual(found, [200, 300, 400]);
  assert.equal(found.includes(100), false, "the start pid is never its own descendant");

  // A self-parent, the other artifact pid reuse can produce: pid 10 recorded
  // as its own ppid. Without the visited set this is an infinite loop on the
  // very first hop.
  const t2 = tree([
    [10, 10],
    [11, 10],
  ]);
  assert.deepEqual(descendantsOf(10, t2), [11]);
});

// ---------------------------------------------------------------------------
// resolvePaneClaude
// ---------------------------------------------------------------------------

test("resolvePaneClaude: finds Claude as a grandchild of the pane pid", () => {
  // pane_pid is the pane's shell, never Claude, so the walk has to go down:
  // 21563 (zsh) -> 21590 (node wrapper) -> 21598 (claude).
  const t = tree([
    [21590, 21563],
    [21598, 21590],
  ]);
  const byPid = new Map([[21598, claude(21598)]]);
  assert.equal(resolvePaneClaude(21563, byPid, t)?.pid, 21598);
});

test("resolvePaneClaude: null when no descendant of the pane is a Claude session", () => {
  const t = tree([
    [21590, 21563],
    [21598, 21590],
  ]);
  // A plain shell pane, or a pane whose Claude has exited.
  assert.equal(resolvePaneClaude(21563, new Map(), t), null);
  assert.equal(resolvePaneClaude(21563, new Map([[99999, claude(99999)]]), t), null);
});

test("resolvePaneClaude: matches the pane pid itself when Claude is the pane process", () => {
  const byPid = new Map([[21598, claude(21598)]]);
  assert.equal(resolvePaneClaude(21598, byPid, tree([]))?.pid, 21598);
});

test("resolvePaneClaude: pid resolution is what tells two panes of one worktree apart", () => {
  // The reason this is not cwd-based: a work session's plan pane and implement
  // pane live in the SAME worktree, so cwd is identical for both and cannot
  // distinguish them. Only the process tree can.
  const t = tree([
    [21598, 21563], // plan pane shell -> claude
    [21636, 21600], // implement pane shell -> claude
  ]);
  const sameCwd = "/Users/you/Documents/code/myrepo_plt-1637";
  const byPid = new Map([
    [21598, claude(21598, { cwd: sameCwd, sessionId: "plan" })],
    [21636, claude(21636, { cwd: sameCwd, sessionId: "impl" })],
  ]);
  assert.equal(resolvePaneClaude(21563, byPid, t)?.sessionId, "plan");
  assert.equal(resolvePaneClaude(21600, byPid, t)?.sessionId, "impl");
});

test("resolvePaneClaude: the nearest Claude wins over a nested one", () => {
  const t = tree([
    [200, 100],
    [300, 200],
  ]);
  const byPid = new Map([
    [200, claude(200, { sessionId: "outer" })],
    [300, claude(300, { sessionId: "inner" })],
  ]);
  assert.equal(resolvePaneClaude(100, byPid, t)?.sessionId, "outer");
});

// ---------------------------------------------------------------------------
// snapshotPs
// ---------------------------------------------------------------------------

test("snapshotPs: runs ps exactly once per tick and returns the parsed map", async () => {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const map = await snapshotPs(async (cmd, args) => {
    calls.push({ cmd, args });
    return REAL_PS;
  });
  assert.deepEqual(calls, [{ cmd: "ps", args: ["-ax", "-o", "pid,ppid"] }]);
  assert.equal(map.get(21598), 21563);
});

test("snapshotPs: a failing ps degrades to an empty map for one frame", async () => {
  const map = await snapshotPs(async () => {
    throw new Error("ps exploded");
  });
  assert.equal(map.size, 0);
});

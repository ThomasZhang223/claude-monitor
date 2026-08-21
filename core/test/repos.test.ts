import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  branchFor,
  currentBranchCommand,
  ensureWorktree,
  fastForwardMain,
  ffMainCommands,
  isGitCapable,
  isGitRepo,
  listWorktrees,
  parseWorktreeList,
  worktreeAddCommand,
  worktreePathFor,
} from "../src/repos.ts";
import type { Exec, ExecResult } from "../src/exec.ts";
import { ALPHA, GENERAL } from "./fixtures/boxes.ts";

const PREFIX = "cc";

/** An Exec that replays canned results and records every command it saw. */
function fakeExec(handlers: Array<[RegExp, Partial<ExecResult>]>): Exec & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string) => {
    calls.push(cmd);
    for (const [pattern, result] of handlers) {
      if (pattern.test(cmd)) return { ok: true, stdout: "", stderr: "", ...result };
    }
    return { ok: true, stdout: "", stderr: "" };
  }) as Exec & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("no emitted git command ever recurses submodules", () => {
  // A repo whose primary carries dirty submodule pointers would have every
  // fetch/merge fight recursion into them - this is the guard for that whole
  // class of mistake.
  const commands = [
    ffMainCommands("/repo").fetch,
    ffMainCommands("/repo").merge,
    currentBranchCommand("/repo"),
    worktreeAddCommand("/repo", "b", "/target"),
  ];
  for (const cmd of commands) {
    assert.ok(!cmd.includes("--recurse-submodules"), `no recursion in: ${cmd}`);
    assert.ok(!cmd.includes("--recurse"), `no recursion in: ${cmd}`);
  }
});

test("ff uses merge --ff-only, never pull", () => {
  const { merge } = ffMainCommands("/repo");
  assert.match(merge, /merge --ff-only origin\/main/);
  assert.ok(!merge.includes("pull"), "pull can create a merge commit on main");
});

test("new worktrees branch from origin/main, not local HEAD", () => {
  // A stale primary must not silently seed a session with old code.
  const cmd = worktreeAddCommand("/repo", "cc/x", "/target");
  assert.match(cmd, /origin\/main$/);
});

test("branchFor / worktreePathFor follow the configured branch prefix and box path", () => {
  assert.equal(branchFor("plt1836", PREFIX), "cc/plt1836");
  assert.equal(branchFor("plt1836", "team/feature"), "team/feature/plt1836");
  assert.equal(worktreePathFor(ALPHA, "plt1836"), path.join(path.dirname(ALPHA.path!), "alpha_plt1836"));
  assert.equal(worktreePathFor(GENERAL, "anything"), null);
});

test("fastForwardMain: skips (does not fail) when the primary is on another branch", async () => {
  // The primary is deliberately used for `gh pr checkout` review, so sitting on
  // someone else's branch is normal and must not read as an error.
  const exec = fakeExec([
    [/fetch origin main/, { ok: true }],
    [/branch --show-current/, { stdout: "someone-else/feature/thing\n" }],
  ]);
  const outcome = await fastForwardMain(ALPHA, exec);
  assert.equal(outcome.kind, "skipped");
  assert.match((outcome as { reason: string }).reason, /someone-else/);
  assert.ok(
    !exec.calls.some((c) => c.includes("merge")),
    "must not attempt the merge when off main",
  );
});

test("fastForwardMain: skips on a detached HEAD with a readable reason", async () => {
  const exec = fakeExec([[/branch --show-current/, { stdout: "\n" }]]);
  const outcome = await fastForwardMain(ALPHA, exec);
  assert.equal(outcome.kind, "skipped");
  assert.match((outcome as { reason: string }).reason, /detached/);
});

test("fastForwardMain: merges only when actually on main", async () => {
  const exec = fakeExec([[/branch --show-current/, { stdout: "main\n" }]]);
  const outcome = await fastForwardMain(ALPHA, exec);
  assert.equal(outcome.kind, "ok");
  assert.ok(exec.calls.some((c) => c.includes("merge --ff-only")));
});

test("fastForwardMain: a failed fetch is a failure, not a silent skip", async () => {
  const exec = fakeExec([[/fetch origin main/, { ok: false, stderr: "could not resolve host\n" }]]);
  const outcome = await fastForwardMain(ALPHA, exec);
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /could not resolve host/);
});

test("fastForwardMain: a box with no folder is a skip, not a failure", async () => {
  const outcome = await fastForwardMain(GENERAL, fakeExec([]));
  assert.equal(outcome.kind, "skipped");
});

test("parseWorktreeList: pulls paths out of porcelain output", () => {
  const stdout = [
    "worktree /repo/alpha",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree /repo/alpha_plt1836",
    "HEAD def456",
    "branch refs/heads/cc/plt1836",
    "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(stdout), ["/repo/alpha", "/repo/alpha_plt1836"]);
});

test("listWorktrees: excludes the primary checkout", async () => {
  const exec = fakeExec([
    [/worktree list/, { stdout: `worktree ${ALPHA.path}\n\nworktree ${ALPHA.path}_plt1836\n` }],
  ]);
  const found = await listWorktrees(ALPHA, exec);
  assert.deepEqual(found, [`${ALPHA.path}_plt1836`]);
});

test("listWorktrees: a box with no folder has no worktrees", async () => {
  assert.deepEqual(await listWorktrees(GENERAL, fakeExec([])), []);
});

test("ensureWorktree: adopts an existing worktree when asked to", async () => {
  // The post-reboot recovery path: tmux died and took every session with it,
  // but the worktrees are still on disk.
  const exec = fakeExec([]);
  const outcome = await ensureWorktree(ALPHA, "plt1836", PREFIX, { adopt: true, exists: () => true }, exec);
  assert.equal(outcome.kind, "adopted");
  assert.ok(!exec.calls.some((c) => c.includes("worktree add")), "adopting creates nothing");
});

test("ensureWorktree: refuses an existing worktree when not adopting", async () => {
  const outcome = await ensureWorktree(
    ALPHA,
    "plt1836",
    PREFIX,
    { adopt: false, exists: () => true },
    fakeExec([]),
  );
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /already exists/);
});

test("ensureWorktree: creates when nothing is there", async () => {
  const exec = fakeExec([]);
  const outcome = await ensureWorktree(
    ALPHA,
    "plt1836",
    PREFIX,
    { adopt: false, exists: () => false },
    exec,
  );
  assert.equal(outcome.kind, "created");
  assert.equal((outcome as { branch: string }).branch, "cc/plt1836");
  assert.ok(exec.calls.some((c) => c.includes("worktree add")));
});

test("ensureWorktree: surfaces git's own error text on failure", async () => {
  const exec = fakeExec([
    [/worktree add/, { ok: false, stderr: "fatal: invalid reference: origin/main\n" }],
  ]);
  const outcome = await ensureWorktree(
    ALPHA,
    "x",
    PREFIX,
    { adopt: false, exists: () => false },
    exec,
  );
  assert.equal(outcome.kind, "failed");
  assert.match((outcome as { reason: string }).reason, /invalid reference/);
});

test("ensureWorktree: a box with no folder fails rather than building a path off null", async () => {
  const outcome = await ensureWorktree(GENERAL, "x", PREFIX, { adopt: false, exists: () => true }, fakeExec([]));
  assert.equal(outcome.kind, "failed");
});

// ---------------------------------------------------------------------------
// isGitRepo / isGitCapable
// ---------------------------------------------------------------------------

test("isGitRepo / isGitCapable: true only for a real .git directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-repo-"));
  fs.mkdirSync(path.join(dir, ".git"));
  assert.equal(isGitRepo(dir), true);
  assert.equal(isGitCapable({ id: "x", label: "x", color: "#fff", path: dir }), true);
});

test("isGitRepo / isGitCapable: false for a plain folder, and for no folder at all", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-plain-"));
  assert.equal(isGitRepo(dir), false);
  assert.equal(isGitCapable({ id: "x", label: "x", color: "#fff", path: dir }), false);
  assert.equal(isGitCapable(GENERAL), false);
});

test("isGitRepo: a nonexistent path is false, not a thrown error", () => {
  assert.equal(isGitRepo("/no/such/directory/at/all"), false);
});

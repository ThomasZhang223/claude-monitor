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
  worktreeCollectionDir,
  worktreeFolderProblem,
  worktreeRootProblem,
  worktreeRootWritable,
  defaultWorktreeRoot,
  type DirProbe,
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

test("worktreePathFor: worktreeRoot collects worktrees instead of scattering siblings", () => {
  // The default drops them beside the box folder. For an umbrella checkout
  // that is among the other repos it coordinates, and for a box on ~/src it is
  // the home directory itself.
  const box = { ...ALPHA, path: "/home/me/repos", worktreeRoot: "/home/me/worktrees" };
  assert.equal(worktreePathFor(box, "plt1836"), "/home/me/worktrees/repos_plt1836");
});

test("worktreePathFor: an absent worktreeRoot keeps the sibling default", () => {
  const box = { ...ALPHA, worktreeRoot: null };
  assert.equal(worktreePathFor(box, "x"), path.join(path.dirname(ALPHA.path!), "alpha_x"));
});

test("worktreeAddCommand: creates the root before git needs it", () => {
  // `git worktree add` makes the leaf directory but not the path above it, so
  // the first session in a box with a fresh worktreeRoot would otherwise fail
  // on nothing worse than an absent folder.
  const cmd = worktreeAddCommand("/repo", "cc/x", "/home/me/worktrees/repos_x");
  assert.match(cmd, /^mkdir -p '\/home\/me\/worktrees' && git -C/);
});

// ---------------------------------------------------------------------------
// Worktree root
// ---------------------------------------------------------------------------

test("worktreeRootProblem: a sibling collection directory is fine", () => {
  assert.equal(worktreeRootProblem("/home/me/worktrees", "/home/me/repos/app"), null);
});

test("worktreeRootProblem: relative paths are refused", () => {
  // A relative root would resolve against whatever the dashboard's working
  // directory happened to be, which is not a thing the config author controls.
  assert.match(worktreeRootProblem("worktrees", "/home/me/app") ?? "", /absolute/);
});

test("worktreeRootProblem: the filesystem root is not a worktree root", () => {
  assert.match(worktreeRootProblem("/", "/home/me/app") ?? "", /filesystem root/);
});

test("worktreeRootProblem: the box's own folder is refused", () => {
  assert.match(worktreeRootProblem("/home/me/app", "/home/me/app") ?? "", /own folder/);
});

test("worktreeRootProblem: a root inside the repo is refused", () => {
  // git accepts a worktree target under the checkout, and the result is a repo
  // containing copies of itself which git then reports as untracked.
  assert.match(worktreeRootProblem("/home/me/app/wt", "/home/me/app") ?? "", /inside/);
});

test("worktreeRootProblem: a sibling whose name merely starts the same is fine", () => {
  // String-prefix containment would call /home/me/app-worktrees "inside"
  // /home/me/app. Path segments are what matter, not characters.
  assert.equal(worktreeRootProblem("/home/me/app-worktrees", "/home/me/app"), null);
});

/** A probe over a fixed map: anything unlisted is missing. */
const probeOf = (states: Record<string, "writable" | "blocked">): DirProbe =>
  (dir) => states[dir] ?? "missing";

test("worktreeRootWritable: a root that does not exist yet rides on its nearest ancestor", () => {
  // It is created on first use, so requiring it up front would fail the very
  // first session in a new box.
  const probe = probeOf({ "/home/me": "writable" });
  assert.equal(worktreeRootWritable("/home/me/worktrees/deep", probe), true);
});

test("worktreeRootWritable: a blocked ancestor stops the walk, it is not climbed past", () => {
  // The bug this guards: /home/me is writable, so a walk that treats "blocked"
  // and "missing" alike would climb straight past the read-only directory and
  // call the root fine, and mkdir -p would then fail on first use.
  const probe = probeOf({ "/home/me/ro": "blocked", "/home/me": "writable" });
  assert.equal(worktreeRootWritable("/home/me/ro/wt", probe), false);
});

test("worktreeRootWritable: nothing writable all the way up is false, not a hang", () => {
  assert.equal(worktreeRootWritable("/a/b/c", probeOf({})), false);
});

test("defaultWorktreeRoot: the box folder's own parent, which is where they already go", () => {
  const probe = probeOf({ "/home/me/repos": "writable" });
  assert.equal(defaultWorktreeRoot("/home/me/repos/app", probe), "/home/me/repos");
});

test("defaultWorktreeRoot: null for a box with no folder", () => {
  assert.equal(defaultWorktreeRoot(null, probeOf({})), null);
});

test("defaultWorktreeRoot: null when the parent refuses writes", () => {
  // A dotfiles repo checked out at ~ has /Users (or /home) as its parent, and
  // that is root-owned. Offering it would prefill a path the first session
  // fails on, so the panel offers nothing and says why instead.
  const probe = probeOf({ "/Users": "blocked" });
  assert.equal(defaultWorktreeRoot("/Users/me", probe), null);
});

test("defaultWorktreeRoot: null for a repo at the filesystem root", () => {
  assert.equal(defaultWorktreeRoot("/", probeOf({ "/": "writable" })), null);
});

test("defaultWorktreeRoot: what it returns is always a root worktreePathFor accepts", () => {
  // The prefill and the placement have to agree, or the panel would offer a
  // value that changes where worktrees go the moment it is saved.
  const probe = probeOf({ "/home/me/repos": "writable" });
  const boxPath = "/home/me/repos/app";
  const root = defaultWorktreeRoot(boxPath, probe);
  const box = { ...ALPHA, path: boxPath, worktreeRoot: null };
  assert.equal(worktreePathFor(box, "x"), worktreePathFor({ ...box, worktreeRoot: root }, "x"));
});

// ---------------------------------------------------------------------------
// Worktree collection folder
// ---------------------------------------------------------------------------

const DUCK = {
  ...ALPHA,
  path: "/calder/duck",
  worktreeRoot: "/calder",
  worktreeFolder: "duck_worktrees",
};

test("worktreeCollectionDir: root plus folder is where worktrees collect", () => {
  assert.equal(worktreeCollectionDir(DUCK), "/calder/duck_worktrees");
});

test("worktreePathFor: the worktree lands inside the named folder", () => {
  assert.equal(worktreePathFor(DUCK, "plt1836"), "/calder/duck_worktrees/duck_plt1836");
});

test("worktreePathFor: the leaf keeps its box prefix inside a dedicated folder", () => {
  // Mildly redundant for one box, and it is what lets two boxes share a
  // collection folder without colliding on a slug they both use.
  const goose = { ...DUCK, path: "/calder/goose" };
  assert.equal(worktreePathFor(goose, "plt1836"), "/calder/duck_worktrees/goose_plt1836");
  assert.notEqual(worktreePathFor(goose, "plt1836"), worktreePathFor(DUCK, "plt1836"));
});

test("worktreeCollectionDir: no folder collects straight in the root", () => {
  // Every config written before the folder field existed means exactly this,
  // so it has to keep behaving the way it did.
  assert.equal(worktreeCollectionDir({ ...DUCK, worktreeFolder: null }), "/calder");
  assert.equal(worktreePathFor({ ...DUCK, worktreeFolder: null }, "x"), "/calder/duck_x");
});

test("worktreeCollectionDir: no root at all falls back to the box folder's parent", () => {
  const bare = { ...DUCK, worktreeRoot: null, worktreeFolder: null };
  assert.equal(worktreeCollectionDir(bare), "/calder");
});

test("worktreeCollectionDir: a folder with no root hangs off the parent default", () => {
  assert.equal(worktreeCollectionDir({ ...DUCK, worktreeRoot: null }), "/calder/duck_worktrees");
});

test("worktreeCollectionDir: a box with no folder has nowhere to collect", () => {
  assert.equal(worktreeCollectionDir(GENERAL), null);
});

test("worktreeFolderProblem: one folder name, never a path", () => {
  // A separator would let the folder climb out of the root the author chose,
  // which would make the root field a suggestion rather than a boundary.
  assert.equal(worktreeFolderProblem("duck_worktrees"), null);
  assert.match(worktreeFolderProblem("a/b") ?? "", /not a path/);
  assert.match(worktreeFolderProblem("../escape") ?? "", /not a path/);
  assert.match(worktreeFolderProblem("..") ?? "", /real folder name/);
  assert.match(worktreeFolderProblem(".") ?? "", /real folder name/);
  assert.match(worktreeFolderProblem("") ?? "", /blank/);
  assert.match(worktreeFolderProblem(" pad ") ?? "", /space/);
});

test("worktreeAddCommand: the branch is cut from the box dir, not from the collection folder", () => {
  // The repo git operates on stays the box's own checkout. Only the target
  // moves, so a collection folder cannot change what the branch forks from.
  const target = worktreePathFor(DUCK, "plt1836")!;
  const cmd = worktreeAddCommand(DUCK.path!, branchFor("plt1836", PREFIX), target);
  assert.match(cmd, /git -C '\/calder\/duck' worktree add/);
  assert.match(cmd, /-b 'cc\/plt1836'/);
  assert.match(cmd, /origin\/main$/);
});

test("worktreeAddCommand: the collection folder is created before git needs it", () => {
  const target = worktreePathFor(DUCK, "plt1836")!;
  const cmd = worktreeAddCommand(DUCK.path!, "cc/plt1836", target);
  assert.match(cmd, /^mkdir -p '\/calder\/duck_worktrees' && /);
});

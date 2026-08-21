import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_MODE,
  modelFor,
  paneCommand,
  permissionModeFor,
  spawnSession,
} from "../src/spawn.ts";
import { IMPL_PANE, PLAN_PANE } from "../src/model.ts";
import { resetTmuxBin } from "../src/tmux.ts";
import type { Exec, ExecResult } from "../src/exec.ts";
import { ALPHA, GENERAL } from "./fixtures/boxes.ts";

const PREFIX = "cc";

function fakeExec(handlers: Array<[RegExp, Partial<ExecResult>]> = []): Exec & { calls: string[] } {
  // The tmux binary lookup is memoized across calls, so drop the cache or a
  // previous test's answer leaks into this one.
  resetTmuxBin();
  const calls: string[] = [];
  const fn = (async (cmd: string) => {
    calls.push(cmd);
    for (const [pattern, result] of handlers) {
      if (pattern.test(cmd)) return { ok: true, stdout: "", stderr: "", ...result };
    }
    // Everything that shells out goes through the tmux binary lookup first.
    if (cmd.includes("command -v tmux")) return { ok: true, stdout: "/usr/bin/tmux\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  }) as Exec & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** Everything a spawn touches, stubbed, so no session or worktree is created. */
function stubDeps(exec: Exec) {
  return {
    exec,
    claudeBin: "/bin/claude",
    exists: () => false,
    now: () => 1_700_000_000_000,
  };
}

test("paneCommand: every pane runs in auto permission mode", () => {
  const cmd = paneCommand("/bin/claude", "do a thing", "/bin/zsh");
  assert.equal(PERMISSION_MODE, "auto");
  assert.match(cmd, /--permission-mode auto/);
});

test("modelFor: questions run sonnet at high effort", () => {
  // A question is a lookup or an explanation, not construction: sonnet answers
  // it well and far more cheaply, and high effort is plenty. Single-pane, so
  // pane index shouldn't matter, but the signature still requires one.
  assert.deepEqual(modelFor("q", PLAN_PANE), { model: "sonnet", effort: "high" });
});

test("modelFor: the implementation pane runs sonnet at xhigh", () => {
  // Executing an already-approved plan is mechanical enough that sonnet keeps
  // up with opus, at a fraction of the cost.
  assert.deepEqual(modelFor("work", IMPL_PANE), { model: "sonnet", effort: "xhigh" });
});

test("modelFor: the planning pane runs opus at xhigh effort", () => {
  // Planning is where judgment matters, so it always gets opus.
  assert.deepEqual(modelFor("work", PLAN_PANE), { model: "opus", effort: "xhigh" });
});

test("modelFor: quick and research both pin opus at high effort", () => {
  // Neither has a second pane to catch a cheap model's mistake - a quick
  // session takes a change all the way to a PR by itself, and a research
  // session's whole output is a judgment call. high rather than xhigh because
  // neither is building something large.
  assert.deepEqual(modelFor("quick", 0), { model: "opus", effort: "high" });
  assert.deepEqual(modelFor("research", 0), { model: "opus", effort: "high" });
});

test("permissionModeFor: quick and research boot into auto, like every other single pane", () => {
  assert.equal(permissionModeFor("quick", 0), "auto");
  assert.equal(permissionModeFor("research", 0), "auto");
});

test("paneCommand: pins model and effort only when asked to", () => {
  const pinned = paneCommand("/bin/claude", null, "/bin/zsh", {
    model: "sonnet",
    effort: "xhigh",
  });
  assert.match(pinned, /--model sonnet/);
  assert.match(pinned, /--effort xhigh/);

  const unpinned = paneCommand("/bin/claude", null, "/bin/zsh", { model: null, effort: null });
  assert.ok(!unpinned.includes("--model"), unpinned);
  assert.ok(!unpinned.includes("--effort"), unpinned);
});

test("paneCommand: a null prompt launches Claude with no opening turn", () => {
  // This is what the implementation pane gets. It must not carry a stray pair of
  // empty quotes, which Claude would read as an empty first prompt.
  const cmd = paneCommand("/bin/claude", null, "/bin/zsh");
  assert.match(cmd, /^\/bin\/claude --permission-mode auto; exec \/bin\/zsh -l$/);
  assert.ok(!cmd.includes("''"), cmd);
});

test("paneCommand: a prompt is quoted, so apostrophes survive", () => {
  const cmd = paneCommand("/bin/claude", "it's fine", "/bin/zsh");
  assert.match(cmd, /--permission-mode auto '/);
  assert.ok(cmd.includes("exec /bin/zsh -l"), "still drops to a shell afterwards");
});

test("paneCommand: always drops to a login shell after Claude exits", () => {
  // Without this the last pane closing destroys the whole tmux session, so a
  // stray Ctrl-D would silently delete a session the dashboard is tracking.
  for (const prompt of ["something", null]) {
    assert.match(paneCommand("/bin/claude", prompt, "/bin/zsh"), /; exec \/bin\/zsh -l$/);
  }
});

test("work session: only the left pane is primed, the right comes up blank", async () => {
  const exec = fakeExec([[/branch --show-current/, { stdout: "main\n" }]]);
  const deps = stubDeps(exec);

  const res = await spawnSession(
    { box: ALPHA, mode: "work", label: "two panes", slug: "twopanes", worktree: "new", branchPrefix: PREFIX },
    deps,
  );
  assert.ok(res.ok, res.error ?? "");

  const create = exec.calls.find((c) => c.includes("new-session"))!;
  const split = exec.calls.find((c) => c.includes("split-window"))!;
  assert.ok(create, "created a session");
  assert.ok(split, "split a second pane");

  // Left pane: told which half of the session it is. No packet exists any
  // more - there is nothing per-box to pre-load.
  assert.match(create, /planning half/);
  assert.ok(!create.includes("packet"), create);

  // Right pane: no opening prompt whatsoever. Priming it would spend context on
  // a turn thrown away before there is any plan to implement.
  assert.ok(!split.includes("await"), `right pane must have no opener: ${split}`);
  assert.match(split, /--permission-mode auto/);

  // Left pane boots in plan mode: it should only explore and propose, not edit,
  // until its plan is handed off to the implementation pane.
  assert.match(create, /--permission-mode plan/);
});

test("permissionModeFor: the planning pane of a work session starts in plan mode, everything else in auto", () => {
  assert.equal(permissionModeFor("work", PLAN_PANE), "plan");
  assert.equal(permissionModeFor("work", IMPL_PANE), "auto");
  assert.equal(permissionModeFor("q", PLAN_PANE), "auto");
});

test("spawn: a typed task scopes the opener rather than being appended after it", async () => {
  const exec = fakeExec([[/branch --show-current/, { stdout: "main\n" }]]);
  const deps = stubDeps(exec);
  await spawnSession(
    {
      box: ALPHA,
      mode: "work",
      label: "with extra",
      slug: "withextra",
      worktree: "new",
      branchPrefix: PREFIX,
      extraPrompt: "focus on the retry logic first",
    },
    deps,
  );
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.match(create, /Task: focus on the retry logic first/);
  assert.match(create, /planning half/);
});

test("spawn: no extraPrompt leaves a folder box's opener unchanged", async () => {
  const exec = fakeExec([[/branch --show-current/, { stdout: "main\n" }]]);
  const deps = stubDeps(exec);
  await spawnSession(
    { box: ALPHA, mode: "work", label: "no extra", slug: "noextra", worktree: "new", branchPrefix: PREFIX },
    deps,
  );
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.match(create, /the pane beside you implements\./);
});

test("spawn: a no-folder box's extraPrompt becomes the opener outright, since it otherwise has none", async () => {
  const exec = fakeExec();
  const deps = stubDeps(exec);
  await spawnSession(
    {
      box: GENERAL,
      mode: "work",
      label: "general extra",
      slug: "generalextra",
      worktree: "none",
      branchPrefix: PREFIX,
      extraPrompt: "look into the flaky test",
    },
    deps,
  );
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.match(create, /look into the flaky test/);
});

test("spawn: a no-folder box with no extraPrompt still has no opener at all", async () => {
  const exec = fakeExec();
  const deps = stubDeps(exec);
  await spawnSession(
    { box: GENERAL, mode: "work", label: "general bare", slug: "generalbare", worktree: "none", branchPrefix: PREFIX },
    deps,
  );
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.ok(!create.includes("await"), `no-folder box with no extraPrompt must stay bare: ${create}`);
});

test("spawn: extraPrompt is collapsed to one line before it reaches the pane command", async () => {
  const exec = fakeExec();
  const deps = stubDeps(exec);
  await spawnSession(
    {
      box: GENERAL,
      mode: "q",
      label: "multiline",
      slug: "multiline",
      worktree: "none",
      branchPrefix: PREFIX,
      extraPrompt: "line one\n  line two\t\tline three  ",
    },
    deps,
  );
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.match(create, /line one line two line three/);
});

test("spawn: a questions session pins sonnet/high on its pane", async () => {
  const exec = fakeExec();
  const deps = stubDeps(exec);
  await spawnSession(
    { box: ALPHA, mode: "q", label: "q", slug: "q", worktree: "none", branchPrefix: PREFIX },
    deps,
  );
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.match(create, /--model sonnet/);
  assert.match(create, /--effort high/);
});

test("spawn: a no-folder box's work session pins opus/xhigh on the plan pane, sonnet/xhigh on the impl pane", async () => {
  const exec = fakeExec();
  const deps = stubDeps(exec);
  await spawnSession(
    { box: GENERAL, mode: "work", label: "m", slug: "m", worktree: "none", branchPrefix: PREFIX },
    deps,
  );
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  const split = exec.calls.find((c) => c.includes("split-window"))!;
  assert.match(create, /--model opus/, create);
  assert.match(create, /--effort xhigh/, create);
  assert.match(split, /--model sonnet/, split);
  assert.match(split, /--effort xhigh/, split);
});

test("spawn: a folder box's plan pane pins opus/xhigh, its impl pane pins sonnet/xhigh", async () => {
  const exec = fakeExec([[/branch --show-current/, { stdout: "main\n" }]]);
  const deps = stubDeps(exec);
  await spawnSession(
    { box: ALPHA, mode: "work", label: "h", slug: "h", worktree: "new", branchPrefix: PREFIX },
    deps,
  );
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  const split = exec.calls.find((c) => c.includes("split-window"))!;
  assert.match(create, /--model opus/, create);
  assert.match(create, /--effort xhigh/, create);
  assert.match(split, /--model sonnet/, split);
  assert.match(split, /--effort xhigh/, split);
});

test("questions session: its single pane IS primed", async () => {
  // The rule is "only the first pane gets an opener", not "only work sessions do".
  const exec = fakeExec();
  const deps = stubDeps(exec);
  const res = await spawnSession(
    { box: ALPHA, mode: "q", label: "a question", slug: "aq", worktree: "none", branchPrefix: PREFIX },
    deps,
  );
  assert.ok(res.ok, res.error ?? "");
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.match(create, /Await my questions/);
  assert.match(create, /--permission-mode auto/);
  assert.ok(!exec.calls.some((c) => c.includes("split-window")), "no second pane");
});

test("work session with no worktree: no packet is written anywhere", async () => {
  // The context packet is gone entirely - a generic tool has no per-box wiki to
  // slice. A session with no worktree simply has no opener context beyond the
  // typed task, same as one with a worktree.
  const exec = fakeExec();
  const deps = stubDeps(exec);
  const res = await spawnSession(
    { box: ALPHA, mode: "work", label: "no wt", slug: "nowt", worktree: "none", branchPrefix: PREFIX },
    deps,
  );
  assert.ok(res.ok, res.error ?? "");
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  const split = exec.calls.find((c) => c.includes("split-window"))!;
  assert.ok(!create.includes("packet"), create);
  assert.match(create, /planning half/);
  assert.ok(!split.includes("await"), `right pane still blank: ${split}`);
});

test("a no-folder box's sessions start completely fresh - no opener on any pane", async () => {
  // There is no folder behind this box, so there is no context to pre-load and
  // nothing to plan against. An opener would only put words in the session's
  // mouth.
  const exec = fakeExec();
  const deps = stubDeps(exec);
  for (const mode of ["work", "quick", "q", "research"] as const) {
    await spawnSession(
      { box: GENERAL, mode, label: "ad hoc", slug: "adhoc", worktree: "none", branchPrefix: PREFIX },
      deps,
    );
  }
  for (const cmd of exec.calls.filter((c) => /new-session|split-window/.test(c))) {
    assert.match(cmd, /(?:plan|auto)(?: --model \S+)?(?: --effort \S+)?; exec/, `no opener: ${cmd}`);
  }
});

test("a quick session is one pane, primed, opus/high", async () => {
  const exec = fakeExec([[/branch --show-current/, { stdout: "main\n" }]]);
  const deps = stubDeps(exec);
  const res = await spawnSession(
    { box: ALPHA, mode: "quick", label: "hotfix", slug: "hotfix", worktree: "new", branchPrefix: PREFIX },
    deps,
  );
  assert.ok(res.ok, res.error ?? "");
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.match(create, /--model opus/);
  assert.match(create, /--effort high/);
  assert.match(create, /--permission-mode auto/);
  assert.ok(!exec.calls.some((c) => c.includes("split-window")), "one pane only");
});

test("a research session with a typed task investigates and does not touch code", async () => {
  const exec = fakeExec();
  const deps = stubDeps(exec);
  const res = await spawnSession(
    {
      box: ALPHA,
      mode: "research",
      label: "dig",
      slug: "dig",
      worktree: "none",
      branchPrefix: PREFIX,
      extraPrompt: "why does the retry loop spin",
    },
    deps,
  );
  assert.ok(res.ok, res.error ?? "");
  const create = exec.calls.find((c) => c.includes("new-session"))!;
  assert.match(create, /--model opus/);
  assert.match(create, /--effort high/);
  assert.match(create, /Task: why does the retry loop spin/);
  assert.match(create, /do not change code/);
});

test("a no-folder box never gets a worktree, even when one is asked for", async () => {
  // Every git path would fail with "no folder for this box" and take the spawn
  // with it, so the request is corrected rather than attempted.
  const exec = fakeExec();
  const deps = stubDeps(exec);
  const res = await spawnSession(
    { box: GENERAL, mode: "work", label: "wt please", slug: "wtplease", worktree: "new", branchPrefix: PREFIX },
    deps,
  );
  assert.ok(res.ok, res.error ?? "");
  assert.equal(res.worktree, null);
  assert.equal(res.ff, null, "no fast-forward was attempted either");
  assert.ok(!exec.calls.some((c) => c.includes("git ")), exec.calls.join("\n"));
});

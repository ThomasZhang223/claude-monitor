import { test } from "node:test";
import assert from "node:assert/strict";
import { openingPrompt, paneRoles, promptTailLines } from "../src/prompt.ts";
import { ALPHA, BRAVO } from "./fixtures/boxes.ts";

const ROLES = ["plan", "impl", "question", "quick", "research"] as const;
const NO_TASK = { task: "" };
const TASK = (task: string) => ({ task });

// ---------------------------------------------------------------------------
// openingPrompt
// ---------------------------------------------------------------------------

test("opening prompts are single-line and reasonably short", () => {
  // These are passed as the pane's command. A newline is exactly what makes
  // delivery ambiguous.
  for (const role of ROLES) {
    const prompt = openingPrompt(role, ALPHA, NO_TASK);
    assert.ok(!prompt.includes("\n"), `${role} prompt is one line`);
    assert.ok(prompt.length < 400, `${role} prompt stays short`);
  }
});

test("every opener ends with the recap sentence, worded with no apostrophes or quotes", () => {
  // Embedded in a shell-quoted pane command (spawn.ts's paneCommand, then
  // tmux.ts's buildCreateSessionCmd) - each layer of quoting expands a
  // literal quote fourfold.
  for (const role of ROLES) {
    for (const opts of [NO_TASK, TASK("fix the retry loop")]) {
      const prompt = openingPrompt(role, ALPHA, opts);
      assert.match(prompt, /cc-recap/, `${role} names cc-recap`);
      assert.ok(!prompt.includes("'"), `${role}: no apostrophes - ${prompt}`);
      assert.ok(!prompt.includes('"'), `${role}: no quote characters - ${prompt}`);
    }
  }
});

test("the opener never mentions a wiki, packet, or repo - there is no per-box context to load", () => {
  for (const role of ROLES) {
    const prompt = openingPrompt(role, ALPHA, TASK("investigate the flake"));
    assert.ok(!/wiki|packet|session-packet/i.test(prompt), `${role}: ${prompt}`);
  }
});

test("the opener does not depend on which box it is for - the tool has no per-box knowledge", () => {
  for (const role of ROLES) {
    for (const opts of [NO_TASK, TASK("ship the fix")]) {
      assert.equal(openingPrompt(role, ALPHA, opts), openingPrompt(role, BRAVO, opts), role);
    }
  }
});

test("with no task, each role says what it is waiting for", () => {
  assert.match(openingPrompt("plan", ALPHA, NO_TASK), /planning half/);
  assert.match(openingPrompt("plan", ALPHA, NO_TASK), /ExitPlanMode/);
  assert.match(openingPrompt("impl", ALPHA, NO_TASK), /[Ww]ait for the approved plan/);
  assert.match(openingPrompt("question", ALPHA, NO_TASK), /Await my questions/);
  assert.match(openingPrompt("quick", ALPHA, NO_TASK), /small, self-contained change/);
  assert.match(openingPrompt("research", ALPHA, NO_TASK), /do not change code/);
});

test("a typed task is folded in as its own clause, for every role", () => {
  for (const role of ROLES) {
    const prompt = openingPrompt(role, ALPHA, TASK("fix the retry loop"));
    assert.match(prompt, /Task: fix the retry loop\./, role);
  }
});

test("the typed task is terminated, so the role's own sentence cannot fuse onto it", () => {
  const prompt = openingPrompt("research", ALPHA, TASK("why does the recycle flake"));
  assert.match(prompt, /Task: why does the recycle flake\./);
  // Punctuation the user typed is left alone rather than doubled.
  for (const ending of ["it?", "now!", "done."]) {
    const p = openingPrompt("question", ALPHA, TASK(`fix ${ending}`));
    assert.ok(p.includes(`Task: fix ${ending}`), p);
    assert.ok(!p.includes(`${ending}.`), `must not double the punctuation: ${p}`);
  }
});

test("the question role has nothing to add beyond the task itself, plus the recap sentence", () => {
  const prompt = openingPrompt("question", ALPHA, TASK("ship the fix"));
  assert.match(prompt, /^Task: ship the fix\. After each meaningful step/);
});

// ---------------------------------------------------------------------------
// paneRoles
// ---------------------------------------------------------------------------

test("paneRoles: work is plan alongside impl, every other class is one named pane", () => {
  assert.deepEqual(paneRoles("work"), ["plan", "impl"]);
  assert.deepEqual(paneRoles("q"), ["question"]);
  assert.deepEqual(paneRoles("quick"), ["quick"]);
  assert.deepEqual(paneRoles("research"), ["research"]);
});

// ---------------------------------------------------------------------------
// promptTailLines
// ---------------------------------------------------------------------------

test("promptTailLines: keeps only the last N wrapped lines", () => {
  const lines = promptTailLines("abcdefghij", 4, 2);
  assert.deepEqual(lines, ["efgh", "ij"]);
});

test("promptTailLines: text shorter than one line is returned whole", () => {
  assert.deepEqual(promptTailLines("hi", 10, 4), ["hi"]);
});

test("promptTailLines: empty text is one empty line, not zero lines", () => {
  assert.deepEqual(promptTailLines("", 10, 4), [""]);
});

test("promptTailLines: a literal newline in a paste starts a fresh line", () => {
  assert.deepEqual(promptTailLines("one\ntwo", 10, 4), ["one", "two"]);
});

test("promptTailLines: fewer lines than maxLines returns what exists, not padded", () => {
  assert.deepEqual(promptTailLines("one\ntwo", 10, 4), ["one", "two"]);
});

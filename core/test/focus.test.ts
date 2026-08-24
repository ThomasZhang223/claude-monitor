import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boxRows,
  clampFocus,
  focusFor,
  focusedRecord,
  initialFocus,
  moveBox,
  moveRow,
} from "../src/focus.ts";
import type { BoxId, Mode, SessionRecord } from "../src/model.ts";
import { ALPHA, BOX_IDS, BRAVO, GENERAL } from "./fixtures/boxes.ts";

function record(box: BoxId, mode: Mode, slug: string): SessionRecord {
  return {
    tmuxName: `cc-${box}-${mode}-${slug}`,
    box,
    mode,
    slug,
    label: slug,
    worktree: null,
    recap: null,
    planPath: null,
    createdAt: null,
    branch: null,
    status: "idle",
    panes: [],
    contextPct: null,
    model: null,
    effort: null,
    runtimeMs: null,
    flagged: false,
  };
}

test("boxRows: WORK rows come before QUESTIONS, matching the drawn order", () => {
  const records = [
    record(ALPHA.id, "q", "a"),
    record(ALPHA.id, "work", "b"),
    record(ALPHA.id, "q", "c"),
    record(BRAVO.id, "work", "d"),
  ];
  assert.deepEqual(
    boxRows(records, ALPHA.id).map((r) => r.slug),
    ["b", "a", "c"],
  );
});

test("boxRows: all four classes walk in MODE_ORDER - work, quick, q, research", () => {
  const records = [
    record(ALPHA.id, "research", "r"),
    record(ALPHA.id, "q", "a"),
    record(ALPHA.id, "quick", "b"),
    record(ALPHA.id, "work", "c"),
  ];
  assert.deepEqual(
    boxRows(records, ALPHA.id).map((r) => r.slug),
    ["c", "b", "a", "r"],
  );
});

test("boxRows: a box using only the two newer classes still orders them correctly", () => {
  const records = [record(ALPHA.id, "research", "r"), record(ALPHA.id, "quick", "b")];
  assert.deepEqual(
    boxRows(records, ALPHA.id).map((r) => r.slug),
    ["b", "r"],
  );
});

test("moveBox: steps through every box including empty ones", () => {
  // The bug this replaces: box movement hunted for a session in the next box, so
  // a box with nothing in it was unreachable - and therefore impossible to
  // create the first session in.
  let focus = { box: BOX_IDS[0], row: 0 };
  const visited = [focus.box];
  for (let i = 0; i < BOX_IDS.length - 1; i++) {
    focus = moveBox(focus, 1, BOX_IDS);
    visited.push(focus.box);
  }
  assert.deepEqual(visited, [...BOX_IDS]);
});

test("moveBox: wraps in both directions", () => {
  const last = BOX_IDS[BOX_IDS.length - 1];
  assert.equal(moveBox({ box: last, row: 0 }, 1, BOX_IDS).box, BOX_IDS[0]);
  assert.equal(moveBox({ box: BOX_IDS[0], row: 0 }, -1, BOX_IDS).box, last);
});

test("moveBox: lands on the new box's first row", () => {
  assert.equal(moveBox({ box: ALPHA.id, row: 5 }, 1, BOX_IDS).row, 0);
});

test("moveBox: a focused box no longer in the configured set lands on the first box", () => {
  // The setup panel can delete the box the cursor was on. Rather than throw,
  // moveBox treats that as "start over" - the same recovery clampFocus and
  // Dashboard's own boxIds-changed effect give the row index.
  assert.deepEqual(moveBox({ box: "deleted", row: 3 }, 1, BOX_IDS), { box: BOX_IDS[0], row: 0 });
});

test("moveBox: an empty box list is a no-op rather than a throw", () => {
  const focus = { box: "anything", row: 2 };
  assert.deepEqual(moveBox(focus, 1, []), focus);
});

test("moveRow: clamps at both ends rather than wrapping", () => {
  assert.deepEqual(moveRow({ box: GENERAL.id, row: 0 }, -1, 3), { box: GENERAL.id, row: 0 });
  assert.deepEqual(moveRow({ box: GENERAL.id, row: 2 }, 1, 3), { box: GENERAL.id, row: 2 });
  assert.deepEqual(moveRow({ box: GENERAL.id, row: 1 }, 1, 3), { box: GENERAL.id, row: 2 });
});

test("moveRow: an empty box stays at row zero", () => {
  assert.deepEqual(moveRow({ box: BRAVO.id, row: 0 }, 1, 0), { box: BRAVO.id, row: 0 });
});

test("focusedRecord: null for an empty box, never a session from another one", () => {
  const records = [record(ALPHA.id, "work", "a")];
  assert.equal(focusedRecord(records, { box: BRAVO.id, row: 0 }), null);
  assert.equal(focusedRecord(records, { box: ALPHA.id, row: 0 })?.slug, "a");
});

test("focusedRecord: an out-of-range row reads as the last row, not undefined", () => {
  const records = [record(GENERAL.id, "work", "a"), record(GENERAL.id, "work", "b")];
  assert.equal(focusedRecord(records, { box: GENERAL.id, row: 9 })?.slug, "b");
});

test("clampFocus: pulls the row back when a session dies underneath it", () => {
  const before = [record(GENERAL.id, "work", "a"), record(GENERAL.id, "work", "b")];
  const after = [record(GENERAL.id, "work", "a")];
  assert.deepEqual(clampFocus({ box: GENERAL.id, row: 1 }, before), { box: GENERAL.id, row: 1 });
  assert.deepEqual(clampFocus({ box: GENERAL.id, row: 1 }, after), { box: GENERAL.id, row: 0 });
});

test("clampFocus: returns the same object when nothing moves, so React does not re-render", () => {
  const records = [record(GENERAL.id, "work", "a")];
  const focus = { box: GENERAL.id as BoxId, row: 0 };
  assert.equal(clampFocus(focus, records), focus);
});

test("focusFor: locates a freshly created session so the cursor can land on it", () => {
  const records = [
    record(BRAVO.id, "work", "a"),
    record(BRAVO.id, "q", "new-one"),
    record(GENERAL.id, "work", "b"),
  ];
  assert.deepEqual(focusFor(records, `cc-${BRAVO.id}-q-new-one`), { box: BRAVO.id, row: 1 });
  assert.equal(focusFor(records, `cc-${GENERAL.id}-q-nope`), null);
});

test("initialFocus: starts on the first configured box, in config order", () => {
  assert.deepEqual(initialFocus(BOX_IDS), { box: BOX_IDS[0], row: 0 });
  assert.deepEqual(initialFocus(["only"]), { box: "only", row: 0 });
});

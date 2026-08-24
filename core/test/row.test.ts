/**
 * Row layout: the arithmetic that decides how many glyphs a row shows, whether
 * the detail band splits, and which pane each segment speaks for.
 *
 * Worth testing rather than eyeballing because the failure mode is quiet — a
 * row that overflows its box by one column corrupts the frame to its right,
 * and a threshold set slightly wrong produces two truncated fragments that look
 * deliberate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_FOCUS_TINT,
  FLAG_TINT,
  FOCUS_TINT,
  glyphSlots,
  layoutRow,
  paneText,
  rowBackground,
  tint,
  worstPane,
} from "../src/row.ts";
import {
  GLYPH_SLOTS,
  GLYPH_W,
  MIN_SEGMENT_W,
  SEGMENT_SEPARATOR,
  type AutoRecap,
  type Mode,
  type PaneRecord,
  type SessionRecord,
  type Status,
} from "../src/model.ts";

/** A full-width band: wide enough that the detail splits. */
const WIDE = 196;
/** Two boxes side by side at WIDE_COLUMNS: too narrow to split. */
const NARROW = 71;

function away(text: string, at = 1000): AutoRecap {
  return { text, source: "away", at };
}

function pane(paneIndex: number, status: Status, auto: AutoRecap | null = null): PaneRecord {
  return {
    paneIndex,
    panePid: 100 + paneIndex,
    status,
    claude: null,
    auto,
  };
}

function record(panes: PaneRecord[], over: Partial<SessionRecord> = {}): SessionRecord {
  const mode: Mode = over.mode ?? (panes.length > 1 ? "work" : "q");
  return {
    tmuxName: "cc-app-work-packaging",
    box: "app",
    mode,
    slug: "packaging",
    label: "packaging",
    worktree: "/Users/t/code/myrepo_packaging",
    recap: null,
    planPath: null,
    createdAt: null,
    branch: "team/feature/packaging",
    status: "idle",
    panes,
    contextPct: null,
    model: null,
    effort: null,
    runtimeMs: null,
    flagged: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Glyph slots
// ---------------------------------------------------------------------------

test("glyphSlots: a work session fills both slots in pane order", () => {
  const r = record([pane(1, "working"), pane(0, "awaiting")]);
  const slots = glyphSlots(r);
  assert.equal(slots.length, GLYPH_SLOTS);
  // Sorted by pane index regardless of the order collect happened to produce.
  assert.equal(slots[0]?.paneIndex, 0);
  assert.equal(slots[0]?.status, "awaiting");
  assert.equal(slots[1]?.paneIndex, 1);
  assert.equal(slots[1]?.status, "working");
});

test("glyphSlots: a single-pane session still reserves the second slot", () => {
  // The alignment invariant. A `q` row and a `work` row sit in one box under
  // different group headers; if the band shrank the name column would step
  // sideways between the two groups.
  const slots = glyphSlots(record([pane(0, "awaiting")], { mode: "q" }));
  assert.equal(slots.length, GLYPH_SLOTS);
  assert.equal(slots[1], null);
});

test("glyphSlots: a session with no panes at all is all blanks", () => {
  assert.deepEqual(glyphSlots(record([])), [null, null]);
});

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

test("layoutRow: a wide work row splits into one segment per pane", () => {
  const r = record([
    pane(0, "awaiting", away("waiting on the tarball layout")),
    pane(1, "working", away("running the smoke test")),
  ]);
  const { segments } = layoutRow(r, WIDE);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].paneIndex, 0);
  assert.equal(segments[0].text, "waiting on the tarball layout");
  assert.equal(segments[1].paneIndex, 1);
  assert.equal(segments[1].text, "running the smoke test");
  assert.ok(segments[0].width >= MIN_SEGMENT_W, `left ${segments[0].width}`);
  assert.ok(segments[1].width >= MIN_SEGMENT_W, `right ${segments[1].width}`);
});

test("layoutRow: a narrow work row collapses to the worst pane", () => {
  const r = record([
    pane(0, "working", away("reading fixtures")),
    pane(1, "permission", away("needs approval to run pytest")),
  ]);
  const { segments } = layoutRow(r, NARROW);
  assert.equal(segments.length, 1);
  // permission outranks working, so the collapsed line is pane 1's.
  assert.equal(segments[0].status, "permission");
  assert.equal(segments[0].text, "needs approval to run pytest");
  // No single pane owns the line when it stands for the whole session.
  assert.equal(segments[0].paneIndex, null);
});

test("layoutRow: a q session never splits, however wide the box", () => {
  const r = record([pane(0, "awaiting", away("read the wiki history"))], { mode: "q" });
  const { segments } = layoutRow(r, WIDE);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].paneIndex, 0);
});

test("layoutRow: splits exactly at the MIN_SEGMENT_W boundary, not around it", () => {
  // Walk the width up one column at a time and find the first split. Both
  // halves must clear the floor at that width, and the width one column below
  // must not split - a threshold that is off by one produces a row of
  // fragments at the very width it was meant to protect.
  const r = record([pane(0, "awaiting"), pane(1, "working")]);
  let firstSplit = -1;
  for (let w = 40; w <= 200; w++) {
    if (layoutRow(r, w).segments.length === 2) {
      firstSplit = w;
      break;
    }
  }
  assert.ok(firstSplit > 0, "found a splitting width");
  const at = layoutRow(r, firstSplit).segments;
  assert.ok(Math.min(at[0].width, at[1].width) >= MIN_SEGMENT_W);
  assert.equal(layoutRow(r, firstSplit - 1).segments.length, 1);
});

// ---------------------------------------------------------------------------
// The row must never overflow its box
// ---------------------------------------------------------------------------

test("layoutRow: chrome plus segments never exceeds the row width", () => {
  // The invariant that keeps the frame intact. Ink does not clip for us; a row
  // one column too wide wraps and shoves every box below it out of place.
  const shapes: PaneRecord[][] = [
    [pane(0, "awaiting")],
    [pane(0, "awaiting"), pane(1, "working")],
    [],
  ];
  for (const panes of shapes) {
    for (let w = 30; w <= 240; w++) {
      const { segments, nameW, pidW, ctxW } = layoutRow(record(panes), w);
      const separators = (segments.length - 1) * SEGMENT_SEPARATOR.length;
      const segW = segments.reduce((sum, s) => sum + s.width, 0);
      const NAME_PID_GAP = 3;
      const PID_DETAIL_GAP = 3;
      const total =
        1 + GLYPH_W * GLYPH_SLOTS + 1 + nameW + NAME_PID_GAP + pidW + PID_DETAIL_GAP + segW +
        separators + ctxW;
      // At very small widths the detail band hits its floor of 6 and the row
      // legitimately cannot fit; everywhere else it must land exactly.
      if (w >= 60) {
        assert.equal(total, w, `width=${w} panes=${panes.length}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Text selection
// ---------------------------------------------------------------------------

test("paneText: only an away-summary counts as a recap", () => {
  assert.equal(paneText(pane(0, "working", away("compiling the parser"))), "compiling the parser");
  // The last-assistant fallback is a fragment of whatever the pane was saying,
  // which on a fresh pane is it reading its own opening prompt. That reads as
  // activity when nothing has happened.
  assert.equal(
    paneText(pane(0, "idle", { text: "Let me look at that file", source: "assistant", at: null })),
    "idle",
  );
  assert.equal(paneText(pane(0, "awaiting")), "awaiting you");
});

test("paneText: a multi-line recap is flattened to one line", () => {
  // A newline here would push every box below this row out of place.
  const text = paneText(pane(0, "idle", away("Did the thing.\n\nNext: the other thing.")));
  assert.equal(text, "Did the thing. Next: the other thing.");
});

test("layoutRow: a collapsed row with no recap falls back to the branch", () => {
  // The branch is the only place a narrow row says which checkout it is - the
  // status is already in the glyph, so repeating it there would waste the line.
  const r = record([pane(0, "idle"), pane(1, "idle")]);
  const { segments } = layoutRow(r, NARROW);
  assert.equal(segments[0].text, "team/feature/packaging");
});

test("layoutRow: a split row prefers the status label over the branch", () => {
  // Split segments are per pane, and a branch is per session - printing it in
  // both halves would say the same thing twice and describe neither pane.
  const r = record([pane(0, "idle"), pane(1, "working")]);
  const { segments } = layoutRow(r, WIDE);
  assert.equal(segments[0].text, "idle");
  assert.equal(segments[1].text, "working");
});

// ---------------------------------------------------------------------------
// worstPane
// ---------------------------------------------------------------------------

test("worstPane: picks by severity, and matches the row's aggregate status", () => {
  assert.equal(worstPane([pane(0, "awaiting"), pane(1, "working")])?.paneIndex, 0);
  assert.equal(worstPane([pane(0, "working"), pane(1, "permission")])?.paneIndex, 1);
  assert.equal(worstPane([pane(0, "idle"), pane(1, "dead")])?.paneIndex, 0);
  assert.equal(worstPane([pane(0, "error"), pane(1, "permission")])?.paneIndex, 0);
  assert.equal(worstPane([]), null);
});

// ---------------------------------------------------------------------------
// tint / rowBackground
// ---------------------------------------------------------------------------

test("tint: matches the measured ladder for both repo colours", () => {
  // Verified by hand against the plan's table, so a formula change that
  // silently drifts the actual on-screen colours fails here first.
  assert.equal(tint("#7FFFD4", FOCUS_TINT), "#142922");
  assert.equal(tint("#7FFFD4", FLAG_TINT), "#264d40");
  assert.equal(tint("#7FFFD4", FLAG_FOCUS_TINT), "#38705d");
  assert.equal(tint("#C9A227", FOCUS_TINT), "#201a06");
  assert.equal(tint("#C9A227", FLAG_TINT), "#3c310c");
  assert.equal(tint("#C9A227", FLAG_FOCUS_TINT), "#584711");
});

test("tint: strength 0 is black, and strength climbs the channel sums monotonically", () => {
  assert.equal(tint("#7FFFD4", 0), "#000000");
  const sum = (hex: string) =>
    [0, 2, 4].reduce((total, i) => total + parseInt(hex.slice(1 + i, 3 + i), 16), 0);
  assert.ok(sum(tint("#7FFFD4", FOCUS_TINT)) < sum(tint("#7FFFD4", FLAG_TINT)));
  assert.ok(sum(tint("#7FFFD4", FLAG_TINT)) < sum(tint("#7FFFD4", FLAG_FOCUS_TINT)));
});

test("rowBackground: null for neither focused nor flagged", () => {
  assert.equal(rowBackground("#7FFFD4", false, false), null);
});

test("rowBackground: flagged is brighter than merely focused, and flagged+focused brighter still", () => {
  const focused = rowBackground("#7FFFD4", true, false)!;
  const flagged = rowBackground("#7FFFD4", false, true)!;
  const both = rowBackground("#7FFFD4", true, true)!;
  const sum = (hex: string) =>
    [0, 2, 4].reduce((total, i) => total + parseInt(hex.slice(1 + i, 3 + i), 16), 0);
  assert.ok(sum(focused) < sum(flagged), "flagged reads louder than the cursor alone");
  assert.ok(sum(flagged) < sum(both), "flagged+focused is the loudest state");
});

test("rowBackground: matches tint() at the named strength for each state", () => {
  assert.equal(rowBackground("#C9A227", true, false), tint("#C9A227", FOCUS_TINT));
  assert.equal(rowBackground("#C9A227", false, true), tint("#C9A227", FLAG_TINT));
  assert.equal(rowBackground("#C9A227", true, true), tint("#C9A227", FLAG_FOCUS_TINT));
});

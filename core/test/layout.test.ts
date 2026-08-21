import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOXES_MIN_ROWS,
  PREVIEW_MIN_ROWS,
  arrange,
  boxHeights,
  panelSplit,
  previewRows,
  type LayoutBoxesRow,
} from "../src/layout.ts";
import { BOX_MAX_SHARE, BOX_MIN_ROWS, SHORT_ROWS, WIDE_COLUMNS, type BoxId } from "../src/model.ts";

function ids(n: number): BoxId[] {
  return Array.from({ length: n }, (_, i) => `b${i}`);
}

function boxRows(layout: ReturnType<typeof arrange>): LayoutBoxesRow[] {
  return layout.rows.filter((r): r is LayoutBoxesRow => r.kind === "boxes");
}

function sum(heights: Record<BoxId, number>, boxes: readonly BoxId[]): number {
  return boxes.reduce((s, id) => s + heights[id], 0);
}

function counts(boxes: readonly BoxId[], values: readonly number[]): Record<BoxId, number> {
  const out: Record<BoxId, number> = {};
  boxes.forEach((id, i) => (out[id] = values[i] ?? 0));
  return out;
}

// ---------------------------------------------------------------------------
// arrange
// ---------------------------------------------------------------------------

test("arrange: flips to two columns exactly at WIDE_COLUMNS", () => {
  const three = ids(3);
  assert.equal(arrange(WIDE_COLUMNS - 1, 40, three).mode, "narrow");
  assert.equal(arrange(WIDE_COLUMNS, 40, three).mode, "wide");
  assert.equal(arrange(WIDE_COLUMNS + 40, 40, three).mode, "wide");
});

test("arrange wide: boxes pair off in config order", () => {
  const four = ids(4);
  const bands = boxRows(arrange(WIDE_COLUMNS, 50, four));
  assert.equal(bands.length, 2);
  assert.deepEqual(bands[0].columns, [{ boxes: ["b0"] }, { boxes: ["b1"] }]);
  assert.deepEqual(bands[1].columns, [{ boxes: ["b2"] }, { boxes: ["b3"] }]);
});

test("arrange wide: an odd final box takes a full-width band alone", () => {
  const five = ids(5);
  const bands = boxRows(arrange(WIDE_COLUMNS, 50, five));
  assert.equal(bands.length, 3, "two pairs, then the odd one out");
  assert.deepEqual(bands[2].columns, [{ boxes: ["b4"] }]);
});

test("arrange wide: a single box is its own full-width band", () => {
  const bands = boxRows(arrange(WIDE_COLUMNS, 50, ids(1)));
  assert.equal(bands.length, 1);
  assert.deepEqual(bands[0].columns, [{ boxes: ["b0"] }]);
});

test("arrange: global is always first and preview always last, in both modes", () => {
  const three = ids(3);
  for (const columns of [WIDE_COLUMNS - 1, WIDE_COLUMNS]) {
    const { rows } = arrange(columns, 50, three);
    assert.equal(rows[0].kind, "global", `global first at ${columns}`);
    assert.equal(rows[rows.length - 1].kind, "preview", `preview last at ${columns}`);
  }
});

test("arrange narrow: one full-width band per box, in config order", () => {
  const boxes = ids(4);
  const bands = boxRows(arrange(80, 40, boxes));
  assert.equal(bands.length, boxes.length);
  bands.forEach((band, i) => assert.deepEqual(band.columns, [{ boxes: [boxes[i]] }]));
});

// ---------------------------------------------------------------------------
// boxHeights
// ---------------------------------------------------------------------------

test("boxHeights: rows follow session counts", () => {
  const boxes = ids(3);
  const h = boxHeights(counts(boxes, [8, 3, 3]), boxes, 40, "narrow");
  assert.ok(h.b0 > h.b1, "the busiest box is the tallest");
  // The greedy round-robin keeps two equally-weighted bands within a row of
  // each other, not always exactly equal - allocate() breaks ties by index,
  // so which of the two absorbs a leftover row depends on the total.
  assert.ok(Math.abs(h.b1 - h.b2) <= 1, `equal counts get near-equal rows: ${h.b1} vs ${h.b2}`);
});

test("boxHeights: no box is privileged - an idle dashboard splits evenly", () => {
  const boxes = ids(4);
  const h = boxHeights(counts(boxes, []), boxes, 40, "narrow");
  for (const id of boxes.slice(1)) assert.equal(h[id], h.b0, `${id} matches b0 with no sessions anywhere`);
});

test("boxHeights wide: every box in a band shares the band's height", () => {
  const boxes = ids(5);
  const h = boxHeights(counts(boxes, [10, 0, 0, 0, 3]), boxes, 60, "wide");
  assert.equal(h.b0, h.b1, "first pair shares one band height");
  assert.equal(h.b2, h.b3, "second pair shares one band height");
  // b4 is the odd box out, alone in its own band - nothing to equal against.
  assert.ok(h.b4 >= BOX_MIN_ROWS);
});

test("boxHeights: no box ever drops below BOX_MIN_ROWS, even with no sessions", () => {
  const boxes = ids(5);
  for (const mode of ["narrow", "wide"] as const) {
    for (const rows of [24, 40, 60, 120]) {
      const h = boxHeights(counts(boxes, [50]), boxes, rows, mode);
      for (const id of boxes) {
        assert.ok(h[id] >= BOX_MIN_ROWS, `${mode}/${rows}: ${id} keeps its header and (none) line`);
      }
    }
  }
});

test("boxHeights: no band exceeds BOX_MAX_SHARE of the area", () => {
  const boxes = ids(3);
  const rows = 40;
  const h = boxHeights(counts(boxes, [100, 1, 0]), boxes, rows, "narrow");
  assert.equal(h.b0, Math.floor(BOX_MAX_SHARE * rows), "one busy box is capped at its share");
  for (const id of boxes) assert.ok(h[id] / rows <= BOX_MAX_SHARE + 1e-9, `${id} stays within its share`);
});

test("boxHeights narrow: allocations sum to exactly availableRows, for N = 1, 2, 3, 5, 8, 12", () => {
  for (const n of [1, 2, 3, 5, 8, 12]) {
    const boxes = ids(n);
    const shapes: Record<BoxId, number>[] = [
      counts(boxes, []),
      counts(boxes, boxes.map((_, i) => i)),
      counts(boxes, [40, ...boxes.slice(1).map(() => 0)]),
    ];
    const floor = n * BOX_MIN_ROWS;
    for (const shape of shapes) {
      for (let rows = floor; rows <= floor + 60; rows++) {
        const h = boxHeights(shape, boxes, rows, "narrow");
        assert.equal(sum(h, boxes), rows, `N=${n}, rows=${rows}: sums exactly`);
      }
    }
  }
});

test("boxHeights wide: paired boxes match, and every band's height sums to the total, for N = 1, 2, 3, 5, 8, 12", () => {
  for (const n of [1, 2, 3, 5, 8, 12]) {
    const boxes = ids(n);
    const bandCount = Math.ceil(n / 2);
    const floor = bandCount * BOX_MIN_ROWS;
    for (let rows = floor; rows <= floor + 60; rows++) {
      const h = boxHeights(counts(boxes, boxes.map((_, i) => i)), boxes, rows, "wide");
      let total = 0;
      for (let i = 0; i < n; i += 2) {
        if (i + 1 < n) assert.equal(h[boxes[i]], h[boxes[i + 1]], `N=${n}, rows=${rows}: pair matches`);
        total += h[boxes[i]];
      }
      assert.equal(total, rows, `N=${n}, rows=${rows}: bands fill the area`);
    }
  }
});

test("boxHeights: a terminal too short for the minimums returns floors to drop from, for N = 1, 2, 3, 5, 8, 12", () => {
  // Below the minimums there is no honest allocation, so every box gets its own
  // floor and the sum deliberately overflows: the caller decides what to drop.
  for (const n of [1, 2, 3, 5, 8, 12]) {
    const boxes = ids(n);
    for (const mode of ["narrow", "wide"] as const) {
      const bandCount = mode === "narrow" ? n : Math.ceil(n / 2);
      const rows = bandCount * BOX_MIN_ROWS - 1;
      const h = boxHeights(counts(boxes, [5, 1]), boxes, rows, mode);
      for (const id of boxes) assert.equal(h[id], BOX_MIN_ROWS, `N=${n} ${mode}: ${id} at its floor`);
      assert.ok(sum(h, boxes) > rows, `N=${n} ${mode}: overflow is visible to the caller`);
    }
  }
  // Degenerate sizes must not produce negative or fractional rows.
  const boxes = ids(3);
  for (const rows of [0, -5, 3.5]) {
    const h = boxHeights(counts(boxes, []), boxes, rows, "narrow");
    for (const id of boxes) assert.equal(h[id], BOX_MIN_ROWS, `rows=${rows}: ${id}`);
  }
});

test("boxHeights: an empty box list returns an empty map rather than throwing", () => {
  assert.deepEqual(boxHeights({}, [], 40, "narrow"), {});
});

// ---------------------------------------------------------------------------
// previewRows
// ---------------------------------------------------------------------------

test("previewRows: collapses to a single line below SHORT_ROWS", () => {
  assert.equal(previewRows(SHORT_ROWS - 1), 1);
  assert.equal(previewRows(10), 1);
  assert.ok(previewRows(SHORT_ROWS) > 1, "at the breakpoint the preview opens up");
});

test("previewRows: grows with height but never dominates the screen", () => {
  const tall = previewRows(120);
  assert.ok(tall >= previewRows(SHORT_ROWS), "taller terminals give the preview more room");
  assert.ok(tall <= 17, "the box list keeps the majority of the screen");
  for (const rows of [30, 40, 60, 120, 300]) {
    assert.ok(previewRows(rows) < rows / 2, `preview stays a minority at ${rows}`);
  }
});

// ---------------------------------------------------------------------------
// panelSplit — sharing the screen with a create/kill/setup prompt
// ---------------------------------------------------------------------------

test("panelSplit: with no prompt open, every row is spoken for", () => {
  const s = panelSplit(50, 6, previewRows(50), 0);
  assert.equal(s.previewRows + s.boxesRows + 6 + 1, 50);
});

test("panelSplit: a prompt's rows come out of the total, not out of the prompt", () => {
  // The prompt is reserved rather than squeezed: as a plain flex sibling Ink
  // shrank the wizard and silently ate the line previewing the name it was about
  // to create.
  const modal = 14;
  const s = panelSplit(50, 6, previewRows(50), modal);
  assert.equal(s.previewRows + s.boxesRows + 6 + 1 + modal, 50);
});

test("panelSplit: the preview gives up rows before the boxes do", () => {
  // It stays on screen - that is the whole reason the prompt sits underneath it -
  // but the boxes keep their floor.
  const wanted = previewRows(30);
  const tight = panelSplit(30, 4, wanted, 14);
  assert.ok(tight.previewRows < wanted, `preview shrank: ${tight.previewRows} < ${wanted}`);
  assert.ok(tight.previewRows >= PREVIEW_MIN_ROWS, "but stays visible");
  assert.equal(tight.boxesRows, BOXES_MIN_ROWS);
});

test("panelSplit: never grows the preview beyond what the height asked for", () => {
  const wanted = previewRows(80);
  assert.equal(panelSplit(80, 6, wanted, 0).previewRows, wanted);
  // A one-line preview on a short terminal stays one line.
  assert.equal(panelSplit(24, 4, 1, 0).previewRows, 1);
});

test("panelSplit: a hidden preview gives all its rows to the boxes", () => {
  const s = panelSplit(50, 6, 0, 0);
  assert.equal(s.previewRows, 0);
  assert.equal(s.boxesRows, 50 - 6 - 1);
});

test("panelSplit: the boxes never go below their floor, even absurdly cramped", () => {
  for (const rows of [0, 5, 12, 20]) {
    assert.ok(panelSplit(rows, 4, 6, 14).boxesRows >= BOXES_MIN_ROWS, `rows=${rows}`);
  }
});

/**
 * How the dashboard is cut up: which boxes sit where at the current terminal
 * size, and how many rows each one gets.
 *
 * Entirely pure — no IO, no clock, no environment. The TUI measures the
 * terminal, calls arrange() for the structure and boxHeights()/previewRows()
 * for the sizes, and renders exactly what it is handed.
 */
import { BOX_MAX_SHARE, BOX_MIN_ROWS, SHORT_ROWS, WIDE_COLUMNS, type BoxId } from "./model.ts";

// ---------------------------------------------------------------------------
// Arrangement
// ---------------------------------------------------------------------------

export type LayoutMode = "wide" | "narrow";

/** One vertical stack of boxes. Boxes render top to bottom in this order. */
export interface LayoutColumn {
  boxes: BoxId[];
}

/** A band of boxes across the screen. `columns` renders left to right; a
 *  full-width band simply has one column. */
export interface LayoutBoxesRow {
  kind: "boxes";
  columns: LayoutColumn[];
}

/** The global summary strip. Always the first row, always full width. */
export interface LayoutGlobalRow {
  kind: "global";
}

/** The focused-session preview. Always the last row, always full width. */
export interface LayoutPreviewRow {
  kind: "preview";
}

export type LayoutRow = LayoutGlobalRow | LayoutBoxesRow | LayoutPreviewRow;

/**
 * The whole screen, top to bottom. To render from Ink: map over `rows`, switch
 * on `kind`, and for a "boxes" row lay its `columns` out side by side (each
 * column a vertical stack). Nothing else about position is implied, and no row
 * carries a height — heights come from boxHeights()/previewRows() so the TUI can
 * recompute them on resize without re-deriving the structure.
 */
export interface Layout {
  mode: LayoutMode;
  rows: LayoutRow[];
}

/** Bands of boxes, in config order: one box per band in narrow mode, pairs
 *  (an odd final box alone) in wide mode. Shared between `arrange` (which
 *  turns bands into layout rows) and `boxHeights` (which allocates rows across
 *  them), so the two can never disagree about what a "band" is. */
function bandsFor(boxIds: readonly BoxId[], mode: LayoutMode): BoxId[][] {
  if (mode === "narrow") return boxIds.map((id) => [id]);
  const bands: BoxId[][] = [];
  for (let i = 0; i < boxIds.length; i += 2) bands.push(boxIds.slice(i, i + 2));
  return bands;
}

/**
 * Pick the arrangement for a terminal of `columns` x `rows`, over `boxes` in
 * config order.
 *
 * Wide (columns >= WIDE_COLUMNS): boxes pair off in config order, each pair a
 * full-width band split into two columns; an odd box left over at the end
 * takes a full-width band by itself, same as a pair's band but with one
 * column instead of two.
 *
 * Narrow: one full-width band per box, stacked in config order.
 *
 * `rows` is accepted so callers can pass the measured size as a pair; height
 * changes what fits (see boxHeights/previewRows) but never which arrangement is
 * used, so the structure depends on width alone.
 */
export function arrange(columns: number, rows: number, boxes: readonly BoxId[]): Layout {
  void rows;
  const mode: LayoutMode = columns >= WIDE_COLUMNS ? "wide" : "narrow";
  const bandRows: LayoutBoxesRow[] = bandsFor(boxes, mode).map((band) => ({
    kind: "boxes",
    columns: band.map((id) => ({ boxes: [id] })),
  }));
  return { mode, rows: [{ kind: "global" }, ...bandRows, { kind: "preview" }] };
}

// ---------------------------------------------------------------------------
// Heights
// ---------------------------------------------------------------------------

/**
 * Hand out `total` rows across `weights`, each entry at least `mins[i]` and at
 * most `caps[i]`, summing to exactly `total`.
 *
 * Greedy by deficit: each row goes to whichever entry currently sits furthest
 * below its weighted ideal. That is deterministic (ties go to the earlier
 * index), needs no largest-remainder bookkeeping, and cannot drift off the
 * total. Row counts are small, so one pass per row is free.
 *
 * Caller guarantees sum(mins) <= total.
 */
function allocate(weights: number[], total: number, mins: number[], caps: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];

  const alloc = mins.slice();
  let remaining = total - mins.reduce((a, b) => a + b, 0);
  const weightSum = weights.reduce((a, b) => a + Math.max(0, b), 0);

  while (remaining > 0) {
    let best = -1;
    let bestDeficit = -Infinity;
    for (let i = 0; i < n; i++) {
      if (alloc[i] >= caps[i]) continue;
      // With no sessions anywhere, weights are all zero: fall back to an even
      // split so an idle dashboard still looks deliberate.
      const ideal = weightSum > 0 ? (total * Math.max(0, weights[i])) / weightSum : total / n;
      const deficit = ideal - alloc[i];
      if (deficit > bestDeficit + 1e-9) {
        bestDeficit = deficit;
        best = i;
      }
    }
    if (best === -1) break;
    alloc[best]++;
    remaining--;
  }

  // Every entry hit its cap and rows are still unspent. The exact-sum invariant
  // wins over the cap: a row left unassigned would either show as a gap or push
  // the preview off the bottom of the screen.
  for (let i = 0; remaining > 0; i = (i + 1) % n) {
    alloc[i]++;
    remaining--;
  }

  return alloc;
}

/** Rows per box. */
export type BoxHeights = Record<BoxId, number>;

/**
 * Divide `availableRows` between the boxes, band by band.
 *
 * A band (see `bandsFor`) is one box in narrow mode or a pair in wide mode;
 * every box in a band takes the band's height, since a pair sits side by side
 * and never competes for vertical space with each other — only for width,
 * which `arrange`'s column split already handles.
 *
 * Bands are weighted by how many sessions they hold and allocated with the
 * same `allocate()` helper the rest of the dashboard's proportional splits
 * use: never below BOX_MIN_ROWS, never above BOX_MAX_SHARE of what the bands
 * are competing for, filling the space exactly. No band is privileged with a
 * taller floor or a fixed share of its own — boxes are user-defined, so no
 * particular one can be assumed to matter more than the others.
 *
 * TOO-SHORT TERMINAL: when availableRows cannot cover every band's minimum
 * (fewer than `bands.length * BOX_MIN_ROWS` of vertical extent), every box
 * gets exactly BOX_MIN_ROWS. The result then deliberately OVERFLOWS
 * availableRows: this function will not invent a sub-minimum box, so the
 * caller must decide what to drop (usually the preview first, then empty
 * boxes). Detect it by comparing the sum against availableRows.
 *
 * Reachable far sooner than it used to be: band count is `ceil(N/2)` in wide
 * mode and `N` in narrow mode, so a wide 12-box config already needs 6 bands
 * at their floor before anything else fits, and a narrow one needs all 12.
 * That headroom is exactly why config.ts's MAX_BOXES caps at 12 — a fail-loud
 * limit beats an unreadable dashboard.
 */
export function boxHeights(
  counts: Record<BoxId, number>,
  boxIds: readonly BoxId[],
  availableRows: number,
  mode: LayoutMode,
): BoxHeights {
  const rows = Number.isFinite(availableRows) ? Math.floor(availableRows) : 0;
  const bands = bandsFor(boxIds, mode);
  const n = bands.length;

  const heights: BoxHeights = {};
  if (n === 0) return heights;

  if (rows < n * BOX_MIN_ROWS) {
    for (const band of bands) for (const id of band) heights[id] = BOX_MIN_ROWS;
    return heights;
  }

  const weights = bands.map((band) => band.reduce((sum, id) => sum + (counts[id] ?? 0), 0));
  const cap = Math.max(BOX_MIN_ROWS, Math.floor(BOX_MAX_SHARE * rows));
  const bandHeights = allocate(
    weights,
    rows,
    bands.map(() => BOX_MIN_ROWS),
    bands.map(() => cap),
  );
  bands.forEach((band, i) => {
    for (const id of band) heights[id] = bandHeights[i];
  });
  return heights;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Rows for the focused-session preview, given the whole terminal height.
 *
 *  Below SHORT_ROWS it collapses to a single line: on a short terminal the box
 *  list is the point, and a multi-line preview would eat it. Above that it takes
 *  a quarter of the height, bounded so it neither shrinks to uselessness nor
 *  dominates a tall window. Bounds are 9/17, not 6/14: a work session's preview
 *  now shows up to two panes' recaps stacked, and the lower bound needs enough
 *  headroom for both blocks' subtitles to be worth having. */
export function previewRows(rows: number): number {
  if (!Number.isFinite(rows) || rows < SHORT_ROWS) return 1;
  return Math.max(9, Math.min(17, Math.floor(rows * 0.25)));
}

// ---------------------------------------------------------------------------
// Sharing the screen with a modal
// ---------------------------------------------------------------------------

/** The boxes never render shorter than this: below it a box cannot show its own
 *  group headings, which is the point of having boxes at all. */
export const BOXES_MIN_ROWS = 8;
/** How far the preview may be squeezed to make room. It stays on screen — that
 *  is the whole reason the create and kill prompts sit underneath it — but it
 *  gives up rows before the boxes do. */
export const PREVIEW_MIN_ROWS = 3;

export interface PanelSplit {
  previewRows: number;
  boxesRows: number;
}

/**
 * Divide the rows between the boxes and the preview, with a prompt taking its
 * share off the top.
 *
 * The prompt's rows are reserved rather than borrowed. An in-flow prompt that
 * merely competes with the boxes is what Ink shrinks first, which silently ate
 * lines out of the wizard — including the one previewing the name it was about to
 * create. So the prompt's height is subtracted here and the prompt itself is
 * marked unshrinkable; what is left is split, preview first down to its floor.
 */
export function panelSplit(
  totalRows: number,
  globalRows: number,
  wantedPreviewRows: number,
  modalRows: number,
  footerRows = 1,
): PanelSplit {
  const available = Math.max(0, totalRows - globalRows - footerRows - modalRows);
  if (wantedPreviewRows <= 0) {
    return { previewRows: 0, boxesRows: Math.max(BOXES_MIN_ROWS, available) };
  }
  // Never grows the preview beyond what the terminal height asked for; only
  // shrinks it, and only as far as the floor.
  const floor = Math.min(wantedPreviewRows, PREVIEW_MIN_ROWS);
  const preview = Math.max(floor, Math.min(wantedPreviewRows, available - BOXES_MIN_ROWS));
  return { previewRows: preview, boxesRows: Math.max(BOXES_MIN_ROWS, available - preview) };
}

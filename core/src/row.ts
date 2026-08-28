/**
 * What one dashboard row is made of, decided here rather than in the renderer.
 *
 * A work session is two independent Claude processes side by side, and the row
 * used to collapse them into a single worst-of-both glyph. That is a lie of
 * omission in the direction that matters: a plan pane waiting on you outranks
 * an implement pane that is working, so the row said "awaiting" and gave no
 * hint that the other half was mid-tool-call. Both statuses are shown instead,
 * in pane order, with the detail column split the same way when the box is
 * wide enough to make two readable halves.
 *
 * Pure and DI-free, like the rest of core/: a row's arithmetic is a truth table
 * about widths, and it belongs in unit tests rather than in a terminal that has
 * to be squinted at.
 */
import {
  GLYPH_SLOTS,
  GLYPH_W,
  MIN_SEGMENT_W,
  SEGMENT_SEPARATOR,
  STATUS_STYLES,
  comparePanePosition,
  type PaneRecord,
  type SessionRecord,
  type Status,
} from "./model.ts";

/** How loudly a status shouts for attention. Kept beside `worstStatus` in
 *  collect.ts conceptually, but re-derived from the same order so a collapsed
 *  segment picks the same pane the aggregate status came from. */
const SEVERITY: Record<Status, number> = {
  error: 5,
  permission: 4,
  awaiting: 3,
  working: 2,
  idle: 1,
  dead: 0,
};

// ---------------------------------------------------------------------------
// Row background
// ---------------------------------------------------------------------------

/**
 * How strongly a row's background carries its box's colour, per row state.
 *
 * Every value is a fraction of the box colour blended toward black rather than
 * the colour at full strength, so a tint reads as "this one" without fighting
 * the text sitting on top of it.
 *
 * The flag tiers are deliberately BRIGHTER than the cursor's. Focus is already
 * carried by the "▸" glyph and the bold label, which frees brightness to mean
 * "I am working on this" — and a flagged row has to be findable from across the
 * screen without moving the cursor onto it, which is the whole point of the
 * flag.
 *
 * ceiling: the dimColor pid and ctx columns lose some contrast at
 * FLAG_FOCUS_TINT. Accepted — they are secondary, and the loudness is the
 * feature. Toning it down is a one-number change here.
 */
export const FOCUS_TINT = 0.16;
export const FLAG_TINT = 0.3;
export const FLAG_FOCUS_TINT = 0.44;

/** Blend a `#rrggbb` colour toward black: 0 is black, 1 is the colour itself. */
export function tint(hex: string, strength: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) =>
    Math.round(c * strength)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

/**
 * The background for one row, or null for "take the terminal's own".
 *
 * Here rather than in the renderer because it is a decision over three states,
 * not markup — and because a colour ladder whose tiers must stay distinct is
 * exactly the kind of arithmetic that should fail a test rather than look
 * slightly wrong on screen.
 */
export function rowBackground(
  boxColor: string,
  focused: boolean,
  flagged: boolean,
): string | null {
  if (flagged) return tint(boxColor, focused ? FLAG_FOCUS_TINT : FLAG_TINT);
  if (focused) return tint(boxColor, FOCUS_TINT);
  return null;
}

export interface RowSegment {
  /** The pane this text describes, or null when one segment stands for the
   *  whole session because there was not room to split. */
  paneIndex: number | null;
  status: Status;
  text: string;
  /** Columns this segment gets, separator excluded. */
  width: number;
}

export interface RowLayout {
  /** Exactly GLYPH_SLOTS entries. A null slot renders as blanks, which is what
   *  keeps a single-pane row's name column aligned with a two-pane one. */
  glyphs: (PaneRecord | null)[];
  /** One segment when collapsed, two when split. */
  segments: RowSegment[];
  nameW: number;
  pidW: number;
  ctxW: number;
  /** Total columns the detail band occupies, separator included. */
  detailW: number;
}

/**
 * The panes that get a glyph slot, in pane order, padded to GLYPH_SLOTS.
 *
 * Padded rather than sized to content on purpose. A `q` session has one pane
 * and a `work` session two, and they sit in the same box under different group
 * headers — if the glyph band grew and shrank per row, the name column would
 * step left and right between the two groups, which is the one alignment the
 * eye actually uses when scanning a box.
 */
export function glyphSlots(record: SessionRecord): (PaneRecord | null)[] {
  const ordered = [...record.panes].sort((a, b) => a.paneIndex - b.paneIndex);
  const slots: (PaneRecord | null)[] = [];
  for (let i = 0; i < GLYPH_SLOTS; i++) slots.push(ordered[i] ?? null);
  return slots;
}

/** The pane whose status the row would show if it could only show one. */
export function worstPane(panes: readonly PaneRecord[]): PaneRecord | null {
  let worst: PaneRecord | null = null;
  for (const pane of panes) {
    if (!worst || SEVERITY[pane.status] > SEVERITY[worst.status]) worst = pane;
  }
  return worst;
}

/**
 * What a pane has to say for itself.
 *
 * Only an away-summary counts as a recap. The other thing `autoRecap` can
 * return is the last assistant message, which on a freshly spawned pane is a
 * fragment of it reading its own opening prompt — that reads as activity when
 * nothing has happened yet, and a 24-column segment has no room to caveat it.
 * The status label is the honest answer in that case.
 */
export function paneText(pane: PaneRecord): string {
  if (pane.auto?.source === "away" && pane.auto.text.trim()) {
    return oneLine(pane.auto.text);
  }
  return STATUS_STYLES[pane.status].label;
}

/** Collapse to one line: a recap may legitimately span lines (the preview wants
 *  those breaks) and a newline here would push every box below out of place. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Width of the name column for a box `width` columns wide.
 *
 * Shared between `layoutRow` and `layoutDeepRow` so the two layouts cannot
 * drift apart — a DEEP WORK row sits in the same box as WORK/QUICK/etc rows,
 * and a name column that stepped sideways between them would be the one
 * alignment the eye actually uses when scanning a box.
 */
export function nameWidth(width: number): number {
  return Math.min(16, Math.max(8, Math.floor(width * 0.32)));
}

/**
 * Lay out one row for a box `width` columns wide.
 *
 * The chrome is fixed — cursor, glyph band, gap, name, pid, context — and the
 * detail band is whatever is left. It splits only when both halves clear
 * MIN_SEGMENT_W, so a narrow box degrades to today's single line rather than to
 * two truncated fragments.
 */
export function layoutRow(record: SessionRecord, width: number): RowLayout {
  const nameW = nameWidth(width);
  // "100%|100%" - two 3-digit percentages and the separator, the worst case
  // now that a multi-pane row shows each pane's own context usage rather than
  // one shared value. Only sized up for a session that actually has two
  // panes: taxing every single-pane row (q/quick/research, the common case)
  // for a budget only a work session needs pushes the detail band's own
  // floor into a width that used to be safe.
  const ctxW = record.panes.length >= 2 ? 9 : 5;
  // "123456/78901" - two 6-digit pids and the separator, the worst case for a
  // work session's plan+impl panes.
  const pidW = 12;
  // Breathing room around the pid column, so it does not read as glued to the
  // name on one side and the summary on the other.
  const NAME_PID_GAP = 3;
  const PID_DETAIL_GAP = 3;
  const glyphBandW = GLYPH_W * GLYPH_SLOTS;
  const detailW = Math.max(
    6,
    width - 1 - glyphBandW - 1 - nameW - NAME_PID_GAP - pidW - PID_DETAIL_GAP - ctxW,
  );

  const panes = [...record.panes].sort((a, b) => a.paneIndex - b.paneIndex);
  const halfW = Math.floor((detailW - SEGMENT_SEPARATOR.length) / 2);
  const canSplit = panes.length >= 2 && halfW >= MIN_SEGMENT_W;

  let segments: RowSegment[];
  if (canSplit) {
    // The remainder of an odd detail band goes to the second segment, so the
    // row still ends flush at ctx.
    const rightW = detailW - SEGMENT_SEPARATOR.length - halfW;
    segments = [
      { paneIndex: panes[0].paneIndex, status: panes[0].status, text: paneText(panes[0]), width: halfW },
      { paneIndex: panes[1].paneIndex, status: panes[1].status, text: paneText(panes[1]), width: rightW },
    ];
  } else {
    const pane = worstPane(panes);
    // With no room to split there is no pane to attribute the line to, so the
    // branch is worth more than a second copy of the status already in the
    // glyph - it is the only place the row says which checkout this is.
    const text = pane
      ? (pane.auto?.source === "away" && pane.auto.text.trim()
          ? oneLine(pane.auto.text)
          : record.branch ?? STATUS_STYLES[pane.status].label)
      : record.branch ?? "-";
    segments = [
      {
        paneIndex: panes.length === 1 ? panes[0].paneIndex : null,
        status: pane?.status ?? record.status,
        text,
        width: detailW,
      },
    ];
  }

  return { glyphs: glyphSlots(record), segments, nameW, pidW, ctxW, detailW };
}

// ---------------------------------------------------------------------------
// DEEP WORK row: every pane's glyph, then the name, then every pane's PID,
// then every pane's context usage - the same glyph/name/pid/ctx column order
// every other group's row already draws, with a pane list standing in for
// the single value in the last two slots.
//
// A second, independent layout, kept apart from layoutRow/glyphSlots/paneText
// above so the four existing groups keep today's row byte for byte. A DEEP
// WORK row is the only row that draws this way.
// ---------------------------------------------------------------------------

export type DeepRowTier = "full" | "glyph" | "badge";

export interface PaneCell {
  windowIndex: number;
  paneIndex: number;
  status: Status;
}

export interface DeepRowLayout {
  nameW: number;
  /** The glyphs to draw, in (window, pane) order. Empty only in the "badge"
   *  tier, where a single glyph stands in for all of them. */
  cells: PaneCell[];
  tier: DeepRowTier;
  /** Every pane's PID, in cell order, joined by "|"; "—" for a pane with no
   *  Claude resolved, so a position always corresponds to the same glyph.
   *  Empty outside the "full" tier. */
  pidText: string;
  /** Every pane's context-window percentage, in cell order, joined by "|";
   *  "—" for a pane with no reading yet. Empty outside the "full" tier. */
  ctxText: string;
  /** Spaces between the PID list and `ctxText` that right-flush ctx to this
   *  row's own width, the same way layoutRow's ctx column always ends flush
   *  against the box. Meaningful only in the "full" tier - 0 otherwise, since
   *  neither list is drawn there. */
  fillerWidth: number;
  /** The first pane's own account of itself (`paneText`, the same fallback a
   *  split WORK segment uses) - drawn on a second line under this one. The
   *  first pane, in (window, pane) order, is the plan pane for a work
   *  session that outgrew two panels, so this is its most useful single
   *  recap. Never used to size anything above - see the module doc on
   *  DeepWorkRow needing two lines of box height per session. */
  recap: string;
  /** Set only in the "badge" tier: the worst pane's status and how many
   *  panes it stands for. */
  badge: { status: Status; total: number } | null;
}

const DEEP_GLYPH_NAME_GAP = 1;
const DEEP_NAME_PID_GAP = 3;
const DEEP_PID_CTX_GAP = 3;

/**
 * Lay out a DEEP WORK row: every pane's glyph, then the name, then every
 * pane's PID, then every pane's context usage, then the plan pane's own
 * recap on a second line - full when the first line's lists fit, glyphs-
 * plus-name only when they do not, and a single "worst status ×N" badge when
 * even the glyphs do not fit. The recap line draws regardless of tier.
 *
 * ceiling: pid and ctx degrade together, not independently - a row shows
 * both lists or neither, rather than adding a tier for "pid fits, ctx
 * doesn't". The panes this row is built for top out around 5, so that gap is
 * small in practice; splitting it into its own tier is the natural follow-on
 * if a session ever grows enough panes to make it visible.
 */
export function layoutDeepRow(record: SessionRecord, width: number): DeepRowLayout {
  const nameW = nameWidth(width);
  const panes = [...record.panes].sort(comparePanePosition);
  const n = panes.length;

  const cells: PaneCell[] = panes.map((p) => ({
    windowIndex: p.windowIndex,
    paneIndex: p.paneIndex,
    status: p.status,
  }));
  const pidText = panes.map((p) => (p.claude ? String(p.claude.pid) : "—")).join("|");
  const ctxText = panes.map((p) => (p.contextPct === null ? "—" : `${p.contextPct}%`)).join("|");
  const recap = panes.length > 0 ? paneText(panes[0]) : "";

  const glyphNameWidth = 1 + n * GLYPH_W + DEEP_GLYPH_NAME_GAP + nameW;
  const beforeCtx = glyphNameWidth + DEEP_NAME_PID_GAP + pidText.length;
  const fullWidth = beforeCtx + DEEP_PID_CTX_GAP + ctxText.length;

  if (fullWidth <= width) {
    // Always >= DEEP_PID_CTX_GAP, since fullWidth <= width already accounts
    // for that minimum - the rest goes to right-flushing ctx exactly.
    const fillerWidth = width - beforeCtx - ctxText.length;
    return { nameW, cells, tier: "full", pidText, ctxText, fillerWidth, recap, badge: null };
  }
  if (glyphNameWidth <= width) {
    return {
      nameW,
      cells,
      tier: "glyph",
      pidText: "",
      ctxText: "",
      fillerWidth: 0,
      recap,
      badge: null,
    };
  }
  // Below this the badge itself may not fit either - matching layoutRow's own
  // floor, which likewise stops degrading and simply overflows below the
  // width its tests actually cover (see row.test.ts's `w >= 60` guard).
  const worst = worstPane(panes);
  return {
    nameW,
    cells: [],
    tier: "badge",
    pidText: "",
    ctxText: "",
    fillerWidth: 0,
    recap,
    badge: { status: worst?.status ?? "dead", total: n },
  };
}

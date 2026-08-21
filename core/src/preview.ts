/**
 * What the preview box says, decided here rather than in the renderer.
 *
 * The rule, learned the hard way twice: the preview shows the session's recap and
 * nothing else. It used to fall back to the tail of the pane's terminal output,
 * which was worse than empty — the bottom of a pane is the status line HUD, so
 * the preview filled up with context bars and "auto mode on" rendered in the
 * colour reserved for things needing attention. What scrolled past is never what
 * you came to the preview to read.
 *
 * Three sources, best first:
 *
 *  1. What the session published with `cc-recap` — deliberate, so it wins,
 *     UNLESS Claude's own away-summary is strictly newer. A session that
 *     published once and never called `cc-recap` again would otherwise mask a
 *     fresher automatic recap forever with an increasingly stale manual one.
 *  2. Claude's own recap, which it writes unprompted whenever it goes idle. This
 *     is the one that makes the box useful without anyone doing anything.
 *  3. The last thing the session said, which is a stand-in and is labelled as
 *     one.
 */
import type { Recap } from "./recap.ts";
import type { AutoRecap } from "./recap.ts";

/** Where a line came from, which is what the renderer colours by. */
export type Tone =
  | "recap" // the session's own account of itself, published or automatic
  | "auto" // its last message, standing in for a recap it never wrote
  | "hint"; // our own explanation of why there is nothing better to show

export interface PreviewLine {
  text: string;
  tone: Tone;
}

export interface PreviewContent {
  /** Wrapped body, already cut to the rows available. */
  lines: PreviewLine[];
  /** Null when nothing has been published to date. */
  recapAt: number | null;
  /** Set when the body is a stand-in rather than a recap, so the renderer can
   *  say so without guessing. */
  standIn: boolean;
}

export interface PreviewInput {
  recap: Recap | null;
  auto: AutoRecap | null;
  /** Columns available for text. */
  width: number;
  /** Rows available for the body. */
  rows: number;
}

/** Break a paragraph on word boundaries, hard-splitting only a word longer than
 *  the whole width. Ink can wrap, but wrapping here is what lets the row budget
 *  be enforced against the lines that will actually be drawn. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(8, Math.floor(width));
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      if (word.length > w) {
        if (line) {
          out.push(line);
          line = "";
        }
        for (let i = 0; i < word.length; i += w) out.push(word.slice(i, i + w));
        continue;
      }
      if (line === "") line = word;
      else if (line.length + 1 + word.length <= w) line = `${line} ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Which of the two authoritative sources is actually current.
 *
 * Shared with the caller (rather than kept private), so the "recap N ago" age
 * shown above the body and the body itself never disagree about which recap
 * they are describing.
 */
export function pickRecap(
  recap: Recap | null,
  auto: AutoRecap | null,
): { text: string; at: number | null } | null {
  const awayIsFresher =
    recap?.at != null && auto?.source === "away" && auto.at != null && auto.at > recap.at;
  if (recap && !awayIsFresher) {
    return { text: [recap.headline, ...recap.detail].join("\n"), at: recap.at };
  }
  if (auto?.source === "away") return { text: auto.text, at: auto.at };
  return null;
}

/**
 * Wrap `text` to `width`, then fit it to `rows` — saying so when it does not
 * fit.
 *
 * Cutting a recap off at the bottom of the box is the same fault as cutting it
 * off after one sentence, only quieter: the text simply stops and nothing says
 * there is more. So the last row becomes a count of what was dropped, which
 * costs one line and turns a silent truncation into a fact.
 *
 * A standalone function rather than a closure, so a multi-block preview can
 * fit each block to its own row budget instead of one shared one.
 */
export function fitText(text: string, tone: Tone, width: number, rows: number): PreviewLine[] {
  const wrapped = wrapText(text, width);
  if (wrapped.length <= rows) return wrapped.map((t) => ({ text: t, tone }));
  if (rows <= 1) return wrapped.slice(0, rows).map((t) => ({ text: t, tone }));
  const kept = wrapped.slice(0, rows - 1).map((t) => ({ text: t, tone }));
  const dropped = wrapped.length - kept.length;
  return [...kept, { text: `… +${dropped} more lines`, tone: "hint" as Tone }];
}

/** Which text to show and how to label it, before wrapping/fitting to a row
 *  budget — shared by the single- and multi-block builders below so the
 *  picking rule (published recap, unless a fresher away-summary; then the
 *  last-message stand-in; then nothing) lives in exactly one place. */
function resolveContent(
  recap: Recap | null,
  auto: AutoRecap | null,
): { text: string; at: number | null; standIn: boolean; tone: Tone } {
  // A published recap is a headline plus optional detail; an away-summary that
  // outranks it is just its own text. Either way it is body text.
  const picked = pickRecap(recap, auto);
  if (picked) return { text: picked.text, at: picked.at, standIn: false, tone: "recap" };
  if (auto) return { text: auto.text, at: null, standIn: true, tone: "auto" };
  return {
    text: "nothing published yet - a session can publish with cc-recap",
    at: null,
    standIn: false,
    tone: "hint",
  };
}

export function buildPreview(input: PreviewInput): PreviewContent {
  const resolved = resolveContent(input.recap, input.auto);
  return {
    lines: fitText(resolved.text, resolved.tone, input.width, Math.max(0, input.rows)),
    recapAt: resolved.at,
    standIn: resolved.standIn,
  };
}

// ---------------------------------------------------------------------------
// Two-pane preview — a work session's plan and implement panes, both shown
// ---------------------------------------------------------------------------

export interface PanePreviewInput {
  /** "plan" / "implement" for a work session's two panes; null for a
   *  single-pane (`q`-mode) session, where there is nothing to disambiguate. */
  label: string | null;
  recap: Recap | null;
  auto: AutoRecap | null;
}

export interface PanePreviewBlock {
  label: string | null;
  lines: PreviewLine[];
  recapAt: number | null;
  standIn: boolean;
}

/**
 * Split `rows` between two blocks' bodies. Even by default; if one side's
 * actual content needs fewer rows than its even share, the unused rows go to
 * the other side before either is truncated.
 *
 * Not a reuse of `layout.ts`'s `allocate()` — that distributes by weight/cap
 * across N competing boxes, and has no notion of "how many rows a consumer can
 * actually use," which is exactly what give-back needs here. A dedicated
 * two-item helper is simpler than bending a weight/cap allocator to answer a
 * question it was not built to answer.
 */
export function splitPreviewRows(
  aWrappedLen: number,
  bWrappedLen: number,
  rows: number,
): [number, number] {
  const total = Math.max(0, rows);
  // The remainder of an odd total goes to `a` — the freshest block, by the
  // time this is called with real (sorted) inputs.
  const evenA = Math.ceil(total / 2);
  const evenB = total - evenA;
  const aNeeds = Math.max(0, aWrappedLen);
  const bNeeds = Math.max(0, bWrappedLen);

  let aShare = Math.min(aNeeds, evenA);
  let bShare = Math.min(bNeeds, evenB);
  // Give unused rows to whichever side can still use more — but only as much
  // as it can use. Two short blocks should not sum back up to `total`; the
  // rest of the panel just goes unused, same as a single short block does
  // today (buildPreview already returns fewer than `rows` lines when the
  // content is short).
  let leftover = total - aShare - bShare;
  const aExtra = Math.min(leftover, aNeeds - aShare);
  aShare += aExtra;
  leftover -= aExtra;
  bShare += Math.min(leftover, bNeeds - bShare);

  return [aShare, bShare];
}

/**
 * Up to two panes' recaps, freshest first, each fit to its own row share.
 *
 * `rows` is the body budget only — subtitle rows (one per block) are the
 * caller's to reserve, the same way it already reserves the facts line and
 * the worktree line, since that is where the rest of the panel's chrome
 * budgeting already lives.
 */
export function buildMultiPreview(
  inputs: readonly PanePreviewInput[],
  width: number,
  rows: number,
): PanePreviewBlock[] {
  const resolved = inputs
    .map((input) => ({ label: input.label, ...resolveContent(input.recap, input.auto) }))
    // Freshest first; a pane that has never published anything (`at` null)
    // sorts last rather than winning ties against a real timestamp.
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));

  const budget = Math.max(0, rows);

  if (resolved.length <= 1) {
    return resolved.map((r) => ({
      label: r.label,
      lines: fitText(r.text, r.tone, width, budget),
      recapAt: r.at,
      standIn: r.standIn,
    }));
  }

  const wrappedLens = resolved.map((r) => wrapText(r.text, width).length);
  const bodyRows = splitPreviewRows(wrappedLens[0], wrappedLens[1], budget);

  return resolved.map((r, i) => ({
    label: r.label,
    lines: fitText(r.text, r.tone, width, bodyRows[i]),
    recapAt: r.at,
    standIn: r.standIn,
  }));
}

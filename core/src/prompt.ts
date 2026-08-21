/**
 * The opening turn a freshly spawned pane gets, and the wizard's prompt-input
 * text wrapping.
 *
 * There used to be a context packet here too — a pre-computed slice of a work
 * wiki, written to disk so the opener could point at it in a few characters.
 * A generic tool has no wiki to slice, so that whole mechanism (and its
 * per-section character budgets) is gone; the opener is plain prose now.
 */
import type { BoxDef, Mode } from "./model.ts";
import { MODES } from "./model.ts";

/** What one pane is there to do. One per pane of a session, in pane order. */
export type Role = "plan" | "impl" | "question" | "quick" | "research";

export interface OpenerInput {
  /** What was typed at spawn time, already collapsed to one line. Empty when
   *  nothing was typed. */
  task: string;
}

/** Every opener ends with this, worded with no apostrophes or quote
 *  characters: it is embedded in a shell-quoted pane command (see spawn.ts's
 *  paneCommand and tmux.ts's buildCreateSessionCmd), and each layer of
 *  quoting expands a literal quote fourfold. */
const RECAP_SENTENCE =
  "After each meaningful step run cc-recap with a one-line headline and then detail lines, so the dashboard shows what you are doing.";

/**
 * The opening turn.
 *
 * `box` is accepted but not read in the text below — every role's framing is
 * generic now that there is no per-box wiki context to fold in — kept in the
 * signature because a future role or box-specific opener is a one-line change
 * away rather than a threading exercise.
 *
 * It has to stay single-line: this is passed as the pane's command, and a
 * multi-line prompt is what makes send-keys delivery ambiguous.
 */
export function openingPrompt(role: Role, box: BoxDef, opts: OpenerInput): string {
  void box;
  const task = opts.task.trim();
  const taskClause = task ? ` Task: ${/[.!?]$/.test(task) ? task : `${task}.`}` : "";

  switch (role) {
    case "plan":
      return (
        `You are the planning half of this session: research and plan only, ending at ` +
        `ExitPlanMode - the pane beside you implements.${taskClause} ${RECAP_SENTENCE}`
      );
    case "impl":
      return `Wait for the approved plan before you start.${taskClause} ${RECAP_SENTENCE}`;
    case "question":
      return task ? `${taskClause.trim()} ${RECAP_SENTENCE}` : `Await my questions. ${RECAP_SENTENCE}`;
    case "quick":
      return (
        `This is meant to be a small, self-contained change: take it end to end rather ` +
        `than splitting planning from implementation.${taskClause} ${RECAP_SENTENCE}`
      );
    case "research":
      return (
        `Investigate as far as it goes and report what you find; do not change ` +
        `code.${taskClause} ${RECAP_SENTENCE}`
      );
  }
}

/**
 * Which roles a session's panes take, in pane order.
 *
 * Pane count comes from MODES so adding a class does not mean remembering to
 * edit this too; the role names are per class, because what a pane is FOR is a
 * decision rather than a count.
 */
export function paneRoles(mode: Mode): Role[] {
  if (MODES[mode].panes === 2) return ["plan", "impl"];
  switch (mode) {
    case "quick":
      return ["quick"];
    case "research":
      return ["research"];
    default:
      return ["question"];
  }
}

/**
 * The last `maxLines` display lines of `text`, hard-wrapped at `width`.
 *
 * For the wizard's prompt input, which reserves its height before it draws (see
 * wizardRows): the tail is what you are typing, so the tail is what stays on
 * screen. Pure, and tested, because an off-by-one here does not look like a
 * wrapping bug — Ink resolves an overflowing column by drawing children on top
 * of one another, so it looks like a missing line somewhere else entirely.
 *
 * Wraps on width alone, not on word boundaries: this echoes what was typed, and
 * a soft-wrapped echo that reflows as you type is harder to read than a hard one.
 */
export function promptTailLines(text: string, width: number, maxLines: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    for (let i = 0; i < paragraph.length; i += w) lines.push(paragraph.slice(i, i + w));
  }
  if (lines.length === 0) return [""];
  return lines.slice(-Math.max(1, Math.floor(maxLines)));
}

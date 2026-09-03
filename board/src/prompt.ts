/**
 * The interactive prompts Claude Code blocks on, read out of the terminal.
 *
 * Claude Code stops for three kinds of decision — a permission prompt, an
 * `AskUserQuestion` picker, a plan/model menu — and all three render as the
 * same thing: a numbered list with a `❯` cursor and a footer. So this is one
 * parser, not three.
 *
 * WHY THE PANE AND NOT THE TRANSCRIPT. `AskUserQuestion` does record its
 * options as structured data in the transcript, which looks like the better
 * source right up until you compare the two. The terminal appends options the
 * tool never declared:
 *
 *     ❯ 1. Info            <- from the tool_use row
 *       2. Debug           <- from the tool_use row
 *       3. Warn            <- from the tool_use row
 *       4. Type something. <- appended by the TUI
 *       5. Chat about this <- appended by the TUI
 *
 * Rendering from the transcript would disagree with the terminal about what
 * the choices are and mis-map every key index. The pane carries the
 * descriptions too, so it is the source of truth here.
 *
 * The cost is that this reads an internal TUI layout, not a supported API. So
 * it fails CLOSED at four separate points: an unrecognised footer, numbering
 * that is not a plain 1..N, a menu with fewer than two options, and a menu
 * with no question line above it all return null rather than a guess.
 * Sending a wrong key into a live session is far worse than showing no
 * picker.
 *
 * Ported VERBATIM from the reference implementation's server/src/prompt.ts,
 * fixtures included (test/fixtures/pane-*.txt are that PR's own real
 * `tmux capture-pane` captures, copied rather than hand-written — see the
 * plan). The one change is `WAITING_STATUSES`/`mayHavePrompt`, re-gated below
 * on claude-monitor's own status vocabulary (core/src/model.ts) in place of
 * claude-board's status names.
 */
import { createHash } from "crypto";
import { NEEDS_USER, type Status } from "../../core/src/model.ts";

export interface PromptOption {
  /** The number shown in the terminal, and the key that selects it. */
  index: number;
  label: string;
  /** Continuation lines under the label. Empty when the menu has none. */
  description: string;
  /** Whether board can deliver this choice. */
  drivable: boolean;
  /** Why not, when it cannot. Rendered to the user, so it is a sentence. */
  reason: string;
}

export interface Prompt {
  /** The question itself, e.g. "Do you want to create fixture-a.txt?". */
  question: string;
  /** The `☐ Log level` eyebrow above the question, when there is one. */
  header: string;
  options: PromptOption[];
  /** Which option the terminal's own cursor is on, 1-based; 0 if none found. */
  cursor: number;
  /**
   * Multi-select menus need Space to toggle before Enter, a sequence this has
   * not verified, so the whole prompt is marked undrivable rather than guessed.
   */
  multiSelect: boolean;
  fingerprint: string;
}

/** A run of box-drawing characters — tmux gives us the TUI's own rules. */
const BORDER = /^[\s─━╌╍┄┅–—_=]+$/;

/**
 * An option line: optional cursor, a number, a dot, then the label.
 *
 * The cursor test is deliberately part of THIS pattern rather than a separate
 * "line starts with ❯" check. `❯` is also the ordinary chat prompt marker, and
 * during testing it sat on a line directly above a real menu — a naive
 * first-`❯`-wins scan picks that line every time.
 */
const OPTION = /^(\s*)(❯\s*)?(\d+)\.\s+(\S.*)$/;

/**
 * The footer is what proves a numbered list is a live menu.
 *
 * Both forms end with "Esc to cancel" but differ before it — a permission
 * prompt says `Esc to cancel · Tab to amend`, a question says `Enter to select
 * · ↑/↓ to navigate · Esc to cancel`. Requiring the common part is what stops
 * a numbered list in ordinary program output being mistaken for a menu.
 */
const FOOTER = /Esc to cancel/;

/** Multi-select menus say so in the footer. */
const MULTI = /space to (toggle|select)/i;

/** A header eyebrow: `☐ Log level` / `☑ Log level`. */
const HEADER = /^\s*[☐☑✓]\s*(\S.*)$/;

function isBorder(line: string): boolean {
  return line.trim() === "" || BORDER.test(line);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Whether board can deliver a given choice.
 *
 * "Type something." drops the terminal into a text field, which this picker has
 * no box for — offering a button that silently strands you mid-entry would be
 * worse than saying so.
 */
export function drivable(label: string, multiSelect: boolean): { ok: boolean; reason: string } {
  if (multiSelect) {
    return { ok: false, reason: "multi-select — answer this one in the terminal" };
  }
  if (/^type something/i.test(label.trim())) {
    return { ok: false, reason: "needs typing — open the terminal" };
  }
  return { ok: true, reason: "" };
}

export function fingerprint(question: string, labels: readonly string[]): string {
  return createHash("sha1").update([question, ...labels].join("\n")).digest("hex").slice(0, 16);
}

/**
 * Parse a captured pane into a prompt, or null if no menu is on screen.
 *
 * `capture-pane` returns the LIVE screen, and the TUI erases a menu once it is
 * answered — so "is there a menu visible" is the whole detection, with no need
 * to reason about scrollback.
 */
export function parsePrompt(pane: string): Prompt | null {
  const lines = pane.replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));

  // Anchor on the last footer: a pane can hold an old menu's leftovers above a
  // newer one, and the newest is the live one.
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;

  const multiSelect = MULTI.test(lines[footer]);

  // Collect option lines above the footer. They are NOT contiguous: a real
  // capture put option 5 below a border line, with options 1-4 above it. So
  // borders and blanks are skipped rather than treated as the end of the block.
  const found: { i: number; indent: number; index: number; cursor: boolean; label: string }[] = [];
  for (let i = footer - 1; i >= 0; i--) {
    const line = lines[i];
    const m = OPTION.exec(line);
    if (m) {
      found.push({
        i,
        indent: m[1].length,
        index: Number(m[3]),
        cursor: m[2] !== undefined,
        label: m[4].trim(),
      });
      continue;
    }
    if (isBorder(line)) continue;
    // A description belongs to the option below it in reading order, so it is
    // indented past that option's number. Anything else ends the block.
    if (found.length > 0 && indentOf(line) > found[found.length - 1].indent) continue;
    break;
  }
  if (found.length < 2) return null;

  found.reverse();

  // Fail closed on anything that is not a plain 1..N menu. A list that does not
  // number the way the keys work is one this cannot safely drive.
  if (found.some((o, n) => o.index !== n + 1)) return null;

  const first = found[0].i;
  const options: PromptOption[] = found.map((o, n) => {
    const end = n + 1 < found.length ? found[n + 1].i : footer;
    const description = lines
      .slice(o.i + 1, end)
      .filter((l) => !isBorder(l) && indentOf(l) > o.indent)
      .map((l) => l.trim())
      .join(" ");
    const d = drivable(o.label, multiSelect);
    return { index: o.index, label: o.label, description, drivable: d.ok, reason: d.reason };
  });

  // The question is the nearest real line above the first option; the header,
  // if any, sits one line above that.
  let question = "";
  let header = "";
  for (let i = first - 1; i >= 0 && i > first - 6; i--) {
    if (isBorder(lines[i])) continue;
    if (HEADER.test(lines[i])) {
      header = HEADER.exec(lines[i])![1].trim();
      break;
    }
    if (question === "") {
      question = lines[i].trim();
      continue;
    }
    break;
  }
  if (question === "") return null;

  const cursor = found.find((o) => o.cursor)?.index ?? 0;
  return {
    question,
    header,
    options,
    cursor,
    multiSelect,
    fingerprint: fingerprint(question, options.map((o) => o.label)),
  };
}

export function capturePaneCommand(session: string): string[] {
  return ["capture-pane", "-p", "-t", session];
}

/**
 * The keystrokes that select an option.
 *
 * The digit is used wherever the terminal shows one, because it is absolute —
 * it lands on the right option no matter where the cursor happens to be.
 * Past 9 there is no digit to press, so it falls back to moving the cursor,
 * which is why `cursor` is parsed at all.
 */
export function answerKeys(prompt: Prompt, index: number, session: string): string[][] {
  if (index <= 9) return [["send-keys", "-t", session, String(index)]];
  const from = prompt.cursor > 0 ? prompt.cursor : 1;
  const steps = index - from;
  const key = steps > 0 ? "Down" : "Up";
  const move: string[][] = [];
  for (let i = 0; i < Math.abs(steps); i++) move.push(["send-keys", "-t", session, key]);
  return [...move, ["send-keys", "-t", session, "Enter"]];
}

/** Matches `TmuxRunner` in lifecycle.ts; injectable so tests need no tmux. */
export type PaneRunner = (args: readonly string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * A short cache, because the dashboard polls every 2s and a blocked session's
 * menu does not change between two polls. Deliberately shorter than the poll so
 * a menu answered in the terminal disappears from the board promptly.
 */
export const PROMPT_CACHE_MS = 1_000;
const cache = new Map<string, { at: number; pane: string | null }>();

export function resetPromptCache(): void {
  cache.clear();
  refreshing.clear();
}

/**
 * Drop one session's cached read.
 *
 * Needed after sending keys: the cache is a poll optimisation, and re-reading
 * to confirm an answer landed must not be served the capture taken a moment
 * BEFORE the keystroke. That is exactly what happened the first time this ran
 * against a live session — the answer worked, the file appeared, and the route
 * still reported the menu as still up.
 */
export function forgetPrompt(session: string): void {
  cache.delete(session);
}

/**
 * How long to let the TUI redraw before checking whether a menu cleared.
 *
 * The keystroke is delivered synchronously but the redraw is not, so an
 * immediate re-read still sees the old screen.
 */
export const REDRAW_MS = 250;

/** Refreshes in flight, so a slow tmux cannot pile up spawns behind a poll. */
const refreshing = new Map<string, Promise<string | null>>();

async function refreshPane(session: string, run: PaneRunner, now: number): Promise<string | null> {
  const existing = refreshing.get(session);
  if (existing) return existing;
  const work = (async () => {
    try {
      const out = await run(capturePaneCommand(session));
      // A dead session is not an error worth surfacing — it is simply not
      // showing anything. Fail closed.
      const pane = out.ok ? out.stdout : null;
      // The CALLER's clock, not this function's. Stamping Date.now() while
      // callers pass an injected `now` puts two clocks in one cache, and an
      // entry ends up both fresh and stale depending on who asks — the same
      // mistake the PR cache made once.
      cache.set(session, { at: now, pane });
      return pane;
    } finally {
      refreshing.delete(session);
    }
  })();
  refreshing.set(session, work);
  return work;
}

/**
 * A session's pane, served from cache and refreshed BEHIND the response.
 *
 * Reading a pane means spawning `tmux capture-pane`, and a busy tmux server can
 * take a while to answer. So only the FIRST read for a session waits. After
 * that the last known pane is returned immediately and a refresh runs behind
 * it, which is exactly the right trade for what this feeds: a picker and a
 * "compacting" label, both of which are allowed to be a second old and
 * neither of which is worth stalling a page for.
 */
export async function capturePane(
  session: string,
  run: PaneRunner,
  now: number = Date.now(),
): Promise<string | null> {
  const hit = cache.get(session);
  if (hit && now - hit.at < PROMPT_CACHE_MS) return hit.pane;
  if (hit) {
    void refreshPane(session, run, now).catch(() => undefined);
    return hit.pane;
  }
  return refreshPane(session, run, now);
}

/** Whatever menu is on a session's screen. */
export async function capturePrompt(
  session: string,
  run: PaneRunner,
  now: number = Date.now(),
): Promise<Prompt | null> {
  const pane = await capturePane(session, run, now);
  return pane === null ? null : parsePrompt(pane);
}

/**
 * The permission mode, read from the terminal's own footer.
 *
 * NOT from the transcript, though it records a `permission-mode` row: that row
 * is written when a turn happens, so a session that has just been switched —
 * or has never taken a turn at all, which has no transcript whatsoever — would
 * report the wrong mode or none. The footer is always current.
 *
 * Four forms, captured from a live session while cycling through all of them:
 *   ⏸ plan mode on (shift+tab to cycle)
 *   ⏵⏵ auto mode on (shift+tab to cycle)
 *   ⏸ manual mode on
 *   ⏵⏵ accept edits on (shift+tab to cycle)
 */
export function parseMode(pane: string): string | null {
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /\b(plan|auto|manual|bypass permissions|accept edits)\s+(?:mode\s+)?on\b/i.exec(lines[i]);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export async function captureMode(
  session: string,
  run: PaneRunner,
  now: number = Date.now(),
): Promise<string | null> {
  const pane = await capturePane(session, run, now);
  return pane === null ? null : parseMode(pane);
}

/**
 * Whether a session's status is worth reading a pane for.
 *
 * Gating on status is what keeps this cheap: without it the dashboard would
 * shell out to tmux once per session every two seconds forever. A session
 * that is working is busy, not blocked on you, and never has a menu up.
 *
 * Re-gated on claude-monitor's own vocabulary (core/src/model.ts) rather than
 * claude-board's own status names, per the plan. `needsUser` alone
 * (awaiting/permission/error) is not quite enough here, though: unlike
 * claude-board, board's own `collectSessions()` (core/src/collect.ts) only
 * upgrades an `idle` pane to `permission` when it was ALREADY told to scrape
 * that pane's screen (`CollectDeps.paneSuggestsPrompt`) — which board's own
 * listing does not request, to keep the 2s poll to four process spawns
 * total. So a session sitting at a permission prompt that never triggered
 * Claude Code's own PreToolUse hook — most commonly the very first prompt in
 * a directory it has not seen before — reports `idle`, not `permission`,
 * from board's point of view. Reading `idle` panes too, exactly as
 * claude-board's own `WAITING_STATUSES` did, is what still finds that menu.
 */
export const WAITING_STATUSES: ReadonlySet<Status> = new Set<Status>([...NEEDS_USER, "idle"]);

export function mayHavePrompt(status: Status, tmux: string | null): boolean {
  return tmux !== null && WAITING_STATUSES.has(status);
}

/**
 * Whether a message is still sitting unsent in the composer.
 *
 * The composer is the LAST `❯` line on screen — the ones above it are turns
 * that were submitted. So this asks a narrow question: did the text we just
 * pasted fail to leave the box?
 *
 * It exists because that happens. Pasting and pressing Enter in the same breath
 * works on an idle session and loses the Enter on a busy one, which left the
 * message visible in the terminal and apparently unsent.
 */
export function inputHolds(pane: string, text: string): boolean {
  const first = text.split("\n")[0].trim();
  if (!first) return false;
  const lines = pane.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trimStart().startsWith("❯")) continue;
    // Compare on a prefix: the composer wraps and truncates long messages, so
    // requiring the whole thing would never match one.
    const probe = first.slice(0, 30);
    return line.includes(probe);
  }
  return false;
}

/**
 * A long-running operation the terminal is showing but the status file is not.
 *
 * Compaction is the case this exists for. `/compact` can take a minute on a big
 * transcript, and throughout it the status can stay quiet the whole time — so
 * the page had nothing to show and looked like it had stopped responding. The
 * terminal says `✻ Compacting conversation…` the whole time.
 *
 * The spinner glyph is deliberately not matched: it cycles through several
 * characters, and pinning one would work until the frame changed.
 */
export function parseActivity(pane: string): string | null {
  if (/Compacting conversation/i.test(pane)) return "compacting conversation";
  // The automatic one names the window it is compacting at.
  if (/Compacting at auto window/i.test(pane)) return "compacting conversation (auto)";
  return null;
}

export async function captureActivity(
  session: string,
  run: PaneRunner,
  now: number = Date.now(),
): Promise<string | null> {
  const pane = await capturePane(session, run, now);
  return pane === null ? null : parseActivity(pane);
}

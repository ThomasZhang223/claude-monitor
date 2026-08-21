/**
 * Turning what the user typed into a tmux-safe slug, suggesting a name when
 * they cannot be bothered, and deciding what creating that name would actually
 * do.
 *
 * Labels are free-form: the new-session prompt accepts anything, including
 * punctuation and non-Latin text. tmux session names may not contain `.` or
 * `:` (both are target-address syntax), and `formatSessionName` splits on `-`,
 * so the slug has to be reduced to `[a-z0-9-]` before it goes anywhere near a
 * tmux command line.
 */
import { MODE_ORDER, formatSessionName, type BoxId, type Mode } from "./model.ts";

/** Long enough to stay recognisable in a box row, short enough that
 *  `cc-<box>-work-<slug>` still fits a status line. */
export const MAX_SLUG_LEN = 40;

/** Used when a label reduces to nothing at all — a fully non-Latin label, or
 *  pure punctuation. Deterministic so the same input always lands in the same
 *  place, and `classifyName` then reports the collision rather than silently
 *  creating a second unnameable session. */
export const FALLBACK_SLUG = "session";

/** The reduction, without the empty-string fallback. `sanitizeLabel` and
 *  `validateLabel` both need to know whether anything survived. */
function slugify(label: string): string {
  return label
    .normalize("NFKD")
    // Strip combining marks left behind by NFKD, so "café spike" becomes
    // "cafe-spike" rather than "caf-spike".
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Everything that is not [a-z0-9] becomes a hyphen: whitespace, `.` and
    // `:` (illegal in a tmux name), and any character we did not fold above.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    // Truncation can land mid-hyphen, so trim again after the cut.
    .replace(/-+$/, "");
}

/** Free-form label -> tmux-safe slug. Never contains `.`, `:` or a space, and
 *  is never empty. */
export function sanitizeLabel(label: string): string {
  return slugify(label) || FALLBACK_SLUG;
}

/** Human-readable reason the label is unusable, or null if it is fine. */
export function validateLabel(label: string): string | null {
  if (!label.trim()) return "Label cannot be empty";
  if (!slugify(label)) return "Label must contain at least one letter or digit";
  return null;
}

/** NATO phonetic alphabet — short, memorable, easy to type, and unambiguous
 *  when read back. Mirrors the localstack monitor's instance naming so the two
 *  tools feel like one family. */
export const PHONETIC_POOL = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
  "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
  "xray", "yankee", "zulu",
] as const;

/** First phonetic name not already in use, falling back to `session-N`. */
export function suggestLabel(taken: Set<string>): string {
  for (const name of PHONETIC_POOL) {
    if (!taken.has(name)) return name;
  }
  // With `taken.size` names in use, one of `taken.size + 1` candidates must be
  // free, so this always terminates with a name.
  for (let i = 1; i <= taken.size + 1; i++) {
    const candidate = `session-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `session-${taken.size + 1}`;
}

/** What creating a session under this slug would do. */
export type NameClass =
  | { kind: "free" }
  /** The post-reboot recovery path: the work is still on disk, only the tmux
   *  session died, so the new session adopts the existing worktree.
   *
   *  `heldBy` names a LIVE session of a different class that already occupies
   *  that worktree, or null when nothing does. It exists because a worktree
   *  path is keyed by (box, slug) while a session is keyed by (box, mode,
   *  slug): `cc-<box>-work-cache-opt` and `cc-<box>-quick-cache-opt` are
   *  two different sessions that want the same tree and the same branch. The
   *  exact-name check above cannot see that, so an occupied tree used to be
   *  offered for adoption as though it were abandoned — which would put two
   *  live Claude sessions in one worktree. */
  | { kind: "adopt"; worktree: string; heldBy: string | null }
  /** Nothing to create — the caller re-attaches instead. */
  | { kind: "session-exists"; tmuxName: string };

export interface ClassifyOpts {
  box: BoxId;
  mode: Mode;
  /** Session names from the single `list-sessions` snapshot. */
  existingSessions: ReadonlySet<string>;
  /** Where this slug's worktree would live. */
  worktree: string;
  /** Injected rather than called directly, so this stays a pure function the
   *  tests can drive without touching a filesystem. */
  worktreeExists: (path: string) => boolean;
}

export function classifyName(slug: string, opts: ClassifyOpts): NameClass {
  const tmuxName = formatSessionName({ box: opts.box, mode: opts.mode, slug });
  // Exact name, not slug: `cc-<box>-work-alpha` and `cc-<box>-q-alpha` are
  // different sessions, and creating the second while the first runs is fine.
  if (opts.existingSessions.has(tmuxName)) return { kind: "session-exists", tmuxName };
  if (opts.worktreeExists(opts.worktree)) {
    return { kind: "adopt", worktree: opts.worktree, heldBy: worktreeHolder(slug, opts) };
  }
  return { kind: "free" };
}

/**
 * A live session of a DIFFERENT class that already occupies this slug's
 * worktree, or null.
 *
 * Same box, same slug, any other mode — because that is exactly the set of
 * names that `worktreePathFor(box, slug)` maps onto one directory and
 * `branchFor(slug)` maps onto one branch.
 */
function worktreeHolder(slug: string, opts: ClassifyOpts): string | null {
  for (const mode of MODE_ORDER) {
    if (mode === opts.mode) continue;
    const name = formatSessionName({ box: opts.box, mode, slug });
    if (opts.existingSessions.has(name)) return name;
  }
  return null;
}

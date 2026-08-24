/**
 * Shared vocabulary for the session monitor: statuses and their glyphs, the
 * box shape, poll cadences, layout breakpoints, and the tmux session-name
 * codec.
 *
 * Everything else in core/ consumes the shapes declared here, so this module
 * is written first and never imports from its siblings.
 */
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Everything this tool persists lives under one directory. */
export const STATE_DIR = path.join(os.homedir(), ".local", "share", "claude-monitor");
/** Append-only journal: session created, every recap change, session killed. */
export const HISTORY_PATH = path.join(STATE_DIR, "history.jsonl");
/** Hook-written per-session status, keyed by Claude's own session id. */
export const STATUS_DIR = path.join(STATE_DIR, "status");
/** Latest statusline payload, the only source of rate-limit percentages. */
export const USAGE_PATH = path.join(STATE_DIR, "usage.json");

/** Claude Code's own state, which we read and never write. */
export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_DIR, "sessions");
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

/** A box's identity token: the second field of a tmux session name. Kept as a
 *  named alias (rather than writing `string` everywhere) so a reader can tell
 *  "this is a box id" from "this is arbitrary text" at a glance — even though
 *  the underlying type carries no compile-time restriction any more. Which ids
 *  actually exist is a runtime fact of config.ts's `Config.boxes`, not
 *  something this module can enumerate. */
export type BoxId = string;

/**
 * A box on the dashboard, as config.ts's `loadConfig()` produces it.
 *
 * `path` is the one field that used to be three (`repoDir`, `wikiDir`,
 * `ownerRepo`) — a folder is either there or it isn't, and everything else
 * (git-capable, worktree path, branch) is derived from it at use time rather
 * than stored, so nothing here can go stale. See repos.ts.
 */
export interface BoxDef {
  id: BoxId;
  /** Title rendered in the box's inset top edge. */
  label: string;
  /** Border colour, and the colour a working spinner takes inside this box. */
  color: string;
  /** Absolute path to the folder this box points at, or null for a catch-all
   *  box with no folder behind it. */
  path: string | null;
  /** Absolute directory new worktrees are created under, or null for the
   *  default: beside the box's own folder. Set this when the box's folder has
   *  siblings that must not be polluted — an umbrella checkout whose siblings
   *  are other repos, or a home directory. */
  worktreeRoot?: string | null;
}

/** The preview box's border. White, distinct from every box colour. */
export const PREVIEW_COLOR = "white";

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

/** What kind of session this is. A work session is two side-by-side panes
 *  (plan | implement); every other class is a single pane. Deliberately not
 *  called `kind` — that name is already taken by Claude's own
 *  `interactive` / `bg` field.
 *
 *  The tokens are also the `mode` field of a session name, so `q` stays `q`
 *  rather than becoming `question`: renaming it would orphan every running
 *  session on the next dashboard restart. */
export type Mode = "work" | "quick" | "q" | "research";

export interface ModeDef {
  id: Mode;
  /** Group heading inside a box, and the class picker's label. */
  label: string;
  /** The picker's one-line description of what the class is for. */
  hint: string;
  /** Panes the session gets. Two means plan | implement. */
  panes: 1 | 2;
  /** Which worktree option the wizard starts on. Classes that change code
   *  want their own tree; classes that only read do not. */
  worktree: "new" | "none";
}

/**
 * Everything that differs per class, in one place.
 *
 * Written as a table for the same reason BoxDef exists as a shape rather than
 * a hardcoded union: the alternative is a `mode === "work" ? … : …` in every
 * consumer, and every one of those silently treats a newly added class as "the
 * other thing". Adding a class here is meant to be the whole change, minus the
 * parts that genuinely need a decision (model choice, pane roles, permission
 * mode).
 */
export const MODES: Record<Mode, ModeDef> = {
  work: {
    id: "work",
    label: "WORK",
    hint: "plan | implement, two panes",
    panes: 2,
    worktree: "new",
  },
  quick: {
    id: "quick",
    label: "QUICK",
    hint: "one pane, opus/high - small PRs and hotfixes",
    panes: 1,
    worktree: "new",
  },
  q: {
    id: "q",
    label: "QUESTIONS",
    hint: "one pane, sonnet/high - answers, no changes",
    panes: 1,
    worktree: "none",
  },
  research: {
    id: "research",
    label: "RESEARCH",
    hint: "one pane, opus/high - open-ended investigation",
    panes: 1,
    worktree: "none",
  },
};

/** Group order inside a box, the class picker's order, and the order the cursor
 *  walks rows. One constant, so the renderer and the cursor cannot disagree —
 *  the hazard core/src/focus.ts's own header is written about. */
export const MODE_ORDER: readonly Mode[] = ["work", "quick", "q", "research"] as const;

export function isMode(v: string): v is Mode {
  return (MODE_ORDER as readonly string[]).includes(v);
}

/** Only sessions whose names start with this prefix are ours. It is what keeps
 *  unrelated local tmux sessions out of the dashboard entirely. */
export const SESSION_PREFIX = "cc";

export interface SessionName {
  box: BoxId;
  mode: Mode;
  /** Sanitised, tmux-safe. The human label lives in the @cc_label option. */
  slug: string;
}

/** `cc-<box>-<mode>-<slug>`. */
export function formatSessionName({ box, mode, slug }: SessionName): string {
  return `${SESSION_PREFIX}-${box}-${mode}-${slug}`;
}

/**
 * Inverse of formatSessionName. Splits on the first three delimiters only, so
 * a slug may itself contain hyphens. Returns null for anything that is not
 * shaped like one of ours.
 *
 * Validates SHAPE only — a box token matching `[a-z0-9]+` — not membership in
 * any particular set of configured boxes. Filtering to the boxes that actually
 * exist right now happens in tmux.ts's `parseSessionsOutput`, which is "the
 * only place that filtering happens" by its own header comment: keeping that
 * one place true means this function stays pure and never needs the config
 * threaded through it just to parse a name.
 */
export function parseSessionName(name: string): SessionName | null {
  const parts = name.split("-");
  if (parts.length < 4) return null;
  const [prefix, box, mode] = parts;
  if (prefix !== SESSION_PREFIX) return null;
  if (!/^[a-z0-9]+$/.test(box)) return null;
  if (!isMode(mode)) return null;
  const slug = parts.slice(3).join("-");
  if (!slug) return null;
  return { box, mode, slug };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type Status =
  | "working"      // thinking or running tools
  | "awaiting"     // finished, waiting on the user
  | "permission"   // blocked on a permission prompt
  | "idle"         // alive, nothing pending
  | "error"        // API failure — rate limit, auth
  | "dead";        // process gone

export interface StatusStyle {
  glyph: string;
  /** null means "use the containing box's colour". */
  color: string | null;
  /** Cycle the spinner frames in place of the glyph. */
  spin?: boolean;
  /** Blink to pull the eye — reserved for states needing user action. */
  blink?: boolean;
  label: string;
}

/** Status colours deliberately sit outside the box palette (see palette.ts) so
 *  a box border and a status mark can never read as the same thing. `working`
 *  is the exception: it takes its box's colour, which ties a busy row to its
 *  box. */
export const STATUS_STYLES: Record<Status, StatusStyle> = {
  working:    { glyph: "✶", color: null,      spin: true,  label: "working" },
  awaiting:   { glyph: "◆", color: "magenta", blink: true, label: "awaiting you" },
  permission: { glyph: "▲", color: "red",     blink: true, label: "needs permission" },
  idle:       { glyph: "◇", color: "gray",                 label: "idle" },
  error:      { glyph: "✗", color: "red",                  label: "error" },
  dead:       { glyph: "✗", color: "gray",                 label: "dead" },
};

/** Statuses that mean the session is blocked on the user. Drives the header
 *  counts and the preview's "show the active question" branch. */
export const NEEDS_USER: readonly Status[] = ["awaiting", "permission", "error"] as const;

export function needsUser(s: Status): boolean {
  return (NEEDS_USER as readonly string[]).includes(s);
}

export const SPINNER_FRAMES = ["✶", "✷", "✸", "✹", "✺", "✹", "✸", "✷"] as const;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One Claude Code process, as reported by ~/.claude/sessions/<pid>.json. */
export interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  /** Claude's own field: busy | idle | waiting. */
  rawStatus: string;
  statusUpdatedAt: number | null;
  /** interactive | bg. Only interactive sessions are rendered. */
  kind: string;
  name: string | null;
}

/** A tmux pane, from the single `list-panes -a` snapshot. */
export interface PaneInfo {
  session: string;
  windowIndex: number;
  paneIndex: number;
  panePid: number;
  currentCommand: string;
  currentPath: string;
}

/** One row on the dashboard: a tmux session of ours, plus whatever we could
 *  resolve about the Claude process(es) inside it. */
export interface SessionRecord {
  /** tmux session name — the identity used for every tmux call. */
  tmuxName: string;
  box: BoxId;
  mode: Mode;
  slug: string;
  /** Free-form label the user typed, from @cc_label. Falls back to slug. */
  label: string;
  /** Worktree path from @cc_worktree, if the session has one. */
  worktree: string | null;
  /** One-line recap the session published via cc-recap. */
  recap: string | null;
  /** Plan-file path the plan pane published, if any. */
  planPath: string | null;
  createdAt: number | null;
  /** Git branch of the worktree, refreshed on the slow tick. */
  branch: string | null;
  /** Worst status across the session's panes — what the row shows. */
  status: Status;
  /** Per-pane detail, ordered by pane index (0 = plan, 1 = implement). */
  panes: PaneRecord[];
  /** Context-window percentage from the statusline snapshot, if known. */
  contextPct: number | null;
  /** Model display name, e.g. "Opus 5". From the per-session snapshot. */
  model: string | null;
  /** Reasoning effort, e.g. "high". From the per-session snapshot. */
  effort: string | null;
  /** Wall-clock runtime so far, from the per-session snapshot. */
  runtimeMs: number | null;
  /** An in-flight `/wrap` this session is being killed after, from @cc_wrap. */
  wrap: PendingWrap | null;
  /** Whether this session is flagged as one being actively worked on, from
   *  @cc_flag. Display only — nothing else reads it. */
  flagged: boolean;
}

/**
 * The part of an in-flight wrap that rides the tmux session.
 *
 * Enough to resume the wait after the dashboard restarts: which pane the
 * command went to, which pane is queued behind it, and when it was sent. The
 * label a waiting message uses is not here — it comes off the record.
 *
 * Declared in this module rather than in wrap.ts, the same way AutoRecap is,
 * because SessionRecord carries one and this is the module that imports from no
 * sibling.
 */
export interface PendingWrap {
  /** Pane the command was sent to. */
  pane: number;
  /** The pane still queued after this one goes quiet, or null if this is the
   *  last (or only) pane. */
  next: number | null;
  sentAt: number;
}

export interface PaneRecord {
  paneIndex: number;
  panePid: number;
  status: Status;
  /** Resolved Claude session, when a descendant pid matched. */
  claude: ClaudeSession | null;
  /** This pane's own recap, read from its own transcript. Per pane rather than
   *  per session because the two panes of a work session are separate
   *  processes with separate accounts of themselves. */
  auto: AutoRecap | null;
}

/** Where an unpublished recap came from, which decides how it is presented. */
export type AutoRecapSource = "away" | "assistant";

/** A recap the session did not publish itself. Declared here rather than in
 *  recap.ts (which re-exports it) because PaneRecord carries one, and this
 *  module is the one that imports from no sibling. */
export interface AutoRecap {
  text: string;
  source: AutoRecapSource;
  /** Epoch ms the away-summary was written, or null for the last-message
   *  fallback (which is never compared for freshness) or an unparseable stamp. */
  at: number | null;
}

/** Which pane of a work session is which. */
export const PLAN_PANE = 0;
export const IMPL_PANE = 1;

// ---------------------------------------------------------------------------
// tmux user options
// ---------------------------------------------------------------------------

/** Live metadata rides on the tmux session, so it dies exactly when the
 *  session does and can never go stale or orphan. */
export const OPT_LABEL = "@cc_label";
export const OPT_RECAP = "@cc_recap";
export const OPT_WORKTREE = "@cc_worktree";
export const OPT_CREATED = "@cc_created";
export const OPT_PLAN = "@cc_plan";
/** An in-flight `/wrap` the session is to be killed after. Here rather than in
 *  the dashboard's own memory so that quitting the dashboard mid-wrap loses
 *  nothing: the intent belongs to the session, and dies with it. */
export const OPT_WRAP = "@cc_wrap";
/**
 * Sessions being actively worked on right now, as opposed to parked open.
 *
 * A display marker and nothing else reads it — but it rides the session for the
 * same reason OPT_WRAP does: it is a fact about the session, not about whichever
 * dashboard process last polled it. `monitor` has no hot reload outside `--dev`,
 * so relaunching it to pick up an edit must not silently clear every flag, and a
 * file under STATE_DIR would outlive the session it describes.
 *
 * ceiling: one boolean per session, not a set of named or coloured labels. If
 * several concurrent workstreams ever need telling apart, this becomes a small
 * enum here plus one tint per value in row.ts.
 */
export const OPT_FLAG = "@cc_flag";

/** The only value ever written to OPT_FLAG. A flag is set or unset rather than
 *  encoded, but both sides compare against one constant so they cannot drift. */
export const FLAG_ON = "1";

/** Order is load-bearing: it is the field order of the batched `-F` read that
 *  parseSessionsOutput splits positionally. Append, never insert. */
export const ALL_OPTS = [
  OPT_LABEL,
  OPT_RECAP,
  OPT_WORKTREE,
  OPT_CREATED,
  OPT_PLAN,
  OPT_WRAP,
  OPT_FLAG,
] as const;

// ---------------------------------------------------------------------------
// Cadences
// ---------------------------------------------------------------------------

/** Main tick: one `ps`, one `list-sessions`, one `list-panes -a`, plus the
 *  status files. Everything cheap. */
export const POLL_MS = 2000;
/** Spinner frame advance. */
export const SPINNER_MS = 200;
/** Blink duty cycle — longer on than off so the glyph stays readable. */
export const BLINK_ON_MS = 800;
export const BLINK_OFF_MS = 400;
/** capture-pane for the focused session only. */
export const PREVIEW_MS = 1500;
/** git branch + worktree lookups. */
export const GIT_MS = 30_000;
/** usage.json re-read + transcript token sums. */
export const USAGE_MS = 30_000;

/** A status file or session file older than this, with no other evidence, is
 *  treated as stale rather than current. */
export const STALE_STATUS_MS = 15_000;
/** Transcript untouched for longer than this means idle, not mid-turn. */
export const IDLE_TRANSCRIPT_MS = 30_000;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Columns one status glyph occupies, padding included. The status is the one
 *  thing scanned for across the whole dashboard, so it gets space of its own
 *  rather than sitting flush against the name. */
export const GLYPH_W = 3;
/** Glyph slots every row reserves, whether or not it has that many panes: one
 *  per pane of a work session. A `q` session renders its second slot blank, so
 *  the name column does not step sideways between a box's WORK and QUESTIONS
 *  groups. */
export const GLYPH_SLOTS = 2;
/** Divider between a row's two detail segments. */
export const SEGMENT_SEPARATOR = " │ ";
/**
 * Narrowest a split detail segment may be before the row shows one segment
 * instead of two.
 *
 * Below this a half can only ever hold a truncated fragment, which is worse
 * than the single line it replaced.
 */
export const MIN_SEGMENT_W = 24;

/**
 * Ceiling on the prompt typed at spawn time, and how much of it stays on screen.
 *
 * The cap is generous rather than tight — the prompt is the session's actual
 * first instruction, so a paragraph of framing is the normal case, not an abuse
 * of the field. It is still a cap: the prompt ends up inside the pane's command
 * line, and an unbounded paste storm belongs nowhere near an argv.
 *
 * Only the tail is rendered. The wizard's height is reserved before it draws
 * (see wizardRows), so the number of input rows has to be a constant rather
 * than growing with what is typed.
 */
export const PROMPT_MAX_CHARS = 2000;
export const PROMPT_VISIBLE_LINES = 4;

/** At or above this width the boxes go two-column, pairing off in config
 *  order with an odd final box spanning the full width. Below it everything
 *  stacks, one band per box. */
export const WIDE_COLUMNS = 150;
/** Below this height the preview collapses to a single line. */
export const SHORT_ROWS = 30;

/** Rows a box needs with no sessions at all: top edge, its "(no sessions)"
 *  line, bottom edge — plus a spare, since a box that is exactly full the moment
 *  anything lands in it has nowhere to draw the first row. Group headings are
 *  rendered only for classes that actually hold sessions, so an empty box never
 *  pays for four of them. Every box uses this same floor — no box is
 *  privileged with a taller minimum or a share-of-the-screen exemption; see
 *  layout.ts. */
export const BOX_MIN_ROWS = 4;
/** No single band may take more than this share of the boxes' area, so one
 *  busy box cannot starve the others. */
export const BOX_MAX_SHARE = 0.6;

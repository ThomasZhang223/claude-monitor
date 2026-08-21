/**
 * Everything we learn by reading Claude Code's own on-disk state: the per-pid
 * session files, the per-cwd transcript directories, and the hook-written
 * status files this tool owns.
 *
 * Two rules shape this module:
 *
 *  - All real IO goes through an injectable `FsDeps` seam, so tests exercise
 *    the parsing without a fixture tree under the real home directory. The
 *    default seam is the only place `node:fs` is touched.
 *  - Every decision function is pure. In particular `deriveStatus` takes its
 *    whole world as an argument (including `now`) so the status truth table is
 *    testable rather than merely observable.
 */
import * as fsp from "fs/promises";
import * as path from "path";
import {
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SESSIONS_DIR,
  IDLE_TRANSCRIPT_MS,
  STALE_STATUS_MS,
  STATUS_DIR,
  type ClaudeSession,
  type Status,
} from "./model.ts";

// ---------------------------------------------------------------------------
// Filesystem seam
// ---------------------------------------------------------------------------

/** The only filesystem surface this module needs. Narrow on purpose: a test
 *  fake is a handful of lines, and nothing here can reach outside these three
 *  operations. */
export interface FsDeps {
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
  /** Only mtime is ever read, so a fake need not synthesise a whole Stats. */
  stat(file: string): Promise<{ mtimeMs: number }>;
}

export const realFs: FsDeps = {
  readdir: (dir) => fsp.readdir(dir),
  readFile: (file) => fsp.readFile(file, "utf8"),
  stat: async (file) => ({ mtimeMs: (await fsp.stat(file)).mtimeMs }),
};

// ---------------------------------------------------------------------------
// Session files: ~/.claude/sessions/<pid>.json
// ---------------------------------------------------------------------------

/** Parse one session file's contents into a ClaudeSession.
 *
 *  `filenamePid` is the pid taken from the filename. The in-file `pid` is
 *  preferred because it is what the process itself wrote, but an older or
 *  partially written file may lack it and the filename is authoritative enough
 *  to keep the row alive.
 *
 *  Returns null for anything we cannot use, including `kind !== "interactive"`
 *  (see readClaudeSessions for why) — callers treat null as "skip silently". */
export function parseSessionFile(text: string, filenamePid: number): ClaudeSession | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // A session file can be read mid-write. Half a JSON object is normal, not
    // an error worth surfacing; the next tick two seconds later will get it.
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.sessionId !== "string" || typeof o.cwd !== "string") return null;

  // Background agents (`kind: "bg"`) inherit their parent's cwd verbatim, so
  // they are indistinguishable from their parent by path and would render as
  // phantom dashboard rows under whichever repo the parent happens to be in.
  // A Task/subagent is not a session the user can attach to, so it is dropped
  // here rather than filtered at the presentation layer.
  const kind = typeof o.kind === "string" ? o.kind : "";
  if (kind !== "interactive") return null;

  const pid = typeof o.pid === "number" && Number.isFinite(o.pid) ? o.pid : filenamePid;
  if (!Number.isFinite(pid) || pid <= 0) return null;

  return {
    pid,
    sessionId: o.sessionId,
    cwd: o.cwd,
    rawStatus: typeof o.status === "string" ? o.status : "",
    statusUpdatedAt:
      typeof o.statusUpdatedAt === "number" && Number.isFinite(o.statusUpdatedAt)
        ? o.statusUpdatedAt
        : null,
    kind,
    name: typeof o.name === "string" ? o.name : null,
  };
}

/** Every interactive Claude process Claude Code currently knows about.
 *
 *  Files whose name is not a pid, and files that fail to parse, are skipped
 *  without comment: this runs on every tick and a transient bad read must not
 *  blank the dashboard. */
export async function readClaudeSessions(deps: FsDeps = realFs): Promise<ClaudeSession[]> {
  let names: string[];
  try {
    names = await deps.readdir(CLAUDE_SESSIONS_DIR);
  } catch {
    return [];
  }

  const out: ClaudeSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const filenamePid = Number(name.slice(0, -".json".length));
    if (!Number.isInteger(filenamePid) || filenamePid <= 0) continue;
    let text: string;
    try {
      text = await deps.readFile(path.join(CLAUDE_SESSIONS_DIR, name));
    } catch {
      continue;
    }
    const session = parseSessionFile(text, filenamePid);
    if (session) out.push(session);
  }
  return out;
}

/** Convenience view for the pane resolver in procs.ts. */
export function sessionsByPid(sessions: readonly ClaudeSession[]): Map<number, ClaudeSession> {
  return new Map(sessions.map((s) => [s.pid, s]));
}

/** Is that pid still a live process?
 *
 *  Signal 0 performs the permission and existence check without delivering
 *  anything. EPERM means the process exists but is not ours, which still counts
 *  as alive. This is the backstop that keeps a crashed Claude from rendering as
 *  alive forever: it leaves its session file behind with `status: "busy"`, and
 *  no hook fires on a crash to correct it. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------
// Transcripts: ~/.claude/projects/<munged cwd>/<sessionId>.jsonl
// ---------------------------------------------------------------------------

/** Claude Code's cap on a munged directory name before it appends a hash. */
const MUNGED_MAX = 200;

/** Claude Code's own string hash for over-long paths: the classic
 *  `h = h * 31 + c` accumulator, forced back to int32 each step. Reproduced
 *  exactly so deep paths still resolve. */
function cwdHash(cwd: string): string {
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** The `~/.claude/projects` subdirectory holding a cwd's transcripts.
 *
 *  The transformation is blunt: EVERY non-alphanumeric character becomes `-`.
 *  That is why underscores turn into hyphens — there is no special case for
 *  them, `_` is simply not alphanumeric. Dots and spaces go the same way.
 *  Runs of separators are NOT collapsed, which is what makes
 *  `/private/tmp/x/-Users-you/y` produce a literal `--Users-you`.
 *
 *  For example:
 *    /Users/you/code/myrepo
 *      -> -Users-you-code-myrepo
 *    /Users/you/code/myrepo_ec2-worktree
 *      -> -Users-you-code-myrepo-ec2-worktree
 *
 *  Note the second: every git worktree is a sibling checkout with its own
 *  directory, so two panes on different worktrees of one repo have entirely
 *  separate transcript directories. Nothing merges them. */
export function transcriptDirForCwd(cwd: string): string {
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (munged.length <= MUNGED_MAX) return munged;
  return `${munged.slice(0, MUNGED_MAX)}-${cwdHash(cwd)}`;
}

/** Absolute path of the transcript directory for a cwd. */
export function transcriptDirPathForCwd(cwd: string): string {
  return path.join(CLAUDE_PROJECTS_DIR, transcriptDirForCwd(cwd));
}

async function transcriptEntries(
  cwd: string,
  deps: FsDeps,
): Promise<{ file: string; mtimeMs: number }[]> {
  const dir = transcriptDirPathForCwd(cwd);
  let names: string[];
  try {
    names = await deps.readdir(dir);
  } catch {
    // A brand new cwd has no transcript directory yet. Not an error.
    return [];
  }
  const entries: { file: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      entries.push({ file, mtimeMs: (await deps.stat(file)).mtimeMs });
    } catch {
      continue;
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

/** The cwd's `.jsonl` transcripts, newest mtime first.
 *
 *  A cwd accumulates every session ever run there — 237 files for the home
 *  directory on this machine — and several live sessions can share one cwd. So
 *  the newest file is NOT necessarily a given session's own. For anything
 *  session-specific, notably the lastAssistantText recap, read
 *  `transcriptDirPathForCwd(cwd)/<sessionId>.jsonl` directly instead; the
 *  newest-first order here is for the cwd-level "was there any activity"
 *  question that latestTranscriptMtime answers. */
export async function transcriptPathsFor(cwd: string, deps: FsDeps = realFs): Promise<string[]> {
  return (await transcriptEntries(cwd, deps)).map((e) => e.file);
}

/** Epoch ms of the most recently touched transcript for a cwd, or null if the
 *  cwd has none. Feeds the idle-vs-mid-turn judgement in deriveStatus. */
export async function latestTranscriptMtime(
  cwd: string,
  deps: FsDeps = realFs,
): Promise<number | null> {
  const entries = await transcriptEntries(cwd, deps);
  return entries.length > 0 ? entries[0].mtimeMs : null;
}

/**
 * Ceiling on the text returned, not a display width.
 *
 * It used to be 120 characters, sized for a one-line dashboard row — which meant
 * the preview, which wraps across as many rows as the window gives it, was handed
 * a sentence and a half ending in an ellipsis no matter how much space it had.
 * Truncation for display belongs to whoever is doing the displaying; this cap
 * exists only so a pathological message cannot be unbounded.
 */
export const LAST_MESSAGE_MAX = 4000;

/**
 * The last thing Claude said.
 *
 * Used as a fallback when a session has neither published a recap nor written one
 * of its own, so that a row is never blank. Pure: takes the transcript's text.
 *
 * Line breaks are preserved — a wrapping reader can use them as paragraph
 * boundaries, and a one-line reader flattens them itself. Runs of spaces and tabs
 * do get collapsed, since those are markdown indentation rather than meaning.
 *
 * Scans backwards and keeps going past assistant records that carry no prose — in
 * real transcripts the overwhelming majority of assistant records are pure
 * `tool_use` or pure `thinking` blocks, so stopping at the first assistant record
 * would almost always yield nothing. Sidechain records are skipped because those
 * are subagent turns, not the session's own voice.
 */
export function lastAssistantText(
  jsonlText: string,
  maxChars: number = LAST_MESSAGE_MAX,
): string | null {
  const lines = jsonlText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      // The final line of a live transcript is routinely a partial write.
      continue;
    }
    if (typeof rec !== "object" || rec === null) continue;
    const o = rec as Record<string, unknown>;
    if (o.type !== "assistant") continue;
    if (o.isSidechain === true) continue;
    const message = o.message;
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;

    let text: string;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as Record<string, unknown>).type === "text" &&
            typeof (b as Record<string, unknown>).text === "string",
        )
        .map((b) => b.text)
        .join(" ");
    } else {
      continue;
    }

    const tidied = text
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n[ \n]*\n[ \n]*/g, "\n\n")
      .replace(/ *\n */g, "\n")
      .trim();
    if (!tidied) continue;
    return tidied.length > maxChars ? `${tidied.slice(0, maxChars - 1)}…` : tidied;
  }
  return null;
}

/** Claude's own trailing note on its recap, which is UI chrome rather than part
 *  of what the session is doing. */
const RECAP_CHROME = /\s*\(disable recaps in \/config\)\s*$/;

export interface AwaySummary {
  text: string;
  /** Epoch ms the record itself was written, or null if unparseable. Lets a
   *  caller tell this apart in age from a deliberately published recap, so a
   *  stale one does not permanently outrank a fresher one written for free. */
  at: number | null;
}

/**
 * Claude Code's own recap of the session, if it has written one.
 *
 * This is the best recap there is and it costs nothing to get: Claude writes it
 * unprompted whenever it goes idle, as a `system` record with
 * `subtype: "away_summary"`, and it is exactly the "❋ recap:" text shown in the
 * pane. It says what the session did and what it is waiting for, in the
 * session's own words, which is precisely what a dashboard wants and what
 * neither a branch name nor the last assistant message reliably gives.
 *
 * Multi-line: the caller decides how to wrap it. Newest wins, so this scans
 * backwards.
 */
export function awaySummary(jsonlText: string): AwaySummary | null {
  const lines = jsonlText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    // Cheap reject before parsing: these records are a tiny fraction of a
    // transcript and JSON.parse over a megabyte of tool results is not free.
    if (!line.includes("away_summary")) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec !== "object" || rec === null) continue;
    const o = rec as Record<string, unknown>;
    if (o.type !== "system" || o.subtype !== "away_summary") continue;
    if (o.isSidechain === true) continue;
    if (typeof o.content !== "string") continue;
    const text = o.content.replace(RECAP_CHROME, "").trim();
    if (!text) continue;
    const parsed = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    return { text, at: Number.isFinite(parsed) ? parsed : null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook status files: STATUS_DIR/<sessionId>.json
// ---------------------------------------------------------------------------

/** What our own hooks write. The one piece of status we author ourselves. */
export interface HookStatus {
  /** working | awaiting | permission | error, plus whatever a future hook adds. */
  status: string;
  /** Free text for error states — rate limit, auth failure. */
  reason?: string;
  /** Epoch ms the hook fired. Used to age the entry out. */
  at: number;
}

export async function readHookStatus(
  sessionId: string,
  deps: FsDeps = realFs,
): Promise<HookStatus | null> {
  let text: string;
  try {
    text = await deps.readFile(path.join(STATUS_DIR, `${sessionId}.json`));
  } catch {
    // No hook has fired for this session yet, which is the common case.
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.status !== "string") return null;
  return {
    status: o.status,
    ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
    at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0,
  };
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

export interface DeriveStatusInput {
  /** The Claude process resolved for this pane, or null if none was. */
  claude: ClaudeSession | null;
  /** Result of isPidAlive on that process. Ignored when claude is null. */
  pidAlive: boolean;
  /** Our hook's last word on this session, if any. */
  hook: HookStatus | null;
  /** Newest transcript mtime for the session's cwd, or null. */
  transcriptMtime: number | null;
  /** Injected clock. Never call Date.now() in here — the truth table has to be
   *  reproducible. */
  now: number;
  /** Last-resort signal from the TUI's capture-pane text. See below. */
  paneSuggestsPrompt?: boolean;
}

/**
 * The single place a pane's Status is decided. Layered, most authoritative
 * source first, and pure so every cell of the truth table is a unit test.
 *
 * `permission` comes from our own Notification hook, which is the only signal
 * that sees it at all. It cannot be read off Claude's own status field: the
 * prompt is raised mid-turn, so that field still says `busy`. That is why the
 * hook check below sits ABOVE the rawStatus switch rather than beside the
 * quiet statuses — a blocked pane would otherwise render as a working one,
 * which is precisely the state the dashboard exists to make visible.
 *
 * `paneSuggestsPrompt` survives as the last resort for the one case the hook
 * cannot cover: a pane sitting at the trust-this-folder question, where no
 * Claude session exists yet to fire a hook. It can only ever upgrade an
 * already-quiet status.
 */
export function deriveStatus(input: DeriveStatusInput): Status {
  const { claude, pidAlive, hook, transcriptMtime, now, paneSuggestsPrompt } = input;

  // 0. Nothing resolved for this pane. The pane exists (something is running a
  //    shell in it) but no Claude process was found beneath it, so there is no
  //    session to report on. `idle` is the honest answer; whether such a pane
  //    is worth rendering at all is the caller's call, not ours.
  if (claude === null) return "idle";

  // 1. Liveness beats everything, without exception. A crash writes no hook
  //    event and leaves the session file frozen mid-turn, so a file claiming
  //    `busy`, or a hook file claiming `working`, is exactly what a dead
  //    session looks like. If the pid is gone, the session is gone.
  if (!pidAlive) return "dead";

  // 2. Errors only ever come from our own hook — Claude's session file has no
  //    error state. Honoured regardless of age: an error is sticky until the
  //    next hook event overwrites the file, and ageing it out would silently
  //    turn a rate-limited session back into a quiet one.
  if (hook?.status === "error") return "error";

  // 2b. Blocked on a permission prompt. Raised mid-turn, so Claude's own status
  //     field still reads `busy` — this must therefore outrank it, or every
  //     blocked pane renders as a working one. Not aged out, for the same
  //     reason `awaiting` below is not: it is self-correcting, since
  //     PostToolUse (approve), Stop (decline) and UserPromptSubmit all
  //     overwrite the file. Liveness above still wins, so a pane that died at
  //     a prompt is `dead` rather than eternally blocked.
  if (hook?.status === "permission") return "permission";

  // 3. Claude's own status field is the best live signal we have; it is
  //    rewritten continuously by the process itself.
  switch (claude.rawStatus) {
    case "busy":
      return "working";
    case "waiting":
      return upgradeIfPrompted("awaiting", paneSuggestsPrompt);
    // "idle" and anything unrecognised fall through to the quiet layer below.
  }

  // 4. Claude says idle. Our hook may know it is idle *because it has finished a
  //    turn and is waiting on the user*, which is strictly more useful to show.
  //
  //    Honoured regardless of age, and that is the whole point. The status is
  //    self-correcting: the moment the user replies, UserPromptSubmit overwrites
  //    the file with `working`, and any tool call does the same via PreToolUse.
  //    So an hour-old `awaiting` does not mean the signal went stale — it means
  //    nobody has answered yet, which is precisely when the dashboard needs to
  //    still be showing it. Ageing it out would blank the marker exactly while
  //    you were away from the desk, which is the case this tool exists for.
  //
  //    A crash cannot leave a false `awaiting` behind, because the liveness
  //    check above has already returned `dead` in that case.
  if (hook?.status === "awaiting") {
    return upgradeIfPrompted("awaiting", paneSuggestsPrompt);
  }

  // Both remaining branches are `idle`, and that is intentional rather than an
  // oversight. A transcript untouched for longer than IDLE_TRANSCRIPT_MS is
  // settled idle; a freshly touched one is idle-between-turns. They render the
  // same today, but the distinction is the reason the mtime is plumbed here at
  // all, so keep the branches split for whoever wants to separate them.
  const transcriptStale =
    transcriptMtime === null || now - transcriptMtime > IDLE_TRANSCRIPT_MS;
  if (transcriptStale) return upgradeIfPrompted("idle", paneSuggestsPrompt);
  return upgradeIfPrompted("idle", paneSuggestsPrompt);
}

/** Pane text is the only permission-prompt evidence we have, and it can only
 *  sharpen a quiet status — it must never override `working` or `dead`. */
function upgradeIfPrompted(base: Status, paneSuggestsPrompt: boolean | undefined): Status {
  if (!paneSuggestsPrompt) return base;
  return base === "awaiting" || base === "idle" ? "permission" : base;
}

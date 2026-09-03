/**
 * Sessions that have ENDED — the ones you can resume.
 *
 * A live session comes from board/src/sessions.ts's own join of
 * `collectSessions()` and `readClaudeSessions()`. Everything else that ever
 * ran left a transcript behind at
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, and Claude Code can
 * resume any of them by id. So "ended session" is simply "has a transcript,
 * is not live".
 *
 * This lists by `stat` alone and never opens a file — enriching every
 * transcript up front would read tens of megabytes to draw one screen.
 *
 * Ported unchanged from the reference implementation's server/src/history.ts,
 * except its one import: that file read `PROJECTS_DIR` from its own
 * `transcript.ts`, which this port deliberately does not carry over (see the
 * plan's hard constraints — core/src/claude.ts already reads this source,
 * correctly on macOS). The constant is the same path either way, so this
 * imports it from core/src/model.ts instead.
 */
import * as fs from "fs";
import * as path from "path";
import { CLAUDE_PROJECTS_DIR } from "../../core/src/model.ts";

/** How many ended sessions a single page holds. */
export const PAGE_SIZE = 50;

export interface HistoryEntry {
  sessionId: string;
  /** Absolute path to the transcript, for lazy enrichment. */
  file: string;
  /** Last write — how recently the session was active. */
  updatedAt: number;
  /** The directory the session was started in, decoded from the project
   *  folder name. Claude Code encodes it by replacing separators with `-`,
   *  which is lossy (a real `-` in a path is indistinguishable), so this is a
   *  display hint only — never a path to act on. */
  projectSlug: string;
}

export interface HistoryDeps {
  dir?: string;
  readDir?: (dir: string) => string[];
  statOf?: (p: string) => { mtimeMs: number; size: number } | null;
}

const realReadDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

const realStat = (p: string): { mtimeMs: number; size: number } | null => {
  try {
    const s = fs.statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
};

/**
 * Every transcript on disk, newest first.
 *
 * An empty transcript (size 0) is skipped: a session that registered and died
 * before writing anything is not something you can meaningfully resume.
 */
export function allTranscripts(deps: HistoryDeps = {}): HistoryEntry[] {
  const root = deps.dir ?? CLAUDE_PROJECTS_DIR;
  const readDir = deps.readDir ?? realReadDir;
  const statOf = deps.statOf ?? realStat;

  const out: HistoryEntry[] = [];
  for (const slug of readDir(root)) {
    for (const name of readDir(path.join(root, slug))) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(root, slug, name);
      const stat = statOf(file);
      if (!stat || stat.size === 0) continue;
      out.push({
        sessionId: name.slice(0, -".jsonl".length),
        file,
        updatedAt: stat.mtimeMs,
        projectSlug: slug,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Ended sessions: transcripts whose session is not currently live, newest
 * first, one page at a time.
 *
 * `liveIds` is passed in rather than read here so the caller makes exactly one
 * listing read per request and both halves of the picture agree about which
 * sessions are live — computing it twice could report a session as both.
 */
export function endedSessions(
  liveIds: ReadonlySet<string>,
  opts: { offset?: number; limit?: number } & HistoryDeps = {},
): { entries: HistoryEntry[]; total: number } {
  const all = allTranscripts(opts).filter((e) => !liveIds.has(e.sessionId));
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? PAGE_SIZE);
  return { entries: all.slice(offset, offset + limit), total: all.length };
}

/** The transcript for one session id, or null. Used when resuming a session
 *  that is no longer live. */
export function transcriptFor(sessionId: string, deps: HistoryDeps = {}): string | null {
  return allTranscripts(deps).find((e) => e.sessionId === sessionId)?.file ?? null;
}

/**
 * The recap a session publishes about itself.
 *
 * It lives in two places on purpose:
 *
 *  - `@cc_recap` on the tmux session — one line, the headline a row shows. It
 *    dies exactly when the session does, so it can never go stale.
 *  - `RECAP_DIR/<tmuxName>.txt` — the same headline plus as many detail lines as
 *    the session cares to write, which is what the preview reads. A tmux option
 *    cannot carry this: tab and newline are the `-F` field and record separators
 *    of the batched list-sessions read, so anything multi-line has to be a file.
 *
 * The file outliving its session is handled by reading, not by cleanup: a recap
 * stamped before the session was created belongs to a previous session that
 * happened to reuse the name, and is ignored. Cleanup on kill is hygiene, not
 * correctness.
 *
 * Format is deliberately not JSON — the writer is a shell script Claude itself
 * invokes, and hand-escaping JSON in bash is exactly the kind of thing that
 * silently produces a broken file:
 *
 *   line 1   epoch milliseconds
 *   line 2   headline
 *   line 3+  detail, verbatim
 */
import * as fs from "fs";
import * as path from "path";
import { STATE_DIR, type AutoRecap } from "./model.ts";
import { awaySummary, lastAssistantText, transcriptDirPathForCwd } from "./claude.ts";

export const RECAP_DIR = path.join(STATE_DIR, "recap");

export interface Recap {
  /** When the session published it, or null if the stamp was unreadable. */
  at: number | null;
  headline: string;
  detail: string[];
}

export function recapPath(tmuxName: string): string {
  return path.join(RECAP_DIR, `${tmuxName}.txt`);
}

/** Parse the on-disk form. Null for anything without a headline, since a recap
 *  with no headline is indistinguishable from no recap. */
export function parseRecap(text: string): Recap | null {
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  const stamp = Number(lines[0].trim());
  const headline = lines[1].trim();
  if (!headline) return null;
  // Trailing blanks are an artifact of the writer's final newline; blank lines
  // in the middle are the session's own paragraphing and are kept.
  const detail = [...lines.slice(2)];
  while (detail.length > 0 && detail[detail.length - 1].trim() === "") detail.pop();
  return { at: Number.isFinite(stamp) && stamp > 0 ? stamp : null, headline, detail };
}

export interface RecapDeps {
  /** Returns the file's text, or null if it is missing or unreadable. */
  readText?: (p: string) => string | null;
}

const readTextSync = (p: string): string | null => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

export interface ReadRecapOptions {
  /** Discard a recap stamped before this — it belongs to an earlier session of
   *  the same name, not this one. Pass the session's createdAt. */
  notBefore?: number | null;
}

export function readRecap(
  tmuxName: string,
  options: ReadRecapOptions = {},
  deps: RecapDeps = {},
): Recap | null {
  const text = (deps.readText ?? readTextSync)(recapPath(tmuxName));
  if (text === null) return null;
  const recap = parseRecap(text);
  if (!recap) return null;
  const floor = options.notBefore;
  if (floor != null && recap.at !== null && recap.at < floor) return null;
  return recap;
}

/** Remove a session's recap file. Called on kill; failure is not worth
 *  reporting, since a stale file is already handled on read. */
export function clearRecap(tmuxName: string, rm: (p: string) => void = fs.unlinkSync): void {
  try {
    rm(recapPath(tmuxName));
  } catch {
    // Nothing published, or already gone.
  }
}

// ---------------------------------------------------------------------------
// The automatic fallback
// ---------------------------------------------------------------------------

/** Bytes of transcript read from the end for the fallback recap. A live
 *  transcript runs to megabytes and the last assistant message is at the end,
 *  so reading the whole file to find it would be the most expensive thing the
 *  preview does. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export interface AutoRecapDeps {
  /** Last `bytes` of a file as text, or null if unreadable. */
  readTail?: (file: string, bytes: number) => string | null;
}

const readTailSync = (file: string, bytes: number): string | null => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, Math.max(0, size - length));
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
};

// Declared in model.ts, because PaneRecord carries one and that module imports
// from no sibling. Re-exported here so every existing `from "./recap.ts"`
// import keeps working, and so the type still reads as belonging to recaps.
export type { AutoRecap, AutoRecapSource } from "./model.ts";

/**
 * The session's recap when it has not published one itself.
 *
 * Two sources, in order:
 *
 *  1. Claude's OWN recap (`away_summary`), written unprompted every time the
 *     session goes idle. It is a real recap — what was done, what is next — so
 *     it needs no framing and no apology.
 *  2. The last thing the session said, which is only a stand-in: mid-thought,
 *     often about one file, and no summary of anything.
 *
 * Reads that session's OWN transcript — `<dir>/<sessionId>.jsonl`, not the
 * newest file in the directory. Every session started in the same worktree
 * shares one transcript directory, so "newest here" routinely belongs to a
 * different session, and both panes of a work session would otherwise show each
 * other's words.
 */
export function autoRecap(
  cwd: string,
  sessionId: string,
  deps: AutoRecapDeps = {},
): AutoRecap | null {
  const file = path.join(transcriptDirPathForCwd(cwd), `${sessionId}.jsonl`);
  const text = (deps.readTail ?? readTailSync)(file, TRANSCRIPT_TAIL_BYTES);
  if (text === null) return null;
  // The first line of a tail read is almost always a partial record; both
  // readers scan from the end and tolerate it.
  const away = awaySummary(text);
  if (away) return { text: away.text, source: "away", at: away.at };
  const said = lastAssistantText(text);
  return said ? { text: said, source: "assistant", at: null } : null;
}

// ---------------------------------------------------------------------------
// Caching, so every pane can afford a recap on every tick
// ---------------------------------------------------------------------------

/**
 * `autoRecap`, but re-reading only when the transcript actually changed.
 *
 * The preview could afford the uncached call: one focused session, two panes.
 * The dashboard row cannot. Every pane of every session wants a recap on the
 * 2s tick, and TRANSCRIPT_TAIL_BYTES is 256 KB — eight sessions is roughly 4 MB
 * of *synchronous* reads per tick, on the same thread Ink renders from, to
 * re-derive text that changes only when a session speaks.
 *
 * So the transcript is stat'd (cheap, and the mtime is the exact thing that
 * decides whether a re-read could produce anything new) and the tail is read
 * only when it moved. A quiet pane costs one `stat`.
 *
 * Note the null result is cached too. A pane whose transcript does not exist
 * yet is the common case for the first seconds of a session, and retrying the
 * open every tick is the same cost as succeeding.
 */
interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: AutoRecap | null;
}

const autoRecapCache = new Map<string, CacheEntry>();

export interface AutoRecapCacheDeps extends AutoRecapDeps {
  /** mtime + size of a file, or null when it cannot be stat'd. */
  statFile?: (file: string) => { mtimeMs: number; size: number } | null;
}

const statFileSync = (file: string): { mtimeMs: number; size: number } | null => {
  try {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
};

export function autoRecapCached(
  cwd: string,
  sessionId: string,
  deps: AutoRecapCacheDeps = {},
): AutoRecap | null {
  const file = path.join(transcriptDirPathForCwd(cwd), `${sessionId}.jsonl`);
  const stat = (deps.statFile ?? statFileSync)(file);
  const cached = autoRecapCache.get(sessionId);

  // Size is compared alongside mtime because a transcript is appended to, and
  // a coarse filesystem timestamp can leave two writes inside the same tick
  // looking identical by mtime alone.
  if (cached && stat && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.value;
  }
  if (cached && !stat) {
    // The transcript went away (or became unreadable) — hold the last known
    // recap rather than blanking the row over a transient stat failure.
    return cached.value;
  }

  const value = autoRecap(cwd, sessionId, deps);
  if (stat) autoRecapCache.set(sessionId, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/**
 * Drop cached recaps for sessions that no longer exist.
 *
 * Called once per collect tick with the ids still alive. Without it the cache
 * is a slow leak in a dashboard that is meant to run for days, holding a recap
 * string per session ever seen.
 */
export function pruneAutoRecapCache(liveSessionIds: Iterable<string>): void {
  const live = liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds);
  for (const id of autoRecapCache.keys()) {
    if (!live.has(id)) autoRecapCache.delete(id);
  }
}

/** Forget everything. Only tests need this. */
export function resetAutoRecapCache(): void {
  autoRecapCache.clear();
}

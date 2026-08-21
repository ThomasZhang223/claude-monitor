/**
 * The append-only journal.
 *
 * This is the only thing this tool persists that has to outlive a reboot. Live
 * metadata rides on the tmux session as user options, which is what keeps it
 * from ever going stale — but it also means a reboot destroys the tmux server
 * and takes every recap with it, while the worktrees survive. The journal is
 * what lets you still see what a session was doing after that.
 *
 * Appended on create, on every recap change, and on kill. Not only on kill:
 * a crash or a reboot never reaches the kill path.
 */
import * as fs from "fs";
import * as path from "path";
import { HISTORY_PATH, type BoxId, type Mode } from "./model.ts";

export type HistoryEvent = "created" | "recap" | "killed" | "adopted";

export interface HistoryEntry {
  at: number;
  event: HistoryEvent;
  tmuxName: string;
  box: BoxId;
  mode: Mode;
  label: string;
  worktree?: string | null;
  recap?: string | null;
}

export interface HistoryDeps {
  appendFile(filePath: string, data: string): void;
  readFile(filePath: string): string | null;
  mkdirp(dirPath: string): void;
}

export const defaultHistoryDeps: HistoryDeps = {
  appendFile(filePath, data) {
    fs.appendFileSync(filePath, data);
  },
  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  },
  mkdirp(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  },
};

/** One JSON object per line. Append-only, so a truncated final line from a
 *  crash costs at most the last entry and never the file. */
export function append(
  entry: HistoryEntry,
  deps: HistoryDeps = defaultHistoryDeps,
  historyPath: string = HISTORY_PATH,
): void {
  try {
    deps.mkdirp(path.dirname(historyPath));
    deps.appendFile(historyPath, JSON.stringify(entry) + "\n");
  } catch {
    // The journal is a record, not a dependency. Never let it break a spawn.
  }
}

export function parseHistory(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as HistoryEntry;
      if (parsed && typeof parsed.tmuxName === "string") out.push(parsed);
    } catch {
      // A half-written final line from a crash. Skip it, keep the rest.
    }
  }
  return out;
}

export function readHistory(
  deps: HistoryDeps = defaultHistoryDeps,
  historyPath: string = HISTORY_PATH,
): HistoryEntry[] {
  const text = deps.readFile(historyPath);
  return text === null ? [] : parseHistory(text);
}

/**
 * The last recap recorded for a session name, from the journal rather than from
 * tmux. This is the post-reboot answer to "what was this worktree doing?", when
 * the user option that held it no longer exists.
 */
export function lastRecapFor(
  tmuxName: string,
  deps: HistoryDeps = defaultHistoryDeps,
  historyPath: string = HISTORY_PATH,
): string | null {
  const entries = readHistory(deps, historyPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.tmuxName === tmuxName && e.recap) return e.recap;
  }
  return null;
}

/** Only append a recap when it actually changed, so a session that republishes
 *  the same line every tick does not grow the journal without bound. */
export function recapChanged(previous: string | null, next: string | null): boolean {
  if (next === null || next.trim() === "") return false;
  return previous !== next;
}

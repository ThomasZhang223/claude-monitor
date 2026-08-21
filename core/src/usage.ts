/**
 * Usage numbers, from the two places they can be had.
 *
 * There are two entirely separate sources and neither substitutes for the other:
 *
 *  1. RATE LIMITS (the 5-hour and 7-day percentages). These exist ONLY in the
 *     statusline payload Claude Code hands its statusline command on stdin. No
 *     file on disk carries them and no external process can ask for them, so a
 *     statusline wrapper (a later phase) snapshots that payload to USAGE_PATH
 *     and we read the snapshot. That makes the bars only as fresh as the last
 *     live session, which is why snapshotAge/isSnapshotStale exist: a stale
 *     snapshot must be rendered grey with its age, never as a confident number.
 *
 *  2. TOKEN TOTALS. Summed from the JSONL transcripts under
 *     CLAUDE_PROJECTS_DIR. These are LOCAL ESTIMATES. They will not tie out
 *     against what `/usage` shows: we only see transcripts still on this disk,
 *     records can be duplicated by session forks/resumes, and `/usage`'s own
 *     per-model breakdown is rendered text with no machine-readable form. Treat
 *     every total here as "roughly, locally" and never present it as billing.
 *
 * All filesystem access goes through an injected UsageDeps so tests run against
 * fixtures and never touch the real home directory.
 */
import * as path from "path";
import * as fs from "fs";
import { USAGE_PATH, CLAUDE_PROJECTS_DIR } from "./model.ts";

// ---------------------------------------------------------------------------
// Filesystem seam
// ---------------------------------------------------------------------------

/** Every read this module performs. Failures surface as null/empty, never as a
 *  throw: transcripts and the snapshot are written by other processes and can
 *  vanish or be half-written between one tick and the next. */
export interface UsageDeps {
  readFile(filePath: string): string | null;
  mtimeMs(filePath: string): number | null;
  listDir(dirPath: string): string[];
}

export const defaultUsageDeps: UsageDeps = {
  readFile(filePath) {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  },
  mtimeMs(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  },
  listDir(dirPath) {
    try {
      return fs.readdirSync(dirPath);
    } catch {
      return [];
    }
  },
};

// ---------------------------------------------------------------------------
// Rate limits: the statusline snapshot
// ---------------------------------------------------------------------------

/** Beyond this the snapshot is not describing now. 60s is two statusline
 *  redraws' worth of slack; past that the bars grey out. Lives here rather than
 *  in model.ts because only this module and its renderer care. */
export const STALE_SNAPSHOT_MS = 60_000;

/** The statusline payload, flattened to exactly the fields the dashboard shows.
 *  Every one is optional: the file is overwritten in place on every redraw, so a
 *  read can land mid-write, and older Claude Code builds omit whole sections. */
export interface UsageSnapshot {
  /** When the wrapper wrote it (epoch ms). Falls back to the file's mtime. */
  capturedAt: number | null;
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: number | null;
  costUsd: number | null;
  contextPct: number | null;
  modelName: string | null;
  /** Reasoning effort level, e.g. "high". From effort.level. */
  effortLevel: string | null;
  /** Wall-clock duration of the session so far, from cost.total_duration_ms. */
  durationMs: number | null;
  sessionId: string | null;
  /** workspace.current_dir — which checkout the last live session was in. */
  workspaceDir: string | null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Reset stamps arrive as epoch seconds, epoch ms, or ISO strings depending on
 *  the Claude Code build. Normalise to epoch ms; anything below 1e12 cannot be
 *  a millisecond stamp in this century, so it is seconds. */
function asEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.round(v < 1e12 ? v * 1000 : v);
  }
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Parsed usage.json, or null when the file is absent, empty, or truncated
 *  mid-write. A null return means "no snapshot", not "no usage". */
export function readUsageSnapshot(
  deps: UsageDeps = defaultUsageDeps,
  usagePath: string = USAGE_PATH,
): UsageSnapshot | null {
  const text = deps.readFile(usagePath);
  if (text === null || text.trim() === "") return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Half-written file. The next tick will get a whole one.
    return null;
  }
  const root = asObject(raw);
  if (!root) return null;

  const limits = asObject(root["rate_limits"]);
  const fiveHour = limits ? asObject(limits["five_hour"]) : null;
  const sevenDay = limits ? asObject(limits["seven_day"]) : null;
  const cost = asObject(root["cost"]);
  const context = asObject(root["context_window"]);
  const model = asObject(root["model"]);
  const workspace = asObject(root["workspace"]);

  const captured =
    asEpochMs(root["capturedAt"]) ??
    asEpochMs(root["captured_at"]) ??
    asEpochMs(root["updated_at"]) ??
    deps.mtimeMs(usagePath);

  return {
    capturedAt: captured,
    fiveHourPct: fiveHour ? asNumber(fiveHour["used_percentage"]) : null,
    fiveHourResetsAt: fiveHour ? asEpochMs(fiveHour["resets_at"]) : null,
    sevenDayPct: sevenDay ? asNumber(sevenDay["used_percentage"]) : null,
    sevenDayResetsAt: sevenDay ? asEpochMs(sevenDay["resets_at"]) : null,
    costUsd: cost ? asNumber(cost["total_cost_usd"]) : null,
    contextPct: context ? asNumber(context["used_percentage"]) : null,
    modelName: model ? asString(model["display_name"]) : null,
    effortLevel: (() => {
      const effort = asObject(root["effort"]);
      return effort ? asString(effort["level"]) : null;
    })(),
    durationMs: cost ? asNumber(cost["total_duration_ms"]) : null,
    sessionId: asString(root["session_id"]),
    workspaceDir: workspace ? asString(workspace["current_dir"]) : null,
  };
}

/** Milliseconds since the snapshot was written, or null when it carries no
 *  usable stamp (in which case the UI must treat it as stale). Clamped at 0 so
 *  a clock skew ahead of us does not read as a negative age. */
export function snapshotAge(snapshot: UsageSnapshot | null, now: number): number | null {
  if (!snapshot || snapshot.capturedAt === null) return null;
  return Math.max(0, now - snapshot.capturedAt);
}

/** An unknown age counts as stale: better a greyed bar than a confident wrong
 *  percentage. */
export function isSnapshotStale(age: number | null): boolean {
  return age === null || age > STALE_SNAPSHOT_MS;
}

// ---------------------------------------------------------------------------
// Token totals: the transcripts
// ---------------------------------------------------------------------------

/** The four token buckets a message reports, plus their sum.
 *
 *  `total` INCLUDES cacheRead. Cache reads are real tokens that really moved
 *  through the model (they are simply billed at a discount), so leaving them
 *  out understates volume by an order of magnitude — a long session is mostly
 *  cache reads. The parts stay exposed so a renderer that wants to split
 *  discounted from full-price tokens still can. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export function emptyTokenCounts(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
}

function makeCounts(input: number, output: number, cacheRead: number, cacheCreation: number): TokenCounts {
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return makeCounts(
    a.input + b.input,
    a.output + b.output,
    a.cacheRead + b.cacheRead,
    a.cacheCreation + b.cacheCreation,
  );
}

/** One counted message from a transcript. */
export interface UsageRecord {
  /** message.id when there was one, else a positional fallback key. */
  key: string;
  /** False when `key` is the positional fallback, so callers know the key is
   *  only unique within its own file. */
  hasId: boolean;
  /** message.model, e.g. "claude-opus-5". */
  model: string;
  /** The record's own timestamp in epoch ms, or null if it had none. */
  at: number | null;
  counts: TokenCounts;
}

export interface ParsedTranscriptUsage {
  /** First occurrence of each id, in file order. */
  records: UsageRecord[];
  byModel: Map<string, TokenCounts>;
  /** Real message ids seen, for callers deduping across several files. */
  messageIds: Set<string>;
}

/**
 * Sum one transcript's token usage. Pure: text in, counts out.
 *
 * THE DEDUPE TRAP. Claude Code appends one JSONL record per content block of an
 * assistant message — text, each thinking block, each tool_use — and every one
 * of those records repeats the SAME `message.usage` object, already totalled for
 * the whole message (the per-iteration copies live under `usage.iterations`).
 * Summing records naively therefore multiplies real usage by however many blocks
 * the average message had: measured across 50 recent transcripts on this machine
 * it inflated the total 2.5x (2.87e9 naive vs 1.13e9 deduped), and a single
 * transcript inflated 2.06x. So: the FIRST record carrying a given
 * `message.id` contributes, every later record with that id is ignored.
 *
 * Records with no usable id still count, keyed by line position. The tradeoff:
 * such a key is unique only within this file, so if the same idless record is
 * copied into a forked transcript it will be counted twice. That is the right
 * way round — undercounting real usage is worse than a rare double-count of an
 * anomalous record, and in practice every usage-bearing record sampled had an
 * id.
 */
export function parseTranscriptUsage(jsonlText: string): ParsedTranscriptUsage {
  const records: UsageRecord[] = [];
  const byModel = new Map<string, TokenCounts>();
  const messageIds = new Set<string>();
  const seenInFile = new Set<string>();

  const lines = jsonlText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // A transcript being appended to right now can end in a partial line.
      continue;
    }
    const root = asObject(raw);
    if (!root) continue;
    const message = asObject(root["message"]);
    if (!message) continue;
    const usage = asObject(message["usage"]);
    if (!usage) continue;

    const counts = makeCounts(
      asNumber(usage["input_tokens"]) ?? 0,
      asNumber(usage["output_tokens"]) ?? 0,
      asNumber(usage["cache_read_input_tokens"]) ?? 0,
      asNumber(usage["cache_creation_input_tokens"]) ?? 0,
    );
    // Claude Code's synthetic records (interrupts, API errors; model
    // "<synthetic>") carry an all-zero usage object. They would add nothing but
    // an empty row to the per-model breakdown.
    if (counts.total === 0) continue;

    const id = asString(message["id"]);
    const key = id ?? `line:${i}`;
    if (seenInFile.has(key)) continue;
    seenInFile.add(key);
    if (id) messageIds.add(id);

    const model = asString(message["model"]) ?? "unknown";
    const record: UsageRecord = {
      key,
      hasId: id !== null,
      model,
      at: asEpochMs(root["timestamp"]),
      counts,
    };
    records.push(record);
    byModel.set(model, addTokenCounts(byModel.get(model) ?? emptyTokenCounts(), counts));
  }

  return { records, byModel, messageIds };
}

export interface SumUsageOptions {
  /** Injected, never Date.now(): every bucket boundary derives from this. */
  now: number;
  /** Defaults to CLAUDE_PROJECTS_DIR. */
  projectsDir?: string;
}

export interface UsageTotals {
  /** Since local midnight relative to `now`. */
  today: TokenCounts;
  /** The trailing 7 days from `now`. */
  week: TokenCounts;
  allTime: TokenCounts;
  /** All-time split by model id, for the breakdown bar. */
  byModel: Map<string, TokenCounts>;
  /** Diagnostics: how much we actually looked at. */
  transcripts: number;
  messages: number;
}

/** Local midnight of the day containing `now`. Local, not UTC: "today" has to
 *  mean the user's day or the header lies every evening. */
function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Walk every transcript under `projectsDir` and bucket its tokens.
 *
 * LOCAL ESTIMATE — see the module header. Records are bucketed by their own
 * `timestamp`; when a record has none we fall back to the file's mtime, which
 * is the closest thing to "when this session last wrote".
 *
 * Dedupe is global across files, not just within one: resuming or forking a
 * session copies the parent's records into a new transcript, so the same
 * `message.id` legitimately appears in two files and must still count once.
 * Files are visited in sorted order so which copy wins is deterministic.
 */
export function sumUsageAcrossTranscripts(
  opts: SumUsageOptions,
  deps: UsageDeps = defaultUsageDeps,
): UsageTotals {
  const projectsDir = opts.projectsDir ?? CLAUDE_PROJECTS_DIR;
  const dayStart = startOfLocalDay(opts.now);
  const weekStart = opts.now - WEEK_MS;

  let today = emptyTokenCounts();
  let week = emptyTokenCounts();
  let allTime = emptyTokenCounts();
  const byModel = new Map<string, TokenCounts>();
  const seen = new Set<string>();
  let transcripts = 0;
  let messages = 0;

  for (const project of [...deps.listDir(projectsDir)].sort()) {
    const projectDir = path.join(projectsDir, project);
    const files = [...deps.listDir(projectDir)].filter((f) => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const text = deps.readFile(filePath);
      if (text === null) continue;
      transcripts++;
      const mtime = deps.mtimeMs(filePath) ?? opts.now;

      for (const record of parseTranscriptUsage(text).records) {
        // Idless records get a file-scoped key; see parseTranscriptUsage.
        const key = record.hasId ? record.key : `${filePath}#${record.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        messages++;

        const at = record.at ?? mtime;
        allTime = addTokenCounts(allTime, record.counts);
        if (at >= weekStart) week = addTokenCounts(week, record.counts);
        if (at >= dayStart) today = addTokenCounts(today, record.counts);
        byModel.set(
          record.model,
          addTokenCounts(byModel.get(record.model) ?? emptyTokenCounts(), record.counts),
        );
      }
    }
  }

  return { today, week, allTime, byModel, transcripts, messages };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface ModelShare {
  model: string;
  /** Proportion of the summed total, in [0, 1]. */
  fraction: number;
  counts: TokenCounts;
}

/** Per-model proportions, largest first, for the breakdown bar. Ties break on
 *  model id so the bar's segment order never jitters between ticks. */
/**
 * The tokens of the actual conversation: what was sent and what came back.
 *
 * Deliberately excludes cache reads, and that distinction is the difference
 * between a useful number and a meaningless one. Measured across a real corpus,
 * `cache_read_input_tokens` is 97-98% of the raw total — a single day showed
 * 100.8M total against 0.2M of real input and output, because every turn re-reads
 * the whole cached context and that re-read is counted in full. Reporting the raw
 * total makes every figure roughly two orders of magnitude larger than anything
 * you would recognise from `/usage`.
 *
 * Cache creation is included: it is genuinely new tokens written once.
 */
export function conversational(counts: TokenCounts): number {
  return counts.input + counts.output + counts.cacheCreation;
}

/**
 * Model shares, weighted by conversational tokens rather than the raw total.
 *
 * Weighting by the raw total would rank models by how much cached context they
 * happened to re-read, which says more about session length than about use.
 */
export function modelShare(byModel: Map<string, TokenCounts>): ModelShare[] {
  const entries = [...byModel.entries()];
  const total = entries.reduce((sum, [, counts]) => sum + conversational(counts), 0);
  return entries
    .map(([model, counts]) => ({
      model,
      // No usage at all yet is the normal cold-start state, not an error.
      fraction: total > 0 ? conversational(counts) / total : 0,
      counts,
    }))
    .sort(
      (a, b) => conversational(b.counts) - conversational(a.counts) || a.model.localeCompare(b.model),
    );
}

/**
 * A short model label that keeps the version.
 *
 * `claude-opus-4-8` and `claude-opus-5` are different models, and collapsing both
 * to "opus" renders two separate bars with the same name — which is exactly what
 * it looked like on screen before this existed.
 */
export function shortModelLabel(id: string): string {
  const m = id.match(/(opus|sonnet|haiku|fable)-?(\d+(?:-\d+)*)?/i);
  if (!m) return id.replace(/^claude-/, "").slice(0, 10);
  const family = m[1].toLowerCase();
  const version = (m[2] ?? "").replace(/-/g, ".");
  return version ? `${family}${version}` : family;
}

/** A fixed-width bar. Used for the rate-limit bars and the model breakdown, so
 *  it must be total about width: the caller has already reserved the columns.
 *  Fractions outside [0, 1] clamp and NaN reads as empty, because these numbers
 *  come from a file another process wrote. */
export function renderBar(fraction: number, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const w = Math.floor(width);
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.min(w, Math.max(0, Math.round(f * w)));
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/** Compact token counts for the header's narrow columns: "860k", "4.2M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

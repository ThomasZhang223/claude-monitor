import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readUsageSnapshot,
  snapshotAge,
  isSnapshotStale,
  STALE_SNAPSHOT_MS,
  parseTranscriptUsage,
  sumUsageAcrossTranscripts,
  modelShare,
  renderBar,
  formatTokens,
  emptyTokenCounts,
  type UsageDeps,
} from "../src/usage.ts";

// ---------------------------------------------------------------------------
// Fixtures. Nothing in this file may touch the real ~/.claude: every read goes
// through injected deps backed by this in-memory map.
// ---------------------------------------------------------------------------

interface FakeFile {
  text: string;
  mtimeMs?: number;
}

function fakeDeps(files: Record<string, FakeFile>): UsageDeps {
  return {
    readFile: (p) => (p in files ? files[p].text : null),
    mtimeMs: (p) => (p in files ? (files[p].mtimeMs ?? 0) : null),
    listDir: (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        names.add(p.slice(prefix.length).split("/")[0]);
      }
      return [...names];
    },
  };
}

interface LineSpec {
  id?: string | null;
  model?: string;
  ts?: string;
  block?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** One assistant record, shaped like the real transcripts: usage hangs off
 *  `message.usage`, the model off `message.model`, the id off `message.id`. */
function assistantLine(spec: LineSpec): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    model: spec.model ?? "claude-opus-5",
    content: [{ type: spec.block ?? "text" }],
    usage: {
      input_tokens: spec.input ?? 0,
      output_tokens: spec.output ?? 0,
      cache_read_input_tokens: spec.cacheRead ?? 0,
      cache_creation_input_tokens: spec.cacheCreation ?? 0,
      // The real payload repeats the same numbers under `iterations`; they must
      // never be summed on top of the top-level ones.
      iterations: [{ input_tokens: spec.input ?? 0, output_tokens: spec.output ?? 0 }],
    },
  };
  if (spec.id !== null) message["id"] = spec.id ?? "msg_default";
  const record: Record<string, unknown> = { type: "assistant", message };
  if (spec.ts) record["timestamp"] = spec.ts;
  return JSON.stringify(record);
}

// ---------------------------------------------------------------------------
// Rate-limit snapshot
// ---------------------------------------------------------------------------

const SNAPSHOT_PATH = "/fake/state/usage.json";

test("readUsageSnapshot: flattens the documented statusline payload", () => {
  const deps = fakeDeps({
    [SNAPSHOT_PATH]: {
      text: JSON.stringify({
        capturedAt: 1_700_000_000_000,
        session_id: "abc-123",
        workspace: { current_dir: "/Users/x/Documents/code/myrepo" },
        model: { id: "claude-opus-5", display_name: "Opus 5" },
        context_window: { used_percentage: 42.5 },
        cost: { total_cost_usd: 3.25, total_duration_ms: 45_000 },
        effort: { level: "high" },
        rate_limits: {
          five_hour: { used_percentage: 61, resets_at: 1_700_003_600_000 },
          seven_day: { used_percentage: 12.5, resets_at: 1_700_600_000_000 },
        },
      }),
    },
  });
  const snap = readUsageSnapshot(deps, SNAPSHOT_PATH);
  assert.deepEqual(snap, {
    capturedAt: 1_700_000_000_000,
    fiveHourPct: 61,
    fiveHourResetsAt: 1_700_003_600_000,
    sevenDayPct: 12.5,
    sevenDayResetsAt: 1_700_600_000_000,
    costUsd: 3.25,
    contextPct: 42.5,
    modelName: "Opus 5",
    effortLevel: "high",
    durationMs: 45_000,
    sessionId: "abc-123",
    workspaceDir: "/Users/x/Documents/code/myrepo",
  });
});

test("readUsageSnapshot: returns null for a missing, empty, or half-written file", () => {
  assert.equal(readUsageSnapshot(fakeDeps({}), SNAPSHOT_PATH), null);
  assert.equal(readUsageSnapshot(fakeDeps({ [SNAPSHOT_PATH]: { text: "" } }), SNAPSHOT_PATH), null);
  // usage.json is rewritten in place on every statusline redraw, so a read can
  // land mid-write and see a truncated object.
  const truncated = '{"rate_limits":{"five_hour":{"used_perc';
  assert.equal(readUsageSnapshot(fakeDeps({ [SNAPSHOT_PATH]: { text: truncated } }), SNAPSHOT_PATH), null);
});

test("readUsageSnapshot: a partial payload yields nulls, not throws, and dates from mtime", () => {
  const deps = fakeDeps({ [SNAPSHOT_PATH]: { text: "{}", mtimeMs: 555 } });
  const snap = readUsageSnapshot(deps, SNAPSHOT_PATH);
  assert.ok(snap);
  assert.equal(snap.capturedAt, 555);
  assert.equal(snap.fiveHourPct, null);
  assert.equal(snap.sevenDayPct, null);
  assert.equal(snap.costUsd, null);
  assert.equal(snap.modelName, null);
});

test("readUsageSnapshot: reset stamps normalise from epoch seconds and ISO strings", () => {
  const deps = fakeDeps({
    [SNAPSHOT_PATH]: {
      text: JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 1, resets_at: 1_700_003_600 },
          seven_day: { used_percentage: 2, resets_at: "2026-07-24T12:00:00.000Z" },
        },
      }),
    },
  });
  const snap = readUsageSnapshot(deps, SNAPSHOT_PATH);
  assert.equal(snap?.fiveHourResetsAt, 1_700_003_600_000);
  assert.equal(snap?.sevenDayResetsAt, Date.parse("2026-07-24T12:00:00.000Z"));
});

test("snapshotAge / isSnapshotStale: fresh stays live, old and unstamped go stale", () => {
  const fresh = { capturedAt: 1000 } as ReturnType<typeof readUsageSnapshot>;
  assert.equal(snapshotAge(fresh, 1000 + 5_000), 5_000);
  assert.equal(isSnapshotStale(5_000), false);
  assert.equal(isSnapshotStale(STALE_SNAPSHOT_MS + 1), true);
  // No stamp means we cannot claim freshness, so the bars grey out.
  assert.equal(snapshotAge({ ...fresh!, capturedAt: null }, 2000), null);
  assert.equal(isSnapshotStale(null), true);
  assert.equal(snapshotAge(null, 2000), null);
  // A clock ahead of ours must not read as a negative age.
  assert.equal(snapshotAge(fresh, 500), 0);
});

// ---------------------------------------------------------------------------
// Transcript parsing: the dedupe trap
// ---------------------------------------------------------------------------

test("parseTranscriptUsage: a message id repeated across content blocks counts once", () => {
  // Claude Code writes one record per content block, each repeating the SAME
  // already-totalled message.usage. msg_a's 900 tokens appear three times.
  const a = { id: "msg_a", input: 100, output: 200, cacheRead: 500, cacheCreation: 100 }; // 900
  const b = { id: "msg_b", input: 100, output: 100, cacheRead: 800, cacheCreation: 100 }; // 1100
  const text = [
    assistantLine({ ...a, block: "text" }),
    assistantLine({ ...a, block: "thinking" }),
    assistantLine({ ...a, block: "tool_use" }),
    assistantLine({ ...b, block: "tool_use" }),
  ].join("\n");

  const parsed = parseTranscriptUsage(text);
  assert.equal(parsed.records.length, 2, "one record per message, not per block");
  assert.deepEqual([...parsed.messageIds], ["msg_a", "msg_b"]);
  const total = parsed.records.reduce((s, r) => s + r.counts.total, 0);
  assert.equal(total, 2000);

  // What a naive per-record sum would have produced: 3*900 + 1100 = 3800, an
  // inflation of exactly 1.9x. Real transcripts on this machine inflate 2.0-2.5x.
  const naive = text
    .split("\n")
    .map((l) => JSON.parse(l).message.usage)
    .reduce(
      (s, u) =>
        s +
        u.input_tokens +
        u.output_tokens +
        u.cache_read_input_tokens +
        u.cache_creation_input_tokens,
      0,
    );
  assert.equal(naive, 3800);
  assert.equal(naive / total, 1.9);
});

test("parseTranscriptUsage: total includes cache reads and keeps the parts", () => {
  const parsed = parseTranscriptUsage(
    assistantLine({ id: "m1", input: 5, output: 7, cacheRead: 900, cacheCreation: 88 }),
  );
  assert.deepEqual(parsed.records[0].counts, {
    input: 5,
    output: 7,
    cacheRead: 900,
    cacheCreation: 88,
    total: 1000,
  });
});

test("parseTranscriptUsage: per-model split comes from message.model", () => {
  const text = [
    assistantLine({ id: "m1", model: "claude-opus-5", output: 100 }),
    assistantLine({ id: "m2", model: "claude-sonnet-5", output: 40 }),
    assistantLine({ id: "m3", model: "claude-sonnet-5", output: 60 }),
  ].join("\n");
  const { byModel } = parseTranscriptUsage(text);
  assert.equal(byModel.get("claude-opus-5")?.total, 100);
  assert.equal(byModel.get("claude-sonnet-5")?.total, 100);
});

test("parseTranscriptUsage: skips user records, zero-usage synthetics, and a partial last line", () => {
  const text = [
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "summary", summary: "no message at all" }),
    // Interrupts and API errors are logged as model "<synthetic>" with an
    // all-zero usage object; counting them would add an empty breakdown row.
    assistantLine({ id: "m_syn", model: "<synthetic>" }),
    assistantLine({ id: "m_real", output: 10 }),
    '{"type":"assistant","message":{"id":"m_cut","usa',
  ].join("\n");
  const parsed = parseTranscriptUsage(text);
  assert.deepEqual([...parsed.messageIds], ["m_real"]);
  assert.equal(parsed.byModel.has("<synthetic>"), false);
});

test("parseTranscriptUsage: records with no id still count, keyed by position", () => {
  const text = [
    assistantLine({ id: null, output: 10 }),
    assistantLine({ id: null, output: 20 }),
  ].join("\n");
  const parsed = parseTranscriptUsage(text);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.messageIds.size, 0);
  assert.deepEqual(parsed.records.map((r) => r.hasId), [false, false]);
  assert.notEqual(parsed.records[0].key, parsed.records[1].key);
});

// ---------------------------------------------------------------------------
// Bucketing across transcripts
// ---------------------------------------------------------------------------

const PROJECTS = "/fake/projects";
// Fixed local `now`: 2026-07-24 15:00 local. Local midnight is the day boundary.
const NOW = new Date(2026, 6, 24, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("sumUsageAcrossTranscripts: buckets today, week, and allTime off record timestamps", () => {
  const text = [
    assistantLine({ id: "t1", output: 100, ts: new Date(NOW - 2 * HOUR).toISOString() }),
    assistantLine({ id: "t2", output: 200, ts: new Date(NOW - 2 * DAY).toISOString() }),
    assistantLine({ id: "t3", output: 400, ts: new Date(NOW - 30 * DAY).toISOString() }),
  ].join("\n");
  const deps = fakeDeps({ [`${PROJECTS}/-Users-x/a.jsonl`]: { text, mtimeMs: NOW } });

  const totals = sumUsageAcrossTranscripts({ now: NOW, projectsDir: PROJECTS }, deps);
  assert.equal(totals.today.total, 100);
  assert.equal(totals.week.total, 300);
  assert.equal(totals.allTime.total, 700);
  assert.equal(totals.transcripts, 1);
  assert.equal(totals.messages, 3);
  assert.equal(totals.byModel.get("claude-opus-5")?.total, 700);
});

test("sumUsageAcrossTranscripts: a record with no timestamp is bucketed by file mtime", () => {
  const files = {
    [`${PROJECTS}/-Users-x/today.jsonl`]: {
      text: assistantLine({ id: "n1", output: 10 }),
      mtimeMs: NOW - HOUR,
    },
    [`${PROJECTS}/-Users-x/old.jsonl`]: {
      text: assistantLine({ id: "n2", output: 90 }),
      mtimeMs: NOW - 20 * DAY,
    },
  };
  const totals = sumUsageAcrossTranscripts({ now: NOW, projectsDir: PROJECTS }, fakeDeps(files));
  assert.equal(totals.today.total, 10);
  assert.equal(totals.week.total, 10);
  assert.equal(totals.allTime.total, 100);
});

test("sumUsageAcrossTranscripts: the same message id in a forked transcript counts once", () => {
  // Resuming a session copies the parent's records into a new file, so dedupe
  // has to be global across files, not per file.
  const shared = assistantLine({ id: "dup", output: 500, ts: new Date(NOW - HOUR).toISOString() });
  const files = {
    [`${PROJECTS}/-Users-x/parent.jsonl`]: { text: shared, mtimeMs: NOW },
    [`${PROJECTS}/-Users-x/fork.jsonl`]: {
      text: [shared, assistantLine({ id: "own", output: 5, ts: new Date(NOW - HOUR).toISOString() })].join("\n"),
      mtimeMs: NOW,
    },
  };
  const totals = sumUsageAcrossTranscripts({ now: NOW, projectsDir: PROJECTS }, fakeDeps(files));
  assert.equal(totals.transcripts, 2);
  assert.equal(totals.messages, 2);
  assert.equal(totals.allTime.total, 505);
});

test("sumUsageAcrossTranscripts: no transcripts is zeros, not a crash", () => {
  const totals = sumUsageAcrossTranscripts({ now: NOW, projectsDir: PROJECTS }, fakeDeps({}));
  assert.deepEqual(totals.allTime, emptyTokenCounts());
  assert.equal(totals.byModel.size, 0);
  assert.equal(totals.transcripts, 0);
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function counts(total: number) {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

test("modelShare: fractions sum to 1 and sort largest first", () => {
  const shares = modelShare(
    new Map([
      ["claude-sonnet-5", counts(250)],
      ["claude-opus-5", counts(750)],
    ]),
  );
  assert.deepEqual(shares.map((s) => s.model), ["claude-opus-5", "claude-sonnet-5"]);
  assert.deepEqual(shares.map((s) => s.fraction), [0.75, 0.25]);
  assert.equal(shares.reduce((s, m) => s + m.fraction, 0), 1);
});

test("modelShare: a zero total gives zero fractions, never NaN", () => {
  const shares = modelShare(new Map([["claude-opus-5", counts(0)]]));
  assert.equal(shares[0].fraction, 0);
  assert.ok(!Number.isNaN(shares[0].fraction));
  assert.deepEqual(modelShare(new Map()), []);
});

test("renderBar: exact width at 0, half, full, over-full, and NaN", () => {
  assert.equal(renderBar(0, 10), "░░░░░░░░░░");
  assert.equal(renderBar(0.5, 10), "█████░░░░░");
  assert.equal(renderBar(1, 10), "██████████");
  // A percentage past its limit clamps rather than overflowing the column.
  assert.equal(renderBar(1.5, 10), "██████████");
  assert.equal(renderBar(NaN, 10), "░░░░░░░░░░");
  assert.equal(renderBar(-1, 10), "░░░░░░░░░░");
  for (const f of [0, 0.5, 1, 1.5, NaN, -1, 0.333]) {
    assert.equal([...renderBar(f, 7)].length, 7, `width holds at ${f}`);
  }
  assert.equal(renderBar(0.5, 0), "");
});

test("formatTokens: compact enough for a narrow header column", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(860_000), "860k");
  assert.equal(formatTokens(4_200_000), "4.2M");
  assert.equal(formatTokens(31_700_000), "31.7M");
  assert.equal(formatTokens(2_500_000_000), "2.5B");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(NaN), "0");
});

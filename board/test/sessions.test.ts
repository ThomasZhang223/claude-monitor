import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaudeSession, PaneRecord, SessionRecord, Status } from "../../core/src/model.ts";
import {
  getSessionListing,
  resetSessionsCache,
  type SessionsDeps,
} from "../src/sessions.ts";

// ---------------------------------------------------------------------------
// Fixture builders. Every test supplies `boxIds: []` so buildListing() never
// falls back to loadConfig() and touches the machine's real config.json.
// ---------------------------------------------------------------------------

function claudeSession(overrides: Partial<ClaudeSession> & { pid: number }): ClaudeSession {
  return {
    sessionId: `sess-${overrides.pid}`,
    cwd: "/repo",
    rawStatus: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    name: null,
    ...overrides,
  };
}

function paneRecord(overrides: Partial<PaneRecord> = {}): PaneRecord {
  return {
    windowIndex: 0,
    paneIndex: 0,
    panePid: 100,
    status: "working",
    claude: null,
    auto: null,
    contextPct: null,
    ...overrides,
  };
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    tmuxName: "cc-box-work-slug",
    box: "box",
    mode: "work",
    slug: "slug",
    label: "slug",
    worktree: null,
    recap: null,
    planPath: null,
    createdAt: null,
    branch: null,
    status: "working",
    panes: [],
    contextPct: null,
    model: null,
    effort: null,
    runtimeMs: null,
    wrap: null,
    flagged: false,
    ...overrides,
  };
}

function deps(overrides: Partial<SessionsDeps> = {}): SessionsDeps {
  return {
    boxIds: [],
    collectSessions: async () => [],
    readClaudeSessions: async () => [],
    snapshotPs: async () => new Map(),
    ...overrides,
  };
}

test.beforeEach(() => {
  resetSessionsCache();
});

test("a boxed session's pid is not duplicated into the unboxed group", async () => {
  const claudeA = claudeSession({ pid: 111 });
  const claudeB = claudeSession({ pid: 222 });
  const boxed = sessionRecord({
    tmuxName: "cc-box-work-a",
    panes: [paneRecord({ claude: claudeA })],
  });

  const listing = await getSessionListing(
    deps({
      collectSessions: async () => [boxed],
      readClaudeSessions: async () => [claudeA, claudeB],
      snapshotPs: async () => new Map([[111, 1], [222, 1]]),
    }),
  );

  assert.equal(listing.boxed.length, 1);
  assert.equal(listing.boxed[0].tmuxName, "cc-box-work-a");
  assert.equal(listing.unboxed.length, 1);
  assert.equal(listing.unboxed[0].pid, 222);
});

test("an unboxed session's liveness comes from snapshotPs, not a /proc-style check", async () => {
  const alive = claudeSession({ pid: 444 });
  const dead = claudeSession({ pid: 555 });

  const listing = await getSessionListing(
    deps({
      readClaudeSessions: async () => [alive, dead],
      // Only pid 444 is in the ps snapshot. Nothing else in the pipeline could
      // report 555 as alive, so this is the only source of `live`.
      snapshotPs: async () => new Map([[444, 1]]),
    }),
  );

  const byPid = new Map(listing.unboxed.map((u) => [u.pid, u]));
  assert.equal(byPid.get(444)?.live, true);
  assert.equal(byPid.get(555)?.live, false);
});

test("needsUser sessions sort first, then by severity", async () => {
  const statuses: [string, Status][] = [
    ["a-working", "working"],
    ["b-dead", "dead"],
    ["c-idle", "idle"],
    ["d-awaiting", "awaiting"],
    ["e-permission", "permission"],
    ["f-error", "error"],
  ];
  const records = statuses.map(([name, status]) =>
    sessionRecord({ tmuxName: name, status, panes: [paneRecord({ status })] }),
  );

  const listing = await getSessionListing(deps({ collectSessions: async () => records }));

  assert.deepEqual(
    listing.boxed.map((s) => s.tmuxName),
    ["f-error", "e-permission", "d-awaiting", "a-working", "c-idle", "b-dead"],
  );
});

test("the 900ms cache single-flights: two concurrent calls make one collectSessions() call", async () => {
  let calls = 0;
  const d = deps({
    collectSessions: async () => {
      calls++;
      return [];
    },
  });

  const [first, second] = await Promise.all([getSessionListing(d), getSessionListing(d)]);

  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

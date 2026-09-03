/**
 * The board's view model: two independent sources, joined into one listing.
 *
 * `collectSessions()` sees every box-grouped tmux session — the `cc-<box>-
 * <mode>-<slug>` naming convention gives it box, colour, mode, panes and recap.
 * `readClaudeSessions()` sees every registered Claude Code process, including
 * one started by hand outside that naming convention, which the first call
 * never sees at all. Joining both is what keeps the board from losing it.
 */
import type { CollectDeps } from "../../core/src/collect.ts";
import { collectSessions as collectSessionsReal } from "../../core/src/collect.ts";
import type { FsDeps } from "../../core/src/claude.ts";
import { readClaudeSessions as readClaudeSessionsReal } from "../../core/src/claude.ts";
import type { PidMap, PsExec } from "../../core/src/procs.ts";
import { snapshotPs as snapshotPsReal } from "../../core/src/procs.ts";
import { loadConfig } from "../../core/src/config.ts";
import { needsUser } from "../../core/src/model.ts";
import type {
  BoxId,
  ClaudeSession,
  Mode,
  PaneRecord,
  PendingWrap,
  SessionRecord,
  Status,
} from "../../core/src/model.ts";

/** One pane's own status and context usage, addressed by (windowIndex,
 *  paneIndex) — a pane index alone is not unique across windows. */
export interface PaneView {
  windowIndex: number;
  paneIndex: number;
  status: Status;
  contextPct: number | null;
}

/** A box-grouped tmux session, joined from collectSessions(). `box` doubles as
 *  the colour source — board/web resolves it to a hex via GET /api/config. */
export interface SessionView {
  tmuxName: string;
  box: BoxId;
  mode: Mode;
  status: Status;
  recap: string | null;
  flagged: boolean;
  worktree: string | null;
  branch: string | null;
  planPath: string | null;
  wrap: PendingWrap | null;
  panes: PaneView[];
}

/** A registered Claude Code session collectSessions() never sees: started by
 *  hand, outside this tool's tmux naming convention. */
export interface UnboxedSessionView {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string | null;
  rawStatus: string;
  /** From snapshotPs()'s ps snapshot, not a /proc-style check — correct on
   *  macOS, where a Claude session's own recorded start time is not. */
  live: boolean;
}

export interface SessionListing {
  boxed: SessionView[];
  unboxed: UnboxedSessionView[];
}

/** How loudly a status asks for attention, worst first. A local copy of
 *  collect.ts's own SEVERITY table, which that module does not export. */
const SEVERITY: Record<Status, number> = {
  error: 5,
  permission: 4,
  awaiting: 3,
  working: 2,
  idle: 1,
  dead: 0,
};

/** A session needing the user sorts before every other session, then rows
 *  fall back to severity — error, permission, awaiting, working, idle, dead. */
function compareSessionView(a: SessionView, b: SessionView): number {
  const aNeeds = needsUser(a.status) ? 1 : 0;
  const bNeeds = needsUser(b.status) ? 1 : 0;
  if (aNeeds !== bNeeds) return bNeeds - aNeeds;
  return SEVERITY[b.status] - SEVERITY[a.status];
}

function toSessionView(r: SessionRecord): SessionView {
  return {
    tmuxName: r.tmuxName,
    box: r.box,
    mode: r.mode,
    status: r.status,
    recap: r.recap,
    flagged: r.flagged,
    worktree: r.worktree,
    branch: r.branch,
    planPath: r.planPath,
    wrap: r.wrap,
    panes: r.panes.map((p: PaneRecord) => ({
      windowIndex: p.windowIndex,
      paneIndex: p.paneIndex,
      status: p.status,
      contextPct: p.contextPct,
    })),
  };
}

export interface SessionsDeps {
  collectSessions?: (boxIds: readonly string[], deps?: CollectDeps) => Promise<SessionRecord[]>;
  readClaudeSessions?: (deps?: FsDeps) => Promise<ClaudeSession[]>;
  snapshotPs?: (exec?: PsExec) => Promise<PidMap>;
  /** Override for tests, so a listing never depends on the machine's real
   *  config.json. Production omits this and takes every box loadConfig() knows. */
  boxIds?: readonly string[];
}

async function buildListing(deps: SessionsDeps): Promise<SessionListing> {
  const collect = deps.collectSessions ?? collectSessionsReal;
  const readClaude = deps.readClaudeSessions ?? readClaudeSessionsReal;
  const snapPs = deps.snapshotPs ?? snapshotPsReal;
  const boxIds = deps.boxIds ?? loadConfig().boxes.map((b) => b.id);

  const [records, claudeSessions, pidMap] = await Promise.all([
    collect(boxIds),
    readClaude(),
    snapPs(),
  ]);

  const boxed = records.map(toSessionView).sort(compareSessionView);

  // A boxed session's panes already resolved their own Claude pids, via
  // collectSessions' own procs.ts walk. Anything sharing one of those pids is
  // the same process seen twice, not a second, unboxed session.
  const coveredPids = new Set<number>();
  for (const r of records) {
    for (const p of r.panes) {
      if (p.claude) coveredPids.add(p.claude.pid);
    }
  }

  const unboxed: UnboxedSessionView[] = claudeSessions
    .filter((c) => !coveredPids.has(c.pid))
    .map((c) => ({
      pid: c.pid,
      sessionId: c.sessionId,
      cwd: c.cwd,
      name: c.name,
      rawStatus: c.rawStatus,
      live: pidMap.has(c.pid),
    }));

  return { boxed, unboxed };
}

/**
 * A short cache of the whole joined listing.
 *
 * Load-bearing: `findSession` resolves a pane-addressing route through this
 * same cache, so it stays exported rather than a private module variable.
 * Single-flight, so a burst of requests in one tick pays for one
 * collectSessions() call rather than one each.
 */
export const LISTING_CACHE_MS = 900;

let cache: { at: number; listing: SessionListing } | null = null;
let inFlight: Promise<SessionListing> | null = null;

/** Test-only: clears the cache so one test's listing cannot leak into the next. */
export function resetSessionsCache(): void {
  cache = null;
  inFlight = null;
}

export async function getSessionListing(deps: SessionsDeps = {}): Promise<SessionListing> {
  if (cache && Date.now() - cache.at < LISTING_CACHE_MS) return cache.listing;
  if (inFlight) return inFlight;
  inFlight = buildListing(deps)
    .then((listing) => {
      cache = { at: Date.now(), listing };
      return listing;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Resolves a boxed session by tmux name, through the cached listing — so a
 *  pane-addressing route always agrees with what the board is showing now. */
export async function findSession(
  tmuxName: string,
  deps: SessionsDeps = {},
): Promise<SessionView | null> {
  const { boxed } = await getSessionListing(deps);
  return boxed.find((s) => s.tmuxName === tmuxName) ?? null;
}

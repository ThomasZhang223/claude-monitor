/**
 * One dashboard tick: turn the raw snapshots into the rows the TUI renders.
 *
 * The whole tick costs four process spawns regardless of how many sessions
 * exist: one `ps`, one `tmux list-sessions`, one `tmux list-panes -a`, and the
 * (cheap, local) reads of Claude's own session files. That is deliberate. The
 * tool this is modelled on derives candidate session names and probes each one,
 * which grows with sessions times repos and needed a call-counter panel to stay
 * honest. Enumerating instead keeps it flat.
 */
import * as path from "path";
import {
  latestTranscriptMtime,
  deriveStatus,
  isPidAlive,
  readClaudeSessions,
  readHookStatus,
  sessionsByPid,
  transcriptDirPathForCwd,
  type FsDeps,
  type HookStatus,
  realFs,
} from "./claude.ts";
import { buildTree, resolvePaneClaude, snapshotPs } from "./procs.ts";
import { autoRecapCached, pruneAutoRecapCache } from "./recap.ts";
import { capturePane, listAllPanes, listSessions, looksLikePrompt } from "./tmux.ts";
import { execAsync, type Exec } from "./exec.ts";
import {
  FLAG_ON,
  OPT_CREATED,
  OPT_FLAG,
  OPT_LABEL,
  OPT_PLAN,
  OPT_RECAP,
  OPT_WORKTREE,
  OPT_WRAP,
  STATE_DIR,
  comparePanePosition,
  type PaneRecord,
  type SessionRecord,
  type Status,
} from "./model.ts";
import { decodeWrap } from "./wrap.ts";
import { readUsageSnapshot, type UsageDeps, type UsageSnapshot } from "./usage.ts";

/**
 * How loudly a status shouts for attention. A session's row shows the loudest
 * status across its panes, so a work session whose plan pane is waiting on you
 * does not hide behind an implement pane that is merrily working.
 */
const SEVERITY: Record<Status, number> = {
  error: 5,
  permission: 4,
  awaiting: 3,
  working: 2,
  idle: 1,
  dead: 0,
};

export function worstStatus(statuses: readonly Status[]): Status {
  if (statuses.length === 0) return "dead";
  return statuses.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst), statuses[0]);
}

/**
 * How long after a session is created we forgive a pane with no Claude in it.
 *
 * Claude takes a second or two to appear in the process tree, and a brand-new
 * session flashing "dead" would be worse than a moment of "idle".
 */
export const STARTUP_GRACE_MS = 15_000;

/**
 * A pane that resolved no Claude process at all.
 *
 * Three genuinely different situations look identical from the process tree, and
 * conflating them makes the dashboard lie in both directions:
 *
 *  - Claude was killed. `kill -9` removes it from the tree, so no pid survives to
 *    liveness-check and the session file it left behind is never matched. That is
 *    `dead`, and calling it `idle` would leave a crashed session looking healthy.
 *  - Claude is still starting. It takes a moment to appear, and a brand-new
 *    session flashing `dead` would be worse than a moment of `idle`.
 *  - Claude is sitting at a prompt it must be answered before it will even start
 *    — most commonly the trust-this-folder question in a directory it has not
 *    seen before. No session file exists yet, so it looks exactly like a crash,
 *    but it is the precise opposite: it is blocked on the user. Reporting that as
 *    `dead` would hide a session that only needs one keypress.
 */
export function statusForPaneWithoutClaude(
  createdAt: number | null,
  now: number,
  paneSuggestsPrompt = false,
): Status {
  if (paneSuggestsPrompt) return "permission";
  if (createdAt !== null && now - createdAt < STARTUP_GRACE_MS) return "idle";
  return "dead";
}

export interface CollectDeps {
  exec?: Exec;
  fs?: FsDeps;
  usage?: UsageDeps;
  now?: number;
  /** Sessions whose panes should also be scraped for a permission prompt. The
   *  scrape is the last-resort layer, so it runs only for the focused row. */
  paneSuggestsPrompt?: ReadonlySet<string>;
}

export async function collectSessions(
  boxIds: readonly string[],
  deps: CollectDeps = {},
): Promise<SessionRecord[]> {
  const exec = deps.exec ?? execAsync;
  const fs = deps.fs ?? realFs;
  const now = deps.now ?? Date.now();

  const [pidMap, claudeSessions, rows, panes] = await Promise.all([
    snapshotPs(),
    readClaudeSessions(fs),
    listSessions(boxIds, exec),
    listAllPanes(exec),
  ]);

  const tree = buildTree(pidMap);
  const byPid = sessionsByPid(claudeSessions);

  // Group panes by their tmux session once, rather than filtering per row.
  const panesBySession = new Map<string, typeof panes>();
  for (const pane of panes) {
    const list = panesBySession.get(pane.session);
    if (list) list.push(pane);
    else panesBySession.set(pane.session, [pane]);
  }

  const records: SessionRecord[] = [];

  for (const row of rows) {
    const sessionPanes = (panesBySession.get(row.name) ?? []).sort(comparePanePosition);

    const createdAt = parseEpoch(row.options[OPT_CREATED]);
    const paneRecords: PaneRecord[] = [];
    // Per-session statusline facts. Taken from the first pane that has them,
    // which is the planning pane in a work session.
    let snap: UsageSnapshot | null = null;

    // Whether this session's panes are showing a prompt. Resolved lazily and at
    // most once per session: the focused row always gets it (for the preview),
    // and any session with no Claude gets it too, because that is the case where
    // "blocked on a prompt" and "crashed" are otherwise indistinguishable.
    let promptChecked = deps.paneSuggestsPrompt?.has(row.name) ?? false;
    let promptSuggested = promptChecked;

    const suggestsPrompt = async (): Promise<boolean> => {
      if (promptChecked) return promptSuggested;
      promptChecked = true;
      const text = await capturePane(row.name, 12, exec);
      promptSuggested = text !== null && looksLikePrompt(text);
      return promptSuggested;
    };

    for (const pane of sessionPanes) {
      const claude = resolvePaneClaude(pane.panePid, byPid, tree);
      const pidAlive = claude ? isPidAlive(claude.pid) : false;

      let hook: HookStatus | null = null;
      let transcriptMtime: number | null = null;
      // This pane's own statusline snapshot - read per pane, not just once for
      // the session, so a work session's two panes each show their own
      // context usage rather than both echoing the plan pane's.
      let paneSnap: UsageSnapshot | null = null;
      if (claude) {
        hook = await readHookStatus(claude.sessionId, fs);
        transcriptMtime = await ownTranscriptMtime(claude.cwd, claude.sessionId, fs);
        paneSnap = await sessionSnapshot(claude.sessionId, deps.usage);
        if (snap === null) snap = paneSnap;
      }

      const status = claude
        ? deriveStatus({
            claude,
            pidAlive,
            hook,
            transcriptMtime,
            now,
            paneSuggestsPrompt: promptSuggested,
          })
        : statusForPaneWithoutClaude(createdAt, now, await suggestsPrompt());

      // This pane's own account of itself, for the row's detail column and for
      // the notification's summary. Cached on the transcript's mtime, so a
      // quiet pane costs a stat rather than a 256 KB read every tick.
      const auto = claude ? autoRecapCached(claude.cwd, claude.sessionId) : null;

      paneRecords.push({
        windowIndex: pane.windowIndex,
        paneIndex: pane.paneIndex,
        panePid: pane.panePid,
        status,
        claude,
        auto,
        contextPct: paneSnap?.contextPct ?? null,
      });
    }

    const opts = row.options;
    records.push({
      tmuxName: row.name,
      box: row.box,
      mode: row.mode,
      slug: row.slug,
      label: opts[OPT_LABEL] ?? row.slug,
      worktree: opts[OPT_WORKTREE] ?? null,
      recap: opts[OPT_RECAP] ?? null,
      planPath: opts[OPT_PLAN] ?? null,
      createdAt,
      branch: null, // filled in on the slower git tick
      status: worstStatus(paneRecords.map((p) => p.status)),
      panes: paneRecords,
      contextPct: snap?.contextPct ?? null,
      model: snap?.modelName ?? null,
      effort: snap?.effortLevel ?? null,
      runtimeMs: snap?.durationMs ?? null,
      wrap: decodeWrap(opts[OPT_WRAP]),
      // Presence alone would read a hand-set `@cc_flag 0` as flagged, so this
      // compares against the one value the dashboard ever writes.
      flagged: opts[OPT_FLAG] === FLAG_ON,
    });
  }

  // Sessions that have gone away must not keep a cached recap alive. Done here
  // rather than inside the cache because this loop is the only place that knows
  // the full live set.
  pruneAutoRecapCache(
    records.flatMap((r) => r.panes.map((p) => p.claude?.sessionId).filter((id): id is string => !!id)),
  );

  return records;
}

/**
 * The mtime of THIS session's transcript, not the newest in the directory.
 *
 * Every session sharing a working directory shares one transcript directory, so
 * "newest file here" routinely belongs to a different session — three sessions
 * started from the same directory would otherwise all report each other's
 * activity, and all show the same recap.
 */
async function ownTranscriptMtime(
  cwd: string,
  sessionId: string,
  fs: FsDeps,
): Promise<number | null> {
  const own = path.join(transcriptDirPathForCwd(cwd), `${sessionId}.jsonl`);
  try {
    const st = await fs.stat(own);
    return st.mtimeMs;
  } catch {
    // No transcript of its own yet (a session that has not spoken). Fall back to
    // directory-level activity, which is at least a bound on idleness.
    return latestTranscriptMtime(cwd, fs);
  }
}

/**
 * The statusline snapshot for one specific session.
 *
 * The tee writes a per-session copy alongside the newest-wins global one, which
 * is what makes model, effort, context and runtime available per row rather than
 * only for whichever session happened to redraw last. Absent until that session
 * has rendered a status line at least once.
 */
async function sessionSnapshot(
  sessionId: string,
  usageDeps: UsageDeps | undefined,
): Promise<UsageSnapshot | null> {
  const p = path.join(STATE_DIR, "usage", `${sessionId}.json`);
  return readUsageSnapshot(usageDeps, p);
}

function parseEpoch(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

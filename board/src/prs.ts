/**
 * PR detail from GitHub, cached.
 *
 * State, title and CI rollup need `gh`, which is a network call — so it is
 * deliberately behind its own route rather than inside `/api/sessions`, and
 * cached in memory besides. A 2s dashboard poll must never wait on GitHub.
 *
 * A `gh` failure degrades to the bare link. Not being signed in, being
 * offline, or the PR having been deleted are all ordinary conditions here,
 * not errors worth failing a page over.
 *
 * Ported unchanged from the reference implementation's server/src/prs.ts, with
 * two adjustments:
 *  - `PrLink` moves in-file. The reference imported it from its own
 *    `transcript.ts`, which scraped `gh pr create`/`gh pr view` mentions out
 *    of a transcript to build the list — this port does not carry
 *    `transcript.ts` over (see the plan's hard constraints), so the shape
 *    moves here and http.ts is responsible for producing the list some other
 *    way. See http.ts's own ceiling comment on its `/prs` route for why none
 *    is wired up yet.
 *  - The disk cache moves off the reference's own state directory onto
 *    claude-monitor's shared one, alongside auth.ts's token and push.ts's
 *    subscriptions.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { STATE_DIR } from "../../core/src/model.ts";

const execFileAsync = promisify(execFile);

/** What history.ts's transcript scrape used to hand this module. Kept here
 *  now that transcript.ts is not ported — see this file's own header. */
export interface PrLink {
  repository: string;
  number: number;
  url: string;
  /** When this link was last seen. Used to rank, so the PR the session is
   *  actually working on leads. */
  at: number;
}

/** Long enough that clicking between sessions costs nothing, short enough that
 *  a PR you just merged stops claiming to be open while you watch. */
export const TTL_MS = 60_000;

/**
 * MERGED and CLOSED are terminal — a merged PR does not un-merge.
 *
 * Worth its own TTL because most PRs a long session touched are already done.
 * Re-asking GitHub about those every minute is the bulk of the traffic for
 * none of the information.
 */
export const TERMINAL_TTL_MS = 6 * 60 * 60 * 1000;

/** How many `gh` subprocesses may be in flight at once. Enough to fill the
 *  board quickly, few enough not to fork 40 processes on a cold start. */
export const WARM_CONCURRENCY = 4;

export interface PrDetail extends PrLink {
  title: string | null;
  /** OPEN | MERGED | CLOSED, or null when `gh` could not answer. */
  state: string | null;
  isDraft: boolean | null;
  /** Waiting in a merge queue, or set to auto-merge — the same thing to a
   *  reader: it will merge itself without you. */
  queued: boolean;
  /** "3 passing, 1 failing", or null when there are no checks. */
  checks: string | null;
  /** The one word the UI colours and folds by. Carried on the detail so the
   *  session page and the dashboard share one `splitPrs` rather than each
   *  deciding for itself what counts as done. */
  phase: PrPhase;
}

/**
 * The one word that describes a PR, which is what the UI colours by.
 *
 * Draft outranks open because a draft is not asking for anything yet, and
 * queued outranks plain open because it needs nothing from you either.
 */
export type PrPhase = "draft" | "queued" | "open" | "merged" | "closed" | "unknown";

export function phaseOf(pr: Pick<PrDetail, "state" | "isDraft" | "queued">): PrPhase {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.state !== "OPEN") return "unknown";
  if (pr.isDraft) return "draft";
  if (pr.queued) return "queued";
  return "open";
}

/** A finished PR needs no further looking at, and is what the UI folds away. */
export function isTerminal(phase: PrPhase): boolean {
  return phase === "merged" || phase === "closed";
}

interface CacheEntry {
  at: number;
  detail: PrDetail;
}

const cache = new Map<string, CacheEntry>();

/**
 * The cache survives restarts, on disk.
 *
 * It did not, and that mattered more than it sounds: every restart emptied it,
 * the warmer refetched every PR the board knows about, and a few dozen
 * restarts in an afternoon exhausted the GitHub GraphQL budget outright
 * (`gh pr view` is GraphQL-backed and `statusCheckRollup` is not cheap).
 * Nothing then rendered a state at all.
 */
export const CACHE_PATH = path.join(STATE_DIR, "board", "prs.json");

/** Where the cache is actually written. Redirectable so tests never touch the
 *  real one — `warmPrs` saves as a side effect, and a test run was writing its
 *  fixtures into a developer's own cache. */
let cacheFile = CACHE_PATH;

export function setPrCachePath(file: string): void {
  cacheFile = file;
}

/** Long enough to outlast the usual window reset. */
export const BACKOFF_MS = 10 * 60_000;

/**
 * Set while GitHub is refusing on rate-limit grounds.
 *
 * Retrying into a rate limit is how you stay rate-limited: the warmer would
 * otherwise re-attempt every stale PR on every poll, none would succeed, and
 * the budget would never recover. While this is set nothing calls `gh`, and
 * whatever is already cached keeps being shown.
 */
let backoffUntil = 0;

export function isRateLimited(now: number = Date.now()): boolean {
  return now < backoffUntil;
}

export function noteRateLimit(now: number = Date.now()): void {
  backoffUntil = now + BACKOFF_MS;
  console.error(
    `GitHub is rate limiting; not asking again for ${BACKOFF_MS / 60_000} minutes. `
      + "Cached PR state is still shown.",
  );
}

export function resetPrCache(): void {
  cache.clear();
  backoffUntil = 0;
}

export function loadPrCache(file: string = cacheFile): void {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, CacheEntry>;
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && typeof entry.at === "number" && entry.detail) cache.set(key, entry);
    }
  } catch {
    // No cache yet, or an unreadable one. Neither is worth a word: it refills.
  }
}

export function savePrCache(file: string = cacheFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache)));
    fs.renameSync(tmp, file);
  } catch {
    // A cache that cannot be written is a slower next start, not a failure.
  }
}

/** Summarise a statusCheckRollup into one short phrase. */
export function summariseChecks(rollup: unknown): string | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const counts = new Map<string, number>();
  for (const c of rollup) {
    const v = (c as Record<string, unknown>)?.conclusion;
    const key = typeof v === "string" && v ? v.toLowerCase() : "pending";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const order = ["failure", "cancelled", "timed_out", "action_required", "pending", "neutral", "skipped", "success"];
  return [...counts.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

export function detailFrom(link: PrLink, raw: Record<string, unknown> | null): PrDetail {
  const mergeState = typeof raw?.mergeStateStatus === "string" ? raw.mergeStateStatus : null;
  const partial = {
    ...link,
    title: typeof raw?.title === "string" ? raw.title : null,
    state: typeof raw?.state === "string" ? raw.state : null,
    isDraft: typeof raw?.isDraft === "boolean" ? raw.isDraft : null,
    // Three mechanisms, one meaning: it will merge without you.
    //
    // `isInMergeQueue` is the real signal and it is NOT available from
    // `gh pr view --json` — that field set has no merge-queue entry at all,
    // and `mergeStateStatus` has no QUEUED value either (its enum is BEHIND,
    // BLOCKED, CLEAN, DIRTY, DRAFT, HAS_HOOKS, UNKNOWN, UNSTABLE). It comes
    // from GraphQL instead — see `realGh`.
    queued:
      raw?.isInMergeQueue === true
      || mergeState === "QUEUED"
      || Boolean(raw?.autoMergeRequest),
    checks: summariseChecks(raw?.statusCheckRollup),
  };
  return { ...partial, phase: phaseOf(partial) };
}

function ttlFor(detail: PrDetail): number {
  return isTerminal(phaseOf(detail)) ? TERMINAL_TTL_MS : TTL_MS;
}

/** What is already known about a PR, without asking GitHub. Used by the
 *  session listing, which must never block on the network. */
export function cachedPr(link: PrLink, now: number = Date.now()): PrDetail | null {
  const hit = cache.get(`${link.repository}#${link.number}`);
  if (!hit || now - hit.at >= ttlFor(hit.detail)) return null;
  return hit.detail;
}

/**
 * What is known, however old.
 *
 * Used when a refresh is impossible — rate limited, offline — because a
 * day-old state is enormously better than none. Expiry is a signal to REFETCH,
 * not a reason to forget: treating it as forgetting is what turned a rate
 * limit into a strip of bare numbers with no titles, no states and no checks,
 * on data the board already had on disk.
 */
export function staleCachedPr(link: PrLink): PrDetail | null {
  return cache.get(`${link.repository}#${link.number}`)?.detail ?? null;
}

/**
 * Fill the cache in the background so the board can colour its badges without
 * a `gh` call on the render path.
 *
 * Bounded concurrency: a cold start across every session is dozens of unique
 * PRs, and forking that many subprocesses at once to draw a dashboard is not
 * a trade worth making. Already-cached PRs cost nothing, so this settles
 * quickly and then only refreshes the handful that are still open.
 */
export async function warmPrs(
  links: readonly PrLink[],
  now: number = Date.now(),
  gh: GhRunner = realGh,
): Promise<void> {
  if (isRateLimited(now)) return;
  const stale = links.filter((l) => cachedPr(l, now) === null);
  const seen = new Set<string>();
  const queue = stale.filter((l) => {
    const key = `${l.repository}#${l.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const link = queue[next++];
      if (isRateLimited(now)) return;
      const key = `${link.repository}#${link.number}`;
      const raw = await gh(link.repository, link.number);
      // A FAILED fetch must never replace a good answer. It used to, so one
      // rate-limited afternoon blanked every PR the board had already
      // resolved — the display went from full detail to nothing at all.
      if (raw === null && cache.has(key)) continue;
      // Stamped with the CALLER's clock, not the wall clock. `enrichPrs`
      // threads a `now` through for testability, and two different clocks in
      // one cache means entries that are simultaneously fresh and stale.
      cache.set(key, { at: now, detail: detailFrom(link, raw) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, worker));
  savePrCache();
}

/**
 * Whether a PR sits in a merge queue. GraphQL only.
 *
 * Failure is `false` rather than an exception: a repository without merge
 * queues enabled, an older GitHub Enterprise, or a rate limit should leave the
 * PR looking open — which it is — not break the listing.
 */
async function inMergeQueue(repo: string, number: number): Promise<boolean> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return false;
  try {
    // JSON.stringify, not raw interpolation: GraphQL string literals follow
    // the same escaping rules as JSON, so this is what keeps an owner or
    // repo name containing a quote or backslash from breaking the query
    // rather than merely being looked up.
    const { stdout } = await execFileAsync(
      "gh",
      [
        "api", "graphql",
        "-f", `query=query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${number}) { isInMergeQueue } } }`,
        "--jq", ".data.repository.pullRequest.isInMergeQueue",
      ],
      { timeout: 10_000 },
    );
    return stdout.trim() === "true";
  } catch (e) {
    const text = String((e as { stderr?: string }).stderr ?? "");
    if (/rate limit/i.test(text)) noteRateLimit();
    return false;
  }
}

export type GhRunner = (repo: string, number: number) => Promise<Record<string, unknown> | null>;

const realGh: GhRunner = async (repo, number) => {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr", "view", String(number), "-R", repo,
        "--json", "number,title,state,isDraft,mergeStateStatus,autoMergeRequest,statusCheckRollup",
      ],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    // Merge-queue membership needs GraphQL, and only an OPEN non-draft PR can
    // be in a queue — so the extra call is skipped for the great majority,
    // which on a real board are already merged.
    if (parsed.state === "OPEN" && parsed.isDraft !== true) {
      parsed.isInMergeQueue = await inMergeQueue(repo, number);
    }
    return parsed;
  } catch (e) {
    // A rate limit is not an ordinary failure. It means STOP, rather than
    // "this PR is unknown, try again in a minute".
    const text = String((e as { stderr?: string; message?: string }).stderr ?? (e as Error).message ?? "");
    if (/rate limit/i.test(text)) noteRateLimit();
    return null;
  }
};

/**
 * PR detail for a set of links, fetching whatever is missing.
 *
 * "Warm, then read the cache" rather than its own fetch loop. It had one, and
 * the duplication showed: the warmer capped itself at four `gh` subprocesses
 * while this fired one per PR at once — sixteen for a single session page,
 * into a budget that was already tight.
 */
export async function enrichPrs(
  links: readonly PrLink[],
  now: number = Date.now(),
  gh: GhRunner = realGh,
): Promise<PrDetail[]> {
  await warmPrs(links, now, gh);
  // Fresh, else stale, else nothing known. The middle step is what keeps the
  // board useful through a rate limit or an offline spell.
  return links.map((link) => cachedPr(link, now) ?? staleCachedPr(link) ?? detailFrom(link, null));
}

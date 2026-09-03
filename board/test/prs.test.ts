import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BACKOFF_MS,
  CACHE_PATH,
  cachedPr,
  detailFrom,
  enrichPrs,
  isRateLimited,
  isTerminal,
  loadPrCache,
  noteRateLimit,
  phaseOf,
  resetPrCache,
  savePrCache,
  setPrCachePath,
  staleCachedPr,
  summariseChecks,
  TERMINAL_TTL_MS,
  TTL_MS,
  warmPrs,
  type PrLink,
} from "../src/prs.ts";

const link: PrLink = { repository: "o/r", number: 7, url: "u", at: 0 };

test("summariseChecks: failures lead, because that is what you need to see", () => {
  const rollup = [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { conclusion: "SUCCESS" }];
  assert.equal(summariseChecks(rollup), "1 failure, 2 success");
});

test("summariseChecks: a check with no conclusion is pending, not dropped", () => {
  assert.equal(summariseChecks([{ conclusion: null }, { conclusion: "SUCCESS" }]), "1 pending, 1 success");
});

test("summariseChecks: no checks is null, not an empty string", () => {
  assert.equal(summariseChecks([]), null);
  assert.equal(summariseChecks(undefined), null);
});

test("enrichPrs: fills in title, state and checks", async () => {
  resetPrCache();
  const details = await enrichPrs([link], 0, async () => ({
    title: "Add the thing", state: "OPEN", isDraft: true,
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }));
  assert.equal(details[0].title, "Add the thing");
  assert.equal(details[0].state, "OPEN");
  assert.equal(details[0].isDraft, true);
  assert.equal(details[0].checks, "1 success");
  assert.equal(details[0].url, "u", "the transcript's own fields survive");
});

test("enrichPrs: a gh failure degrades to the bare link, never throws", async () => {
  // Offline, not signed in, or the PR was deleted - all ordinary here.
  resetPrCache();
  const details = await enrichPrs([link], 0, async () => null);
  assert.equal(details[0].title, null);
  assert.equal(details[0].number, 7, "still shows the PR the transcript knew about");
});

test("enrichPrs: caches within the TTL and refreshes after it", async () => {
  resetPrCache();
  let calls = 0;
  const gh = async () => { calls++; return { title: `call ${calls}` }; };
  await enrichPrs([link], 0, gh);
  await enrichPrs([link], TTL_MS - 1, gh);
  assert.equal(calls, 1, "a second look inside the TTL costs nothing");
  const after = await enrichPrs([link], TTL_MS + 1, gh);
  assert.equal(calls, 2);
  assert.equal(after[0].title, "call 2");
});

test("enrichPrs: failures are cached too, so being offline is not a subprocess per poll", async () => {
  resetPrCache();
  let calls = 0;
  const gh = async () => { calls++; return null; };
  await enrichPrs([link], 0, gh);
  await enrichPrs([link], 1, gh);
  assert.equal(calls, 1);
});

test("enrichPrs: the same number in two repos is cached separately", async () => {
  resetPrCache();
  const seen: string[] = [];
  const gh = async (repo: string) => { seen.push(repo); return { title: repo }; };
  const out = await enrichPrs([link, { ...link, repository: "o/other" }], 0, gh);
  assert.deepEqual(seen, ["o/r", "o/other"]);
  assert.deepEqual(out.map((d) => d.title), ["o/r", "o/other"]);
});

test("phaseOf: the one word that describes a PR", () => {
  const p = (o: object) => phaseOf({ state: "OPEN", isDraft: false, queued: false, ...o } as never);
  assert.equal(p({ state: "MERGED" }), "merged");
  assert.equal(p({ state: "CLOSED" }), "closed");
  assert.equal(p({ isDraft: true }), "draft", "a draft is not asking for anything yet");
  assert.equal(p({ queued: true }), "queued", "queued needs nothing from you either");
  assert.equal(p({}), "open");
  assert.equal(p({ state: null }), "unknown", "not looked up yet is not a guess");
});

test("phaseOf: merged wins over draft, whatever the flags say", () => {
  // A merged PR whose isDraft is stale must not render as a draft.
  assert.equal(phaseOf({ state: "MERGED", isDraft: true, queued: false }), "merged");
});

test("detailFrom: a merge queue and auto-merge both read as queued", () => {
  // Two different GitHub mechanisms, one meaning to a reader: it will merge
  // without you.
  assert.equal(detailFrom(link, { mergeStateStatus: "QUEUED" }).queued, true);
  assert.equal(detailFrom(link, { autoMergeRequest: { enabledAt: "x" } }).queued, true);
  assert.equal(detailFrom(link, { mergeStateStatus: "CLEAN" }).queued, false);
});

test("isTerminal: only merged and closed are done", () => {
  assert.deepEqual(
    (["draft", "queued", "open", "merged", "closed", "unknown"] as const).filter(isTerminal),
    ["merged", "closed"],
  );
});

test("cachedPr: a terminal PR is cached far longer than an open one", async () => {
  // Most PRs a long session touched are already merged; re-asking GitHub about
  // those every minute is the bulk of the traffic for none of the information.
  resetPrCache();
  await enrichPrs([link], 0, async () => ({ state: "MERGED" }));
  assert.ok(cachedPr(link, TTL_MS + 1), "still cached well past the open TTL");
  assert.equal(cachedPr(link, TERMINAL_TTL_MS + 1), null, "but not forever");

  resetPrCache();
  await enrichPrs([link], 0, async () => ({ state: "OPEN" }));
  assert.equal(cachedPr(link, TTL_MS + 1), null, "an open PR expires on the short TTL");
});

test("cachedPr: never triggers a lookup", () => {
  resetPrCache();
  assert.equal(cachedPr(link), null, "unknown is null, not a fetch");
});

test("warmPrs: fetches each unique PR once, and skips what is cached", async () => {
  resetPrCache();
  const calls: string[] = [];
  const gh = async (repo: string, n: number) => { calls.push(`${repo}#${n}`); return { state: "OPEN" }; };
  const links = [link, { ...link }, { ...link, number: 8 }];
  await warmPrs(links, 0, gh);
  assert.deepEqual(calls.sort(), ["o/r#7", "o/r#8"], "the duplicate was not fetched twice");

  calls.length = 0;
  await warmPrs(links, 1, gh);
  assert.deepEqual(calls, [], "a warm cache costs nothing");
});

test("warmPrs: a gh failure caches an unknown, and does not reject", async () => {
  // The board must render with no GitHub at all: the badge shows, uncoloured.
  resetPrCache();
  await warmPrs([link], 0, async () => null);
  const hit = cachedPr(link, 0);
  assert.ok(hit, "the failure is cached, so it is not retried every poll");
  assert.equal(hit.state, null);
  assert.equal(phaseOf(hit), "unknown");
});


// --- surviving a restart, and a rate limit ---------------------------------

test("prCache: survives a restart, so a restart does not refetch everything", async () => {
  // What this is for: every restart used to empty the cache, the warmer
  // refetched every PR the board knows about, and a few dozen restarts in an
  // afternoon exhausted the GitHub GraphQL budget outright.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-prcache-"));
  const file = path.join(dir, "prs.json");
  setPrCachePath(file);
  resetPrCache();

  const now = Date.now();
  await warmPrs([link], now, async () => ({ state: "MERGED", title: "T" }));
  assert.ok(fs.existsSync(file), "warming persists");

  resetPrCache(); // as a restart would
  assert.equal(cachedPr(link, now), null);
  loadPrCache(file);
  assert.equal(cachedPr(link, now)?.state, "MERGED", "and it comes back without asking GitHub");

  setPrCachePath(CACHE_PATH);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prCache: a missing or corrupt file is not an error", () => {
  resetPrCache();
  loadPrCache("/nonexistent/prs.json");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-prcache-"));
  const bad = path.join(dir, "prs.json");
  fs.writeFileSync(bad, "{not json");
  loadPrCache(bad);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("savePrCache: an unwritable location is a slower next start, not a failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-prcache-"));
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  savePrCache(path.join(blocker, "prs.json"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("noteRateLimit: stops asking, rather than retrying into the limit", () => {
  // Retrying into a rate limit is how you stay rate-limited.
  resetPrCache();
  const now = 1_000_000;
  assert.equal(isRateLimited(now), false);
  noteRateLimit(now);
  assert.equal(isRateLimited(now), true);
  assert.equal(isRateLimited(now + BACKOFF_MS - 1), true);
  assert.equal(isRateLimited(now + BACKOFF_MS + 1), false, "and it does recover");
});

test("warmPrs: asks for nothing while rate limited", async () => {
  resetPrCache();
  const now = 1_000_000;
  noteRateLimit(now);
  let calls = 0;
  await warmPrs([link], now, async () => { calls++; return { state: "OPEN" }; });
  assert.equal(calls, 0);
  resetPrCache();
});

test("warmPrs: a failed fetch never replaces a good answer", async () => {
  // It used to, so one rate-limited afternoon blanked every PR the board had
  // already resolved — the display went from full detail to nothing at all.
  resetPrCache();
  const now = Date.now();
  await warmPrs([link], now, async () => ({ state: "MERGED", title: "known" }));
  assert.equal(cachedPr(link, now)?.title, "known");

  // Expire it, then fail the refetch.
  await warmPrs([link], now + TERMINAL_TTL_MS + 1, async () => null);
  assert.equal(cachedPr(link, now)?.title, "known", "the good answer survived");
  resetPrCache();
});

test("detailFrom: carries the phase, so both UIs fold by the same rule", () => {
  assert.equal(detailFrom(link, { state: "MERGED" }).phase, "merged");
  assert.equal(detailFrom(link, null).phase, "unknown");
});

test("staleCachedPr: expiry means REFETCH, not forget", async () => {
  // Treating expiry as forgetting is what turned a rate limit into a strip of
  // bare numbers — no titles, no states, no checks — on data already on disk.
  resetPrCache();
  const now = Date.now();
  await warmPrs([link], now, async () => ({ state: "OPEN", title: "known" }));
  const later = now + TTL_MS + 1;
  assert.equal(cachedPr(link, later), null, "expired for refresh purposes");
  assert.equal(staleCachedPr(link)?.title, "known", "but not forgotten");
  resetPrCache();
  assert.equal(staleCachedPr(link), null, "and gone once actually cleared");
});

test("enrichPrs: serves stale detail when a refresh is impossible", async () => {
  resetPrCache();
  const now = Date.now();
  await warmPrs([link], now, async () => ({ state: "OPEN", title: "known" }));
  noteRateLimit(now);
  const out = await enrichPrs([link], now + TTL_MS + 1, async () => null);
  assert.equal(out[0].title, "known", "the board keeps working through a rate limit");
  assert.equal(out[0].state, "OPEN");
  resetPrCache();
});

test("detailFrom: a PR in a merge queue is queued, not open", () => {
  // The original check tested `mergeStateStatus === "QUEUED"`, a value that
  // enum does not contain, so it could never fire — a queued PR showed green.
  assert.equal(detailFrom(link, { state: "OPEN", isInMergeQueue: true }).phase, "queued");
  assert.equal(detailFrom(link, { state: "OPEN", isInMergeQueue: false }).phase, "open");
  assert.equal(detailFrom(link, { state: "OPEN" }).phase, "open", "absent means not queued");
});

test("detailFrom: merged still beats queued", () => {
  assert.equal(detailFrom(link, { state: "MERGED", isInMergeQueue: true }).phase, "merged");
});

test("detailFrom: auto-merge still counts as queued", () => {
  assert.equal(detailFrom(link, { state: "OPEN", autoMergeRequest: { enabledAt: "x" } }).phase, "queued");
});

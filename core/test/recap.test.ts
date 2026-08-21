import { test } from "node:test";
import assert from "node:assert/strict";
import {
  autoRecap,
  autoRecapCached,
  parseRecap,
  pruneAutoRecapCache,
  readRecap,
  recapPath,
  resetAutoRecapCache,
} from "../src/recap.ts";
import { STATE_DIR } from "../src/model.ts";

test("recapPath: one file per session, under our own state directory", () => {
  assert.equal(recapPath("cc-alpha-work-plt1836"), `${STATE_DIR}/recap/cc-alpha-work-plt1836.txt`);
});

test("parseRecap: stamp, headline, then detail verbatim", () => {
  const recap = parseRecap("1700000000000\nreworking the wizard\ndone: key scoping\nnext: tests\n");
  assert.deepEqual(recap, {
    at: 1_700_000_000_000,
    headline: "reworking the wizard",
    detail: ["done: key scoping", "next: tests"],
  });
});

test("parseRecap: a headline on its own is a valid recap", () => {
  assert.deepEqual(parseRecap("1700000000000\njust the headline\n"), {
    at: 1_700_000_000_000,
    headline: "just the headline",
    detail: [],
  });
});

test("parseRecap: blank detail lines in the middle are the session's paragraphing", () => {
  const recap = parseRecap("1700000000000\nheadline\nfirst\n\nsecond\n\n\n");
  assert.deepEqual(recap?.detail, ["first", "", "second"]);
});

test("parseRecap: no headline means no recap", () => {
  assert.equal(parseRecap(""), null);
  assert.equal(parseRecap("1700000000000\n"), null);
  assert.equal(parseRecap("1700000000000\n   \ndetail"), null);
});

test("parseRecap: an unreadable stamp still yields the recap, without an age", () => {
  const recap = parseRecap("not-a-number\nheadline\n");
  assert.equal(recap?.at, null);
  assert.equal(recap?.headline, "headline");
});

test("readRecap: a missing file is not an error", () => {
  assert.equal(readRecap("cc-general-q-nothing", {}, { readText: () => null }), null);
});

test("readRecap: a recap from a previous session of the same name is discarded", () => {
  // tmux session names are reusable, and the file outlives the session that wrote
  // it. Without this, killing a session and creating another by the same name
  // would show the dead one's recap as if it were live.
  const stale = { readText: () => "1000\nwhat the old session was doing\n" };
  assert.equal(readRecap("cc-general-work-reused", { notBefore: 5000 }, stale), null);
  assert.equal(readRecap("cc-general-work-reused", { notBefore: 500 }, stale)?.at, 1000);
  // No creation time to compare against: keep it rather than hide it.
  assert.ok(readRecap("cc-general-work-reused", { notBefore: null }, stale));
});

test("autoRecap: falls back to the last thing the session itself said", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Rewrote the preview." }] },
  });
  const readTail = () => `${line}\n`;
  assert.deepEqual(
    autoRecap("/Users/you/Documents/code/myrepo", "abc-123", { readTail }),
    { text: "Rewrote the preview.", source: "assistant", at: null },
  );
});

test("autoRecap: Claude's own recap outranks the last thing it said", () => {
  // The away_summary IS a recap - what was done and what is next - written
  // unprompted every time the session goes idle. The last message is only ever a
  // stand-in for it.
  const said = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Let me check the parser." }] },
  });
  const recapRec = JSON.stringify({
    type: "system",
    subtype: "away_summary",
    isMeta: false,
    content: "Read the wiki notes and oriented. Next: awaiting instructions. (disable recaps in /config)",
  });
  const out = autoRecap("/tmp/wt", "s", { readTail: () => `${said}\n${recapRec}\n` });
  assert.equal(out?.source, "away");
  // Claude's own trailing note about /config is UI chrome, not part of the recap.
  assert.equal(out?.text, "Read the wiki notes and oriented. Next: awaiting instructions.");
});

test("autoRecap: carries the away-summary's own timestamp through", () => {
  const recapRec = JSON.stringify({
    type: "system",
    subtype: "away_summary",
    isMeta: false,
    content: "Oriented.",
    timestamp: "2026-07-27T15:27:25.503Z",
  });
  const out = autoRecap("/tmp/wt", "s", { readTail: () => `${recapRec}\n` });
  assert.equal(out?.at, Date.parse("2026-07-27T15:27:25.503Z"));
});

test("autoRecap: reads THAT session's transcript, not the newest in the directory", () => {
  // Both panes of a work session share a worktree, so a directory-level read
  // would show each pane the other's words.
  const seen: string[] = [];
  autoRecap("/tmp/wt", "session-one", {
    readTail: (file) => {
      seen.push(file);
      return "";
    },
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /session-one\.jsonl$/);
});

test("autoRecap: an unreadable transcript is null, not a throw", () => {
  assert.equal(autoRecap("/tmp/wt", "s", { readTail: () => null }), null);
});

test("autoRecap: a partial first line from the tail read is tolerated", () => {
  const complete = JSON.stringify({
    type: "assistant",
    message: { content: "Complete record." },
  });
  const readTail = () => `type":"assistant"}}\n${complete}\n`;
  assert.equal(autoRecap("/tmp/wt", "s", { readTail })?.text, "Complete record.");
});

// ---------------------------------------------------------------------------
// autoRecapCached
// ---------------------------------------------------------------------------

/** One assistant record, which autoRecap resolves as an "assistant" fallback. */
function saidLine(text: string): string {
  return `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;
}

test("autoRecapCached: re-reads only when the transcript actually moved", () => {
  // The reason the cache exists: TRANSCRIPT_TAIL_BYTES is 256 KB and every pane
  // of every session wants a recap on the 2s tick. A quiet pane must cost a
  // stat, not a quarter-megabyte read.
  resetAutoRecapCache();
  let reads = 0;
  let stat = { mtimeMs: 100, size: 10 };
  const deps = {
    statFile: () => stat,
    readTail: () => {
      reads++;
      return saidLine("first");
    },
  };

  assert.equal(autoRecapCached("/tmp/wt", "s1", deps)?.text, "first");
  assert.equal(reads, 1);
  // Same mtime and size: served from cache.
  for (let i = 0; i < 5; i++) autoRecapCached("/tmp/wt", "s1", deps);
  assert.equal(reads, 1);

  // mtime moves - the session spoke.
  stat = { mtimeMs: 200, size: 20 };
  autoRecapCached("/tmp/wt", "s1", deps);
  assert.equal(reads, 2);
});

test("autoRecapCached: a size change alone re-reads", () => {
  // A transcript is appended to, and a coarse filesystem timestamp can leave
  // two writes inside one tick looking identical by mtime.
  resetAutoRecapCache();
  let reads = 0;
  let stat = { mtimeMs: 100, size: 10 };
  const deps = {
    statFile: () => stat,
    readTail: () => {
      reads++;
      return saidLine("x");
    },
  };
  autoRecapCached("/tmp/wt", "s1", deps);
  stat = { mtimeMs: 100, size: 999 };
  autoRecapCached("/tmp/wt", "s1", deps);
  assert.equal(reads, 2);
});

test("autoRecapCached: caches a null result too", () => {
  // A session with no transcript yet is the common case for the first seconds,
  // and retrying the open every tick costs the same as succeeding.
  resetAutoRecapCache();
  let reads = 0;
  const deps = {
    statFile: () => ({ mtimeMs: 1, size: 1 }),
    readTail: () => {
      reads++;
      return null;
    },
  };
  assert.equal(autoRecapCached("/tmp/wt", "s1", deps), null);
  assert.equal(autoRecapCached("/tmp/wt", "s1", deps), null);
  assert.equal(reads, 1);
});

test("autoRecapCached: an unstattable transcript keeps the last known recap", () => {
  // Rather than blanking the row over a transient failure.
  resetAutoRecapCache();
  let stat: { mtimeMs: number; size: number } | null = { mtimeMs: 1, size: 1 };
  const deps = {
    statFile: () => stat,
    readTail: () => saidLine("still here"),
  };
  assert.equal(autoRecapCached("/tmp/wt", "s1", deps)?.text, "still here");
  stat = null;
  assert.equal(autoRecapCached("/tmp/wt", "s1", deps)?.text, "still here");
});

test("autoRecapCached: two sessions in one directory keep separate entries", () => {
  // The bug this shape is written against: panes sharing a worktree share a
  // transcript directory, and a cache keyed by anything coarser than the
  // session id would make both panes show one pane's words.
  resetAutoRecapCache();
  const deps = (text: string) => ({
    statFile: () => ({ mtimeMs: 1, size: 1 }),
    readTail: () => saidLine(text),
  });
  assert.equal(autoRecapCached("/tmp/wt", "plan", deps("plan words"))?.text, "plan words");
  assert.equal(autoRecapCached("/tmp/wt", "impl", deps("impl words"))?.text, "impl words");
  // And neither evicted the other.
  assert.equal(autoRecapCached("/tmp/wt", "plan", deps("ignored"))?.text, "plan words");
});

test("pruneAutoRecapCache: drops sessions that are gone, keeps the live ones", () => {
  // Without this the cache is a slow leak in a dashboard meant to run for days.
  resetAutoRecapCache();
  let reads = 0;
  const deps = {
    statFile: () => ({ mtimeMs: 1, size: 1 }),
    readTail: () => {
      reads++;
      return saidLine("x");
    },
  };
  autoRecapCached("/tmp/wt", "alive", deps);
  autoRecapCached("/tmp/wt", "gone", deps);
  assert.equal(reads, 2);

  pruneAutoRecapCache(["alive"]);
  autoRecapCached("/tmp/wt", "alive", deps);
  assert.equal(reads, 2, "the live session is still cached");
  autoRecapCached("/tmp/wt", "gone", deps);
  assert.equal(reads, 3, "the dead session was evicted and had to be re-read");
});

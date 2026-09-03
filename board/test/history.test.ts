import { test } from "node:test";
import assert from "node:assert/strict";
import { allTranscripts, endedSessions, transcriptFor, type HistoryDeps } from "../src/history.ts";

/** A fake projects tree: slug -> transcript name -> size. */
function tree(spec: Record<string, Record<string, { mtimeMs: number; size: number }>>): HistoryDeps {
  return {
    dir: "/p",
    readDir: (dir) => (dir === "/p" ? Object.keys(spec) : Object.keys(spec[dir.slice("/p/".length)] ?? {})),
    statOf: (file) => {
      const [, , slug, name] = file.split("/");
      return spec[slug]?.[name] ?? null;
    },
  };
}

const T = tree({
  "-home-me-repos": {
    "aaa.jsonl": { mtimeMs: 300, size: 10 },
    "bbb.jsonl": { mtimeMs: 100, size: 10 },
    "empty.jsonl": { mtimeMs: 999, size: 0 },
    "notes.txt": { mtimeMs: 999, size: 10 },
  },
  "-home-me-other": {
    "ccc.jsonl": { mtimeMs: 200, size: 10 },
  },
});

test("allTranscripts: every session, newest first, across projects", () => {
  assert.deepEqual(allTranscripts(T).map((e) => e.sessionId), ["aaa", "ccc", "bbb"]);
});

test("allTranscripts: skips non-jsonl and empty transcripts", () => {
  // A session that registered and died before writing anything is not
  // something you can meaningfully resume.
  const ids = allTranscripts(T).map((e) => e.sessionId);
  assert.ok(!ids.includes("empty"));
  assert.ok(!ids.includes("notes"));
});

test("allTranscripts: an unreadable directory entry is skipped, not fatal", () => {
  // ~/.claude/projects holds a dangling symlink on this machine.
  const deps: HistoryDeps = {
    dir: "/p",
    readDir: (dir) => (dir === "/p" ? ["good", "broken"] : dir.endsWith("good") ? ["x.jsonl"] : []),
    statOf: (f) => (f.includes("good") ? { mtimeMs: 1, size: 5 } : null),
  };
  assert.deepEqual(allTranscripts(deps).map((e) => e.sessionId), ["x"]);
});

test("endedSessions: excludes anything currently live", () => {
  // The core rule: live sessions come from the registry, ended ones from here,
  // and nothing may appear in both.
  const { entries } = endedSessions(new Set(["aaa"]), T);
  assert.deepEqual(entries.map((e) => e.sessionId), ["ccc", "bbb"]);
});

test("endedSessions: paginates and reports the true total", () => {
  const page1 = endedSessions(new Set(), { ...T, limit: 2 });
  assert.deepEqual(page1.entries.map((e) => e.sessionId), ["aaa", "ccc"]);
  assert.equal(page1.total, 3, "total counts everything, not the page");
  const page2 = endedSessions(new Set(), { ...T, limit: 2, offset: 2 });
  assert.deepEqual(page2.entries.map((e) => e.sessionId), ["bbb"]);
});

test("endedSessions: a negative offset or zero limit does not empty the list", () => {
  const { entries } = endedSessions(new Set(), { ...T, offset: -5, limit: 0 });
  assert.ok(entries.length > 0);
});

test("transcriptFor: finds a session's file, or null", () => {
  assert.equal(transcriptFor("ccc", T), "/p/-home-me-other/ccc.jsonl");
  assert.equal(transcriptFor("nope", T), null);
});

test("allTranscripts: against the real machine, survives the projects tree", () => {
  const all = allTranscripts();
  assert.ok(Array.isArray(all));
  for (const e of all.slice(0, 20)) {
    assert.ok(e.file.endsWith(".jsonl"));
    assert.ok(e.sessionId.length > 0);
  }
});

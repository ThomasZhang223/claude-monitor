import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FALLBACK_SLUG,
  MAX_SLUG_LEN,
  PHONETIC_POOL,
  classifyName,
  sanitizeLabel,
  suggestLabel,
  validateLabel,
} from "../src/naming.ts";
import { formatSessionName, parseSessionName, type Mode } from "../src/model.ts";

// ---------------------------------------------------------------------------
// sanitizeLabel
// ---------------------------------------------------------------------------

test("sanitizeLabel: lowercases and hyphenates a free-form label", () => {
  assert.equal(sanitizeLabel("EC2 always-on spike"), "ec2-always-on-spike");
  assert.equal(sanitizeLabel("PLT-1836"), "plt-1836");
});

test("sanitizeLabel: strips the characters tmux forbids in a session name", () => {
  // "." and ":" are tmux target-address syntax, so a slug containing either
  // would make every `-t` reference ambiguous.
  const slug = sanitizeLabel("v1.2: fix the thing / part 2");
  assert.equal(slug, "v1-2-fix-the-thing-part-2");
  for (const label of ["a.b", "a:b", "a b", "a\tb", "a\nb", "app/main", "50% done"]) {
    const out = sanitizeLabel(label);
    assert.ok(!out.includes("."), `${JSON.stringify(label)} -> ${out} has no dot`);
    assert.ok(!out.includes(":"), `${JSON.stringify(label)} -> ${out} has no colon`);
    assert.ok(!/\s/.test(out), `${JSON.stringify(label)} -> ${out} has no whitespace`);
    assert.ok(/^[a-z0-9-]+$/.test(out), `${JSON.stringify(label)} -> ${out} is tmux-safe`);
  }
});

test("sanitizeLabel: collapses runs of hyphens and trims the ends", () => {
  assert.equal(sanitizeLabel("--a---b--"), "a-b");
  assert.equal(sanitizeLabel("  spaced   out  "), "spaced-out");
  assert.equal(sanitizeLabel("...dots..."), "dots");
  assert.equal(sanitizeLabel("a . : - b"), "a-b");
});

test("sanitizeLabel: folds accents, hyphenates other unicode", () => {
  assert.equal(sanitizeLabel("café spike"), "cafe-spike");
  assert.equal(sanitizeLabel("naïve über"), "naive-uber");
  // Emoji and CJK carry no Latin fold, so they reduce away entirely.
  assert.equal(sanitizeLabel("release 発表"), "release");
});

test("sanitizeLabel: caps the length without leaving a trailing hyphen", () => {
  const long = sanitizeLabel("a".repeat(80));
  assert.equal(long.length, MAX_SLUG_LEN);
  const cutMidHyphen = sanitizeLabel(`${"a".repeat(MAX_SLUG_LEN - 1)} tail`);
  assert.ok(!cutMidHyphen.endsWith("-"), cutMidHyphen);
  assert.ok(cutMidHyphen.length <= MAX_SLUG_LEN);
});

test("sanitizeLabel: never returns empty — falls back deterministically", () => {
  for (const label of ["", "   ", "...", ":::", "!!!", "発表"]) {
    assert.equal(sanitizeLabel(label), FALLBACK_SLUG, JSON.stringify(label));
  }
});

test("sanitizeLabel: output always round-trips through the session-name codec", () => {
  for (const label of ["EC2 always-on spike", "café", "...", "v1.2: fix", "発表", "x".repeat(80)]) {
    const slug = sanitizeLabel(label);
    const name = formatSessionName({ box: "app", mode: "work", slug });
    assert.deepEqual(parseSessionName(name), { box: "app", mode: "work", slug }, label);
  }
});

// ---------------------------------------------------------------------------
// validateLabel
// ---------------------------------------------------------------------------

test("validateLabel: null for anything usable, a message for anything not", () => {
  assert.equal(validateLabel("PLT-1836"), null);
  assert.equal(validateLabel("café"), null);
  assert.equal(typeof validateLabel(""), "string");
  assert.equal(typeof validateLabel("   "), "string");
  assert.equal(typeof validateLabel("..."), "string");
  assert.equal(typeof validateLabel("発表"), "string");
  assert.notEqual(validateLabel(""), validateLabel("..."), "empty and unsluggable read differently");
});

// ---------------------------------------------------------------------------
// suggestLabel
// ---------------------------------------------------------------------------

test("suggestLabel: first unused phonetic name", () => {
  assert.equal(suggestLabel(new Set()), "alpha");
  assert.equal(suggestLabel(new Set(["alpha"])), "bravo");
  assert.equal(suggestLabel(new Set(["alpha", "bravo", "charlie"])), "delta");
  assert.equal(suggestLabel(new Set(["bravo"])), "alpha", "gaps are reused");
});

test("suggestLabel: falls back to session-N once the pool is exhausted", () => {
  const all = new Set<string>(PHONETIC_POOL);
  assert.equal(suggestLabel(all), "session-1");
  all.add("session-1");
  all.add("session-2");
  assert.equal(suggestLabel(all), "session-3");
});

test("suggestLabel: every suggestion is already a valid slug", () => {
  const taken = new Set<string>();
  for (let i = 0; i < PHONETIC_POOL.length + 3; i++) {
    const name = suggestLabel(taken);
    assert.equal(sanitizeLabel(name), name, name);
    assert.equal(validateLabel(name), null, name);
    taken.add(name);
  }
});

// ---------------------------------------------------------------------------
// classifyName
// ---------------------------------------------------------------------------

const WORKTREE = "/repo/app-alpha";

function classify(
  slug: string,
  sessions: string[],
  worktrees: string[] = [],
  mode: Mode = "work",
) {
  return classifyName(slug, {
    box: "app",
    mode,
    existingSessions: new Set(sessions),
    worktree: WORKTREE,
    worktreeExists: (p) => worktrees.includes(p),
  });
}

test("classifyName: free when there is no session and no worktree", () => {
  assert.deepEqual(classify("alpha", []), { kind: "free" });
});

test("classifyName: adopt when the worktree outlived its tmux session", () => {
  // The post-reboot recovery path: tmux is gone, the branch and the working
  // copy are not, so the new session reuses them instead of forking a second.
  assert.deepEqual(classify("alpha", [], [WORKTREE]), {
    kind: "adopt",
    worktree: WORKTREE,
    heldBy: null,
  });
});

test("classifyName: adopt names the live session of ANOTHER class holding that tree", () => {
  // A worktree path is keyed by (box, slug); a session by (box, mode, slug). So
  // cc-app-work-alpha and cc-app-quick-alpha are different sessions that
  // want the same directory and the same branch. Offering that tree for adoption
  // as though it were abandoned would put two live Claudes in one worktree.
  assert.deepEqual(classify("alpha", ["cc-app-work-alpha"], [WORKTREE], "quick"), {
    kind: "adopt",
    worktree: WORKTREE,
    heldBy: "cc-app-work-alpha",
  });
  // Every other class counts, not just work.
  assert.equal(
    (classify("alpha", ["cc-app-research-alpha"], [WORKTREE], "work") as { heldBy: string })
      .heldBy,
    "cc-app-research-alpha",
  );
});

test("classifyName: heldBy ignores sessions that cannot share the tree", () => {
  // Another box is another directory entirely, and a different slug is a
  // different path - neither can be holding this one.
  for (const other of ["cc-web-work-alpha", "cc-app-work-bravo"]) {
    assert.equal(
      (classify("alpha", [other], [WORKTREE], "quick") as { heldBy: string | null }).heldBy,
      null,
      other,
    );
  }
});

test("classifyName: session-exists wins over an existing worktree", () => {
  assert.deepEqual(classify("alpha", ["cc-app-work-alpha"], [WORKTREE]), {
    kind: "session-exists",
    tmuxName: "cc-app-work-alpha",
  });
});

test("classifyName: only the exact session name collides", () => {
  // Same slug in the other mode, or in another box, is a different session.
  assert.deepEqual(classify("alpha", ["cc-app-q-alpha"]), { kind: "free" });
  assert.deepEqual(classify("alpha", ["cc-web-work-alpha"]), { kind: "free" });
  assert.deepEqual(classify("alpha", ["cc-app-work-alpha"], [], "q"), { kind: "free" });
  assert.deepEqual(classify("alph", ["cc-app-work-alpha"]), { kind: "free" });
});

test("classifyName: does no filesystem IO of its own", () => {
  const asked: string[] = [];
  classifyName("alpha", {
    box: "general",
    mode: "q",
    existingSessions: new Set(),
    worktree: "/nope",
    worktreeExists: (p) => {
      asked.push(p);
      return false;
    },
  });
  assert.deepEqual(asked, ["/nope"], "the injected predicate is the only lookup");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMultiPreview, buildPreview, pickRecap, splitPreviewRows, wrapText } from "../src/preview.ts";
import type { AutoRecap, Recap } from "../src/recap.ts";

const recap: Recap = {
  at: 1_700_000_000_000,
  headline: "reworking the wizard's key handling",
  detail: ["done: scoped the dashboard keys", "next: live smoke test"],
};

const away: AutoRecap = {
  source: "away",
  text: "I've read the repo docs and am fully oriented on the codebase. Next: awaiting your instructions.",
  at: null,
};

function input(over: Partial<Parameters<typeof buildPreview>[0]> = {}) {
  return buildPreview({ recap: null, auto: null, width: 60, rows: 8, ...over });
}

test("a published recap is the body, headline and detail together", () => {
  const out = input({ recap });
  assert.deepEqual(
    out.lines.map((l) => l.text),
    [recap.headline, ...recap.detail],
  );
  assert.ok(out.lines.every((l) => l.tone === "recap"));
  assert.equal(out.standIn, false);
  assert.equal(out.recapAt, recap.at);
});

test("Claude's own recap reads as a recap, not as a fallback", () => {
  // It IS a recap - what was done, what is next - so it gets no caveat and no
  // dimming. This is the source that makes the box useful with nobody doing
  // anything.
  const out = input({ auto: away });
  assert.ok(out.lines.length > 0);
  assert.ok(out.lines.every((l) => l.tone === "recap"));
  assert.equal(out.standIn, false);
});

test("the last thing a session said is marked as a stand-in", () => {
  const out = input({ auto: { source: "assistant", text: "Let me check the parser.", at: null } });
  assert.equal(out.standIn, true);
  assert.ok(out.lines.every((l) => l.tone === "auto"));
});

test("a deliberate publish outranks Claude's own recap, absent proof it is stale", () => {
  const out = input({ recap, auto: away });
  assert.equal(out.lines[0].text, recap.headline);
  assert.ok(!out.lines.some((l) => l.text.includes("fully oriented")));
});

test("a fresher away-summary outranks a stale published recap", () => {
  // The session called cc-recap once and never again; Claude keeps regenerating
  // the away-summary for free every time it goes idle. The newer one should win.
  const fresher: AutoRecap = { ...away, at: recap.at! + 1000 };
  const out = input({ recap, auto: fresher });
  assert.ok(out.lines.every((l) => l.tone === "recap"), "still reads as a recap, not a stand-in");
  assert.equal(out.standIn, false);
  assert.equal(out.recapAt, fresher.at);
  assert.ok(!out.lines.some((l) => l.text === recap.headline));
});

test("an away-summary of unknown age never outranks a published recap", () => {
  const out = input({ recap, auto: { ...away, at: null } });
  assert.equal(out.lines[0].text, recap.headline);
});

test("pickRecap: the effective age matches whichever text is shown", () => {
  assert.equal(pickRecap(recap, null)?.at, recap.at);
  assert.equal(pickRecap(null, away)?.at, away.at);
  const fresher: AutoRecap = { ...away, at: recap.at! + 1000 };
  assert.equal(pickRecap(recap, fresher)?.at, fresher.at);
});

test("nothing at all: one hint line, and it names cc-recap", () => {
  const out = input();
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].tone, "hint");
  assert.match(out.lines[0].text, /cc-recap/);
});

test("no tone means attention - the preview is for reading", () => {
  // The old version coloured captured pane text magenta, which in practice meant
  // a screenful of status-line bars in the colour reserved for things needing
  // action.
  for (const out of [input({ recap }), input({ auto: away }), input()]) {
    assert.ok(out.lines.every((l) => ["recap", "auto", "hint"].includes(l.tone)));
  }
});

test("the summary wraps to the preview's width, not the pane's", () => {
  const long: AutoRecap = { source: "away", text: "word ".repeat(60).trim(), at: null };
  const out = input({ auto: long, width: 30, rows: 20 });
  assert.ok(out.lines.length > 4, `wrapped into ${out.lines.length} lines`);
  assert.ok(out.lines.every((l) => l.text.length <= 30));
});

test("a taller window shows more of the summary", () => {
  const long: AutoRecap = { source: "away", text: "word ".repeat(200).trim(), at: null };
  const short = input({ auto: long, rows: 4 });
  const tall = input({ auto: long, rows: 12 });
  assert.equal(short.lines.length, 4);
  assert.equal(tall.lines.length, 12);
});

test("the row budget is never exceeded", () => {
  const long: Recap = {
    at: 1,
    headline: "h",
    detail: Array.from({ length: 40 }, (_, i) => `detail line number ${i}`),
  };
  for (const rows of [0, 1, 3, 12]) {
    assert.ok(input({ recap: long, rows }).lines.length <= rows, `rows=${rows}`);
  }
});

test("wrapText: breaks on words at the given width", () => {
  assert.deepEqual(wrapText("one two three four", 9), ["one two", "three", "four"]);
});

test("wrapText: a word longer than the width is hard-split rather than overflowing", () => {
  assert.deepEqual(wrapText("aaaaaaaaaaaa", 8), ["aaaaaaaa", "aaaa"]);
  assert.ok(
    wrapText("short /a/very/long/path/that/never/breaks/anywhere", 12).every((l) => l.length <= 12),
  );
});

test("wrapText: paragraph breaks survive", () => {
  assert.deepEqual(wrapText("a\n\nb", 20), ["a", "", "b"]);
});

test("a summary too long for the box says how much was dropped", () => {
  // Stopping at the bottom edge with no marker is the same fault as truncating
  // after one sentence, just quieter.
  const long: AutoRecap = { source: "away", text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), at: null };
  const out = input({ auto: long, rows: 6 });
  assert.equal(out.lines.length, 6);
  assert.equal(out.lines[5].tone, "hint");
  assert.match(out.lines[5].text, /^… \+25 more lines$/);
  // The dropped count plus what is shown accounts for every line.
  assert.equal(5 + 25, 30);
});

test("no overflow marker when the summary fits", () => {
  const out = input({ auto: { source: "away", text: "one line", at: null }, rows: 6 });
  assert.equal(out.lines.length, 1);
  assert.ok(!out.lines.some((l) => l.text.includes("more lines")));
});

test("a one-row preview shows a line rather than only a marker", () => {
  const out = input({ auto: { source: "away", text: "a\nb\nc", at: null }, rows: 1 });
  assert.deepEqual(out.lines, [{ text: "a", tone: "recap" }]);
});

// ---------------------------------------------------------------------------
// splitPreviewRows
// ---------------------------------------------------------------------------

test("splitPreviewRows: even split when both sides need at least their share", () => {
  assert.deepEqual(splitPreviewRows(10, 10, 8), [4, 4]);
  assert.deepEqual(splitPreviewRows(10, 10, 9), [5, 4], "odd remainder goes to the first side");
});

test("splitPreviewRows: a short side gives its unused rows to the other", () => {
  assert.deepEqual(splitPreviewRows(1, 10, 8), [1, 7]);
  assert.deepEqual(splitPreviewRows(10, 1, 8), [7, 1]);
});

test("splitPreviewRows: never hands out more than the total", () => {
  const [a, b] = splitPreviewRows(1, 1, 8);
  assert.equal(a + b, 2, "neither side takes rows the other could not use either");
});

// ---------------------------------------------------------------------------
// buildMultiPreview
// ---------------------------------------------------------------------------

test("buildMultiPreview: a single pane behaves exactly like buildPreview", () => {
  const [block] = buildMultiPreview([{ label: null, recap, auto: null }], 60, 8);
  const solo = buildPreview({ recap, auto: null, width: 60, rows: 8 });
  assert.deepEqual(block.lines, solo.lines);
  assert.equal(block.recapAt, solo.recapAt);
  assert.equal(block.label, null);
});

test("buildMultiPreview: freshest pane first, regardless of input order", () => {
  const older: Recap = { at: 1000, headline: "older", detail: [] };
  const newer: Recap = { at: 2000, headline: "newer", detail: [] };
  const blocks = buildMultiPreview(
    [
      { label: "plan", recap: older, auto: null },
      { label: "implement", recap: newer, auto: null },
    ],
    60,
    8,
  );
  assert.equal(blocks[0].label, "implement");
  assert.equal(blocks[0].lines[0].text, "newer");
  assert.equal(blocks[1].label, "plan");
});

test("buildMultiPreview: a pane that never published anything sorts last", () => {
  const published: Recap = { at: 1000, headline: "published", detail: [] };
  const blocks = buildMultiPreview(
    [
      { label: "plan", recap: null, auto: null },
      { label: "implement", recap: published, auto: null },
    ],
    60,
    8,
  );
  assert.equal(blocks[0].label, "implement");
  assert.equal(blocks[1].label, "plan");
  assert.equal(blocks[1].lines[0].tone, "hint");
});

test("buildMultiPreview: a short block's unused rows go to the other block", () => {
  const short: Recap = { at: 2000, headline: "one line", detail: [] };
  const longDetail = Array.from({ length: 20 }, (_, i) => `detail ${i}`);
  const long: Recap = { at: 1000, headline: "headline", detail: longDetail };
  const blocks = buildMultiPreview(
    [
      { label: "implement", recap: short, auto: null },
      { label: "plan", recap: long, auto: null },
    ],
    60,
    10,
  );
  assert.equal(blocks[0].lines.length, 1, "the short block only takes what it needs");
  assert.equal(blocks[1].lines.length, 9, "the long block gets the rest");
});

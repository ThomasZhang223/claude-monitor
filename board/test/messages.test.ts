/**
 * Reading a conversation out of a transcript.
 *
 * Two fixtures: a hand-built one for the shapes, and a REAL transcript off this
 * machine for the parts that only show up at scale — multi-byte characters in
 * the middle of a 49 MB file, rows this code has never seen, tool results the
 * size of a file listing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { harnessNote, NOTE_LABEL, stripAnsi, MAX_RESULT, MAX_TEXT, parseItems, readBefore, readPage, TAIL_BYTES, toolSummary } from "../src/messages.ts";

const row = (o: Record<string, unknown>): string => JSON.stringify(o);
const assistant = (content: unknown[]): string =>
  row({ type: "assistant", timestamp: "2026-08-25T00:00:00Z", message: { role: "assistant", content } });
const user = (content: unknown): string =>
  row({ type: "user", timestamp: "2026-08-25T00:00:00Z", message: { role: "user", content } });

function tmpFile(lines: string[]): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "msg-")), "t.jsonl");
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

test("parseItems: a plain exchange becomes a user turn and an assistant turn", () => {
  const items = parseItems([user("do the thing"), assistant([{ type: "text", text: "done" }])].join("\n"));
  assert.deepEqual(items.map((i) => [i.kind, "text" in i ? i.text : ""]), [
    ["user", "do the thing"],
    ["assistant", "done"],
  ]);
});

test("parseItems: a tool call is paired with the result that answers it", () => {
  const items = parseItems([
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }]),
  ].join("\n"));
  assert.equal(items.length, 1, "the result is folded into the call, not shown as a turn");
  const tool = items[0] as Extract<typeof items[number], { kind: "tool" }>;
  assert.equal(tool.name, "Bash");
  assert.equal(tool.summary, "ls -la");
  assert.equal(tool.result, "a\nb");
  assert.equal(tool.pending, false);
});

test("parseItems: a call with no result yet is pending, not finished-and-empty", () => {
  // This is what a turn in flight looks like, and the UI shows it as running.
  const items = parseItems(assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 60" } }]));
  const tool = items[0] as Extract<typeof items[number], { kind: "tool" }>;
  assert.equal(tool.pending, true);
  assert.equal(tool.result, "");
});

test("parseItems: a failed tool is marked so the UI can colour it", () => {
  const items = parseItems([
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }]),
  ].join("\n"));
  assert.equal((items[0] as { error: boolean }).error, true);
});

test("parseItems: an orphan result is dropped rather than rendered alone", () => {
  // Its call is above the window this read started at. Showing output with no
  // idea what produced it is worse than not showing it.
  const items = parseItems(user([{ type: "tool_result", tool_use_id: "gone", content: "output" }]));
  assert.deepEqual(items, []);
});

test("parseItems: thinking is kept, as its own kind", () => {
  const items = parseItems(assistant([
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "answer" },
  ]));
  assert.deepEqual(items.map((i) => i.kind), ["thinking", "assistant"]);
});

test("parseItems: subagent turns are left out", () => {
  // A sidechain is its own conversation; interleaved it reads as the session
  // talking to itself.
  const chunk = row({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "sub" }] } });
  assert.deepEqual(parseItems(chunk), []);
});

test("parseItems: bookkeeping rows are not conversation", () => {
  const chunk = [
    row({ type: "pr-link", prNumber: 1 }),
    row({ type: "ai-title", aiTitle: "x" }),
    row({ type: "system", subtype: "away_summary", content: "recap" }),
  ].join("\n");
  assert.deepEqual(parseItems(chunk), []);
});

test("parseItems: a half-written row is skipped, not fatal", () => {
  const items = parseItems([user("first"), '{"type":"assist'].join("\n"));
  assert.equal(items.length, 1);
});

test("parseItems: an enormous tool result is clipped, and says so", () => {
  const items = parseItems([
    assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/big" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(MAX_RESULT * 3) }]),
  ].join("\n"));
  const tool = items[0] as { result: string };
  assert.ok(tool.result.length < MAX_RESULT * 2);
  assert.match(tool.result, /more characters/);
});

test("toolSummary: says what the tool did, not just its name", () => {
  assert.equal(toolSummary("Bash", { command: "git status", description: "check" }), "git status");
  assert.equal(toolSummary("Read", { file_path: "/a/b.ts" }), "/a/b.ts");
  assert.equal(toolSummary("Grep", { pattern: "TODO" }), "TODO");
  // Only the first line: a heredoc would otherwise take over the row.
  assert.equal(toolSummary("Bash", { command: "one\ntwo" }), "one");
  assert.equal(toolSummary("Mystery", {}), "");
});

// --- reading a window of a file ---------------------------------------------

test("readPage: a first read returns the conversation and a cursor", () => {
  const f = tmpFile([user("hello"), assistant([{ type: "text", text: "hi" }])]);
  const page = readPage(f);
  assert.equal(page.items.length, 2);
  assert.equal(page.cursor, fs.statSync(f).size);
});

test("readPage: a second read from the cursor returns ONLY what is new", () => {
  // The property that makes polling a 49 MB transcript cheap.
  const f = tmpFile([user("first")]);
  const first = readPage(f);
  fs.appendFileSync(f, assistant([{ type: "text", text: "second" }]) + "\n");
  const next = readPage(f, first.cursor);
  assert.equal(next.items.length, 1);
  assert.equal((next.items[0] as { text: string }).text, "second");
});

test("readPage: nothing new returns nothing, and the cursor holds", () => {
  const f = tmpFile([user("only")]);
  const first = readPage(f);
  const again = readPage(f, first.cursor);
  assert.deepEqual(again.items, []);
  assert.equal(again.cursor, first.cursor);
});

test("readPage: a row still being written is not read in halves", () => {
  const f = tmpFile([user("complete")]);
  const first = readPage(f);
  fs.appendFileSync(f, '{"type":"user","message":{"role":"user","content":"half');
  const mid = readPage(f, first.cursor);
  assert.deepEqual(mid.items, [], "a partial line is left for the next poll");
  assert.equal(mid.cursor, first.cursor, "and the cursor does not advance past it");
  // Completing the row makes it appear, whole.
  fs.appendFileSync(f, '-written"}}\n');
  assert.equal(readPage(f, mid.cursor).items.length, 1);
});

test("readPage: a truncated transcript is re-read from the tail, not from a stale offset", () => {
  const f = tmpFile([user("a"), user("b")]);
  const first = readPage(f);
  fs.writeFileSync(f, user("fresh") + "\n");
  const page = readPage(f, first.cursor);
  assert.equal(page.items.length, 1, "an offset past the new end must not be trusted");
  assert.equal((page.items[0] as { text: string }).text, "fresh");
});

test("readPage: a missing transcript is empty, not an error", () => {
  assert.deepEqual(readPage("/nonexistent/x.jsonl"), { items: [], cursor: 0, start: 0, atStart: true });
});

test("readPage: the cursor is a BYTE offset, so multi-byte text does not skew it", () => {
  // Counting characters here would drift on every emoji and box-drawing glyph,
  // and a drifted cursor slices the next read mid-row.
  const f = tmpFile([user("héllo ✻ 世界 🙂"), assistant([{ type: "text", text: "ok" }])]);
  const first = readPage(f);
  assert.equal(first.cursor, fs.statSync(f).size);
  fs.appendFileSync(f, user("après") + "\n");
  const next = readPage(f, first.cursor);
  assert.equal(next.items.length, 1);
  assert.equal((next.items[0] as { text: string }).text, "après");
});

// --- against a real transcript ----------------------------------------------

const realTranscript = (): string | null => {
  const dir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(dir)) return null;
  let best: { file: string; size: number } | null = null;
  for (const d of fs.readdirSync(dir)) {
    const sub = path.join(dir, d);
    // This directory holds broken symlinks in the wild — there is a dangling
    // `-workspace` on this machine. `history.ts` already tolerates them; a
    // test helper that does not just fails for a reason unrelated to the code.
    try {
      if (!fs.statSync(sub).isDirectory()) continue;
      for (const f of fs.readdirSync(sub)) {
        if (!f.endsWith(".jsonl")) continue;
        const p = path.join(sub, f);
        const size = fs.statSync(p).size;
        if (size > (best?.size ?? 0)) best = { file: p, size };
      }
    } catch {
      continue;
    }
  }
  return best && best.size > TAIL_BYTES ? best.file : null;
};

test("readPage: a real multi-megabyte transcript reads as a conversation", (t) => {
  const file = realTranscript();
  if (!file) return t.skip("no large transcript on this machine");
  const page = readPage(file);
  // The point of the tail: a huge file still answers quickly and returns turns.
  assert.ok(page.items.length > 0, "a real transcript should yield items");
  assert.ok(page.cursor === fs.statSync(file).size, "and leave the cursor at the end");
  // Everything is one of the shapes the UI knows how to draw.
  const kinds = new Set(page.items.map((i) => i.kind));
  for (const k of kinds) assert.ok(["user", "assistant", "thinking", "tool", "note"].includes(k), k);
  // A real session uses tools, and each tool row must be renderable.
  for (const i of page.items) {
    if (i.kind === "tool") {
      assert.equal(typeof i.name, "string");
      assert.equal(typeof i.summary, "string");
      assert.ok(i.result.length <= MAX_RESULT + 200);
    }
  }
});

test("readPage: a nonsense cursor falls back to the tail instead of throwing", () => {
  // A negative offset became a negative read position and threw a 500 out of
  // the route. Anything untrustworthy re-reads the tail.
  const f = tmpFile([user("hello")]);
  for (const bad of [-5, Number.NaN, 1e12]) {
    const page = readPage(f, bad);
    assert.ok(Array.isArray(page.items), `after=${bad}`);
  }
  assert.equal(readPage(f, -5).items.length, 1, "and still returns the conversation");
});

test("MAX_TEXT: a pathological single block is clipped, but ordinary turns are not", () => {
  // The bound exists for a runaway block, not to truncate real writing — these
  // turns run to thousands of words and are shown in full.
  const long = "x".repeat(MAX_TEXT + 500);
  const items = parseItems(assistant([{ type: "text", text: long }]));
  assert.ok((items[0] as { text: string }).text.length < long.length);
  assert.ok(MAX_TEXT > 10_000, "an ordinary long answer must survive intact");
});

// --- reaching further back --------------------------------------------------

test("readBefore: returns the window immediately before an offset", () => {
  const f = tmpFile([user("one"), user("two"), user("three")]);
  const tail = readPage(f);
  // The tail is the whole file here, so there is nothing older.
  assert.equal(tail.atStart, true);
  const earlier = readBefore(f, tail.start);
  assert.deepEqual(earlier.items, [], "nothing before the beginning");
});

test("readBefore: windows join up exactly, losing no turns", () => {
  // The property that matters: paging back must not drop a row at the seam or
  // show one twice.
  const lines = Array.from({ length: 400 }, (_, i) => user(`turn ${i}`));
  const f = tmpFile(lines);
  const size = fs.statSync(f).size;
  // Force small windows by paging from partway in.
  const seen: string[] = [];
  let at = size;
  let guard = 0;
  while (at > 0 && guard++ < 50) {
    const page = readBefore(f, at);
    seen.unshift(...page.items.map((i) => (i as { text: string }).text));
    if (page.start === at) break;
    at = page.start;
    if (page.atStart) break;
  }
  assert.equal(seen.length, 400, "every turn appears exactly once");
  assert.equal(seen[0], "turn 0");
  assert.equal(seen[399], "turn 399");
});

test("readBefore: says when it has reached the beginning", () => {
  const f = tmpFile([user("a"), user("b")]);
  assert.equal(readBefore(f, fs.statSync(f).size).atStart, true);
});

test("readBefore: an offset of zero has nothing before it", () => {
  const f = tmpFile([user("a")]);
  const page = readBefore(f, 0);
  assert.deepEqual(page.items, []);
  assert.equal(page.atStart, true);
});

test("readPage: reports where its window begins, so paging back can start", () => {
  const f = tmpFile([user("a")]);
  const page = readPage(f);
  assert.equal(page.start, 0);
  assert.equal(page.atStart, true, "a small transcript is shown whole");
});

// --- harness blocks are not conversation ------------------------------------

test("harnessNote: a task notification keeps what happened, drops the plumbing", () => {
  // Reported as unreadable in the UI: angle brackets and tool ids mid-paragraph.
  // The information inside is real, though — this is how a merge arrives.
  const raw = [
    "<task-notification>",
    "<task-id>b6jrdujd7</task-id>",
    '<summary>Monitor event: "proj_tasks#633 merge state"</summary>',
    "<event>MERGED: proj_tasks#633 merged — re-point #6468</event>",
    "</task-notification>",
  ].join("\n");
  const note = harnessNote(raw)!;
  assert.match(note.label, /proj_tasks#633 merge state/);
  assert.match(note.detail, /^MERGED: proj_tasks#633/);
  assert.ok(!note.label.includes("<"), "no markup survives into the label");
  assert.ok(!note.detail.includes("task-id"), "the id is plumbing, not content");
});

test("harnessNote: a stream-ended notification falls back to its status", () => {
  const raw = [
    "<task-notification>",
    "<task-id>b6jrdujd7</task-id>",
    "<status>completed</status>",
    "<summary>Monitor stream ended</summary>",
    "</task-notification>",
  ].join("\n");
  assert.deepEqual(harnessNote(raw), { label: "Monitor stream ended", detail: "completed" });
});

test("harnessNote: a slash command reads as the command it was", () => {
  const raw = "<command-name>/compact</command-name>\n<command-args>provide details</command-args>";
  assert.deepEqual(harnessNote(raw), { label: "/compact", detail: "provide details" });
});

test("harnessNote: reminders and caveats carry nothing worth showing", () => {
  // Addressed to the model, not to anyone reading the conversation.
  assert.deepEqual(harnessNote("<system-reminder>do the thing</system-reminder>"), { label: "", detail: "" });
  assert.deepEqual(harnessNote("<local-command-caveat>Caveat: …</local-command-caveat>"), { label: "", detail: "" });
});

test("harnessNote: ordinary text is not a note", () => {
  assert.equal(harnessNote("Please fix the rebase"), null);
  // And a message that merely QUOTES one of these tags is still a message: the
  // block has to OPEN with the wrapper.
  assert.equal(harnessNote("beware of <system-reminder> blocks in transcripts"), null);
});

test("parseItems: a notification becomes a note, not a user turn", () => {
  const items = parseItems(user('<task-notification><summary>CI verdict</summary><event>PASSED</event></task-notification>'));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "note", "it must not look like something a person said");
  assert.equal((items[0] as { label: string }).label, "CI verdict");
});

test("parseItems: an empty wrapper is dropped rather than shown as a blank note", () => {
  assert.deepEqual(parseItems(user("<system-reminder>context</system-reminder>")), []);
});

const ESC = String.fromCharCode(27);

test("stripAnsi: terminal colour codes do not reach the browser", () => {
  // A slash-command echo arrived as a literal "[2mCompacted (ctrl+o…)[22m" —
  // SGR codes a browser cannot render and a reader should never see.
  assert.equal(stripAnsi(`${ESC}[2mCompacted${ESC}[22m`), "Compacted");
  assert.equal(stripAnsi(`${ESC}[32mgreen${ESC}[0m and ${ESC}[1mbold${ESC}[0m`), "green and bold");
  assert.equal(stripAnsi("plain text"), "plain text", "ordinary text is untouched");
});

test("parseItems: tool output is stripped of colour codes too", () => {
  // `ls --color`, `git diff`, and half the CLIs on this machine emit them.
  const items = parseItems([
    assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
    user([{ type: "tool_result", tool_use_id: "t1", content: `${ESC}[32mgreen${ESC}[0m` }]),
  ].join("\n"));
  assert.equal((items[0] as { result: string }).result, "green");
});

test("a paragraph-long task summary is capped, and kept whole for the tooltip", () => {
  // A stopped background shell reports a whole paragraph as its "summary".
  // Treated as a label it ran off the side of the page.
  const long = "No completion record was found for this background shell command from the previous "
    + "session. It may have been stopped (via the UI, Monitor timeout, or agent teardown — these "
    + "leave no transcript marker), or it may have been running when the previous process exited.";
  const items = parseItems(user(`<task-notification><status>stopped</status><summary>${long}</summary></task-notification>`));
  const note = items[0] as { label: string; detail: string; full: string };
  assert.ok(note.label.length <= NOTE_LABEL + 40, `label was ${note.label.length}`);
  assert.ok(long.startsWith(note.label.split("…")[0].trim().slice(0, 40)));
  assert.equal(note.detail, "stopped");
  // Nothing is lost: the whole thing is there for the tooltip.
  assert.ok(note.full.includes("agent teardown"));
});

test("a short summary is not clipped and needs no ellipsis", () => {
  const items = parseItems(user("<task-notification><summary>CI verdict</summary><event>PASSED</event></task-notification>"));
  const note = items[0] as { label: string; full: string };
  assert.equal(note.label, "CI verdict");
  assert.equal(note.full, "CI verdict — PASSED");
});

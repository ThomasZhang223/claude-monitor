/**
 * The prompt parser, against REAL captured panes.
 *
 * test/fixtures/*.txt are verbatim `tmux capture-pane -p` output from a live
 * Claude Code session (v2.1.246), not hand-written approximations. That
 * mattered twice: the two menu kinds turned out to have different footers, and
 * a real question menu put its last option BELOW a border line. Both would have
 * been "obviously" wrong in a fixture written from memory, and both would have
 * shipped a parser that fails on the actual thing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  answerKeys, capturePaneCommand, capturePrompt, drivable, fingerprint, mayHavePrompt,
  captureActivity, capturePane, captureMode, forgetPrompt, inputHolds, parseActivity, parseMode, parsePrompt,
  PROMPT_CACHE_MS, REDRAW_MS,
  resetPromptCache, WAITING_STATUSES,
} from "../src/prompt.ts";

const FIX = path.join(import.meta.dirname, "fixtures");
const pane = (name: string): string => fs.readFileSync(path.join(FIX, `pane-${name}.txt`), "utf8");
const MENU = pane("permission");

test("parse: a real permission prompt yields its three options", () => {
  const p = parsePrompt(pane("permission"));
  assert.ok(p, "permission pane should parse");
  assert.equal(p!.question, "Do you want to create fixture-a.txt?");
  assert.equal(p!.options.length, 3);
  assert.equal(p!.options[0].label, "Yes");
  assert.equal(p!.options[2].label, "No");
  assert.equal(p!.cursor, 1, "the terminal's cursor starts on Yes");
});

test("parse: a real question menu keeps the options the TUI appended", () => {
  const p = parsePrompt(pane("question"));
  assert.ok(p, "question pane should parse");
  assert.equal(p!.question, "Which log level should be the default?");
  assert.equal(p!.header, "Log level");
  // Three came from the tool; "Type something." and "Chat about this" were
  // added by the terminal. Rendering only the tool's three would mis-map keys.
  assert.equal(p!.options.length, 5);
  assert.equal(p!.options[4].label, "Chat about this");
});

test("parse: an option below a border line is still part of the menu", () => {
  // The real capture separates option 5 from 1-4 with a full-width rule. A
  // parser that stops at the first non-option line loses it, and then every
  // index past the break is wrong.
  const text = pane("question");
  assert.match(text, /4\. Type something/);
  const p = parsePrompt(text)!;
  assert.equal(p.options[3].label, "Type something.");
  assert.equal(p.options[4].index, 5);
});

test("parse: descriptions are folded into their option", () => {
  const p = parsePrompt(pane("question"))!;
  assert.match(p.options[0].description, /Standard operational messages/);
  assert.equal(p.options[3].description, "", "appended options carry no description");
});

test("parse: an idle pane is not a menu", () => {
  assert.equal(parsePrompt(pane("idle")), null);
});

test("parse: a chat line starting with the cursor glyph is not the menu cursor", () => {
  // `❯` is the ordinary prompt marker too. The idle fixture has one on a line
  // of typed text; a first-❯-wins scan would treat it as a selection.
  assert.match(pane("idle"), /^❯ /m);
  const p = parsePrompt(pane("permission"))!;
  assert.equal(p.options[p.cursor - 1].label, "Yes");
});

test("parse: a numbered list without a footer is not a menu", () => {
  const stripped = pane("permission").replace(/Esc to cancel.*/g, "");
  assert.equal(parsePrompt(stripped), null, "the footer is what proves it is live");
});

test("parse: a menu whose numbering is not 1..N is refused", () => {
  // Fail closed: if the numbering does not match the keys, no key is safe.
  const odd = pane("permission").replace(/^(\s*)(❯\s*)?1\./m, "$1$27.");
  assert.equal(parsePrompt(odd), null);
});

test("parse: junk is refused rather than guessed at", () => {
  assert.equal(parsePrompt(""), null);
  assert.equal(parsePrompt("Esc to cancel"), null);
  assert.equal(parsePrompt("1. only one option\nEsc to cancel"), null);
});

test("fingerprint: stable for the same menu, different when a label changes", () => {
  const a = parsePrompt(pane("permission"))!;
  const b = parsePrompt(pane("permission"))!;
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, fingerprint(a.question, ["Yes", "Maybe", "No"]));
});

test("fingerprint: the two real menus do not collide", () => {
  assert.notEqual(parsePrompt(pane("permission"))!.fingerprint, parsePrompt(pane("question"))!.fingerprint);
});

test("drivable: a free-text option is refused with a reason", () => {
  const d = drivable("Type something.", false);
  assert.equal(d.ok, false);
  assert.match(d.reason, /terminal/);
  assert.equal(drivable("Yes", false).ok, true);
});

test("drivable: multi-select disables every option", () => {
  assert.equal(drivable("Yes", true).ok, false);
  assert.match(drivable("Yes", true).reason, /multi-select/);
});

test("answerKeys: a single digit for options the terminal numbers 1-9", () => {
  const p = parsePrompt(pane("permission"))!;
  assert.deepEqual(answerKeys(p, 2, "board-abc"), [["send-keys", "-t", "board-abc", "2"]]);
});

test("answerKeys: past 9 it moves the cursor instead", () => {
  const p = { ...parsePrompt(pane("permission"))!, cursor: 8 };
  assert.deepEqual(answerKeys(p, 11, "s"), [
    ["send-keys", "-t", "s", "Down"],
    ["send-keys", "-t", "s", "Down"],
    ["send-keys", "-t", "s", "Down"],
    ["send-keys", "-t", "s", "Enter"],
  ]);
});

test("capturePaneCommand: reads the live screen of the named session", () => {
  assert.deepEqual(capturePaneCommand("board-abc"), ["capture-pane", "-p", "-t", "board-abc"]);
});

// --- reading a real pane through tmux ---------------------------------------

function runner(stdout: string, ok = true) {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    return { ok, stdout, stderr: ok ? "" : "no such session" };
  };
  return { run, calls };
}

test("capturePrompt: parses whatever the pane holds", async () => {
  resetPromptCache();
  const { run, calls } = runner(pane("permission"));
  const p = await capturePrompt("board-abc", run, 1000);
  assert.equal(p!.question, "Do you want to create fixture-a.txt?");
  assert.deepEqual(calls[0], ["capture-pane", "-p", "-t", "board-abc"]);
});

test("capturePrompt: a dead session is 'not asking', not an error", async () => {
  resetPromptCache();
  const { run } = runner("", false);
  assert.equal(await capturePrompt("gone", run, 1000), null);
});

test("capturePrompt: caches within the window, refreshes behind after it", async () => {
  resetPromptCache();
  const { run, calls } = runner(pane("permission"));
  await capturePrompt("s", run, 1000);
  await capturePrompt("s", run, 1000 + PROMPT_CACHE_MS - 1);
  assert.equal(calls.length, 1, "a second poll inside the window must not fork tmux again");
  // Past the window the caller is served the LAST pane and a refresh runs
  // behind it, rather than waiting on tmux. Measured: a blocking read cost a
  // poll up to 4.9s on a busy machine.
  await capturePrompt("s", run, 1000 + PROMPT_CACHE_MS + 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2, "and the refresh did happen");
});

test("capturePane: only the FIRST read for a session waits", async () => {
  resetPromptCache();
  let release = () => {};
  const slow = new Promise<void>((r) => { release = r; });
  let calls = 0;
  const run = async () => {
    calls++;
    if (calls > 1) await slow;
    return { ok: true, stdout: `pane ${calls}`, stderr: "" };
  };
  assert.equal(await capturePane("s", run, 1000), "pane 1");
  // Second read is past the window, so tmux is slow — but the caller is not
  // made to wait for it.
  const t0 = Date.now();
  assert.equal(await capturePane("s", run, 1000 + PROMPT_CACHE_MS + 1), "pane 1");
  assert.ok(Date.now() - t0 < 50, "served from cache, not from the slow call");
  release();
});

test("capturePane: a slow tmux cannot pile up spawns behind a poll", async () => {
  resetPromptCache();
  let calls = 0;
  const run = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return { ok: true, stdout: "pane", stderr: "" };
  };
  // Several callers arriving together on a cold cache share one read.
  await Promise.all([capturePane("s", run, 1000), capturePane("s", run, 1000), capturePane("s", run, 1000)]);
  assert.equal(calls, 1);
});

test("capturePrompt: the cache window is shorter than the dashboard poll", async () => {
  // Otherwise a prompt answered in the terminal lingers on the board for a
  // whole extra cycle, and the card invites you to answer something that is
  // already gone.
  assert.ok(PROMPT_CACHE_MS < 2000);
});

test("mayHavePrompt: only waiting sessions with a pane are worth reading", () => {
  assert.equal(mayHavePrompt("permission", "s:@1.%1"), true);
  assert.equal(mayHavePrompt("awaiting", "s:@1.%1"), true);
  assert.equal(mayHavePrompt("error", "s:@1.%1"), true);
  // Working means Claude is busy, not blocked on you — never has a menu up,
  // and this is what keeps a 2s poll from forking tmux once per session.
  assert.equal(mayHavePrompt("working", "s:@1.%1"), false);
  assert.equal(mayHavePrompt("dead", "s:@1.%1"), false);
  // A bare session has no pane to read at all.
  assert.equal(mayHavePrompt("permission", null), false);
  // idle is included too, even though it is not one of NEEDS_USER's three: a
  // session sitting at a permission prompt that never triggered Claude
  // Code's own PreToolUse hook (most commonly the first prompt in a fresh
  // directory) reports idle, not permission, from board's collectSessions()
  // — see prompt.ts's own comment on WAITING_STATUSES.
  assert.ok(WAITING_STATUSES.has("idle"));
});

test("forgetPrompt: a confirming read is not served the pre-keystroke capture", () => {
  // The bug this exists for: answering worked against a live session, the file
  // appeared, and the route still reported the menu as up — because the read
  // taken to confirm was the CACHED one from just before the keys were sent.
  resetPromptCache();
  let served = "menu";
  const run = async () => ({ ok: true, stdout: served === "menu" ? MENU : "gone\n", stderr: "" });
  return (async () => {
    await capturePrompt("s", run, 1000);
    served = "gone";
    assert.ok(await capturePrompt("s", run, 1000), "still cached, as designed");
    forgetPrompt("s");
    assert.equal(await capturePrompt("s", run, 1000), null, "after forgetting, the fresh screen wins");
  })();
});

test("REDRAW_MS: long enough to let the TUI repaint, short enough not to stall a click", () => {
  assert.ok(REDRAW_MS >= 100 && REDRAW_MS <= 500);
});

// --- the permission mode, read off the terminal's own footer -----------------

test("parseMode: every mode the terminal cycles through is recognised", () => {
  // Fixtures are real panes, captured while cycling a live session through the
  // whole rotation: plan -> auto -> manual -> accept edits.
  for (const [file, expected] of [
    ["mode-plan", "plan"],
    ["mode-auto", "auto"],
    ["mode-manual", "manual"],
    ["mode-accept-edits", "accept edits"],
  ] as const) {
    assert.equal(parseMode(pane(file)), expected, file);
  }
});

test("parseMode: a pane with no footer has no mode, rather than a guess", () => {
  assert.equal(parseMode("just some output\n"), null);
  assert.equal(parseMode(""), null);
});

test("parseMode: the newest footer wins", () => {
  // Scrollback can hold an older footer above the current one.
  assert.equal(parseMode("⏸ manual mode on\nlater\n⏵⏵ auto mode on (shift+tab to cycle)"), "auto");
});

test("capturePane: one read serves both the picker and the mode", async () => {
  // They are two questions about the same screen; reading it twice per poll
  // would double the tmux calls for nothing.
  resetPromptCache();
  let reads = 0;
  const run = async () => { reads++; return { ok: true, stdout: pane("mode-auto"), stderr: "" }; };
  await capturePrompt("s", run, 1000);
  await captureMode("s", run, 1000);
  assert.equal(reads, 1);
});

test("captureMode: a dead session has no mode, and does not throw", async () => {
  resetPromptCache();
  assert.equal(await captureMode("gone", async () => ({ ok: false, stdout: "", stderr: "no session" }), 1000), null);
});

test("capturePane: returns the raw screen, cached like the parsed views", async () => {
  resetPromptCache();
  const text = await capturePane("s", async () => ({ ok: true, stdout: "hello\n", stderr: "" }), 1000);
  assert.equal(text, "hello\n");
});

// --- did the message actually leave the composer? ---------------------------

test("inputHolds: text still in the composer is detected", () => {
  // The real captured idle pane ends with an unsent line in the box — exactly
  // the state that made a message look sent when it was not.
  assert.equal(inputHolds(pane("idle"), "now create fixture-a.txt with ALPHA"), true);
});

test("inputHolds: text that was submitted is not still in the composer", () => {
  // Those `❯` lines above are turns that WERE sent. Only the last one is the
  // composer, and matching an earlier one would report every message stuck.
  assert.equal(inputHolds(pane("idle"), "Use the AskUserQuestion tool to ask me which log level"), false);
  assert.equal(inputHolds(pane("idle"), "something never typed"), false);
});

test("inputHolds: matches on a prefix, since the composer truncates", () => {
  const long = "x".repeat(200);
  assert.equal(inputHolds(`❯ ${long.slice(0, 60)}`, long), true);
});

test("inputHolds: a multi-line message is judged by its first line", () => {
  assert.equal(inputHolds("❯ first line", "first line\nsecond line"), true);
});

test("inputHolds: a pane with no composer, or an empty message, holds nothing", () => {
  assert.equal(inputHolds("no prompt here", "anything"), false);
  assert.equal(inputHolds(pane("idle"), "   "), false);
});

// --- what the terminal is doing that the status file does not say -----------

test("parseActivity: a real compacting pane is recognised", () => {
  // Captured from a live session mid-`/compact`. The registry status read
  // `idle` for the whole time it ran, which is why this has to come from the
  // pane: the page had nothing to show and looked stalled.
  assert.equal(parseActivity(pane("compacting")), "compacting conversation");
});

test("parseActivity: the spinner frame is not part of the match", () => {
  // It cycles through several glyphs; pinning one would work until it changed.
  assert.equal(parseActivity("✻ Compacting conversation…"), "compacting conversation");
  assert.equal(parseActivity("◐ Compacting conversation…"), "compacting conversation");
});

test("parseActivity: automatic compaction is named as such", () => {
  assert.match(parseActivity("Compacting at auto window (170000 tokens)")!, /auto/);
});

test("parseActivity: an ordinary pane reports no activity", () => {
  assert.equal(parseActivity(pane("idle")), null);
  assert.equal(parseActivity(""), null);
});

test("captureActivity: shares the cached pane read with the picker", async () => {
  resetPromptCache();
  let reads = 0;
  const run = async () => { reads++; return { ok: true, stdout: pane("compacting"), stderr: "" }; };
  assert.equal(await captureActivity("s", run, 1000), "compacting conversation");
  await capturePrompt("s", run, 1000);
  assert.equal(reads, 1);
});

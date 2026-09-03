/**
 * The dashboard's own rendering — escaping, PR folding, status wording.
 *
 * The browser code had no tests at all, including `esc`, which is the only
 * thing standing between a session title and an HTML injection. Everything
 * here is pure, so none of it needs a DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Plain JS shared with the browser, so it has no types. The directive must sit
// immediately above the specifier line, which is why this import stays on one
// line however long it gets.
// @ts-expect-error - untyped browser module
import { STATUS_LABEL, ago, askPanel, attachNote, card, describe, esc, moreButton, prBlock, repoShort, section, splitPrs, steer } from "../web/render.js";

const pr = (o: Record<string, unknown> = {}) => ({
  repository: "Calder-AI/calder_core", number: 7, url: "https://x/7", at: 1,
  title: "A PR", phase: "open", checks: null, ...o,
});
const s = (o: Record<string, unknown> = {}) => ({
  sessionId: "abc", title: "T", recap: null, lastPrompt: null, status: "idle",
  live: true, repo: "Calder-AI/calder_core", model: null, contextPct: null,
  costUsd: null, startedAt: null, updatedAt: null, prs: [], attach: "tmux",
  viewOpen: false, attached: false, ...o,
});

// --- escaping ---------------------------------------------------------------

test("esc: neutralises everything that could break out of HTML", () => {
  assert.equal(esc(`<script>alert("x")&'`), "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
});

test("esc: null and undefined render as empty, not the words", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("card: a hostile title cannot inject markup", () => {
  // Titles come from a session's own transcript, so they are arbitrary text.
  const html = card(s({ title: '</span><img src=x onerror=alert(1)>' }));
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&lt;img"));
});

test("card: a hostile PR url cannot break out of the href", () => {
  const html = card(s({ prs: [pr({ url: '" onmouseover="alert(1)' })] }));
  assert.ok(!html.includes('onmouseover="alert'), html);
});

// --- the description --------------------------------------------------------

test("describe: the recap wins over the last prompt", () => {
  const html = describe(s({ recap: "Goal: ship it", lastPrompt: "it's ok, ignore that" }));
  assert.ok(html.includes("Goal: ship it"));
  assert.ok(!html.includes("ignore that"));
  assert.ok(html.includes("recap"), "and is marked as a recap");
});

test("describe: the last prompt is the fallback, and nothing is fine too", () => {
  assert.ok(describe(s({ lastPrompt: "do the thing" })).includes("do the thing"));
  assert.equal(describe(s()), "");
});

// --- PR badges --------------------------------------------------------------

test("prBlock: finished PRs fold away, live ones do not", () => {
  // A long session links many PRs, most already merged; showing them equally
  // buries the ones that still need something.
  const html = prBlock(s({
    prs: [pr({ number: 1, phase: "open" }), pr({ number: 2, phase: "merged" }), pr({ number: 3, phase: "closed" })],
  }));
  assert.ok(html.includes("#1"), "the open one is shown outright");
  assert.ok(html.includes("<details"), "the finished ones are behind a disclosure");
  assert.ok(html.includes("1 merged, 1 closed"), html);
});

test("prBlock: each phase gets its own class, so colour follows state", () => {
  for (const phase of ["open", "draft", "queued", "merged", "closed"]) {
    assert.ok(prBlock(s({ prs: [pr({ phase })] })).includes(`ph-${phase}`), phase);
  }
});

test("prBlock: a PR not yet looked up is unknown, not guessed", () => {
  assert.ok(prBlock(s({ prs: [pr({ phase: null })] })).includes("ph-unknown"));
});

test("prBlock: draft and queued say so, since colour alone is not enough", () => {
  assert.ok(prBlock(s({ prs: [pr({ phase: "draft" })] })).includes("draft"));
  assert.ok(prBlock(s({ prs: [pr({ phase: "queued" })] })).includes("queued"));
});

test("prBlock: no PRs renders nothing at all", () => {
  assert.equal(prBlock(s()), "");
});

test("prBlock: all-finished still shows the disclosure and no bare badges", () => {
  const html = prBlock(s({ prs: [pr({ phase: "merged" })] }));
  assert.ok(html.includes("<details"));
  assert.ok(html.includes("1 merged"));
});

// --- status wording ---------------------------------------------------------

test("STATUS_LABEL: says what the state MEANS, not the internal token", () => {
  // Red and yellow are the most common pair to be unable to separate, so the
  // word has to carry the meaning on its own.
  assert.equal(STATUS_LABEL.awaiting, "waiting for you");
  assert.equal(STATUS_LABEL.permission, "needs permission");
  assert.equal(STATUS_LABEL.busy, STATUS_LABEL.working, "two sources, one meaning");
});

test("card: the status class drives the colour, and the word explains it", () => {
  const html = card(s({ status: "awaiting" }));
  assert.ok(html.includes('class="card awaiting"'), html.slice(0, 80));
  assert.ok(html.includes("waiting for you"));
});

// --- actions ----------------------------------------------------------------

test("card: offers only what the session can actually do", () => {
  assert.ok(card(s({ attach: "tmux" })).includes("data-open"));
  assert.ok(card(s({ attach: "fork" })).includes("data-fork"));
  assert.ok(card(s({ attach: "resume" })).includes("data-resume"));
  assert.ok(card(s({ attach: "none" })).includes("disabled"));
});

test("card: Close terminal appears only when a view is open", () => {
  assert.ok(!card(s({ attach: "tmux", viewOpen: false })).includes("data-detach"));
  assert.ok(card(s({ attach: "tmux", viewOpen: true })).includes("data-detach"));
});

test("card: End session is always offered for a tmux session, and marked risky", () => {
  const html = card(s({ attach: "tmux" }));
  assert.ok(html.includes("data-close"));
  assert.ok(html.includes("danger"), "styled as the destructive one");
});

test("attachNote: distinguishes a board tab from another window", () => {
  assert.ok(attachNote(s({ viewOpen: true })).includes("here"));
  assert.ok(attachNote(s({ attached: true })).includes("another window"));
  assert.equal(attachNote(s()), "");
});

// --- small helpers ----------------------------------------------------------

test("ago: reads in the largest unit that still says something", () => {
  const now = Date.now();
  assert.match(ago(now - 30_000), /^\d+s$/);
  assert.match(ago(now - 5 * 60_000), /^\d+m$/);
  assert.match(ago(now - 5 * 3_600_000), /^\d+h$/);
  assert.match(ago(now - 3 * 86_400_000), /^\d+d$/);
  assert.equal(ago(null), "", "no timestamp shows nothing, not 'NaNs'");
});

test("repoShort: drops the owner, which is the same for everything here", () => {
  assert.equal(repoShort("Calder-AI/calder_core"), "calder_core");
  assert.equal(repoShort(null), "—");
});

test("card: names its repo, since the board no longer groups by it", () => {
  // Sections are "in progress" and "recently ended" now, so the repo has to be
  // legible on the card itself.
  assert.ok(card(s({ repo: "Calder-AI/calder_core" })).includes("calder_core"));
  assert.ok(card(s({ repo: null })).includes("—"), "and says so when there is none");
});

test("moreButton: shown only while there is more, and says how much more", () => {
  // "showing 12 of 115" is the difference between a button you know what to do
  // with and one you press to find out.
  const html = moreButton(12, 115);
  assert.ok(html.includes("data-more"));
  assert.ok(html.includes("showing 12 of 115"), html);
  assert.equal(moreButton(115, 115), "", "nothing left to show, nothing to press");
  assert.equal(moreButton(5, 3), "", "and never on a count that already exceeds the total");
});

test("section: takes an extra block, which is where the control goes", () => {
  assert.ok(section("ended", [s()], "<b>EXTRA</b>").includes("<b>EXTRA</b>"));
  assert.equal(section("ended", [], "<b>EXTRA</b>"), "", "an empty section draws neither");
});

// --- the picker -------------------------------------------------------------

const prompt = (o = {}) => ({
  question: "Do you want to create fixture-a.txt?",
  header: "",
  cursor: 1,
  multiSelect: false,
  fingerprint: "abc123",
  options: [
    { index: 1, label: "Yes", description: "", drivable: true, reason: "" },
    { index: 2, label: "No", description: "", drivable: true, reason: "" },
  ],
  ...o,
});

test("askPanel: nothing to answer renders nothing", () => {
  assert.equal(askPanel(null, "sid"), "");
});

test("askPanel: each option carries the session, its index and the fingerprint", () => {
  const html = askPanel(prompt(), "sid-1");
  assert.ok(html.includes('data-answer="sid-1"'));
  assert.ok(html.includes('data-index="2"'));
  // The fingerprint rides on the button so the server can refuse a stale click.
  assert.ok(html.includes('data-fp="abc123"'));
});

test("askPanel: numbering follows the terminal, not the array order", () => {
  // The keys the server sends are the terminal's own numbers, so the panel has
  // to show those and not a re-count of the list.
  const html = askPanel(prompt({
    options: [
      { index: 4, label: "Type something.", description: "", drivable: false, reason: "needs typing" },
      { index: 5, label: "Chat about this", description: "", drivable: true, reason: "" },
    ],
  }), "sid");
  assert.ok(html.includes('data-index="5"'));
  assert.ok(!html.includes('data-index="1"'));
});

test("askPanel: an undrivable option is shown, disabled, with its reason", () => {
  const html = askPanel(prompt({
    options: [{ index: 1, label: "Type something.", description: "", drivable: false, reason: "needs typing — open the terminal" }],
  }), "sid");
  // Shown, because hiding it would make the panel disagree with the terminal
  // about what the choices are.
  assert.ok(html.includes("Type something."));
  assert.ok(html.includes("needs typing"));
  // But not clickable.
  assert.ok(!html.includes("data-answer"));
});

test("askPanel: a hostile question or label cannot inject markup", () => {
  const html = askPanel(prompt({
    question: '<img src=x onerror=alert(1)>',
    options: [{ index: 1, label: '"><script>bad()</script>', description: "", drivable: true, reason: "" }],
  }), "sid");
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<script>"));
});

test("askPanel: the header is optional", () => {
  assert.ok(askPanel(prompt({ header: "Log level" }), "s").includes("Log level"));
  assert.ok(!askPanel(prompt(), "s").includes("askeyebrow"));
});

test("askPanel: does not restate what the card header already says", () => {
  // The card shows "NEEDS PERMISSION" and the session page shows a status
  // pill; a third "waiting for you" inside the panel is noise on a dense card.
  assert.ok(!askPanel(prompt(), "s").toLowerCase().includes("waiting for you"));
});

test("card: a blocked session shows its picker", () => {
  const html = card(s({ status: "permission", prompt: prompt() }));
  assert.ok(html.includes("data-answer"), "the whole point is answering without opening the session");
  assert.ok(!card(s({})).includes("data-answer"));
});

// --- stopping and messaging from the card -----------------------------------

test("steer: a live tmux session can be messaged", () => {
  const html = steer(s({ attach: "tmux", status: "idle" }));
  assert.ok(html.includes('data-say="sid"') || html.includes("data-say"));
  assert.ok(html.includes("<input"));
});

test("steer: Stop appears only while there is a turn to stop", () => {
  assert.ok(steer(s({ attach: "tmux", status: "busy" })).includes("data-stop"));
  assert.ok(!steer(s({ attach: "tmux", status: "idle" })).includes("data-stop"));
});

test("steer: the placeholder says a busy session will queue, not interrupt", () => {
  // The distinction the control exists for: sending to a busy session must not
  // read as barging in.
  assert.match(steer(s({ attach: "tmux", status: "busy" })), /queue a message/);
  assert.match(steer(s({ attach: "tmux", status: "idle" })), /say something/);
});

test("steer: a session board cannot type into gets no box", () => {
  // A bare session has no pane to paste into; offering the box would be a
  // button that fails.
  assert.equal(steer(s({ attach: "fork" })), "");
  assert.equal(steer(s({ attach: "resume", live: false })), "");
});

test("steer: a hostile session id cannot inject markup", () => {
  assert.ok(!steer(s({ attach: "tmux", sessionId: '"><img src=x>' })).includes("<img"));
});

test("card: a live tmux session carries the steer control", () => {
  assert.ok(card(s({ attach: "tmux", status: "busy" })).includes("data-say"));
});

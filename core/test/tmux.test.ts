import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PANES_FORMAT,
  SESSIONS_FORMAT,
  buildCreateSessionCmd,
  buildSplitWindowCmd,
  capturePane,
  clearDraft,
  composerText,
  getOption,
  hasSession,
  isClaudeCommand,
  killSession,
  listAllPanes,
  listSessions,
  looksLikePrompt,
  parsePaneLine,
  parseSessionsOutput,
  resetTmuxBin,
  setExtendedKeys,
  setOption,
  shellQuote,
  unsetOption,
  type Exec,
  type ExecResult,
} from "../src/tmux.ts";
import { ALL_OPTS } from "../src/model.ts";

const TAB = "\t";
const BOX_IDS = ["alpha", "bravo", "charlie"];

/** Records every command it is asked to run and answers from a lookup of
 *  substring -> stdout. `command -v tmux` always resolves, so no test needs a
 *  tmux on PATH. */
function fakeExec(replies: Array<[string, string]> = [], ok = true) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, _timeoutMs): Promise<ExecResult> => {
    calls.push(cmd);
    if (cmd.includes("command -v tmux")) return { ok: true, stdout: "/usr/bin/tmux\n", stderr: "" };
    for (const [needle, stdout] of replies) {
      if (cmd.includes(needle)) return { ok, stdout, stderr: "" };
    }
    return { ok, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

/** The lookup misses `command -v tmux` too, i.e. tmux is not installed. */
const noTmuxExec: Exec = async () => ({ ok: false, stdout: "", stderr: "not found" });

// ---------------------------------------------------------------------------
// parsePaneLine
// ---------------------------------------------------------------------------

test("parsePaneLine: parses a well-formed tab-delimited line", () => {
  const line = ["cc-alpha-work-x", "0", "1", "4242", "claude", "/repo/alpha"].join(TAB);
  assert.deepEqual(parsePaneLine(line), {
    session: "cc-alpha-work-x",
    windowIndex: 0,
    paneIndex: 1,
    panePid: 4242,
    currentCommand: "claude",
    currentPath: "/repo/alpha",
  });
});

test("parsePaneLine: a colon inside pane_current_path survives intact", () => {
  // This is the whole reason the format string uses tabs. The prior art split
  // on ":" and would have truncated this path to "/tmp/cc-probe/weird".
  const line = ["cc-general-q-bravo", "1", "0", "77", "zsh", "/tmp/cc-probe/weird:dir"].join(TAB);
  const pane = parsePaneLine(line);
  assert.equal(pane?.currentPath, "/tmp/cc-probe/weird:dir");
  assert.equal(pane?.session, "cc-general-q-bravo");
});

test("parsePaneLine: a tab inside pane_current_path is re-joined from the tail", () => {
  const line = ["cc-general-q-bravo", "1", "0", "77", "zsh", "/tmp/a", "b"].join(TAB);
  assert.equal(parsePaneLine(line)?.currentPath, `/tmp/a${TAB}b`);
});

test("parsePaneLine: rejects short, empty and non-numeric lines", () => {
  assert.equal(parsePaneLine(""), null);
  assert.equal(parsePaneLine(["a", "0", "0", "1", "zsh"].join(TAB)), null, "five fields");
  assert.equal(
    parsePaneLine(["a", "x", "0", "1", "zsh", "/tmp"].join(TAB)),
    null,
    "non-numeric window index",
  );
  assert.equal(
    parsePaneLine(["", "0", "0", "1", "zsh", "/tmp"].join(TAB)),
    null,
    "empty session name",
  );
});

// ---------------------------------------------------------------------------
// parseSessionsOutput
// ---------------------------------------------------------------------------

test("parseSessionsOutput: drops anything that is not shaped like one of ours", () => {
  const stdout = [
    ["devbox_localstack", "", "", "", "", ""].join(TAB),
    ["monitor-bravo-alpha", "", "", "", "", ""].join(TAB),
    ["cc-alpha-work-x", "", "", "", "", ""].join(TAB),
    ["cc-bravo-q-y", "", "", "", "", ""].join(TAB),
    "",
  ].join("\n");
  assert.deepEqual(
    parseSessionsOutput(stdout, BOX_IDS).map((r) => r.name),
    ["cc-alpha-work-x", "cc-bravo-q-y"],
  );
});

test("parseSessionsOutput: also drops a shape-valid session whose box is not configured", () => {
  // The box exists as far as parseSessionName is concerned - the filter is
  // membership in the boxIds passed in, which is tmux.ts's job by its own
  // header comment: "the only place that filtering happens".
  const stdout = ["cc-deleted-work-x", "", "", "", "", ""].join(TAB);
  assert.deepEqual(parseSessionsOutput(stdout, BOX_IDS), []);
  assert.deepEqual(parseSessionsOutput(stdout, [...BOX_IDS, "deleted"]).map((r) => r.name), [
    "cc-deleted-work-x",
  ]);
});

test("parseSessionsOutput: folds the user options in and drops the unset ones", () => {
  // Verified on tmux 3.7b: an unset user option renders as "" inside a -F
  // format, which is why the empty fields have to be dropped rather than kept.
  const stdout = [
    "cc-bravo-work-ec2-always-on-spike",
    "ec2 always-on spike",
    "waiting on Sam's review",
    "/repo/bravo-spike",
    "1750000000",
    "",
  ].join(TAB);
  const [row] = parseSessionsOutput(stdout, BOX_IDS);
  assert.equal(row.box, "bravo");
  assert.equal(row.mode, "work");
  assert.equal(row.slug, "ec2-always-on-spike");
  assert.deepEqual(row.options, {
    "@cc_label": "ec2 always-on spike",
    "@cc_recap": "waiting on Sam's review",
    "@cc_worktree": "/repo/bravo-spike",
    "@cc_created": "1750000000",
  });
});

test("parseSessionsOutput: the last option in ALL_OPTS is read, not dropped off the end", () => {
  // The parse is positional, so a newly appended option is exactly the one an
  // off-by-one would silently swallow. @cc_flag is last: losing it would mean
  // a restarted dashboard never sees a session flagged before it restarted.
  const fields = ["cc-alpha-work-packaging", "packaging", "", "", "", "", "", "1"];
  assert.equal(fields.length, ALL_OPTS.length + 1, "fixture must carry every option");
  const [row] = parseSessionsOutput(fields.join(TAB), BOX_IDS);
  assert.equal(row.options["@cc_flag"], "1");
  assert.equal(row.options["@cc_label"], "packaging");
});

test("parseSessionsOutput: empty output yields no rows", () => {
  assert.deepEqual(parseSessionsOutput("", BOX_IDS), []);
  assert.deepEqual(parseSessionsOutput("\n\n", BOX_IDS), []);
});

test("format strings: one field per option, tab-delimited, never colon", () => {
  assert.equal(SESSIONS_FORMAT.split(TAB).length, ALL_OPTS.length + 1);
  assert.equal(PANES_FORMAT.split(TAB).length, 6);
  assert.ok(!SESSIONS_FORMAT.includes(":"), "a colon delimiter would break on paths and options");
  assert.ok(!PANES_FORMAT.includes(":"));
  // The batched read only works because @cc_* interpolates inside -F.
  for (const opt of ALL_OPTS) assert.ok(SESSIONS_FORMAT.includes(`#{${opt}}`), opt);
});

// ---------------------------------------------------------------------------
// isClaudeCommand / looksLikePrompt
// ---------------------------------------------------------------------------

test("isClaudeCommand: a bare semver is Claude Code reporting its own version", () => {
  assert.equal(isClaudeCommand("2.1.132"), true);
  assert.equal(isClaudeCommand("claude"), true);
  assert.equal(isClaudeCommand("Claude"), true, "case-insensitive");
  assert.equal(isClaudeCommand("  claude  "), true);
});

test("isClaudeCommand: shells and other programs are not Claude", () => {
  for (const cmd of ["bash", "zsh", "sh", "fish", "ZSH"]) {
    assert.equal(isClaudeCommand(cmd), false, cmd);
  }
  for (const cmd of ["", "node", "vim", "1.2", "1.2.3.4", "v2.1.132", "claude-code"]) {
    assert.equal(isClaudeCommand(cmd), false, JSON.stringify(cmd));
  }
});

test("looksLikePrompt: true only for the permission/question sentinel", () => {
  assert.equal(looksLikePrompt("Do you want to proceed?\n  Enter to confirm - Esc to cancel"), true);
  assert.equal(looksLikePrompt("> \n  ? for shortcuts"), false);
  assert.equal(looksLikePrompt(""), false);
  assert.equal(looksLikePrompt("esc to cancel"), false, "sentinel is case-sensitive and literal");
});

// ---------------------------------------------------------------------------
// shellQuote
// ---------------------------------------------------------------------------

test("shellQuote: survives spaces, apostrophes and dollar signs", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("two words"), "'two words'");
  assert.equal(shellQuote("$HOME and `cmd`"), "'$HOME and `cmd`'");
  assert.equal(shellQuote("Sam' review"), `'Sam'\\'' review'`);
});

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

test("buildCreateSessionCmd: detached, quoted, with the pane program as one word", () => {
  const cmd = buildCreateSessionCmd("/usr/bin/tmux", {
    name: "cc-alpha-work-x",
    cwd: "/repo/alpha-x",
    command: "claude 'read the plan'",
    windowName: "plan",
  });
  assert.equal(
    cmd,
    "/usr/bin/tmux new-session -d -s 'cc-alpha-work-x' " +
      "-c '/repo/alpha-x' -n 'plan' " +
      `'claude '\\''read the plan'\\'''`,
  );
});

test("buildSplitWindowCmd: side-by-side by default, vertical on request", () => {
  const base = { target: "cc-alpha-work-x:0", cwd: "/tmp", command: "claude" };
  assert.ok(buildSplitWindowCmd("tmux", base).startsWith("tmux split-window -h "));
  assert.ok(
    buildSplitWindowCmd("tmux", { ...base, horizontal: false }).startsWith("tmux split-window -v "),
  );
  assert.ok(buildSplitWindowCmd("tmux", base).endsWith("-c '/tmp' 'claude'"));
});

// ---------------------------------------------------------------------------
// The exec seam
// ---------------------------------------------------------------------------

test("listSessions: exactly one tmux call, no per-session has-session probe", async () => {
  resetTmuxBin();
  const stdout = [
    ["devbox_localstack", "", "", "", "", ""].join(TAB),
    ["cc-alpha-work-x", "x", "", "", "", ""].join(TAB),
    ["cc-general-q-y", "y", "", "", "", ""].join(TAB),
  ].join("\n");
  const { exec, calls } = fakeExec([["list-sessions", stdout]]);
  const rows = await listSessions(["alpha", "general"], exec);
  assert.deepEqual(rows.map((r) => r.name), ["cc-alpha-work-x", "cc-general-q-y"]);
  const tmuxCalls = calls.filter((c) => !c.includes("command -v"));
  assert.equal(tmuxCalls.length, 1, "one list-sessions and nothing else");
  assert.ok(!calls.some((c) => c.includes("has-session")));
  assert.ok(!calls.some((c) => c.includes("show-options")));
});

test("listSessions: empty when tmux is missing or no server is running", async () => {
  resetTmuxBin();
  assert.deepEqual(await listSessions(BOX_IDS, noTmuxExec), []);
  resetTmuxBin();
  const { exec } = fakeExec([], false);
  assert.deepEqual(await listSessions(BOX_IDS, exec), []);
});

test("listAllPanes: one `list-panes -a` call for the whole server", async () => {
  resetTmuxBin();
  const stdout = [
    ["cc-alpha-work-x", "0", "0", "100", "2.1.132", "/repo/a"].join(TAB),
    ["cc-alpha-work-x", "0", "1", "101", "zsh", "/repo/weird:dir"].join(TAB),
    "garbage",
    ["devbox_localstack", "0", "0", "102", "zsh", "/repo/b"].join(TAB),
  ].join("\n");
  const { exec, calls } = fakeExec([["list-panes", stdout]]);
  const panes = await listAllPanes(exec);
  assert.equal(panes.length, 3, "malformed lines are dropped, unrelated sessions are not");
  assert.equal(panes[1].currentPath, "/repo/weird:dir");
  assert.equal(calls.filter((c) => c.includes("list-panes")).length, 1);
  assert.ok(calls[1].includes(" -a "), "one server-wide call, not one per session");
});

test("getOption: null when the option was never set", async () => {
  resetTmuxBin();
  const { exec } = fakeExec([], false);
  assert.equal(await getOption("cc-general-q-y", "@cc_recap", exec), null);
  resetTmuxBin();
  const set = fakeExec([["show-options", "waiting on review\n"]]);
  assert.equal(await getOption("cc-general-q-y", "@cc_recap", set.exec), "waiting on review");
});

test("setOption: quotes the value and flattens tabs that would break the -F read", async () => {
  resetTmuxBin();
  const { exec, calls } = fakeExec();
  assert.equal(await setOption("cc-general-q-y", "@cc_recap", "Sam' $recap\there", exec), true);
  const cmd = calls[1];
  assert.ok(cmd.includes(`'Sam'\\'' $recap here'`), cmd);
  assert.ok(!cmd.includes(TAB), "a tab would corrupt the batched listSessions read");
});

test("unsetOption: removes the option rather than blanking it", async () => {
  // Setting "" would leave the option present-but-empty, and parseSessionsOutput
  // drops empty fields anyway - but `-u` is what makes a hand-inspected session
  // honestly show no pending wrap.
  resetTmuxBin();
  const { exec, calls } = fakeExec();
  assert.equal(await unsetOption("cc-alpha-work-packaging", "@cc_wrap", exec), true);
  assert.match(calls[1], /set-option -t 'cc-alpha-work-packaging' -u '@cc_wrap'/);
});

test("capturePane / hasSession / killSession / setExtendedKeys shell out once each", async () => {
  resetTmuxBin();
  const { exec, calls } = fakeExec([["capture-pane", "Esc to cancel\n"]]);
  assert.equal(await capturePane("cc-alpha-work-x:.1", 10, exec), "Esc to cancel\n");
  assert.equal(await hasSession("cc-alpha-work-x", exec), true);
  assert.equal(await killSession("cc-alpha-work-x", exec), true);
  assert.equal(await setExtendedKeys(exec), true);
  const tmuxCalls = calls.filter((c) => !c.includes("command -v"));
  assert.equal(tmuxCalls.length, 4);
  assert.ok(tmuxCalls[0].includes("tail -10"));
  assert.ok(tmuxCalls[3].includes("extended-keys on"));
  assert.ok(tmuxCalls[3].includes("terminal-features 'xterm*:extkeys'"));
  // Without this Claude Code opens every pane with a warning about tmux's own
  // configuration, which reads as a fault in the session the tool just made.
  assert.ok(tmuxCalls[3].includes("focus-events on"));
});

test("capturePane: a non-integer line count cannot reach the shell", async () => {
  resetTmuxBin();
  const { exec, calls } = fakeExec();
  await capturePane("t", 10.9, exec);
  await capturePane("t", -5, exec);
  assert.ok(calls[1].includes("tail -10"));
  assert.ok(calls[2].includes("tail -1"));
});

// ---------------------------------------------------------------------------
// clearDraft / composerText

test("clearDraft: one send-keys carrying both escapes, and it reports a failure", async () => {
  // Batched on purpose. It was suspected of collapsing into a single key event
  // and leaving the draft behind, and that was measured to be false: batched, it
  // clears 3 times out of 3. What the clear needs is a gap AFTER it, which is
  // the caller's to give - see CLEAR_GAP_MS in wrap.ts.
  resetTmuxBin();
  const { exec, calls } = fakeExec();
  assert.equal(await clearDraft("cc-general-work-x.1", exec), true);
  const tmuxCalls = calls.filter((c) => !c.includes("command -v"));
  assert.equal(tmuxCalls.length, 1);
  assert.match(tmuxCalls[0], /send-keys -t 'cc-general-work-x\.1' Escape Escape/);

  resetTmuxBin();
  assert.equal(await clearDraft("cc-general-work-x.1", noTmuxExec), false);
});

test("composerText: reads the composer row, bottom-up, and says when it cannot", () => {
  // Shaped after a real capture: the composer sits between two rules, with the
  // status line under it.
  const screen = [
    "  I'll start by reading the repo.",
    "────────────────────────────────────────",
    "❯ /wrap",
    "────────────────────────────────────────",
    "  [Sonnet 5 high] │ myrepo main",
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ].join("\n");
  assert.equal(composerText(screen), "/wrap");

  // The failure this exists to catch.
  assert.equal(composerText("❯ sho/wrap  \n──────\n"), "sho/wrap");

  // NOT an emptiness test: an idle composer draws ghost placeholder text, so
  // "cleared" reads back as the placeholder rather than as "".
  assert.equal(composerText('❯ Try "how does <filepath> work?"'), 'Try "how does <filepath> work?"');
  assert.equal(composerText("❯ "), "");

  // Bottom-up: transcript output can quote the same glyph, the rows below the
  // composer never do.
  assert.equal(composerText("  ran: ❯ npm test\n────\n❯ /wrap\n────\n  ctx 27%"), "/wrap");

  // No composer at all is "could not tell", never "empty" - callers fail open.
  assert.equal(composerText("just some scrollback\nno prompt here"), null);
  assert.equal(composerText(""), null);
});

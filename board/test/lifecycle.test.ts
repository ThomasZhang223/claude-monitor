import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASTE_SETTLE_MS, cancelCopyModeCommand, closeSessionCommand, closeViewCommand, cycleModeCommand,
  disableMouseCommand, ensureView, groupedName, hasSession, interruptCommand, openViewCommands,
  parseTarget, resumeCommands, runTmux, scrollCommands, sendTextCommands, submitCommand,
} from "../src/lifecycle.ts";

// --- the command builders --------------------------------------------------

test("openViewCommands: a GROUPED session, not a plain attach", () => {
  // tmux clamps a session to its smallest attached client, so attaching a
  // browser tab straight to a session you also have open would visibly shrink
  // your real window. A grouped session shares the windows and sizes on its own.
  const { create, attach, view } = openViewCommands(
    { session: "happy", window: "@0", pane: "%0" },
    "cc-general-work-abcd1234",
  );
  assert.deepEqual(create, ["new-session", "-d", "-t", "happy", "-s", "board-cc-gener"]);
  assert.deepEqual(attach, ["attach-session", "-t", "board-cc-gener"]);
  assert.equal(view, "board-cc-gener");
  assert.ok(create.includes("-d"), "detached: this runs from a process with no terminal");
});

test("groupedName: named from the view key, so two tabs share one view", () => {
  assert.equal(groupedName("happy", "abcd1234-0000"), "board-abcd1234");
  assert.equal(groupedName("other", "abcd1234-0000"), groupedName("happy", "abcd1234-0000"));
});

test("closeViewCommand / closeSessionCommand target different things", () => {
  // The whole difference between detaching and ending the work.
  assert.deepEqual(closeViewCommand("board-abcd1234"), ["kill-session", "-t", "board-abcd1234"]);
  assert.deepEqual(closeSessionCommand("happy"), ["kill-session", "-t", "happy"]);
});

test("resumeCommands: forks by default, leaving the original alone", () => {
  const { create, name } = resumeCommands("abcd1234-0000", { cwd: "/repo" });
  assert.equal(name, "board-resume-abcd1234");
  assert.deepEqual(create.slice(0, 6), ["new-session", "-d", "-s", name, "-c", "/repo"]);
  assert.deepEqual(create.slice(6), ["claude", "--resume", "abcd1234-0000", "--fork-session"]);
});

test("resumeCommands: a true resume omits the fork flag", () => {
  const { create } = resumeCommands("abcd1234-0000", { fork: false });
  assert.ok(!create.includes("--fork-session"));
  assert.ok(!create.includes("-c"), "no cwd given, so none is passed");
});

test("resumeCommands: the resume name cannot collide with a view name", () => {
  // They would otherwise fight over one tmux session.
  const id = "abcd1234-0000";
  assert.notEqual(resumeCommands(id).name, groupedName("s", id));
});

test("parseTarget: splits session:window.pane", () => {
  assert.deepEqual(parseTarget("happy:@0.%0"), { session: "happy", window: "@0", pane: "%0" });
});

test("parseTarget: a session name containing a dot survives", () => {
  // Split on the FIRST colon and the LAST dot: a tmux session name may contain
  // a dot but never a colon, so doing it the other way round mangles it.
  assert.deepEqual(parseTarget("my.session:@1.%2"), { session: "my.session", window: "@1", pane: "%2" });
});

test("parseTarget: a bare session name is a session", () => {
  assert.deepEqual(parseTarget("happy"), { session: "happy", window: null, pane: null });
});

test("parseTarget: junk is null, not a half-parsed target", () => {
  assert.equal(parseTarget(""), null);
  assert.equal(parseTarget(":@0.%0"), null, "no session name");
});

test("scrollCommands: enters copy-mode, then scrolls by tmux's own motion", () => {
  // `set-option mouse on` was tried first and does not work: tmux offers mouse
  // reporting but the wheel never comes back from the browser. It also costs
  // drag-select, which this keeps.
  const [enter, scroll] = scrollCommands("board-abcd1234", 3);
  assert.deepEqual(enter, ["copy-mode", "-t", "board-abcd1234"]);
  assert.deepEqual(scroll, ["send-keys", "-t", "board-abcd1234", "-X", "-N", "3", "scroll-up"]);
});

test("scrollCommands: a negative count scrolls the other way", () => {
  assert.equal(scrollCommands("v", -3)[1].at(-1), "scroll-down");
  assert.equal(scrollCommands("v", -3)[1].at(-2), "3", "the count is the magnitude");
});

test("scrollCommands: a runaway wheel cannot ask for an unbounded scroll", () => {
  assert.equal(scrollCommands("v", 999999)[1].at(-2), "500");
});

test("disableMouseCommand: turns tmux mouse reporting off, per session", () => {
  // With mouse reporting on, xterm hands drags to the application and text
  // selection stops working entirely. Scrolling does not need it, so there is
  // nothing traded away by asserting it off.
  assert.deepEqual(disableMouseCommand("board-abcd1234"), ["set-option", "-t", "board-abcd1234", "mouse", "off"]);
  assert.ok(!disableMouseCommand("x").includes("-g"), "never global — only sessions board owns");
});

test("cancelCopyModeCommand: leaves copy-mode, which typing must do first", () => {
  // Scrolling enters copy-mode and tmux stays there: keys become copy-mode
  // commands, so arrows move a cursor and typing does nothing — which reads as
  // the terminal having locked up.
  assert.deepEqual(cancelCopyModeCommand("board-abcd1234"), ["send-keys", "-t", "board-abcd1234", "-X", "cancel"]);
});

test("interruptCommand: stops a turn with the key the terminal itself binds", () => {
  // Not board's own stop mechanism — the same Escape you would press.
  assert.deepEqual(interruptCommand("board-abcd1234"), ["send-keys", "-t", "board-abcd1234", "Escape"]);
});

test("sendTextCommands: one invocation, a bracketed paste, and no submit", () => {
  const cmds = sendTextCommands("s", "hello");
  // Three tmux spawns became one: `;` is tmux's own command separator, and a
  // spawn costs tens of milliseconds on the path of every message you send.
  assert.equal(cmds.length, 1, "one invocation");
  assert.equal(cmds[0].filter((a) => a === ";").length, 2, "three commands, two separators");
  assert.ok(cmds[0].includes("set-buffer") && cmds[0].includes("paste-buffer") && cmds[0].includes("delete-buffer"));
  assert.ok(cmds[0].includes("-p"), "must be a BRACKETED paste");
  // Submitting is a separate step on purpose: an Enter in the same breath as
  // the paste is accepted by an idle session and LOST by a busy one.
  assert.ok(!cmds[0].includes("Enter"), "the paste must not carry the Enter");
});

test("submitCommand: presses Enter, and PASTE_SETTLE_MS leaves room before it", () => {
  assert.deepEqual(submitCommand("s"), ["send-keys", "-t", "s", "Enter"]);
  assert.ok(PASTE_SETTLE_MS >= 100 && PASTE_SETTLE_MS <= 1000);
});

test("sendTextCommands: the message is one argv element, so nothing in it is parsed", () => {
  // The whole reason for set-buffer over typing: a message can contain quotes,
  // shell syntax, a leading dash, or a newline, and every one of those breaks
  // if it is typed instead of pasted.
  const nasty = 'say "hi" $HOME --flag\nsecond line';
  const argv = sendTextCommands("s", nasty)[0];
  const at = argv.indexOf(nasty);
  assert.ok(at > 0, "the message is present verbatim, unescaped and unsplit");
  assert.equal(argv[at - 1], "--", "and after -- so a leading dash is not a flag");
});

test("sendTextCommands: it cleans up its buffer", () => {
  assert.ok(sendTextCommands("s", "x")[0].includes("delete-buffer"));
});

test("cycleModeCommand: cycles with the key the terminal itself binds", () => {
  // BTab is tmux's name for Shift+Tab. There is no one-shot way to SET a mode:
  // /permissions opens a dialog and --permission-mode only applies at launch,
  // so board cycles exactly as the terminal's own footer tells you to.
  assert.deepEqual(cycleModeCommand("board-abcd1234"), ["send-keys", "-t", "board-abcd1234", "BTab"]);
});

// --- execution, against a fake tmux runner ----------------------------------

function fakeRunner(existing: Set<string>) {
  return async (args: readonly string[]) => {
    if (args[0] === "has-session") return { ok: existing.has(args[2]), stdout: "", stderr: existing.has(args[2]) ? "" : "can't find session" };
    if (args[0] === "new-session") {
      const i = args.indexOf("-s");
      if (i >= 0) existing.add(args[i + 1]);
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

test("hasSession: true only for a session the runner reports", async () => {
  const run = fakeRunner(new Set(["happy"]));
  assert.equal(await hasSession("happy", run), true);
  assert.equal(await hasSession("gone", run), false);
});

test("ensureView: already-open is success, not a race to create it", async () => {
  const existing = new Set(["happy", "board-abcd1234"]);
  const run = fakeRunner(existing);
  const res = await ensureView({ session: "happy", window: null, pane: null }, "abcd1234-0000", run);
  assert.deepEqual(res, { ok: true, view: "board-abcd1234" });
});

test("ensureView: creates the view when it does not exist yet", async () => {
  const existing = new Set(["happy"]);
  const run = fakeRunner(existing);
  const res = await ensureView({ session: "happy", window: null, pane: null }, "abcd1234-0000", run);
  assert.equal(res.ok, true);
  assert.ok(existing.has("board-abcd1234"));
});

test("runTmux: exported as the default TmuxRunner", () => {
  assert.equal(typeof runTmux, "function");
});

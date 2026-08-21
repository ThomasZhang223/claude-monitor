import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TERMINAL_APP,
  appleScriptEscape,
  detectTerminal,
  openInNewTerminal,
  openWindowArgs,
  raiseWindowArgs,
} from "../src/terminal.ts";
import { resetTmuxBin } from "../src/tmux.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

test("detectTerminal: macOS with Terminal.app installed is what we can drive", () => {
  assert.equal(detectTerminal({ platform: "darwin", exists: () => true }), "apple");
  assert.equal(detectTerminal({ platform: "linux", exists: () => true }), "unsupported");
  assert.equal(detectTerminal({ platform: "darwin", exists: () => false }), "unsupported");
});

test("detectTerminal: does not consult TERM_PROGRAM, which tmux overwrites", () => {
  // Inside tmux TERM_PROGRAM is "tmux", so keying off it reported unsupported in
  // the one situation the dashboard is always in.
  assert.equal(
    detectTerminal({ platform: "darwin", exists: (p) => p === TERMINAL_APP }),
    "apple",
  );
});

test("openWindowArgs: opens a window first, raises Terminal second", () => {
  // Raising before the window exists focuses whatever was last in front.
  const args = openWindowArgs("/usr/bin/tmux", "cc-app-work-plt1836");
  assert.equal(args.length, 4);
  assert.match(args[1], /do script/);
  assert.match(args[1], /attach -t 'cc-app-work-plt1836'/);
  assert.match(args[3], /activate/);
});

test("appleScriptEscape: quotes and backslashes survive the AppleScript literal", () => {
  assert.equal(appleScriptEscape('a"b'), 'a\\"b');
  assert.equal(appleScriptEscape("a\\b"), "a\\\\b");
});

function fakeExec(handlers: Array<[RegExp, Partial<ExecResult>]> = []): Exec & { calls: string[] } {
  resetTmuxBin();
  const calls: string[] = [];
  const fn = (async (cmd: string): Promise<ExecResult> => {
    calls.push(cmd);
    for (const [pattern, result] of handlers) {
      if (pattern.test(cmd)) return { ok: true, stdout: "", stderr: "", ...result };
    }
    if (cmd.includes("command -v tmux")) return { ok: true, stdout: "/usr/bin/tmux\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  }) as Exec & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("openInNewTerminal: runs osascript against the named session", async () => {
  const exec = fakeExec();
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: { platform: "darwin", exists: () => true },
  });
  assert.ok(res.ok, res.error ?? "");
  const call = exec.calls.find((c) => c.startsWith("osascript"))!;
  assert.ok(call, "called osascript");
  assert.match(call, /cc-general-q-notes/);
  assert.equal(res.note, undefined);
});

test("raiseWindowArgs: matches by tty, sets frontmost before activate", () => {
  const args = raiseWindowArgs("/dev/ttys004");
  const script = args.filter((_, i) => i % 2 === 1).join("\n");
  assert.match(script, /tty of t is "\/dev\/ttys004"/);
  const frontmostIdx = script.indexOf("set frontmost of w to true");
  const activateIdx = script.indexOf("if found then activate");
  assert.ok(frontmostIdx >= 0 && activateIdx >= 0, "both statements present");
  // Order is load-bearing: activate alone double-jumps through whichever
  // window Terminal last considered key, confirmed by live testing.
  assert.ok(frontmostIdx < activateIdx, "frontmost must be set before activate runs");
});

test("openInNewTerminal: raises the existing window instead of opening a duplicate", async () => {
  const exec = fakeExec([
    [/list-clients/, { stdout: "/dev/ttys004\n" }],
    [/frontmost/, { stdout: "true\n" }],
  ]);
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: { platform: "darwin", exists: () => true },
  });
  assert.ok(res.ok, res.error ?? "");
  assert.match(res.note ?? "", /switched to it/);
  assert.ok(
    !exec.calls.some((c) => c.includes("do script")),
    "does not also open a duplicate window",
  );
});

test("openInNewTerminal: falls back to opening a window when the tty is stale", async () => {
  // tmux still lists a client, but no Terminal window matches its tty (closed
  // without detaching) - same as never having been attached at all.
  const exec = fakeExec([
    [/list-clients/, { stdout: "/dev/ttys004\n" }],
    [/frontmost/, { stdout: "false\n" }],
  ]);
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: { platform: "darwin", exists: () => true },
  });
  assert.ok(res.ok, res.error ?? "");
  assert.equal(res.note, undefined);
  assert.ok(
    exec.calls.some((c) => c.includes("do script")),
    "opens a new window when nothing was found to raise",
  );
});

test("openInNewTerminal: an unsupported terminal points at the in-place attach", async () => {
  const exec = fakeExec();
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: { platform: "linux", exists: () => true },
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /press a to attach in place/);
  assert.equal(exec.calls.length, 0, "does not shell out at all");
});

test("openInNewTerminal: a failed osascript is reported, not swallowed", async () => {
  const exec = fakeExec([[/osascript/, { ok: false, stderr: "not authorised" }]]);
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: { platform: "darwin", exists: () => true },
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not authorised/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LINUX_TERMINALS,
  TERMINAL_APP,
  appleScriptEscape,
  detectTerminal,
  findLinuxTerminal,
  linuxAttachCommand,
  linuxWindowTitle,
  openInNewTerminal,
  openWindowArgs,
  raiseLinuxWindowCommand,
  raiseWindowArgs,
} from "../src/terminal.ts";
import { resetTmuxBin } from "../src/tmux.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

test("detectTerminal: each platform is driven by what it can actually open", () => {
  assert.equal(detectTerminal({ platform: "darwin", exists: () => true }), "apple");
  assert.equal(detectTerminal({ platform: "darwin", exists: () => false }), "unsupported");
  // Linux has no system-wide "the terminal", so it is a PATH search.
  assert.equal(
    detectTerminal({ platform: "linux", pathDirs: ["/usr/bin"], exists: (p) => p === "/usr/bin/ghostty" }),
    "linux",
  );
  assert.equal(
    detectTerminal({ platform: "linux", pathDirs: ["/usr/bin"], exists: () => false }),
    "unsupported",
  );
  assert.equal(detectTerminal({ platform: "win32", exists: () => true }), "unsupported");
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
    detect: { platform: "linux", pathDirs: ["/usr/bin"], exists: () => false },
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

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

const LINUX = (bins: string[]) => ({
  platform: "linux",
  pathDirs: ["/usr/bin"],
  exists: (p: string) => bins.some((b) => p === `/usr/bin/${b}`),
  override: "",
});

test("findLinuxTerminal: prefers the table's order, not PATH order", () => {
  // gnome-terminal is installed on nearly every GNOME box, so "first on PATH"
  // would mean nobody's better emulator is ever chosen.
  const found = findLinuxTerminal(LINUX(["gnome-terminal", "ghostty", "xterm"]));
  assert.equal(found?.bin, "ghostty");
});

test("findLinuxTerminal: x-terminal-emulator is the last resort, not the first", () => {
  // It is Debian's alternatives symlink, so it resolves to one of the others.
  const found = findLinuxTerminal(LINUX(["x-terminal-emulator", "konsole"]));
  assert.equal(found?.bin, "konsole");
});

test("findLinuxTerminal: nothing installed is null, not a guess", () => {
  assert.equal(findLinuxTerminal(LINUX([])), null);
});

test("findLinuxTerminal: an override names a known emulator, overriding preference", () => {
  const found = findLinuxTerminal({ ...LINUX(["ghostty", "kitty"]), override: "kitty" });
  assert.equal(found?.bin, "kitty");
});

test("findLinuxTerminal: an override for something not installed is null, not a fallback", () => {
  // Silently using a different emulator than the one named would be the wrong
  // kind of helpful - the override exists precisely to be obeyed.
  assert.equal(findLinuxTerminal({ ...LINUX(["ghostty"]), override: "kitty" }), null);
});

test("findLinuxTerminal: a {} override is a full command template", () => {
  const found = findLinuxTerminal({ ...LINUX([]), override: "myterm --new-window -- {}" });
  assert.equal(found?.run("'echo hi'"), "myterm --new-window -- 'echo hi'");
});

test("findLinuxTerminal: an unknown bare binary on PATH gets the conventional -e", () => {
  const found = findLinuxTerminal({ ...LINUX(["myterm"]), override: "myterm" });
  assert.equal(found?.run("'echo hi'"), "myterm -e sh -c 'echo hi'");
});

test("LINUX_TERMINALS: every entry runs the command through sh -c", () => {
  // One shape every emulator in the table accepts - the alternative is a
  // per-emulator argv split, and getting one of them wrong opens a window that
  // is silently attached to nothing.
  for (const t of LINUX_TERMINALS) {
    assert.match(t.run("'CMD'"), /sh -c 'CMD'$/, `${t.bin} runs via sh -c`);
  }
});

test("linuxAttachCommand: titles the window before tmux takes over, then execs", () => {
  const cmd = linuxAttachCommand("/usr/bin/tmux", "cc-app-work-plt1836");
  // The title has to be set first: it is how the window is found again later,
  // and after `exec` nothing in this shell runs at all.
  assert.ok(cmd.indexOf("033]0;") < cmd.indexOf("exec"), "title is set before the exec");
  assert.match(cmd, /exec \/usr\/bin\/tmux attach -t 'cc-app-work-plt1836'/);
  assert.match(cmd, /'claude-monitor: cc-app-work-plt1836'/);
});

test("linuxWindowTitle: prefixed so it cannot collide with an unrelated window", () => {
  assert.equal(linuxWindowTitle("cc-app-work-x"), "claude-monitor: cc-app-work-x");
});

test("raiseLinuxWindowCommand: anchors the match, so one session is not a prefix of another", () => {
  const cmd = raiseLinuxWindowCommand("cc-app-work-x");
  assert.match(cmd, /xdotool search --name/);
  assert.match(cmd, /\^claude-monitor: cc-app-work-x\$/);
  assert.match(cmd, /windowactivate %1/);
});

test("openInNewTerminal: Linux launches the emulator detached", async () => {
  const exec = fakeExec();
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: LINUX(["ghostty"]),
  });
  assert.ok(res.ok, res.error ?? "");
  const call = exec.calls.find((c) => c.includes("ghostty"));
  assert.ok(call, "launched ghostty");
  // A bare `&` leaves it in this process group, and the dashboard's exit kills
  // it - observed live as a window that opened and vanished a second later.
  assert.match(call!, /^setsid /, "new session - survives the dashboard exiting");
  assert.match(call!, /&$/, "backgrounded - the window must outlive this exec");
  assert.match(call!, /tmux attach -t .*cc-general-q-notes/);
  assert.ok(!exec.calls.some((c) => c.startsWith("osascript")), "no AppleScript on Linux");
});

test("openInNewTerminal: Linux raises an already-attached window instead of duplicating", async () => {
  // A second client shrinks the session to the smaller window for BOTH, so a
  // duplicate is worse than not opening anything.
  const exec = fakeExec([[/list-clients/, { stdout: "/dev/pts/3\n" }]]);
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: LINUX(["ghostty"]),
  });
  assert.ok(res.ok, res.error ?? "");
  assert.match(res.note ?? "", /already open/);
  assert.ok(exec.calls.some((c) => c.startsWith("xdotool")), "tried to raise it");
  assert.ok(!exec.calls.some((c) => c.includes("ghostty")), "did not open a second window");
});

test("openInNewTerminal: Linux without xdotool still refuses to duplicate", async () => {
  const exec = fakeExec([
    [/list-clients/, { stdout: "/dev/pts/3\n" }],
    [/xdotool/, { ok: false, stderr: "xdotool: not found" }],
  ]);
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: LINUX(["ghostty"]),
  });
  assert.ok(res.ok, res.error ?? "");
  assert.match(res.note ?? "", /already open/);
  assert.ok(!exec.calls.some((c) => c.includes("ghostty")), "did not open a second window");
});

test("openInNewTerminal: a failed Linux launch is reported, not swallowed", async () => {
  const exec = fakeExec([[/ghostty/, { ok: false, stderr: "cannot open display" }]]);
  const res = await openInNewTerminal("cc-general-q-notes", {
    exec,
    detect: LINUX(["ghostty"]),
  });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /cannot open display/);
});

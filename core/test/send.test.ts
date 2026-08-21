import { test } from "node:test";
import assert from "node:assert/strict";
import { CLEAR_GAP_MS, RESEND_GAP_MS, SUBMIT_GAP_MS, sendSlashCommand } from "../src/send.ts";
import { resetTmuxBin } from "../src/tmux.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const COMMAND = "/rc";

/**
 * `composer` is what the pane shows each time the code looks at it: one entry
 * per look, the last repeating, so a retry can be handed a different screen
 * from the first attempt. Empty means an unreadable pane.
 */
function fakeExec(composer: string[] = []): Exec & { calls: string[] } {
  resetTmuxBin();
  const calls: string[] = [];
  const screens = [...composer];
  const fn = (async (cmd: string): Promise<ExecResult> => {
    calls.push(cmd);
    if (cmd.includes("command -v tmux")) return { ok: true, stdout: "/usr/bin/tmux\n", stderr: "" };
    if (cmd.includes("capture-pane")) {
      const shown = screens.length > 1 ? screens.shift()! : screens[0];
      return { ok: true, stdout: shown === undefined ? "" : `❯ ${shown}\n`, stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  }) as Exec & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("sendSlashCommand: clear true, clean pane - clears, types, verifies, submits twice", async () => {
  const exec = fakeExec();
  const slept: number[] = [];
  const fail = await sendSlashCommand("cc-general-work-x", 0, COMMAND, {
    clear: true,
    deps: { exec, sleep: async (ms) => void slept.push(ms) },
  });
  assert.equal(fail, null);

  const sends = exec.calls.filter((c) => c.includes("send-keys"));
  assert.equal(sends.length, 4);
  assert.match(sends[0], /send-keys -t 'cc-general-work-x\.0' Escape Escape/);
  assert.match(sends[1], /send-keys -t 'cc-general-work-x\.0' -l '\/rc'/);
  assert.match(sends[2], /send-keys -t 'cc-general-work-x\.0' Enter/);
  assert.match(sends[3], /send-keys -t 'cc-general-work-x\.0' Enter/);
  assert.deepEqual(slept, [CLEAR_GAP_MS, SUBMIT_GAP_MS, RESEND_GAP_MS]);
});

test("sendSlashCommand: clear false - never clears, still verifies and submits", async () => {
  const exec = fakeExec();
  const slept: number[] = [];
  const fail = await sendSlashCommand("cc-general-work-x", 1, COMMAND, {
    clear: false,
    deps: { exec, sleep: async (ms) => void slept.push(ms) },
  });
  assert.equal(fail, null);

  const sends = exec.calls.filter((c) => c.includes("send-keys"));
  // No Escape Escape anywhere - the working-pane path must never interrupt the turn.
  assert.equal(exec.calls.filter((c) => c.includes("Escape Escape")).length, 0);
  assert.equal(sends.length, 3);
  assert.match(sends[0], /send-keys -t 'cc-general-work-x\.1' -l '\/rc'/);
  assert.match(sends[1], /send-keys -t 'cc-general-work-x\.1' Enter/);
  assert.match(sends[2], /send-keys -t 'cc-general-work-x\.1' Enter/);
  // No CLEAR_GAP_MS: nothing was cleared, so there is nothing to wait out.
  assert.deepEqual(slept, [SUBMIT_GAP_MS, RESEND_GAP_MS]);
});

test("sendSlashCommand: clear false and mangled - refuses immediately, no retry, pane untouched", async () => {
  const exec = fakeExec(["<draft>/rc"]);
  const fail = await sendSlashCommand("cc-general-work-x", 1, COMMAND, {
    clear: false,
    deps: { exec, sleep: async () => {} },
  });
  assert.deepEqual(fail, { kind: "mangled", staged: "<draft>/rc" });

  // One send-text attempt only - resending without clearing would reproduce
  // the exact same mangled line, so there is nothing a retry could fix.
  assert.equal(exec.calls.filter((c) => c.includes("-l '/rc'")).length, 1);
  assert.equal(exec.calls.filter((c) => c.includes("Escape Escape")).length, 0);
  assert.equal(exec.calls.filter((c) => /send-keys -t '[^']*' Enter/.test(c)).length, 0);
});

test("sendSlashCommand: clear true and mangled twice - retries once, then cleans up and refuses", async () => {
  const exec = fakeExec(["nope", "still nope"]);
  const fail = await sendSlashCommand("cc-general-work-x", 0, COMMAND, {
    clear: true,
    deps: { exec, sleep: async () => {} },
  });
  assert.deepEqual(fail, { kind: "mangled", staged: "still nope" });
  // Cleared on attempt 1, attempt 2, and once more on the way out.
  assert.equal(exec.calls.filter((c) => c.includes("Escape Escape")).length, 3);
  assert.equal(exec.calls.filter((c) => /send-keys -t '[^']*' Enter/.test(c)).length, 0);
});

test("sendSlashCommand: cannot reach the pane at all", async () => {
  resetTmuxBin();
  const exec = (async (cmd: string): Promise<ExecResult> => {
    if (cmd.includes("command -v tmux")) return { ok: true, stdout: "/usr/bin/tmux\n", stderr: "" };
    return { ok: false, stdout: "", stderr: "no such pane" };
  }) as Exec;
  const fail = await sendSlashCommand("cc-general-work-x", 0, COMMAND, {
    clear: false,
    deps: { exec, sleep: async () => {} },
  });
  assert.deepEqual(fail, { kind: "unreachable" });
});

test("sendSlashCommand: typed and verified clean, but Enter itself fails to send", async () => {
  resetTmuxBin();
  const exec = (async (cmd: string): Promise<ExecResult> => {
    if (cmd.includes("command -v tmux")) return { ok: true, stdout: "/usr/bin/tmux\n", stderr: "" };
    if (cmd.includes("Enter")) return { ok: false, stdout: "", stderr: "" };
    if (cmd.includes("capture-pane")) return { ok: true, stdout: "", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  }) as Exec;
  const fail = await sendSlashCommand("cc-general-work-x", 0, COMMAND, {
    clear: false,
    deps: { exec, sleep: async () => {} },
  });
  assert.deepEqual(fail, { kind: "unsubmitted" });
});

test("sendSlashCommand: an unreadable pane fails open and submits anyway", async () => {
  const exec = fakeExec(); // capture-pane returns nothing recognisable
  const fail = await sendSlashCommand("cc-general-work-x", 0, COMMAND, {
    clear: false,
    deps: { exec, sleep: async () => {} },
  });
  assert.equal(fail, null);
  assert.equal(exec.calls.filter((c) => /send-keys -t '[^']*' Enter/.test(c)).length, 2);
});

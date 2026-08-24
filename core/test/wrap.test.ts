import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLEAR_GAP_MS,
  WRAP_COMMAND,
  WRAP_SETTLE_MS,
  WRAP_TIMEOUT_MS,
  decideWrap,
  decodeWrap,
  encodeWrap,
  wrapOrder,
  sendWrap,
} from "../src/wrap.ts";
import { resetTmuxBin } from "../src/tmux.ts";
import type { ClaudeSession, PaneRecord, Status } from "../src/model.ts";
import type { Exec, ExecResult } from "../src/exec.ts";

const SENT = 1_000_000;
const job = { tmuxName: "cc-general-work-x", label: "x", pane: 0, sentAt: SENT, next: null };

function claude(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 1,
    sessionId: "s",
    cwd: "/tmp/wt",
    rawStatus: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    name: null,
    ...over,
  };
}

function pane(paneIndex: number, sessionId: string | null): PaneRecord {
  return {
    paneIndex,
    panePid: 100 + paneIndex,
    status: "idle",
    claude: sessionId === null ? null : claude({ sessionId }),
    auto: null,
  };
}

test("decideWrap: idleness right after submitting is ignored", () => {
  // Claude is idle in the instant before a turn starts as well as after one ends.
  // Acting on the first tick would kill the session before the wrap wrote a word.
  assert.deepEqual(decideWrap(job, "idle", SENT + 500), { kind: "wait" });
  assert.deepEqual(decideWrap(job, "awaiting", SENT + WRAP_SETTLE_MS - 1), { kind: "wait" });
});

test("decideWrap: kills once the session goes quiet after settling", () => {
  for (const status of ["idle", "awaiting"] as Status[]) {
    assert.deepEqual(decideWrap(job, status, SENT + WRAP_SETTLE_MS + 1), { kind: "kill" }, status);
  }
});

test("decideWrap: waits while the wrap is actually working", () => {
  assert.deepEqual(decideWrap(job, "working", SENT + 60_000), { kind: "wait" });
});

test("decideWrap: a permission prompt is waited on, not killed through", () => {
  // Blocked on the user is still a live wrap. The blinking row is the prompt to
  // go and answer it.
  assert.deepEqual(decideWrap(job, "permission", SENT + 60_000), { kind: "wait" });
});

test("decideWrap: a dead process needs no waiting", () => {
  assert.deepEqual(decideWrap(job, "dead", SENT + 100), { kind: "kill" });
});

test("decideWrap: a timeout NEVER kills", () => {
  // This is the rule the whole module is built around: killing mid-wrap destroys
  // the note the wrap exists to produce.
  const step = decideWrap(job, "working", SENT + WRAP_TIMEOUT_MS + 1);
  assert.equal(step.kind, "giveup");
  assert.match((step as { reason: string }).reason, /left alive/);
});

test("decideWrap: a wrap that overran the timeout but finished still gets its kill", () => {
  // The timeout guards against killing a wrap that is STILL GOING. A pane that
  // has gone quiet is not that, so quiet is decided first - otherwise a wrap
  // that took 15m01s and did write its note gets abandoned a second before the
  // payoff, and the session is left alive for no reason.
  const late = SENT + WRAP_TIMEOUT_MS + 1;
  assert.deepEqual(decideWrap(job, "idle", late), { kind: "kill" });
  assert.deepEqual(decideWrap(job, "awaiting", late), { kind: "kill" });
  assert.deepEqual(decideWrap(job, "dead", late), { kind: "kill" });
});

test("decideWrap: an errored session is abandoned, not killed", () => {
  const step = decideWrap(job, "error", SENT + WRAP_SETTLE_MS + 1);
  assert.equal(step.kind, "giveup");
  assert.match((step as { reason: string }).reason, /left alive/);
});

test("wrapOrder: plan before implement", () => {
  const panes = [pane(1, "impl"), pane(0, "plan")];
  assert.deepEqual(wrapOrder(panes), [0, 1]);
});

test("wrapOrder: a pane with no Claude in it is skipped", () => {
  assert.deepEqual(wrapOrder([pane(0, null), pane(1, "impl")]), [1]);
  assert.deepEqual(wrapOrder([pane(0, null)]), []);
  assert.deepEqual(wrapOrder([]), []);
});

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

test("sendWrap: types the command, then submits it separately, then resends Enter as insurance", async () => {
  const exec = fakeExec();
  const slept: number[] = [];
  const err = await sendWrap("cc-general-work-x", 1, {
    exec,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(err, null);

  const sends = exec.calls.filter((c) => c.includes("send-keys"));
  assert.equal(sends.length, 4);
  // Double Esc first, so a leftover draft doesn't get /wrap appended after it
  // and stop being a slash command the moment it isn't the first character.
  assert.match(sends[0], /send-keys -t 'cc-general-work-x\.1' Escape Escape/);
  // Literal, or tmux would read parts of the command as key names.
  assert.match(sends[1], /send-keys -t 'cc-general-work-x\.1' -l '\/wrap'/);
  assert.match(sends[2], /send-keys -t 'cc-general-work-x\.1' Enter/);
  // A second Enter: insurance against the first arriving before Claude's UI
  // had finished processing the typed text and getting dropped.
  assert.match(sends[3], /send-keys -t 'cc-general-work-x\.1' Enter/);
  // Three gaps, and the first is the one that fixed `sho/wrap`: with nothing
  // between the clear and the text they arrive in the same read and the clear
  // is lost outright. Measured both ways - 5 of 5 mangled at no gap, 14 of 14
  // clean at 50ms and up - so this ordering is the whole fix, not a cushion.
  assert.equal(slept.length, 3);
  assert.equal(slept[0], CLEAR_GAP_MS);
  assert.ok(
    slept.every((ms) => ms > 0),
    `no gap may collapse to zero: ${slept}`,
  );
});

test("sendWrap: looks at what is staged, and will not submit a mangled command", async () => {
  // The composer kept a draft, so the line reads as prose rather than a command.
  const exec = fakeExec(["sho/wrap"]);
  const err = await sendWrap("cc-general-work-x", 0, { exec, sleep: async () => {} });

  assert.match(err ?? "", /not submitted, session left alive/);
  assert.match(err ?? "", /sho\/wrap/, "the error names what it actually saw");
  // The load-bearing assertion: nothing was submitted. runWrapStep records no
  // wrap job on an error, so a session whose note could not be written is also
  // a session that does not get killed.
  const enters = exec.calls.filter((c) => /send-keys -t '[^']*' Enter/.test(c));
  assert.equal(enters.length, 0, `no Enter may be sent: ${enters}`);
  // Cleared twice on the way in, plus once more so the pane is not left
  // holding our half-built command.
  const clears = exec.calls.filter((c) => c.includes("Escape Escape"));
  assert.equal(clears.length, 3);
});

test("sendWrap: retries the clear once, and submits when the second attempt comes back clean", async () => {
  const exec = fakeExec(["sho/wrap", "/wrap"]);
  const err = await sendWrap("cc-general-work-x", 0, { exec, sleep: async () => {} });

  assert.equal(err, null);
  assert.equal(exec.calls.filter((c) => c.includes("Escape Escape")).length, 2);
  assert.equal(exec.calls.filter((c) => /send-keys -t '[^']*' Enter/.test(c)).length, 2);
});

test("sendWrap: submits when the composer cannot be read - the check fails open", async () => {
  // No composer row in the capture at all: a release that moves the prompt
  // glyph must cost this check, not the whole wrap-on-kill feature.
  const exec = fakeExec(); // capture-pane returns nothing recognisable
  const err = await sendWrap("cc-general-work-x", 0, { exec, sleep: async () => {} });

  assert.equal(err, null);
  assert.equal(exec.calls.filter((c) => /send-keys -t '[^']*' Enter/.test(c)).length, 2);
});

test("sendWrap: always clears whatever is in the composer first, regardless of status", async () => {
  const exec = fakeExec();
  const err = await sendWrap("cc-general-work-x", 0, { exec, sleep: async () => {} });
  assert.equal(err, null);
  const sends = exec.calls.filter((c) => c.includes("send-keys"));
  assert.equal(sends.length, 4);
  assert.match(sends[0], /send-keys -t 'cc-general-work-x\.0' Escape Escape/);
  assert.match(sends[1], /send-keys -t 'cc-general-work-x\.0' -l '\/wrap'/);
  assert.match(sends[2], /send-keys -t 'cc-general-work-x\.0' Enter/);
  assert.match(sends[3], /send-keys -t 'cc-general-work-x\.0' Enter/);
});

test("sendWrap: reports a failure to reach the pane rather than pretending", async () => {
  resetTmuxBin();
  const exec = (async (cmd: string): Promise<ExecResult> => {
    if (cmd.includes("command -v tmux")) return { ok: true, stdout: "/usr/bin/tmux\n", stderr: "" };
    return { ok: false, stdout: "", stderr: "no such pane" };
  }) as Exec;
  const err = await sendWrap("cc-general-work-x", 0, { exec, sleep: async () => {} });
  assert.match(err ?? "", /could not send/);
});

test("WRAP_COMMAND is the slash command, not prose", () => {
  assert.equal(WRAP_COMMAND, "/wrap");
});

test("encodeWrap/decodeWrap: a job survives a round trip through the option", () => {
  for (const pending of [
    { pane: 0, next: 1, sentAt: SENT },
    { pane: 1, next: null, sentAt: SENT },
  ]) {
    assert.deepEqual(decodeWrap(encodeWrap(pending)), pending);
  }
});

test("encodeWrap: no braces or quotes, which would have to survive a tmux format", () => {
  assert.equal(encodeWrap({ pane: 1, next: null, sentAt: SENT }), "1:-:1000000");
  assert.equal(encodeWrap({ pane: 0, next: 1, sentAt: SENT }), "0:1:1000000");
});

test("decodeWrap: anything malformed is null, never a throw", () => {
  // This runs on the poll path against a value anyone can set by hand. A bad
  // option must cost that session's kill, not the whole dashboard.
  for (const bad of [
    null,
    undefined,
    "",
    "unset",
    "0:1",
    "0:1:1000000:extra",
    "x:1:1000000",
    "0:x:1000000",
    "0:1:notanumber",
    "-1:1:1000000",
    "0:1:0",
  ]) {
    assert.equal(decodeWrap(bad), null, JSON.stringify(bad));
  }
});

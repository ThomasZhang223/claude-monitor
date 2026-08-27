import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NOTIFY_SETTLE_MS,
  buildNotificationContent,
  fireNotification,
  paneLabelFor,
  paneNotifyKey,
  planNotifications,
  type NotifyStateMap,
} from "../src/notify.ts";
import type { ClaudeSession, Mode, PaneRecord, SessionRecord, Status } from "../src/model.ts";
import type { Exec, ExecResult } from "../src/exec.ts";
import { ALPHA, GENERAL } from "./fixtures/boxes.ts";

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  const mode: Mode = over.mode ?? "work";
  return {
    tmuxName: `cc-${ALPHA.id}-work-plt1654`,
    box: ALPHA.id,
    mode,
    slug: "plt1654",
    label: "plt1654",
    worktree: "/code/worktrees/plt-1654",
    recap: null,
    planPath: null,
    createdAt: null,
    branch: null,
    status: "idle",
    panes: [],
    contextPct: null,
    model: null,
    effort: null,
    runtimeMs: null,
    wrap: null,
    flagged: false,
    ...over,
  };
}

function claude(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 1,
    sessionId: "s",
    cwd: "/tmp/nonexistent-notify-test-wt",
    rawStatus: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    name: null,
    ...over,
  };
}

function pane(
  paneIndex: number,
  status: Status,
  hasClaude = true,
  auto: PaneRecord["auto"] = null,
  windowIndex = 0,
): PaneRecord {
  return {
    windowIndex,
    paneIndex,
    panePid: 100 + paneIndex,
    status,
    claude: hasClaude ? claude({ sessionId: `s${paneIndex}` }) : null,
    auto,
  };
}

// ---------------------------------------------------------------------------
// planNotifications
// ---------------------------------------------------------------------------

test("planNotifications: a fresh transition resets the clock and does not fire", () => {
  const records = [record({ status: "awaiting", panes: [pane(0, "awaiting")] })];
  const { nextState, fire } = planNotifications(new Map(), records, 1_000);
  assert.equal(fire.length, 0);
  assert.deepEqual(nextState.get(paneNotifyKey(records[0].tmuxName, 0, 0)), {
    status: "awaiting",
    since: 1_000,
    notified: false,
  });
});

test("planNotifications: fires once the settle window has passed", () => {
  const records = [record({ status: "awaiting", panes: [pane(0, "awaiting")] })];
  const prev: NotifyStateMap = new Map([
    [paneNotifyKey(records[0].tmuxName, 0, 0), { status: "awaiting", since: 1_000, notified: false }],
  ]);
  const { fire } = planNotifications(prev, records, 1_000 + NOTIFY_SETTLE_MS);
  assert.equal(fire.length, 1);
  assert.equal(fire[0].pane.paneIndex, 0);
});

test("planNotifications: does not fire before the settle window has passed", () => {
  const records = [record({ status: "awaiting", panes: [pane(0, "awaiting")] })];
  const prev: NotifyStateMap = new Map([
    [paneNotifyKey(records[0].tmuxName, 0, 0), { status: "awaiting", since: 1_000, notified: false }],
  ]);
  const { fire } = planNotifications(prev, records, 1_000 + NOTIFY_SETTLE_MS - 1);
  assert.equal(fire.length, 0);
});

test("planNotifications: fires once per streak, not every tick after settling", () => {
  const records = [record({ status: "awaiting", panes: [pane(0, "awaiting")] })];
  const prev: NotifyStateMap = new Map([
    [paneNotifyKey(records[0].tmuxName, 0, 0), { status: "awaiting", since: 1_000, notified: true }],
  ]);
  const { fire } = planNotifications(prev, records, 1_000 + NOTIFY_SETTLE_MS + 10_000);
  assert.equal(fire.length, 0);
});

test("planNotifications: re-arms after the status changes away and back", () => {
  const key = paneNotifyKey(record().tmuxName, 0, 0);
  // Was awaiting and already notified; now working again.
  const prev: NotifyStateMap = new Map([
    [key, { status: "awaiting", since: 1_000, notified: true }],
  ]);
  const working = [record({ status: "working", panes: [pane(0, "working")] })];
  const step1 = planNotifications(prev, working, 2_000);
  assert.equal(step1.fire.length, 0);
  assert.equal(step1.nextState.get(key)?.notified, false);

  // Back to awaiting: this is a fresh transition, so it must not fire yet.
  const awaitingAgain = [record({ status: "awaiting", panes: [pane(0, "awaiting")] })];
  const step2 = planNotifications(step1.nextState, awaitingAgain, 2_100);
  assert.equal(step2.fire.length, 0);

  // Only after settling again does it fire.
  const step3 = planNotifications(step2.nextState, awaitingAgain, 2_100 + NOTIFY_SETTLE_MS);
  assert.equal(step3.fire.length, 1);
});

test("planNotifications: working and idle never fire, however long they persist", () => {
  const key = paneNotifyKey(record().tmuxName, 0, 0);
  const prev: NotifyStateMap = new Map([
    [key, { status: "working", since: 0, notified: false }],
  ]);
  const records = [record({ status: "working", panes: [pane(0, "working")] })];
  const { fire } = planNotifications(prev, records, 1_000_000);
  assert.equal(fire.length, 0);
});

test("planNotifications: a killed session's pane is dropped, not carried forward", () => {
  const key = paneNotifyKey(record().tmuxName, 0, 0);
  const prev: NotifyStateMap = new Map([
    [key, { status: "awaiting", since: 0, notified: false }],
  ]);
  const { nextState } = planNotifications(prev, [], 1_000_000);
  assert.equal(nextState.size, 0);
});

test("planNotifications: a work session's two panes are tracked independently", () => {
  const records = [
    record({
      status: "awaiting",
      panes: [pane(0, "idle"), pane(1, "permission")],
    }),
  ];
  const prev: NotifyStateMap = new Map([
    [paneNotifyKey(records[0].tmuxName, 0, 0), { status: "idle", since: 0, notified: false }],
    [paneNotifyKey(records[0].tmuxName, 0, 1), { status: "permission", since: 0, notified: false }],
  ]);
  const { fire } = planNotifications(prev, records, NOTIFY_SETTLE_MS);
  assert.equal(fire.length, 1, "only the implement pane's permission transition fires");
  assert.equal(fire[0].pane.paneIndex, 1);
});

// ---------------------------------------------------------------------------
// buildNotificationContent
// ---------------------------------------------------------------------------

test("buildNotificationContent: the pane label goes in the title, not the subtitle", () => {
  // In the title specifically. Two panes notifying with the same status
  // previously differed only in the smaller subtitle line, so a plan and an
  // implement alert read as the same banner - which is how implement
  // notifications came to look like they were never firing at all.
  const r = record({ mode: "work", panes: [pane(0, "idle"), pane(1, "idle")] });
  assert.equal(paneLabelFor(r, 0), "plan");
  assert.equal(paneLabelFor(r, 1), "implement");
  const content = buildNotificationContent(r, pane(1, "permission"));
  assert.equal(content?.title, "Needs Permission — implement");
  assert.equal(content?.subtitle, r.tmuxName);

  const planContent = buildNotificationContent(r, pane(0, "permission"));
  assert.equal(planContent?.title, "Needs Permission — plan");
  assert.notEqual(planContent?.title, content?.title);
});

test("buildNotificationContent: a q-mode session has no pane label", () => {
  const r = record({ mode: "q", tmuxName: `cc-${GENERAL.id}-q-notes` });
  assert.equal(paneLabelFor(r, 0), null);
  const content = buildNotificationContent(r, pane(0, "awaiting"));
  assert.equal(content?.title, "Awaiting Input");
  assert.equal(content?.subtitle, `cc-${GENERAL.id}-q-notes`);
});

test("paneLabelFor: a 4-pane work session gets four distinct labels", () => {
  // The exact defect notify.ts's own header is written around: three
  // identically-titled "implement" notifications for a session that grew past
  // two panes.
  const r = record({
    mode: "work",
    panes: [pane(0, "idle"), pane(1, "idle"), pane(2, "idle"), pane(3, "idle")],
  });
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => paneLabelFor(r, i)),
    ["plan", "implement", "panel 3", "panel 4"],
  );
});

test("paneLabelFor: a grown non-work session labels every pane panel N", () => {
  const r = record({ mode: "research", panes: [pane(0, "idle"), pane(1, "idle")] });
  assert.equal(paneLabelFor(r, 0), "panel 1");
  assert.equal(paneLabelFor(r, 1), "panel 2");
});

test("paneLabelFor: a single-pane session has nothing to disambiguate", () => {
  const r = record({ mode: "work", panes: [pane(0, "idle")] });
  assert.equal(paneLabelFor(r, 0), null);
});

test("buildNotificationContent: each pane gets its own notification group", () => {
  // Grouping is per pane, never per session. terminal-notifier replaces a
  // notification that shares a group, so a session-level group would make one
  // pane's alert silently overwrite the other's.
  const r = record({ mode: "work", panes: [pane(0, "idle"), pane(1, "idle")] });
  const planGroup = buildNotificationContent(r, pane(0, "awaiting"))?.group;
  const implGroup = buildNotificationContent(r, pane(1, "awaiting"))?.group;
  assert.equal(planGroup, paneNotifyKey(r.tmuxName, 0, 0));
  assert.equal(implGroup, paneNotifyKey(r.tmuxName, 0, 1));
  assert.notEqual(planGroup, implGroup);
});

test("buildNotificationContent: the summary is the pane's own recap, not a re-read", () => {
  const r = record({ mode: "work" });
  const withRecap = pane(1, "awaiting", true, {
    text: "Ran the packaging smoke test; it fails on the tarball layout.",
    source: "away",
    at: 1,
  });
  assert.match(
    buildNotificationContent(r, withRecap)?.message ?? "",
    /fails on the tarball layout/,
  );
  // A pane that has not published anything says so rather than borrowing the
  // other pane's words.
  assert.match(
    buildNotificationContent(r, pane(0, "awaiting"))?.message ?? "",
    /nothing published yet/,
  );
});

test("buildNotificationContent: no worktree renders the no-folder line", () => {
  const r = record({ worktree: null });
  const content = buildNotificationContent(r, pane(0, "dead"));
  assert.match(content?.message ?? "", /No worktree — this box has no folder behind it/);
});

test("buildNotificationContent: a pane with no resolved Claude still renders", () => {
  const r = record();
  const content = buildNotificationContent(r, pane(0, "dead", false));
  assert.match(content?.message ?? "", /no summary available/);
});

test("buildNotificationContent: null for a status that isn't notify-worthy", () => {
  const r = record();
  assert.equal(buildNotificationContent(r, pane(0, "working")), null);
  assert.equal(buildNotificationContent(r, pane(0, "idle")), null);
});

// ---------------------------------------------------------------------------
// fireNotification
// ---------------------------------------------------------------------------

function fakeExec(handlers: Array<[RegExp, Partial<ExecResult>]> = []): Exec & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string): Promise<ExecResult> => {
    calls.push(cmd);
    for (const [pattern, result] of handlers) {
      if (pattern.test(cmd)) return { ok: true, stdout: "", stderr: "", ...result };
    }
    return { ok: true, stdout: "", stderr: "" };
  }) as Exec & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("fireNotification: shells out with the expected flags and attach command", async () => {
  const exec = fakeExec([[/command -v terminal-notifier/, { stdout: "/usr/local/bin/terminal-notifier\n" }]]);
  const r = record({ panes: [pane(0, "idle"), pane(1, "idle")] });
  await fireNotification(r, pane(1, "permission"), exec, "darwin");
  const call = exec.calls.find((c) => c.startsWith("terminal-notifier"));
  assert.ok(call, "called terminal-notifier");
  assert.match(call!, /-title 'Needs Permission — implement'/);
  assert.match(call!, new RegExp(`-subtitle '${r.tmuxName}'`));
  assert.match(call!, /-sound 'Ping'/);
  assert.match(call!, new RegExp(`-group '${r.tmuxName}:0\\.1'`));
  assert.match(call!, new RegExp(`-execute '.*bin/monitor-attach ${r.tmuxName}'`));
});

test("fireNotification: passes no flag terminal-notifier does not implement", async () => {
  // A composed-command assertion can only prove the string was built, never
  // that the tool honours it. `-actions` was asserted here for exactly that
  // reason and passed for exactly that long: terminal-notifier 2.0.0 has no
  // such flag (it is an `alerter` feature), ignores it silently, and rendered
  // no buttons at all. So this reads the flags back out of the REAL composed
  // command and checks each against the set `terminal-notifier -help` lists.
  const SUPPORTED = new Set([
    "-help", "-version", "-message", "-remove", "-list", "-title", "-subtitle",
    "-sound", "-group", "-activate", "-sender", "-appIcon", "-contentImage",
    "-open", "-execute", "-ignoreDnD",
  ]);
  const exec = fakeExec([[/command -v terminal-notifier/, { stdout: "/usr/local/bin/terminal-notifier\n" }]]);
  await fireNotification(record(), pane(1, "permission"), exec, "darwin");
  const call = exec.calls.find((c) => c.startsWith("terminal-notifier"));
  assert.ok(call, "called terminal-notifier");

  // Flag tokens only: anything starting with "-" that sits outside the
  // single-quoted values, so a hyphen inside a recap or a path cannot be
  // mistaken for one.
  const outsideQuotes = call!.split(/'[^']*'/).join(" ");
  const flags = outsideQuotes.match(/(?:^|\s)(-[A-Za-z]+)/g)?.map((s) => s.trim()) ?? [];
  assert.ok(flags.length >= 6, `found the flags: ${flags.join(" ")}`);
  for (const f of flags) {
    assert.ok(SUPPORTED.has(f), `${f} is not a flag terminal-notifier implements`);
  }
});

test("fireNotification: no-ops when terminal-notifier is missing", async () => {
  const exec = fakeExec([[/command -v terminal-notifier/, { ok: false, stdout: "" }]]);
  await fireNotification(record(), pane(1, "permission"), exec, "darwin");
  assert.ok(!exec.calls.some((c) => c.startsWith("terminal-notifier")));
});

test("fireNotification: Linux fires notify-send, never terminal-notifier", async () => {
  const exec = fakeExec([[/command -v notify-send/, { stdout: "/usr/bin/notify-send\n" }]]);
  const r = record({ panes: [pane(0, "idle"), pane(1, "idle")] });
  await fireNotification(r, pane(1, "permission"), exec, "linux");
  const call = exec.calls.find((c) => c.startsWith("setsid"));
  assert.ok(call, "called notify-send");
  assert.ok(!exec.calls.some((c) => c.includes("terminal-notifier")), "no macOS binary probed");
  assert.match(call!, /-u critical/, "a permission prompt stalls work outright");
  assert.match(call!, /'Needs Permission — implement'/);
  assert.match(call!, new RegExp(`x-canonical-private-synchronous:${r.tmuxName}:0\\.1`));
  assert.match(call!, new RegExp(`bin/monitor-attach ${r.tmuxName}`));
});

test("fireNotification: the notify-send wait is detached, not inline", async () => {
  // `-A` implies --wait, so notify-send blocks until the banner is dismissed.
  // Run inline that would stall the collect tick for as long as it sits unread.
  const exec = fakeExec([[/command -v notify-send/, { stdout: "/usr/bin/notify-send\n" }]]);
  await fireNotification(record(), pane(1, "awaiting"), exec, "linux");
  const call = exec.calls.find((c) => c.startsWith("setsid"))!;
  assert.match(call, /^setsid sh -c /, "own session - outlives the dashboard");
  assert.match(call, /&$/);
});

test("fireNotification: notify-send urgency is spent only where it is warranted", async () => {
  // `critical` never auto-dismisses on GNOME, so every status being critical
  // would leave a wall of banners to clear by hand.
  const exec = fakeExec([[/command -v notify-send/, { stdout: "/usr/bin/notify-send\n" }]]);
  await fireNotification(record(), pane(1, "awaiting"), exec, "linux");
  assert.match(exec.calls.find((c) => c.startsWith("setsid"))!, /-u normal/);
});

test("fireNotification: no-ops when notify-send is missing", async () => {
  const exec = fakeExec([[/command -v notify-send/, { ok: false, stdout: "" }]]);
  await fireNotification(record(), pane(1, "permission"), exec, "linux");
  assert.ok(!exec.calls.some((c) => c.includes("setsid")));
});

test("fireNotification: does nothing at all for a non-notify status", async () => {
  const exec = fakeExec();
  await fireNotification(record(), pane(0, "working"), exec);
  assert.equal(exec.calls.length, 0);
});

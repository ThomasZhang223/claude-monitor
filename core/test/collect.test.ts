import { test } from "node:test";
import assert from "node:assert/strict";
import { STARTUP_GRACE_MS, statusForPaneWithoutClaude, worstStatus } from "../src/collect.ts";
import { comparePanePosition, type Status } from "../src/model.ts";

test("worstStatus: a waiting plan pane is not hidden by a busy implement pane", () => {
  // The whole point of the row status. A work session has two panes; if one is
  // blocked on you, that must be what the dashboard shows.
  assert.equal(worstStatus(["working", "awaiting"]), "awaiting");
  assert.equal(worstStatus(["awaiting", "working"]), "awaiting");
});

test("worstStatus: severity order runs error > permission > awaiting > working > idle > dead", () => {
  const ordered: Status[] = ["dead", "idle", "working", "awaiting", "permission", "error"];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(
      worstStatus([ordered[i - 1], ordered[i]]),
      ordered[i],
      `${ordered[i]} outranks ${ordered[i - 1]}`,
    );
  }
});

test("worstStatus: a session whose panes are all dead reads dead", () => {
  assert.equal(worstStatus(["dead", "dead"]), "dead");
});

test("worstStatus: a session with no panes at all reads dead, not idle", () => {
  // An empty pane list means the tmux session exists but has nothing in it.
  // Calling that idle would make a broken session look alive.
  assert.equal(worstStatus([]), "dead");
});

test("worstStatus: one live pane keeps the row alive", () => {
  assert.equal(worstStatus(["dead", "working"]), "working");
});

test("a pane with no Claude reads dead, not idle", () => {
  // The case a liveness check alone cannot catch: kill -9 removes the process
  // from the tree, so there is no pid left to test. Every session this tool
  // creates launches Claude, so no Claude means it is gone. Calling that idle
  // would leave a crashed session looking healthy on the dashboard.
  const now = 1_000_000;
  assert.equal(statusForPaneWithoutClaude(now - STARTUP_GRACE_MS - 1, now), "dead");
});

test("a pane with no Claude is forgiven briefly right after creation", () => {
  // Claude takes a moment to appear in the process tree; a brand-new session
  // flashing "dead" would be worse than a moment of "idle".
  const now = 1_000_000;
  assert.equal(statusForPaneWithoutClaude(now - 1_000, now), "idle");
  assert.equal(statusForPaneWithoutClaude(now, now), "idle");
});

test("a pane with no Claude and no creation time reads dead", () => {
  // No @cc_created means the session was not created by us, or predates the
  // option. Without evidence of a recent start, assume it is not starting.
  assert.equal(statusForPaneWithoutClaude(null, 1_000_000), "dead");
});

// ---------------------------------------------------------------------------
// comparePanePosition
//
// collect.ts sorts a session's panes with this before anything else touches
// them, so window-then-pane order has to be right before pane 0 even means
// "the first pane" for a multi-window session.
// ---------------------------------------------------------------------------

test("comparePanePosition: a later window always sorts after an earlier one", () => {
  assert.ok(comparePanePosition({ windowIndex: 0, paneIndex: 5 }, { windowIndex: 1, paneIndex: 0 }) < 0);
  assert.ok(comparePanePosition({ windowIndex: 1, paneIndex: 0 }, { windowIndex: 0, paneIndex: 5 }) > 0);
});

test("comparePanePosition: within the same window, pane index decides", () => {
  assert.ok(comparePanePosition({ windowIndex: 0, paneIndex: 0 }, { windowIndex: 0, paneIndex: 1 }) < 0);
  assert.ok(comparePanePosition({ windowIndex: 0, paneIndex: 1 }, { windowIndex: 0, paneIndex: 0 }) > 0);
});

test("comparePanePosition: stable on ties", () => {
  assert.equal(comparePanePosition({ windowIndex: 2, paneIndex: 3 }, { windowIndex: 2, paneIndex: 3 }), 0);
});

test("a pane blocked on a prompt reads permission, never dead", () => {
  // Claude shows a trust-this-folder question in a directory it has not seen
  // before, and creates no session file while it waits there. From the process
  // tree that is indistinguishable from a crash, but it means the exact
  // opposite: the session needs one keypress from you. Calling it dead would
  // hide it completely.
  const now = 1_000_000;
  assert.equal(statusForPaneWithoutClaude(now - 600_000, now, true), "permission");
  // And it wins over the startup grace too, because a prompt is real evidence
  // while the grace period is only a guess.
  assert.equal(statusForPaneWithoutClaude(now, now, true), "permission");
});

/**
 * The status hook is a shell script, so it is tested by running it.
 *
 * Everything else in core/ is TypeScript behind an injectable seam, but
 * `hooks/session-status.sh` is what Claude Code actually executes, and the part
 * most worth pinning is a `case` statement over a payload shape owned by
 * another program. A TypeScript reimplementation of that logic would pass
 * happily while the real script was broken, so this drives the script itself
 * with fixture payloads on stdin and reads back the file it writes.
 *
 * HOME is redirected at the process level, which is the only isolation needed:
 * the script derives its whole output path from $HOME.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.resolve(
  fileURLToPath(import.meta.url),
  "../../..",
  "hooks",
  "session-status.sh",
);

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** Run the hook with `arg` and a JSON payload, and return whatever status file
 *  it wrote — null when it deliberately wrote nothing. */
function runHook(
  arg: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-status-"));
  try {
    execFileSync("bash", [HOOK, arg], {
      input: JSON.stringify(payload),
      env: { ...process.env, HOME: home },
      timeout: 10_000,
    });
    const out = path.join(home, ".local", "share", "claude-monitor", "status", `${SESSION_ID}.json`);
    if (!fs.existsSync(out)) return null;
    return JSON.parse(fs.readFileSync(out, "utf8"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const BASE = {
  session_id: SESSION_ID,
  transcript_path: `/Users/someone/.claude/projects/-x/${SESSION_ID}.jsonl`,
  cwd: "/Users/someone/work",
  hook_event_name: "Notification",
};

test("hook: a permission_prompt notification records `permission`", () => {
  // The payload shape here is copied from a real captured event, not invented:
  // notification_type is a first-class field Claude Code also exposes as a hook
  // matcher, which is why it is matched instead of the prose message.
  const got = runHook("notification", {
    ...BASE,
    message: "Claude needs your permission",
    notification_type: "permission_prompt",
  });
  assert.equal(got?.status, "permission");
  assert.equal(got?.cwd, "/Users/someone/work");
});

test("hook: an idle notification writes nothing at all", () => {
  // Not "writes awaiting" - writes NOTHING. Stop already owns `awaiting`, and a
  // status written here would let an idle notification clobber a session that
  // is genuinely mid-turn. This is the false-positive that kept Notification
  // unwired in the first place.
  const got = runHook("notification", {
    ...BASE,
    message: "Claude is waiting for your input",
    notification_type: "idle_prompt",
  });
  assert.equal(got, null);
});

test("hook: unrecognised notification types are dropped, not guessed at", () => {
  for (const notification_type of [
    "auth_success",
    "elicitation_dialog",
    "agent_completed",
    "some_future_type",
  ]) {
    assert.equal(
      runHook("notification", { ...BASE, message: "whatever", notification_type }),
      null,
      notification_type,
    );
  }
});

test("hook: falls back to the message when notification_type is absent", () => {
  // A build predating the notification_type field must still resolve a
  // permission prompt rather than silently going quiet.
  const got = runHook("notification", {
    ...BASE,
    message: "Claude needs your permission to use Bash",
  });
  assert.equal(got?.status, "permission");

  assert.equal(
    runHook("notification", { ...BASE, message: "Claude is waiting for your input" }),
    null,
  );
});

test("hook: the plain statuses are passed through untouched", () => {
  for (const status of ["working", "awaiting", "error", "ended"]) {
    const got = runHook(status, { ...BASE, hook_event_name: "Stop", reason: "" });
    assert.equal(got?.status, status, status);
  }
});

test("hook: a payload with no session_id writes nothing and still exits 0", () => {
  // It runs in front of every tool call, so failing open is the whole contract.
  assert.equal(runHook("working", { cwd: "/tmp" }), null);
});

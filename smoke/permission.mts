/**
 * The end-to-end that no fixture can fake: a work session's IMPLEMENT pane
 * blocked on a real permission prompt, seen by the dashboard and announced.
 *
 * This is the case the whole change exists for, and it is the one the unit
 * tests structurally cannot reach — the signal originates in Claude Code, is
 * carried by a shell hook, lands on disk, and only then becomes a status. Every
 * layer between those is a place it can be lost, and three of them were.
 *
 * Run:  npx tsx smoke/permission.mts
 *
 * Requires the Notification hook to be wired in ~/.claude/settings.json and
 * $HOME/.claude/hooks/session-status.sh to resolve to THIS checkout's copy;
 * the script checks both and refuses to report a misleading pass otherwise.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collectSessions } from "../core/src/collect.ts";
import { execAsync } from "../core/src/exec.ts";
import { fireNotification, planNotifications, type NotifyStateMap } from "../core/src/notify.ts";
import { formatSessionName, OPT_CREATED, OPT_LABEL, STATUS_STYLES } from "../core/src/model.ts";
import { layoutRow } from "../core/src/row.ts";
import { resolveClaudeBin } from "../core/src/spawn.ts";
import { hasSession } from "../core/src/tmux.ts";

const SLUG = "permsmoke";
const BOX_ID = "general";
const BOX_IDS = [BOX_ID];
const name = formatSessionName({ box: BOX_ID, mode: "work", slug: SLUG });
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Passes every command through to the real shell — nothing is stubbed, the
 *  notifications genuinely fire — while keeping what was run so it can be
 *  asserted on afterwards. */
const notifierCalls: string[] = [];
const recordingExec: typeof execAsync = (cmd, timeoutMs) => {
  if (cmd.startsWith("terminal-notifier -title")) notifierCalls.push(cmd);
  return execAsync(cmd, timeoutMs);
};

// ---------------------------------------------------------------------------
// Preconditions. A smoke that silently skips its own subject is worse than one
// that fails, so these abort rather than warn.
// ---------------------------------------------------------------------------

const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
if (!settings.hooks?.Notification) {
  console.error("ABORT: no Notification hook in ~/.claude/settings.json - nothing can produce");
  console.error("       a `permission` status, so this smoke could only ever fail.");
  process.exit(2);
}
const wiredHook = fs.realpathSync(path.join(os.homedir(), ".claude", "hooks", "session-status.sh"));
const ourHook = fs.realpathSync(path.join(REPO_ROOT, "hooks", "session-status.sh"));
if (wiredHook !== ourHook) {
  console.error("ABORT: $HOME/.claude/hooks/session-status.sh resolves to");
  console.error(`         ${wiredHook}`);
  console.error(`       but this checkout's copy is`);
  console.error(`         ${ourHook}`);
  console.error("       The smoke would be testing a different script than the one changed.");
  process.exit(2);
}

// ---------------------------------------------------------------------------

if (await hasSession(name)) await execAsync(`tmux kill-session -t '${name}'`, 5000);

// Built here rather than through spawnSession, and that difference is the
// point: spawnSession pins every pane to `--permission-mode auto`
// (spawn.ts PERMISSION_MODE), which is precisely a mode that does not raise
// the prompt this smoke has to observe. Everything else is shaped the same —
// the name parses as one of ours, the options collect reads are set — so the
// detection chain under test is identical.
console.log("building a two-pane work session in default permission mode...");
const claudeBin = resolveClaudeBin();
const shell = process.env.SHELL || "/bin/zsh";
const paneCmd = `${claudeBin}; exec ${shell} -l`;
await execAsync(
  `tmux new-session -d -s '${name}' -x 200 -y 50 -c '${os.homedir()}' ${JSON.stringify(paneCmd)}`,
  10_000,
);
await execAsync(
  `tmux split-window -h -t '${name}' -c '${os.homedir()}' ${JSON.stringify(paneCmd)}`,
  10_000,
);
await execAsync(`tmux set-option -t '${name}' ${OPT_LABEL} 'perm smoke'`, 5000);
await execAsync(`tmux set-option -t '${name}' ${OPT_CREATED} ${Date.now()}`, 5000);

try {
  // Both panes have to have a live Claude before the prompt means anything.
  console.log("waiting for both panes to come up...");
  let ready = false;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const rec = (await collectSessions(BOX_IDS)).find((r) => r.tmuxName === name);
    if (rec && rec.panes.length === 2 && rec.panes.every((p) => p.claude)) {
      ready = true;
      break;
    }
  }
  check(ready, "both panes resolved a Claude process");
  if (!ready) throw new Error("panes never came up");

  // Drive the IMPLEMENT pane specifically - pane 1. That it is pane 1 and not
  // pane 0 is the entire point: pane 0 reaching `awaiting` already worked.
  console.log("sending the implement pane a command that needs approval...");
  const cmd = `touch /tmp/permsmoke-${Date.now()}`;
  await execAsync(
    `tmux send-keys -t '${name}.1' -l 'Run exactly this bash command, nothing else: ${cmd}'`,
    5000,
  );
  await sleep(600);
  await execAsync(`tmux send-keys -t '${name}.1' Enter`, 5000);

  console.log("polling for the implement pane to report `permission`...");
  let notifyState: NotifyStateMap = new Map();
  let sawPermission = false;
  let fired = false;

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const records = await collectSessions(BOX_IDS);
    const rec = records.find((r) => r.tmuxName === name);
    if (!rec) continue;
    const impl = rec.panes.find((p) => p.paneIndex === 1);

    if (impl?.status === "permission" && !sawPermission) {
      sawPermission = true;
      console.log(`  implement pane reached \`permission\` after ~${(i + 1) * 2}s`);

      // The row must SHOW it, in the second glyph slot, at a width that splits.
      const { glyphs, segments } = layoutRow(rec, 196);
      check(glyphs[1]?.status === "permission", "row's second glyph slot is the implement pane's permission");
      check(
        STATUS_STYLES[glyphs[1]!.status].glyph === "⚠",
        "that slot renders the permission glyph",
        STATUS_STYLES[glyphs[1]!.status].glyph,
      );
      check(segments.length === 2, "a wide row splits into one segment per pane");
      // And the plan pane must NOT have been dragged along with it.
      check(glyphs[0]?.status !== "permission", "the plan pane keeps its own status", glyphs[0]?.status);
    }

    // Run the real edge detector over the real records, exactly as the TUI
    // does, and fire for real - the notification genuinely lands in
    // Notification Center. The command is recorded on its way through so the
    // assertions below describe what was actually delivered.
    const { nextState, fire } = planNotifications(notifyState, records, Date.now());
    notifyState = nextState;
    for (const decision of fire) {
      if (decision.record.tmuxName === name && decision.pane.paneIndex === 1) fired = true;
      await fireNotification(decision.record, decision.pane, recordingExec);
    }
    if (sawPermission && fired) break;
  }

  check(sawPermission, "the implement pane was seen as `permission` at all");
  check(fired, "a notification fired for pane 1 specifically");

  // Asserted against the composed command rather than against
  // `terminal-notifier -list ALL`, which cannot be read from here: invoked from
  // a Node child process it never returns and is killed by its own timeout,
  // while the same command from a shell answers in 60ms. Posting is unaffected
  // (162ms), so the notification below really is delivered - it just has to be
  // confirmed by eye, or by running `terminal-notifier -list ALL` in a shell.
  const posted = notifierCalls.find((c) => c.includes("Needs Permission"));
  check(!!posted, "a permission notification was posted", posted ? "" : "none seen");
  check(
    !!posted && posted.includes("-title 'Needs Permission — implement'"),
    "its title carries the pane label, not just the subtitle",
  );
  check(
    !!posted && posted.includes(`-group '${name}:1'`),
    "it is grouped per pane, so it cannot overwrite the plan pane's",
  );
  console.log(`  note  confirm delivery by eye, or: terminal-notifier -list ALL | grep ${name}`);

  // Approving must clear it, or the dashboard is stuck at `permission` for the
  // whole tool run - the reason PostToolUse -> working exists.
  console.log("approving the prompt, then checking it clears...");
  await execAsync(`tmux send-keys -t '${name}.1' Enter`, 5000);
  let cleared = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const rec = (await collectSessions(BOX_IDS)).find((r) => r.tmuxName === name);
    const impl = rec?.panes.find((p) => p.paneIndex === 1);
    if (impl && impl.status !== "permission") {
      cleared = true;
      console.log(`  cleared to \`${impl.status}\` after ~${(i + 1) * 2}s`);
      break;
    }
  }
  check(cleared, "`permission` clears once the prompt is answered");
} finally {
  console.log("tearing down...");
  await execAsync(`tmux kill-session -t '${name}'`, 5000);
  for (const f of fs.readdirSync("/tmp").filter((f) => f.startsWith("permsmoke-"))) {
    try {
      fs.unlinkSync(path.join("/tmp", f));
    } catch {
      // best effort
    }
  }
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

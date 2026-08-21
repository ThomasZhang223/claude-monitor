/**
 * The composer really is empty before `/wrap` is typed into it.
 *
 * This is the one thing no unit test in this repo can see. Every test of the
 * send path stubs the exec seam, so it can only assert which tmux commands were
 * built — never what Claude's input buffer did with them. The bug that produced
 * `sho/wrap` in a real wrap was invisible at that level: the command strings
 * were exactly what the tests asserted, and the keystrokes still did nothing.
 *
 * Phase 3 is the point of the file. It reproduces the bug on purpose, by
 * sending the clear and the text with no gap between them, and requires the
 * composer to come back reading `sho/wrap`. A test that passes both before and
 * after a fix proves nothing about the fix, so this establishes first that it
 * can tell the two apart — and it is also what identified the cause, since the
 * batched double-Escape everyone suspected clears a draft perfectly well.
 *
 * Run:  npx tsx smoke/wrap-clear.mts
 *
 * `Enter` is intercepted and dropped, so `sendWrap` runs in full — including
 * its staged-line check — without submitting anything. No wrap runs and nothing
 * is written to the wiki inbox; the subject here is the composer, not the skill.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execAsync, type Exec } from "../core/src/exec.ts";
import { resolveClaudeBin } from "../core/src/spawn.ts";
import { clearDraft, composerText, hasSession, sendText } from "../core/src/tmux.ts";
import { CLEAR_GAP_MS, WRAP_COMMAND, sendWrap } from "../core/src/wrap.ts";

const SESSION = "cc-general-q-wrapclear";
const PANE = 0;
const TARGET = `${SESSION}.${PANE}`;
const DRAFT = "sho";
const OUT_DIR = process.env.TMPDIR ?? "/tmp";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Raw, deliberately not core's capturePane: that one pipes through
 *  `grep -v '^$'` and tails N rows, which is fine for the code under test but
 *  loses the shape of the screen when a check fails and has to be read. */
async function screen(): Promise<string> {
  const res = await execAsync(`tmux capture-pane -t '${TARGET}' -p 2>/dev/null`, 5000);
  return res.ok ? res.stdout : "";
}
const composer = async () => composerText(await screen());

/** Real exec, except Enter is swallowed. Lets sendWrap run end to end - the
 *  clear, the gap, the text, the staged-line check - while guaranteeing that
 *  nothing is ever submitted to a real Claude. */
let entersSuppressed = 0;
const noEnterExec: Exec = (cmd, timeoutMs) => {
  if (/send-keys -t '[^']*' Enter/.test(cmd)) {
    entersSuppressed++;
    return Promise.resolve({ ok: true, stdout: "", stderr: "" });
  }
  return execAsync(cmd, timeoutMs);
};

/** Put the pane back to a known state: cleared, then holding DRAFT. */
async function armDraft(): Promise<boolean> {
  for (let i = 0; i < 6; i++) {
    await clearDraft(TARGET);
    await sleep(CLEAR_GAP_MS + 300);
    if ((await composer()) !== DRAFT) break;
  }
  await sendText(TARGET, DRAFT);
  await sleep(700);
  return (await composer()) === DRAFT;
}

function save(label: string, text: string): string {
  const p = path.join(OUT_DIR, `wrap-clear-${label}-${process.pid}.txt`);
  fs.writeFileSync(p, text);
  return p;
}

// ---------------------------------------------------------------------------
// Preconditions. Abort rather than report a pass this did not earn.
// ---------------------------------------------------------------------------

const claudeBin = resolveClaudeBin();
if (!fs.existsSync(claudeBin)) {
  console.error(`ABORT: no claude binary at ${claudeBin} - there is no composer to clear.`);
  process.exit(2);
}
if ((await execAsync("command -v tmux", 5000)).stdout.trim() === "") {
  console.error("ABORT: no tmux on PATH.");
  process.exit(2);
}

console.log("=== composer clear before /wrap ===");
console.log(`claude: ${claudeBin}`);

if (await hasSession(SESSION)) {
  await execAsync(`tmux kill-session -t '${SESSION}'`, 5000);
}

try {
  // -------------------------------------------------------------------------
  // Phase 1: a real Claude pane, and an anchor to read its composer by.
  // -------------------------------------------------------------------------
  const shell = process.env.SHELL || "/bin/zsh";
  await execAsync(
    `tmux new-session -d -s '${SESSION}' -x 120 -y 40 -c '${os.homedir()}' ` +
      JSON.stringify(`${claudeBin}; exec ${shell} -l`),
    10_000,
  );

  console.log("\nphase 1 - the pane comes up with a composer on screen");
  let first = "";
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    first = await screen();
    if (composerText(first) !== null) break;
  }
  if (composerText(first) === null) {
    console.error("\nABORT: never found a composer row. The prompt glyph may have changed;");
    console.error("       composerText's anchor is version specific and needs re-reading.");
    console.error(`       capture saved to ${save("no-anchor", first)}`);
    process.exit(2);
  }
  check(true, "composerText found a composer row", JSON.stringify(composerText(first)));
  console.log(`  capture: ${save("phase1", first)}`);

  // -------------------------------------------------------------------------
  // Phase 2: a draft in the composer. A precondition, not a result - if this
  // never lands, nothing below it means anything.
  // -------------------------------------------------------------------------
  console.log(`\nphase 2 - a stale draft (${JSON.stringify(DRAFT)}) is sitting in the composer`);
  const drafted = await armDraft();
  check(drafted, "the draft landed in the composer", JSON.stringify(await composer()));
  if (!drafted) {
    console.error("\nABORT: could not put a draft in the composer, so there is nothing to clear.");
    process.exit(2);
  }

  // -------------------------------------------------------------------------
  // Phase 3: THE GATE. Reproduce the bug by removing only the gap.
  // -------------------------------------------------------------------------
  console.log("\nphase 3 - GATE: clear-then-type with NO gap must still mangle the command");
  await clearDraft(TARGET);
  await sendText(TARGET, WRAP_COMMAND); // no sleep - this is the whole defect
  await sleep(1200);
  const mangled = await composer();
  const reproduced = mangled === `${DRAFT}${WRAP_COMMAND}`;
  check(reproduced, `the composer reads ${DRAFT}${WRAP_COMMAND}`, JSON.stringify(mangled));
  if (!reproduced) {
    console.error("\nABORT: could not reproduce the mangling, so a pass below would prove");
    console.error("       nothing - this test would report green against the old code too.");
    console.error(`       capture saved to ${save("no-repro", await screen())}`);
    process.exit(2);
  }

  // -------------------------------------------------------------------------
  // Phase 4: the real sendWrap, Enter suppressed.
  // -------------------------------------------------------------------------
  console.log("\nphase 4 - sendWrap stages the command alone on the line");
  const rearmed = await armDraft();
  check(rearmed, "the draft is back in place for the real run", JSON.stringify(await composer()));

  entersSuppressed = 0;
  const err = await sendWrap(SESSION, PANE, { exec: noEnterExec });
  check(err === null, "sendWrap reported no error", err ?? "");
  await sleep(500);

  const staged = await screen();
  console.log(`  capture: ${save("phase4", staged)}`);
  check(
    composerText(staged) === WRAP_COMMAND,
    `the composer reads exactly ${WRAP_COMMAND}`,
    JSON.stringify(composerText(staged)),
  );
  check(
    !staged.includes(`${DRAFT}${WRAP_COMMAND}`),
    `no ${DRAFT}${WRAP_COMMAND} anywhere on screen`,
  );
  check(entersSuppressed === 2, "both Enters were intercepted, not delivered", `${entersSuppressed}`);
} finally {
  console.log("\ntearing down (nothing was submitted)...");
  await clearDraft(TARGET).catch(() => {});
  await execAsync(`tmux kill-session -t '${SESSION}' 2>/dev/null`, 5000);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

/**
 * PENDING PANEL A'S PR — does not run in this branch.
 *
 * The picker, end to end, against a REAL Claude session. Exercises
 * `../src/prompt.ts` and its `http.ts` route, both Panel A's files
 * (`board/src/{prompt,http}.ts`), which do not exist on this branch — Stage 2
 * runs as three panels on disjoint branches off `board/stage1-foundation`.
 * This script typechecks against the contract below but cannot be run until
 * Panel A's PR merges. See this PR's body.
 *
 * The pane-addressed route path below —
 * `/api/sessions/:tmuxName/panes/:windowIndex/:paneIndex/{prompt,answer}` —
 * is this panel's own best reading of the plan's http.ts instruction ("Pane
 * routes take windowIndex"; every route that names a pane takes all three:
 * session, windowIndex, paneIndex), not a contract Panel A has published yet.
 * If Panel A's actual route differs, only the two URL templates below need to
 * change — the assertions, especially the fingerprint-revalidation one, are
 * written to be correct regardless of the exact path and must not be
 * weakened to make this "pass" against an incomplete branch.
 *
 * Run:  npx tsx smoke/prompt.mts <board-url-with-?t=token>
 *
 * Deliberately NOT part of `npm run check`: this starts a real Claude session
 * and makes it do a turn, which costs model tokens.
 *
 * Drives the session over `tmux send-keys` directly, the same as a human
 * typing — never the messaging socket. Board's own write path is
 * `tmux send-keys` (see the plan's Settled item 2: the messaging socket
 * frames a message as "another session sent a message" and cannot navigate a
 * permission menu), so the smoke test drives the session the same way board
 * itself would, rather than reaching for a shortcut board deliberately does
 * not use.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const run = promisify(execFile);
const url = process.argv[2];
if (!url) {
  console.error("usage: prompt.mts <board-url-with-?t=token>");
  process.exit(2);
}
const token = new URL(url).searchParams.get("t") ?? "";
const base = new URL(url).origin;

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "ok  " : "FAIL"}   ${label}${detail ? `  ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const api = async (p: string, init: RequestInit = {}) =>
  fetch(`${base}${p}`, { ...init, headers: { Authorization: `Bearer ${token}` } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SESSION = `board-prompt-smoke-${process.pid}`;
const WINDOW = 0;
const PANE = 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-prompt-smoke-"));
const marker = path.join(dir, "answered.txt");

async function tmux(args: string[]) {
  return run("tmux", args).catch((e) => ({ stdout: "", stderr: String(e) }));
}

async function capture(): Promise<string> {
  return (await tmux(["capture-pane", "-p", "-t", SESSION])).stdout;
}

console.log("\n=== a real session, blocked on a real permission prompt ===");
await tmux(["kill-session", "-t", SESSION]);
// `manual` so an ordinary file write raises a prompt rather than being
// auto-approved by whatever this machine's settings happen to be.
await tmux([
  "new-session", "-d", "-s", SESSION, "-x", "120", "-y", "40", "-c", dir,
  "claude --permission-mode manual",
]);

let trusted = false;
let started = false;
for (let i = 0; i < 40 && !started; i++) {
  await sleep(1000);
  const pane = await capture();
  // A directory Claude Code has not seen before opens with "Is this a
  // project you trust?" and takes no input until it is answered. The
  // directory was created by this script moments ago, so accepting is not a
  // judgement call.
  if (!trusted && /trust/i.test(pane)) {
    await tmux(["send-keys", "-t", SESSION, "Enter"]);
    trusted = true;
    continue;
  }
  if (/\?\s*for shortcuts|>\s*$/m.test(pane)) started = true;
}
check("the session reached its own prompt", started);

// Ask it to do something that needs approval, typed exactly as a human
// would: set the buffer, paste it, then submit on a separate step (a
// bracketed paste and an immediate Enter can race on a busy session).
const instruction = `Create a file called ${path.basename(marker)} containing the word ANSWERED`;
await tmux(["set-buffer", "--", instruction]);
await tmux(["paste-buffer", "-t", SESSION]);
await sleep(300);
await tmux(["send-keys", "-t", SESSION, "Enter"]);

interface PromptOption { index: number; label: string; }
interface PaneOnScreenPrompt { fingerprint: string; options: PromptOption[]; }

const promptUrl = `/api/sessions/${encodeURIComponent(SESSION)}/panes/${WINDOW}/${PANE}/prompt`;
const answerUrl = (index: number, fingerprint: string) =>
  `/api/sessions/${encodeURIComponent(SESSION)}/panes/${WINDOW}/${PANE}/answer` +
  `?index=${index}&fingerprint=${encodeURIComponent(fingerprint)}`;

let prompt: PaneOnScreenPrompt | null = null;
for (let i = 0; i < 40 && !prompt; i++) {
  await sleep(1000);
  const res = await api(promptUrl);
  prompt = res.ok ? ((await res.json()) as { prompt: PaneOnScreenPrompt | null }).prompt : null;
}
check(
  "board sees the prompt the terminal is showing",
  prompt !== null,
  prompt ? `${prompt.options.length} options` : "none within 40s",
);
if (!prompt) {
  await tmux(["kill-session", "-t", SESSION]);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}

console.log("\n=== a stale answer is refused, and sends nothing ===");
const stale = await api(answerUrl(1, "not-the-one"), { method: "POST" });
check("a mismatched fingerprint is a 409", stale.status === 409, String(stale.status));
const stillRes = await api(promptUrl);
const still: PaneOnScreenPrompt | null = stillRes.ok
  ? ((await stillRes.json()) as { prompt: PaneOnScreenPrompt | null }).prompt
  : null;
check("and the menu is untouched", still !== null && still.fingerprint === prompt.fingerprint);
check("no keys were sent for the stale answer", !fs.existsSync(marker));

console.log("\n=== answering it ===");
const yes = prompt.options.find((o) => /^yes$/i.test(o.label))?.index ?? 1;
const res = await api(answerUrl(yes, prompt.fingerprint), { method: "POST" });
const body = (await res.json()) as { ok?: boolean; cleared?: boolean };
check("the answer was accepted", res.status === 200 && body.ok === true, JSON.stringify(body));
check(
  "and board reports the menu cleared",
  body.cleared === true,
  body.cleared === true ? "" : "the confirming read was served a cached pre-keystroke capture",
);

let landed = false;
for (let i = 0; i < 20 && !landed; i++) {
  await sleep(1000);
  landed = fs.existsSync(marker);
}
// The one that matters: the keystroke did not merely disappear, it did the
// work.
check("the session actually did the thing it asked about", landed, marker);

await tmux(["kill-session", "-t", SESSION]);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

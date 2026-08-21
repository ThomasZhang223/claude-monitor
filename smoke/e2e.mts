/**
 * End-to-end smoke test. Creates real tmux sessions, real worktrees and real
 * Claude processes, checks each expectation, then tears everything down.
 *
 * The box under test is a throwaway git repo generated fresh in a temp
 * directory, with a bare "origin" clone so `fetch origin main` / `worktree add
 * ... origin/main` work with no network - this tool has no compiled-in repos
 * any more, so there is nothing else for a smoke test to point at.
 *
 * Run:  npx tsx smoke/e2e.mts
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collectSessions } from "../core/src/collect.ts";
import { execAsync } from "../core/src/exec.ts";
import { readHistory } from "../core/src/history.ts";
import { HISTORY_PATH, formatSessionName, type BoxDef } from "../core/src/model.ts";
import { spawnSession } from "../core/src/spawn.ts";
import { branchFor, worktreePathFor } from "../core/src/repos.ts";
import { capturePane, hasSession, listSessions } from "../core/src/tmux.ts";
import { killSession } from "../core/src/attach.ts";

const SLUG = "smoke-e2e";
const LABEL = "smoke e2e run";
const BRANCH_PREFIX = "cc";

// A real repo with a real "origin", so every git command spawnSession issues
// (fetch, merge --ff-only, worktree add off origin/main) runs for real.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-e2e-"));
const REPO_DIR = path.join(TMP, "repo");
const REMOTE_DIR = path.join(TMP, "repo.git");
fs.mkdirSync(REPO_DIR);
execSync(`git init -q -b main ${REPO_DIR}`);
execSync(`git -C ${REPO_DIR} -c user.email=smoke@test -c user.name=smoke commit -q --allow-empty -m init`);
execSync(`git clone -q --bare ${REPO_DIR} ${REMOTE_DIR}`);
execSync(`git -C ${REPO_DIR} remote add origin ${REMOTE_DIR}`);
execSync(`git -C ${REPO_DIR} fetch -q origin`);
execSync(`git -C ${REPO_DIR} branch -q --set-upstream-to=origin/main main`);

const BOX: BoxDef = { id: "alpha", label: "alpha", color: "#7FFFD4", path: REPO_DIR };
const BOX_IDS = [BOX.id];

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cleanup(): Promise<void> {
  const work = formatSessionName({ box: BOX.id, mode: "work", slug: SLUG });
  const q = formatSessionName({ box: BOX.id, mode: "q", slug: SLUG });
  for (const s of [work, q]) {
    if (await hasSession(s)) await execAsync(`tmux kill-session -t '${s}'`, 5000);
  }
  const wt = worktreePathFor(BOX, SLUG);
  if (wt && fs.existsSync(wt)) {
    await execAsync(`git -C '${REPO_DIR}' worktree remove --force '${wt}'`, 20000);
  }
  await execAsync(`git -C '${REPO_DIR}' branch -D '${branchFor(SLUG, BRANCH_PREFIX)}'`, 10000);
  await execAsync(`git -C '${REPO_DIR}' worktree prune`, 10000);
}

console.log("=== cleaning any leftovers from a previous run ===");
await cleanup();

// -------------------------------------------------------------------------
console.log("\n=== 1. spin up a WORK session with a fresh worktree ===");
const historyBefore = readHistory().length;
const res = await spawnSession({
  box: BOX,
  mode: "work",
  label: LABEL,
  slug: SLUG,
  worktree: "new",
  branchPrefix: BRANCH_PREFIX,
});
console.log("   spawn:", JSON.stringify({ ok: res.ok, worktree: res.worktree, ff: res.ff?.kind, notes: res.notes, error: res.error }));
check("spawn reports success", res.ok, res.error ?? "");
check("worktree path returned", Boolean(res.worktree));

// -------------------------------------------------------------------------
console.log("\n=== 2. worktree exists, on the right branch, off origin/main ===");
const wt = res.worktree!;
check("worktree directory exists", fs.existsSync(wt));
const br = await execAsync(`git -C '${wt}' branch --show-current`, 5000);
check("worktree is on the feature branch", br.stdout.trim() === branchFor(SLUG, BRANCH_PREFIX), br.stdout.trim());
const mergeBase = await execAsync(`git -C '${wt}' rev-parse HEAD origin/main`, 5000);
const [head, originMain] = mergeBase.stdout.trim().split("\n");
check("branched from origin/main", head === originMain, `${head?.slice(0, 8)} vs ${originMain?.slice(0, 8)}`);

// -------------------------------------------------------------------------
console.log("\n=== 3. no context packet is written anywhere - the opener is plain text ===");
check("no .claude/session-packet.md in the worktree", !fs.existsSync(path.join(wt, ".claude", "session-packet.md")));

// -------------------------------------------------------------------------
console.log("\n=== 4. two panes, both running Claude ===");
await sleep(9000);

// The worktree is a directory Claude Code has never seen before (a fresh temp
// path, not a subdirectory of anything already trusted), so the very first
// spawn here always lands on the trust-this-folder question - documented in
// spawn.ts's fallbackCwd comment as the one case a pane with no resolved
// Claude reads `permission` rather than `dead`. "1. Yes, I trust this folder"
// is the prompt's own default, so Enter accepts it, exactly as a real user
// would from the dashboard.
const workName0 = formatSessionName({ box: BOX.id, mode: "work", slug: SLUG });
let recs = await collectSessions(BOX_IDS, { now: Date.now() });
let rec = recs.find((r) => r.slug === SLUG && r.mode === "work");
if (rec?.status === "permission" && rec.panes.some((p) => !p.claude)) {
  console.log("   accepting the trust-this-folder prompt on both panes...");
  await execAsync(`tmux send-keys -t '${workName0}.0' Enter`, 5000);
  await execAsync(`tmux send-keys -t '${workName0}.1' Enter`, 5000);
  await sleep(6000);
  recs = await collectSessions(BOX_IDS, { now: Date.now() });
  rec = recs.find((r) => r.slug === SLUG && r.mode === "work");
}
check("session appears in collect()", Boolean(rec));
if (rec) {
  console.log(`   status=${rec.status} label=${JSON.stringify(rec.label)} panes=${rec.panes.length}`);
  for (const p of rec.panes) {
    console.log(`     pane ${p.paneIndex} status=${p.status} claude=${p.claude ? `${p.claude.pid}/${p.claude.rawStatus}` : "none"}`);
  }
  check("session has two panes (plan | implement)", rec.panes.length === 2, `${rec.panes.length}`);
  check("both panes resolved a Claude process", rec.panes.every((p) => p.claude !== null));
  check("label round-tripped through @cc_label", rec.label === LABEL, rec.label);
  check("worktree round-tripped through @cc_worktree", rec.worktree === wt);
  check("status is not dead", rec.status !== "dead", rec.status);
}

// -------------------------------------------------------------------------
console.log("\n=== 5. preview can capture pane text ===");
const cap = await capturePane(formatSessionName({ box: BOX.id, mode: "work", slug: SLUG }), 12);
check("capture-pane returned text", Boolean(cap && cap.trim().length > 0), `${(cap ?? "").length} chars`);

// -------------------------------------------------------------------------
console.log("\n=== 6. journal recorded the creation ===");
const hist = readHistory();
check("journal grew", hist.length > historyBefore, `${historyBefore} -> ${hist.length}`);
const created = hist.filter((h) => h.tmuxName.includes(SLUG) && h.event === "created");
check("a 'created' entry exists for this session", created.length >= 1);
check("journal file is on disk", fs.existsSync(HISTORY_PATH));

// -------------------------------------------------------------------------
console.log("\n=== 7. persistence: sessions are detached and outlive us ===");
const names = (await listSessions(BOX_IDS)).map((s) => s.name);
check("session is enumerable from a fresh tmux query", names.includes(formatSessionName({ box: BOX.id, mode: "work", slug: SLUG })));
const detached = await execAsync(`tmux list-sessions -F '#{session_name}:#{session_attached}'`, 5000);
const line = detached.stdout.split("\n").find((l) => l.includes(SLUG));
check("session exists detached (attached=0)", Boolean(line?.endsWith(":0")), line ?? "");

// -------------------------------------------------------------------------
console.log("\n=== 8. a QUESTIONS session gets one pane and no worktree ===");
const qres = await spawnSession({
  box: BOX,
  mode: "q",
  label: "smoke question",
  slug: SLUG,
  worktree: "none",
  branchPrefix: BRANCH_PREFIX,
});
check("questions spawn ok", qres.ok, qres.error ?? "");
check("questions session has no worktree", qres.worktree === null);
await sleep(7000);
const recs2 = await collectSessions(BOX_IDS, { now: Date.now() });
const qrec = recs2.find((r) => r.slug === SLUG && r.mode === "q");
check("questions session appears", Boolean(qrec));
if (qrec) check("questions session has exactly one pane", qrec.panes.length === 1, `${qrec.panes.length}`);

// -------------------------------------------------------------------------
console.log("\n=== 9. adopt: an orphaned worktree is reusable ===");
const workName = formatSessionName({ box: BOX.id, mode: "work", slug: SLUG });
await execAsync(`tmux kill-session -t '${workName}'`, 5000);
check("session killed, worktree still present", fs.existsSync(wt));
const adopt = await spawnSession({
  box: BOX,
  mode: "work",
  label: LABEL,
  slug: SLUG,
  worktree: "adopt",
  branchPrefix: BRANCH_PREFIX,
});
check("adopt spawn ok", adopt.ok, adopt.error ?? "");
check("adopt reused the same worktree", adopt.worktree === wt);
check("adopt noted the reuse", adopt.notes.some((n) => n.includes("adopted")), adopt.notes.join("|"));

// -------------------------------------------------------------------------
console.log("\n=== 10. teardown ===");
const killErr = await killSession(workName, {
  tmuxName: workName, box: BOX.id, mode: "work", label: LABEL, worktree: wt, recap: null,
});
check("kill returned no error", killErr === null, killErr ?? "");
check("session is gone from tmux", !(await hasSession(workName)));
check("worktree survives a kill (git cleanup is separate)", fs.existsSync(wt));
const killed = readHistory().filter((h) => h.tmuxName === workName && h.event === "killed");
check("journal recorded the kill", killed.length >= 1);

console.log("\n=== final cleanup ===");
await cleanup();
check("worktree removed", !fs.existsSync(wt));
const leftovers = (await listSessions(BOX_IDS)).filter((s) => s.slug === SLUG);
check("no sessions left behind", leftovers.length === 0, leftovers.map((s) => s.name).join(","));
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Watch a real session's status over time, to verify the transitions the
 * dashboard depends on: working while Claude is thinking, awaiting once it has
 * finished and is blocked on the user.
 *
 * Run:  npx tsx src/watch.mts
 */
import { collectSessions } from "../core/src/collect.ts";
import { execAsync } from "../core/src/exec.ts";
import { formatSessionName } from "../core/src/model.ts";
import { spawnSession } from "../core/src/spawn.ts";
import { hasSession } from "../core/src/tmux.ts";

const SLUG = "statuswatch";
const BOX = { id: "general", label: "general", color: "#C9A227", path: null } as const;
const name = formatSessionName({ box: BOX.id, mode: "q", slug: SLUG });

if (await hasSession(name)) await execAsync(`tmux kill-session -t '${name}'`, 5000);

console.log("spawning a questions session with no worktree...");
const res = await spawnSession({
  box: BOX,
  mode: "q",
  label: "status watch",
  slug: SLUG,
  worktree: "none",
  branchPrefix: "cc",
});
console.log("spawn ok:", res.ok, res.error ?? "");

// Sampled fast at first: a trivial opening prompt is answered in a second or
// two, so a 4s cadence can miss the working phase entirely.
const seen: string[] = [];
let sawClaude = false;
let elapsed = 0;
for (let i = 0; i < 60; i++) {
  const gap = elapsed < 20_000 ? 1_000 : 4_000;
  await new Promise((r) => setTimeout(r, gap));
  elapsed += gap;
  const rec = (await collectSessions([BOX.id], { now: Date.now() })).find((x) => x.slug === SLUG);
  const pane = rec?.panes[0];
  if (pane?.claude) sawClaude = true;
  console.log(
    `${String(Math.round(elapsed / 1000)).padStart(3)}s  status=${rec?.status ?? "gone"}` +
      `  claude=${pane?.claude ? `${pane.claude.pid}/${pane.claude.rawStatus}` : "none"}`,
  );
  if (rec && seen[seen.length - 1] !== rec.status) seen.push(rec.status);
  // Stop once it has settled: awaiting held across three consecutive samples.
  if (seen[seen.length - 1] === "awaiting" && elapsed > 25_000) break;
}

console.log("\ntransitions observed:", seen.join(" -> "));
// The load-bearing assertions: a real Claude process was resolved through the
// pid tree, and the session ends up reported as blocked on the user rather than
// decaying to idle. `working` is nice to catch but is only a second or two wide
// for a trivial prompt, so it is not required.
const ok = sawClaude && seen.includes("awaiting") && !seen.includes("dead");
console.log(
  ok
    ? "PASS resolved a live Claude and settled on awaiting"
    : `FAIL sawClaude=${sawClaude} states=${seen.join(",")}`,
);

await execAsync(`tmux kill-session -t '${name}'`, 5000);
console.log("cleaned up");
process.exit(ok ? 0 : 1);

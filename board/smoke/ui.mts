/**
 * PENDING PANEL B'S PR — does not run in this branch.
 *
 * The dashboard's theme, in a real browser. Exercises `../web/*.css` (Panel
 * B's files), which do not carry the monitor's re-themed `:root` token block
 * in this branch yet — Stage 2 runs as three panels on disjoint branches off
 * `board/stage1-foundation`. This script typechecks against the theme table
 * in the plan ("Theme: the monitor's colours, on Di's layout") but cannot be
 * run until Panel B's PR merges. See this PR's body.
 *
 * Deliberately narrower than `claude-board`'s own `smoke/ui.mts`: this file's
 * job is the colour regression the plan asks for ("a theme regression fails
 * a test rather than an eye"), not a full re-test of Di's DOM structure and
 * terminal interaction — those are Panel A's and this panel's own concerns
 * (`board/src/prompt.ts`'s route, `board/src/ws.ts`'s terminal), already
 * covered where they belong (`smoke/prompt.mts`, `smoke/e2e.mts`).
 *
 * Asserts against CSS CUSTOM PROPERTIES (`--status-awaiting`, etc.) rather
 * than hardcoded RGB literals, because this panel does not know Panel B's
 * exact chosen hex values — only the token names and the constraints the
 * plan's theme table places on them (dark ground, magenta awaiting, red
 * permission/error, gray idle, box colour never in the red/magenta band).
 * The one exception is `--code-bg`, which the plan says to carry over
 * UNCHANGED from Di's original (`#16273a`), so that one IS checked literally.
 *
 * Run:  npx tsx smoke/ui.mts <board-url-with-?t=token>
 * with Chrome already listening on 9222 (see claude-board's own smoke/ui.mts
 * for the launch invocation this is modelled on).
 */
import WebSocket from "ws";

const url = process.argv[2];
if (!url) {
  console.error("usage: tsx smoke/ui.mts <board-url-with-?t=token>");
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`); }
}

const tab = (await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json()) as {
  webSocketDebuggerUrl: string;
};
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
const consoleErrors: string[] = [];

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
    consoleErrors.push(msg.params.args?.map((a: { value?: string }) => a.value).join(" ") ?? "");
  }
  if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(msg.params?.exceptionDetails?.exception?.description ?? "uncaught exception");
  }
});
await new Promise<void>((r) => ws.on("open", () => r()));
const send = (method: string, params: object = {}): Promise<any> =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });

const evaluate = async (expr: string) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;

async function waitFor(expr: string, what: string, ms = 20000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evaluate(expr)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`  warn   gave up waiting for ${what} after ${ms}ms`);
  return false;
}

/** [r, g, b] out of a `rgb(...)` / `rgba(...)` computed-style string. */
function rgbOf(css: string): [number, number, number] {
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(Number);
  return [r, g, b];
}

async function tokenRgb(name: string): Promise<[number, number, number] | null> {
  const raw = await evaluate(
    `(() => { const v = getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim();
      if (!v) return null;
      const probe = document.createElement("span"); probe.style.color = v;
      document.body.appendChild(probe); const rgb = getComputedStyle(probe).color;
      probe.remove(); return rgb; })()`,
  );
  return raw ? rgbOf(raw) : null;
}

await waitFor(`document.querySelectorAll(".card").length > 0`, "the first cards");

console.log("\n=== the dashboard renders ===");
check("no uncaught errors on the page", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
const cards = await evaluate(`document.querySelectorAll(".card").length`);
check("session cards were drawn", cards > 0, `${cards} cards`);

console.log("\n=== :root carries the monitor's own token block ===");
const bgLayout = await tokenRgb("--bg-layout");
check("--bg-layout is defined", bgLayout !== null);
if (bgLayout) {
  const [r, g, b] = bgLayout;
  // A dark terminal ground, not claude-board's original light Ant-Design
  // `#f5f7f9` (247, 247, 249) — every channel comfortably below mid-grey.
  check("--bg-layout is a dark ground, not the original light theme", r < 100 && g < 100 && b < 100, `rgb(${r},${g},${b})`);
}
const bg = await tokenRgb("--bg");
check("--bg (cards/header/bars) is defined and one step lighter than the ground", bg !== null);
if (bg && bgLayout) {
  const lum = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  check("--bg is lighter than --bg-layout", lum(bg) >= lum(bgLayout));
}

console.log("\n=== status tokens match STATUS_STYLES ===");
const awaiting = await tokenRgb("--status-awaiting");
check("--status-awaiting is defined", awaiting !== null);
if (awaiting) {
  const [r, g, b] = awaiting;
  check("--status-awaiting reads as magenta (high red AND blue, lower green)", r > g && b > g, `rgb(${r},${g},${b})`);
}
const permission = await tokenRgb("--status-permission");
const error = await tokenRgb("--status-error");
check("--status-permission is defined", permission !== null);
check("--status-error is defined", error !== null);
if (permission) check("--status-permission reads as red", permission[0] > permission[1] && permission[0] > permission[2], `rgb(${permission})`);
if (error) check("--status-error reads as red", error[0] > error[1] && error[0] > error[2], `rgb(${error})`);
const idle = await tokenRgb("--status-idle");
check("--status-idle is defined", idle !== null);
if (idle) {
  const [r, g, b] = idle;
  check("--status-idle reads as gray (channels close together)", Math.max(r, g, b) - Math.min(r, g, b) <= 12, `rgb(${r},${g},${b})`);
}
// Distinct tokens must actually render distinctly — a copy-paste of one
// status colour into another would pass every check above and still be
// wrong.
if (awaiting && permission) {
  check(
    "awaiting and permission are visually distinct",
    awaiting.some((c, i) => Math.abs(c - permission[i]) > 15),
    `awaiting rgb(${awaiting}) vs permission rgb(${permission})`,
  );
}

console.log("\n=== the code block colour carries over UNCHANGED ===");
// The plan says to keep this literal from Di's original theme, not re-derive
// it from the monitor palette.
const codeBg = await tokenRgb("--code-bg");
check("--code-bg is the original #16273a", JSON.stringify(codeBg) === JSON.stringify([22, 39, 58]), JSON.stringify(codeBg));

console.log("\n=== box colours never fall in the status red/magenta band ===");
// GET /api/config is Panel A's new route (see the plan's http.ts section).
const token = new URL(url).searchParams.get("t") ?? "";
const configRes = await fetch(new URL("/api/config", url).href, { headers: { Authorization: `Bearer ${token}` } });
if (configRes.ok) {
  const config = (await configRes.json()) as { boxes?: { id: string; color: string }[] };
  const boxes: { id: string; color: string }[] = config.boxes ?? [];
  check("the config route reports at least one box", boxes.length > 0, `${boxes.length} boxes`);
  for (const box of boxes) {
    const probe = await evaluate(
      `(() => { const el = document.createElement("span"); el.style.color = ${JSON.stringify(box.color)};
        document.body.appendChild(el); const rgb = getComputedStyle(el).color; el.remove(); return rgb; })()`,
    );
    const [r, g, b] = rgbOf(probe ?? "rgb(0,0,0)");
    // core/src/palette.ts deliberately excludes red and magenta so a box
    // colour can never be mistaken for a status glyph — this is the web UI
    // half of that same guarantee.
    check(`box "${box.id}"'s colour is not a status red/magenta`, !(r > g + 20 && r > b - 20 && r > 140), `${box.color} -> rgb(${r},${g},${b})`);
  }
} else {
  console.log(`  skip  GET /api/config is not available yet (${configRes.status})`);
}

console.log("\n=== a card's WORKING glyph takes its own box's colour ===");
// Per the plan: STATUS_STYLES.working has color: null, meaning "use the
// containing box's colour" — rendered as a per-card inline custom property,
// not a fixed CSS rule. Two working cards from different boxes must
// therefore show two different colours.
const workingColors: string[] = (await evaluate(
  `[...document.querySelectorAll(".card.working, .card[data-status=working]")]
    .map(c => getComputedStyle(c).borderLeftColor)`,
)) ?? [];
if (workingColors.length >= 2) {
  const distinct = new Set(workingColors).size > 1;
  check("working cards from different boxes render different colours", distinct, workingColors.join(" | "));
} else {
  console.log(`  skip  fewer than two working cards on screen (${workingColors.length})`);
}

ws.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Terminal end-to-end against this machine's real tmux — no mocks.
 *
 * Scoped to Panel C's own file: this exercises `../src/ws.ts` directly, on a
 * bare `http.Server` this script builds itself, rather than going through
 * `../src/http.ts` or `../src/main.ts` (Panel A's files, which wire the real
 * server together). A throwaway tmux session stands in for a Claude one —
 * the bridge attaches to tmux, and what runs inside it is not this test's
 * business.
 *
 * Uses the `/ws/tmux/<name>` path deliberately: it is the one path in
 * `attachWebSocket` that never calls `findSession` (board/src/sessions.ts),
 * so this test needs no real Claude session or box config on the machine —
 * only tmux itself, and `../src/ws.ts`.
 *
 * Run:  npx tsx smoke/e2e.mts
 *
 * NOTE on Panel A's dependency: `../src/ws.ts` imports `./lifecycle.ts` and
 * `./auth.ts`, both Panel A's files, absent from this branch (see the header
 * comment in ws.ts and this PR's body). This script cannot run in THIS
 * branch's own checkout until Panel A's PR merges. It was verified locally
 * against the exact reference implementations of those two files
 * (`claude-board`'s `server/src/lifecycle.ts` and `server/src/auth.ts`,
 * temporarily vendored and then removed before this PR was opened) and
 * passed in full.
 */
import * as http from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { attachWebSocket } from "../src/ws.ts";
import { hasSession, runTmux } from "../src/lifecycle.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
  }
}

/** Wait for a "ready" control frame, or throw after a timeout. Control
 *  frames are prefixed with a NUL byte (see `control` in ws.ts). */
function waitReady(ws: WebSocket, ms = 5000): Promise<{ view: string; session: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no ready frame")), ms);
    ws.on("message", function onMsg(raw: Buffer) {
      const text = raw.toString();
      if (text[0] !== "\x00") return;
      const msg = JSON.parse(text.slice(1));
      if (msg.type === "ready") {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(msg);
      } else if (msg.type === "error") {
        clearTimeout(timer);
        ws.off("message", onMsg);
        reject(new Error(msg.message));
      }
    });
  });
}

const server = http.createServer((_req, res) => {
  res.writeHead(404).end();
});
attachWebSocket(server, { token: null });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const base = `ws://127.0.0.1:${port}`;

const probe = `board-smoke-${process.pid}`;
await runTmux(["kill-session", "-t", probe]);
await runTmux(["new-session", "-d", "-s", probe, "-x", "100", "-y", "30"]);
check("a probe tmux session exists", await hasSession(probe));

console.log("\n=== open a grouped terminal view over ws.ts ===");
let ws = new WebSocket(`${base}/ws/tmux/${encodeURIComponent(probe)}`);
await new Promise<void>((r) => ws.on("open", () => r()));
const ready = await waitReady(ws);
check("the socket attached to the probe session", ready.session === probe, ready.session);

let seen = "";
ws.on("message", (raw: Buffer) => {
  const text = raw.toString();
  if (text[0] === "\x00") return; // control frame, not terminal output
  seen += text;
});
await sleep(800);
ws.send("echo board-e2e-ok\r");
await sleep(1500);
check("typing landed and the terminal echoed it back", seen.includes("board-e2e-ok"), `${seen.length} bytes`);

console.log("\n=== detach: the session survives ===");
ws.close();
await sleep(500);
check("THE SESSION SURVIVED THE DETACH", await hasSession(probe));

console.log("\n=== reopen and close ===");
ws = new WebSocket(`${base}/ws/tmux/${encodeURIComponent(probe)}`);
await new Promise<void>((r) => ws.on("open", () => r()));
const ready2 = await waitReady(ws);
check("a second attach reopens the same session", ready2.session === probe, ready2.session);
ws.close();
await sleep(500);
check("the session is still alive after closing again", await hasSession(probe));

await runTmux(["kill-session", "-t", probe]);
await sleep(300);
check("cleanup: the probe session is gone", !(await hasSession(probe)));

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * `board` — the server entry point.
 *
 * Binds 127.0.0.1 and nothing else. There is deliberately no --host flag:
 * the server hands out terminals, and reaching it from another machine is
 * the user's own tunnel to set up — board never learns one exists (see
 * http.ts's HOST and the plan's Settled item 8).
 *
 * Two things must be right before this ever calls `.listen()`, or a request
 * fails in a way that is much harder to diagnose than refusing to start:
 *
 *  - config.json must exist. It is gitignored, and core/src/config.ts's
 *    `CONFIG_PATH` resolves next to the checkout, so a fresh clone or
 *    worktree has none. Left unchecked, the first `GET /api/sessions` threw
 *    a raw `ENOENT: ... /config.json` 500 — this fails at startup instead,
 *    naming the missing file and config.example.json.
 *  - the optional identity gate (BOARD_IDENTITY_HEADER/BOARD_IDENTITY_ALLOW)
 *    must be either fully set or fully unset. See auth.ts's
 *    `resolveIdentityGate` — a half-configured gate is a startup error, not
 *    a silent no-op.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { CONFIG_PATH, configExists } from "../../core/src/config.ts";
import { persistentToken, resolveIdentityGate, rotateToken, TOKEN_PATH } from "./auth.ts";
import { createServer, DEFAULT_PORT, HOST } from "./http.ts";
import { loadPrCache, savePrCache } from "./prs.ts";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

if (!configExists()) {
  console.error(`board: missing ${CONFIG_PATH}`);
  console.error("  board needs a config.json next to the checkout, naming at least one box.");
  console.error("  copy the example and edit it:");
  console.error(`    cp config.example.json ${CONFIG_PATH}`);
  process.exit(1);
}

let identityGate;
try {
  identityGate = resolveIdentityGate(process.env);
} catch (e) {
  console.error(`board: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (process.argv.includes("--rotate-token")) rotateToken();
// Stable across restarts, so the URL can be bookmarked.
const token = persistentToken();

// xterm ships as plain files; serving them from node_modules avoids a
// bundler and keeps the page working with no network at all.
const assetRoots: Record<string, string> = {};
for (const [prefix, dir] of [
  ["/vendor/xterm/", path.join(ROOT, "node_modules", "@xterm", "xterm", "lib")],
  ["/vendor/xterm-css/", path.join(ROOT, "node_modules", "@xterm", "xterm", "css")],
  ["/vendor/xterm-fit/", path.join(ROOT, "node_modules", "@xterm", "addon-fit", "lib")],
] as const) {
  if (fs.existsSync(dir)) assetRoots[prefix] = dir;
}

// A restart must not refetch every PR the board knows about — see prs.ts's
// own module doc on the GitHub budget that cost.
loadPrCache();

const server = createServer({ token, identityGate, assetRoots });

server.listen(DEFAULT_PORT, HOST, () => {
  const base = `http://${HOST}:${DEFAULT_PORT}`;
  console.log(`board listening on ${base}`);
  console.log(`  open: ${base}/?t=${token}`);
  console.log("  (the token is stable — bookmark that URL. Rotate it with --rotate-token)");
  console.log(`  token stored at ${TOKEN_PATH}`);
  if (identityGate) console.log(`  identity gate armed on header ${identityGate.header}`);
});

// A terminal server that keeps running after its terminal is gone is a
// liability, so exit on the usual signals rather than lingering.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    savePrCache();
    server.close(() => process.exit(0));
    // Do not wait forever on anything still attached.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

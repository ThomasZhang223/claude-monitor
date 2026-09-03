/**
 * The entry point's two startup checks, driven as a real subprocess.
 *
 * main.ts runs its checks as module-level side effects (so a fresh clone
 * fails loudly before ever binding a port) — which is exactly why they
 * cannot be unit-tested by importing the module in-process: importing it
 * would run those side effects, including `process.exit`, inside the test
 * runner itself. A short-lived child process is the only honest way to
 * observe "this refuses to start", the same boundary the reference project
 * drew around its own main.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const ROOT = path.join(import.meta.dirname, "..");

async function runMain(env: Record<string, string | undefined>): Promise<{ code: number; stderr: string }> {
  try {
    await execFileAsync("npx", ["tsx", "src/main.ts"], {
      cwd: ROOT,
      timeout: 10_000,
      env: { ...process.env, ...env },
    });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    return { code: err.code ?? 1, stderr: err.stderr ?? "" };
  }
}

test("main: a missing config.json is a startup error naming config.example.json, not a 500 later", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-main-"));
  const configPath = path.join(dir, "does-not-exist", "config.json");
  const { code, stderr } = await runMain({
    CLAUDE_MONITOR_CONFIG: configPath,
    BOARD_IDENTITY_HEADER: "",
    BOARD_IDENTITY_ALLOW: "",
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /config\.example\.json/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("main: exactly one identity var set is a startup error", async () => {
  // A valid config.json in a temp dir, so this test isolates the identity
  // check from the config check above — both are independent startup gates.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-main-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1, branchPrefix: "cc", notifications: false,
    boxes: [{ id: "general", label: "general", color: "#C9A227", path: null }],
  }));
  const { code, stderr } = await runMain({
    CLAUDE_MONITOR_CONFIG: configPath,
    BOARD_IDENTITY_HEADER: "X-User",
    BOARD_IDENTITY_ALLOW: "",
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /BOARD_IDENTITY_ALLOW/);
  fs.rmSync(dir, { recursive: true, force: true });
});

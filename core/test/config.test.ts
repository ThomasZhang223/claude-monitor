import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  defaultConfig,
  loadConfig,
  saveConfig,
  sanitizeBoxId,
  validateConfig,
  type Config,
} from "../src/config.ts";

function tmpConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-config-"));
  return path.join(dir, "config.json");
}

function validConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 1,
    branchPrefix: "cc",
    notifications: false,
    boxes: [{ id: "alpha", label: "Alpha", color: "#7FFFD4", path: null, worktreeRoot: null }],
    ...overrides,
  };
}

test("validateConfig: accepts a well-formed config unchanged", () => {
  const cfg = validConfig();
  assert.deepEqual(validateConfig(cfg), cfg);
});

test("validateConfig: rejects a non-object", () => {
  assert.throws(() => validateConfig(null), /config must be an object/);
  assert.throws(() => validateConfig("nope"), /config must be an object/);
});

test("validateConfig: rejects a version other than 1", () => {
  assert.throws(() => validateConfig(validConfig({ version: 2 as 1 })), /version must be 1/);
});

test("validateConfig: rejects an empty or unsafe branchPrefix", () => {
  assert.throws(() => validateConfig(validConfig({ branchPrefix: "" })), /branchPrefix/);
  assert.throws(() => validateConfig(validConfig({ branchPrefix: " cc" })), /branchPrefix/);
  assert.throws(() => validateConfig(validConfig({ branchPrefix: "-cc" })), /branchPrefix/);
});

test("validateConfig: rejects a non-boolean notifications field", () => {
  assert.throws(
    () => validateConfig({ ...validConfig(), notifications: "yes" }),
    /notifications must be a boolean/,
  );
});

test("validateConfig: rejects zero boxes and more than the ceiling", () => {
  assert.throws(() => validateConfig(validConfig({ boxes: [] })), /at least one box/);
  const many = Array.from({ length: 13 }, (_, i) => ({
    id: `b${i}`,
    label: `b${i}`,
    color: "#7FFFD4",
    path: null,
  }));
  assert.throws(() => validateConfig(validConfig({ boxes: many })), /at most 12 boxes/);
});

test("validateConfig: a hyphenated id is refused", () => {
  assert.throws(
    () => validateConfig(validConfig({ boxes: [{ id: "api-gw", label: "x", color: "#7FFFD4", path: null }] })),
    /boxes\[0\]\.id.*no hyphens/,
  );
});

test("validateConfig: an id outside [a-z0-9]{1,12}, or longer than 12, is refused", () => {
  for (const id of ["", "Alpha", "has space", "a".repeat(13)]) {
    assert.throws(
      () => validateConfig(validConfig({ boxes: [{ id, label: "x", color: "#7FFFD4", path: null }] })),
      new RegExp("boxes\\[0\\]\\.id"),
      id,
    );
  }
});

test("validateConfig: a reserved id (a mode token or the session prefix) is refused", () => {
  for (const id of ["cc", "work", "quick", "q", "research"]) {
    assert.throws(
      () => validateConfig(validConfig({ boxes: [{ id, label: "x", color: "#7FFFD4", path: null }] })),
      /is reserved/,
      id,
    );
  }
});

test("validateConfig: duplicate ids are refused", () => {
  const boxes = [
    { id: "alpha", label: "a", color: "#7FFFD4", path: null },
    { id: "alpha", label: "b", color: "#87CEFA", path: null },
  ];
  assert.throws(() => validateConfig(validConfig({ boxes })), /used by another box/);
});

test("validateConfig: an empty label, or a malformed colour, is refused", () => {
  assert.throws(
    () => validateConfig(validConfig({ boxes: [{ id: "a", label: "  ", color: "#7FFFD4", path: null }] })),
    /label must be a non-empty string/,
  );
  assert.throws(
    () => validateConfig(validConfig({ boxes: [{ id: "a", label: "x", color: "aqua", path: null }] })),
    /color must be #RRGGBB/,
  );
});

test("validateConfig: path must be null or an absolute, existing directory", () => {
  assert.throws(
    () => validateConfig(validConfig({ boxes: [{ id: "a", label: "x", color: "#7FFFD4", path: "relative" }] })),
    /must be null or an absolute path/,
  );
  assert.throws(
    () =>
      validateConfig(
        validConfig({ boxes: [{ id: "a", label: "x", color: "#7FFFD4", path: "/no/such/directory" }] }),
      ),
    /does not exist or is not a directory/,
  );
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "claude-monitor-box-"));
  assert.deepEqual(
    validateConfig(validConfig({ boxes: [{ id: "a", label: "x", color: "#7FFFD4", path: real }] })).boxes[0]
      .path,
    real,
  );
});

test("saveConfig / loadConfig / configExists: round-trip through a temp file", () => {
  const p = tmpConfigPath();
  const cfg = validConfig({ boxes: [{ id: "b", label: "B", color: "#87CEFA", path: null, worktreeRoot: null }] });
  saveConfig(cfg, p);
  assert.deepEqual(loadConfig(p), cfg);
});

test("loadConfig: a config that fails validation throws, naming the field, not a silent default", () => {
  const p = tmpConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, boxes: [] }));
  assert.throws(() => loadConfig(p), /branchPrefix|boxes/);
});

test("loadConfig: invalid JSON throws naming the path, not a parse-error stack trace", () => {
  const p = tmpConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "{not json");
  assert.throws(() => loadConfig(p), /is not valid JSON/);
});

test("defaultConfig: one general box, so a fresh dashboard is never empty", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.boxes.length, 1);
  assert.equal(cfg.boxes[0].path, null);
  // Must itself be valid, since it is what a first run renders against
  // before anyone has touched the setup panel.
  assert.deepEqual(validateConfig(cfg), cfg);
});

test("sanitizeBoxId: strips everything but [a-z0-9], never hyphenates", () => {
  assert.equal(sanitizeBoxId("api gateway"), "apigateway");
  assert.equal(sanitizeBoxId("My Repo!!"), "myrepo");
  assert.equal(sanitizeBoxId("café spike"), "cafespike");
  assert.equal(sanitizeBoxId("###"), "");
  assert.equal(sanitizeBoxId("a".repeat(20)), "a".repeat(12));
});

test("validateConfig: worktreeRoot is optional, and absent normalises to null", () => {
  // Every config written before this field existed omits it entirely.
  const cfg = validConfig();
  delete (cfg.boxes[0] as unknown as Record<string, unknown>).worktreeRoot;
  assert.equal(validateConfig(cfg).boxes[0].worktreeRoot, null);
});

test("validateConfig: worktreeRoot must be absolute", () => {
  const cfg = validConfig({
    boxes: [{ id: "a", label: "A", color: "#7FFFD4", path: os.tmpdir(), worktreeRoot: "worktrees" }],
  });
  assert.throws(() => validateConfig(cfg), /worktreeRoot must be an absolute path/);
});

test("validateConfig: worktreeRoot needs a folder to be a root FOR", () => {
  // A pathless box never creates a worktree, so a root on one is a config the
  // author has misunderstood - worth saying so rather than accepting silently.
  const cfg = validConfig({
    boxes: [{ id: "a", label: "A", color: "#7FFFD4", path: null, worktreeRoot: "/tmp/wt" }],
  });
  assert.throws(() => validateConfig(cfg), /worktreeRoot needs a path/);
});

test("validateConfig: worktreeRoot need not exist yet", () => {
  // Unlike `path`, it is created on first use - requiring it up front would
  // make the very first session in a new box fail on an absent directory.
  const cfg = validConfig({
    boxes: [
      { id: "a", label: "A", color: "#7FFFD4", path: os.tmpdir(), worktreeRoot: "/nonexistent/wt" },
    ],
  });
  assert.equal(validateConfig(cfg).boxes[0].worktreeRoot, "/nonexistent/wt");
});

test("validateConfig: worktreeRoot cannot sit inside the box's own repo", () => {
  // Shares `worktreeRootProblem` with the setup panel's live field, so the
  // panel can never show a value as fine that the save then rejects.
  const cfg = validConfig({
    boxes: [
      { id: "a", label: "A", color: "#7FFFD4", path: os.tmpdir(), worktreeRoot: path.join(os.tmpdir(), "wt") },
    ],
  });
  assert.throws(() => validateConfig(cfg), /inside the box's own repo/);
});

test("validateConfig: worktreeRoot cannot be the filesystem root", () => {
  const cfg = validConfig({
    boxes: [{ id: "a", label: "A", color: "#7FFFD4", path: os.tmpdir(), worktreeRoot: "/" }],
  });
  assert.throws(() => validateConfig(cfg), /filesystem root/);
});

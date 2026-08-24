/**
 * The user's own boxes and settings — `config.json`, beside the code rather
 * than under `~/.config`. `CONFIG_PATH` is resolved from this module's own
 * location the same way notify.ts already locates `bin/monitor-attach`, so it
 * keeps working wherever the repo is cloned and however the bins are
 * symlinked.
 *
 * Every validation failure throws, naming the field. This config is about as
 * permissive as a file gets — arbitrary folders, arbitrary colours — so there
 * is no safe default to fall back to silently: a wrong guess here is a
 * session spawned in the wrong directory.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { MODE_ORDER, SESSION_PREFIX, type BoxDef } from "./model.ts";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");

/**
 * Overridable so tests and smoke runs never touch the real checkout's own
 * config. Load-bearing, not just convenient: with the real config living
 * inside the repo itself, a test that wrote the default path would clobber
 * the developer's own boxes.
 */
export const CONFIG_PATH =
  process.env.CLAUDE_MONITOR_CONFIG || path.join(REPO_ROOT, "config.json");

/** A fail-loud ceiling, not a nicety: past this, layout.ts's per-band minimum
 *  (model.ts's BOX_MIN_ROWS) can no longer all fit even on a fairly tall
 *  terminal, and an unreadable dashboard is a worse failure than a refusal at
 *  save time. See layout.ts's module doc for the exact arithmetic. */
export const MAX_BOXES = 12;

/** Tokens a box id may not take: the session-name prefix and every mode
 *  token, since `parseSessionName` reads box and mode from fixed positions in
 *  `cc-<box>-<mode>-<slug>` and a collision would parse as something else
 *  entirely. */
const RESERVED_IDS: ReadonlySet<string> = new Set<string>([
  SESSION_PREFIX,
  ...MODE_ORDER,
]);

const ID_RE = /^[a-z0-9]{1,12}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
/** Permissive but not empty, and free of anything that would produce a
 *  malformed `git branch` argument or checkout path. */
const BRANCH_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface Config {
  version: 1;
  branchPrefix: string;
  notifications: boolean;
  boxes: BoxDef[];
}

function fail(field: string, reason: string): never {
  throw new Error(`config: ${field} ${reason}`);
}

/** Every failure names the field it rejected — see the module doc. */
export function validateConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) fail("config", "must be an object");
  const o = raw as Record<string, unknown>;

  if (o.version !== 1) fail("version", "must be 1");
  if (typeof o.branchPrefix !== "string" || !BRANCH_PREFIX_RE.test(o.branchPrefix)) {
    fail("branchPrefix", "must be a non-empty string safe to use in a git branch name");
  }
  if (typeof o.notifications !== "boolean") fail("notifications", "must be a boolean");
  if (!Array.isArray(o.boxes) || o.boxes.length < 1) {
    fail("boxes", "must be an array with at least one box");
  }
  if (o.boxes.length > MAX_BOXES) fail("boxes", `must have at most ${MAX_BOXES} boxes`);

  const seenIds = new Set<string>();
  const boxes: BoxDef[] = o.boxes.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) fail(`boxes[${i}]`, "must be an object");
    const b = entry as Record<string, unknown>;

    if (typeof b.id !== "string" || !ID_RE.test(b.id)) {
      fail(`boxes[${i}].id`, "must match /^[a-z0-9]{1,12}$/ (letters and digits only, no hyphens)");
    }
    if (RESERVED_IDS.has(b.id)) fail(`boxes[${i}].id`, `"${b.id}" is reserved`);
    if (seenIds.has(b.id)) fail(`boxes[${i}].id`, `"${b.id}" is used by another box`);
    seenIds.add(b.id);

    if (typeof b.label !== "string" || b.label.trim() === "") {
      fail(`boxes[${i}].label`, "must be a non-empty string");
    }
    if (typeof b.color !== "string" || !COLOR_RE.test(b.color)) {
      fail(`boxes[${i}].color`, "must be #RRGGBB");
    }

    let boxPath: string | null = null;
    if (b.path !== null) {
      if (typeof b.path !== "string" || !path.isAbsolute(b.path)) {
        fail(`boxes[${i}].path`, "must be null or an absolute path");
      }
      let isDir: boolean;
      try {
        isDir = fs.statSync(b.path).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) fail(`boxes[${i}].path`, `does not exist or is not a directory: ${b.path}`);
      boxPath = b.path;
    }

    // A collection directory for this box's worktrees. Unlike `path` it is NOT
    // required to exist — it is created on first use — so this validates the
    // shape only, and rejects setting one on a box with no folder at all,
    // where nothing would ever be created under it.
    let worktreeRoot: string | null = null;
    if (b.worktreeRoot !== undefined && b.worktreeRoot !== null) {
      if (typeof b.worktreeRoot !== "string" || !path.isAbsolute(b.worktreeRoot)) {
        fail(`boxes[${i}].worktreeRoot`, "must be null or an absolute path");
      }
      if (!boxPath) fail(`boxes[${i}].worktreeRoot`, "needs a path - this box has no folder");
      worktreeRoot = b.worktreeRoot;
    }

    return { id: b.id, label: b.label, color: b.color, path: boxPath, worktreeRoot };
  });

  return {
    version: 1,
    branchPrefix: o.branchPrefix as string,
    notifications: o.notifications as boolean,
    boxes,
  };
}

export function configExists(configPath: string = CONFIG_PATH): boolean {
  try {
    return fs.statSync(configPath).isFile();
  } catch {
    return false;
  }
}

export function loadConfig(configPath: string = CONFIG_PATH): Config {
  const text = fs.readFileSync(configPath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `config: ${configPath} is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  return validateConfig(raw);
}

/** Temp file plus rename — the pattern hooks/statusline-tee.sh already uses —
 *  so a concurrent reader never observes a half-written file. */
export function saveConfig(config: Config, configPath: string = CONFIG_PATH): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
}

/** First run's pre-seed: one `general` box, so the dashboard is never empty
 *  and the setup panel always has something to show. */
export function defaultConfig(): Config {
  return {
    version: 1,
    branchPrefix: "cc",
    notifications: false,
    boxes: [{ id: "general", label: "general", color: "#C9A227", path: null, worktreeRoot: null }],
  };
}

/**
 * The setup panel's own reduction from typed text to an id.
 *
 * Deliberately NOT naming.ts's `sanitizeLabel`: that function maps punctuation
 * to hyphens, which is exactly the character a box id may not contain — it
 * would turn "api gateway" into `api-gateway`, and `parseSessionName` would
 * then mis-split it into a box named "api" holding a slug that starts with
 * "gateway-...". This strips everything but `[a-z0-9]` instead, so "api
 * gateway" becomes `apigateway` while the typed text survives verbatim as the
 * label.
 */
export function sanitizeBoxId(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
}

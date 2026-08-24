/**
 * Git side of spawning a session: fast-forwarding a primary checkout, creating
 * or adopting a worktree, and reading a worktree's branch.
 *
 * One hazard shapes every command built here: a box's folder may be an
 * ordinary repo whose primary checkout is legitimately sitting on someone
 * else's branch (mid review, say), so fast-forwarding blind would either fail
 * or move work. Every ff is therefore gated on the branch actually being
 * `main`, and a skip is reported rather than thrown.
 */
import * as fs from "fs";
import * as path from "path";
import { execAsync, shellQuote, type Exec } from "./exec.ts";
import type { BoxDef } from "./model.ts";

export function branchFor(slug: string, branchPrefix: string): string {
  return `${branchPrefix}/${slug}`;
}

/**
 * Where a new worktree for this box goes: `<root>/<folder-name>_<slug>`.
 *
 * The root defaults to the box folder's own parent — the sibling-of-the-checkout
 * placement the tool always used. That default is wrong whenever the folder's
 * siblings are not scratch space: an umbrella checkout sits among the other
 * repos it coordinates, and a box on `~/src` would drop worktrees straight into
 * the home directory. `worktreeRoot` names a directory to collect them in
 * instead, which is also how a shop with a house convention (`~/worktrees`)
 * gets its worktrees where the rest of its tooling expects them.
 */
export function worktreePathFor(box: BoxDef, slug: string): string | null {
  if (!box.path) return null;
  const root = box.worktreeRoot ?? path.dirname(box.path);
  return path.join(root, `${path.basename(box.path)}_${slug}`);
}

/** Is this folder a git repository at all? The setup panel's live path
 *  validation and the wizard's worktree-step skip both key off this rather
 *  than off any particular box being special. */
export function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

/** Whether a box can have a worktree at all: a folder behind it, and that
 *  folder being a git repo. */
export function isGitCapable(box: BoxDef): boolean {
  return box.path !== null && isGitRepo(box.path);
}

// ---------------------------------------------------------------------------
// Command construction — pure, so hazards are testable
// ---------------------------------------------------------------------------

export function ffMainCommands(repo: string): { fetch: string; merge: string } {
  return {
    fetch: `git -C ${shellQuote(repo)} fetch origin main`,
    merge: `git -C ${shellQuote(repo)} merge --ff-only origin/main`,
  };
}

export function currentBranchCommand(repo: string): string {
  return `git -C ${shellQuote(repo)} branch --show-current`;
}

/**
 * New worktrees branch from `origin/main`, not local HEAD, so a stale primary
 * cannot silently seed a session with old code.
 *
 * The `mkdir -p` is for a `worktreeRoot` that does not exist yet: `git worktree
 * add` creates the leaf directory but not the path above it, so a first run
 * against a fresh collection directory would otherwise fail on nothing worse
 * than an absent folder.
 */
export function worktreeAddCommand(repo: string, branch: string, target: string): string {
  const parent = shellQuote(path.dirname(target));
  return `mkdir -p ${parent} && git -C ${shellQuote(repo)} worktree add -b ${shellQuote(branch)} ${shellQuote(target)} origin/main`;
}

export function worktreeListCommand(repo: string): string {
  return `git -C ${shellQuote(repo)} worktree list --porcelain`;
}

/** Parse `git worktree list --porcelain` into absolute paths. The first entry is
 *  the primary checkout; callers usually want the rest. */
export function parseWorktreeList(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Fast-forward
// ---------------------------------------------------------------------------

export type FfOutcome =
  | { kind: "ok" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * Fetch `origin/main`, then fast-forward the box's folder only when it is
 * actually on `main`. Being on another branch is a normal state (PR review),
 * so it is a `skipped`, not a `failed` — the caller surfaces it in the UI and
 * carries on, because the worktree is created from `origin/main` regardless
 * and a stale primary does not block anything. Deliberately NOT
 * `--recurse-submodules` anywhere in this module: a repo with dirty submodule
 * pointers on its primary checkout would otherwise have every fetch/merge
 * fight them.
 */
export async function fastForwardMain(box: BoxDef, exec: Exec = execAsync): Promise<FfOutcome> {
  if (!box.path) return { kind: "skipped", reason: "no folder for this box" };

  const { fetch, merge } = ffMainCommands(box.path);
  const fetched = await exec(fetch, 30_000);
  if (!fetched.ok) {
    return { kind: "failed", reason: firstLine(fetched.stderr) || "fetch failed" };
  }

  const branch = await exec(currentBranchCommand(box.path), 5000);
  if (!branch.ok) return { kind: "failed", reason: "could not read current branch" };
  const current = branch.stdout.trim();
  if (current !== "main") {
    return { kind: "skipped", reason: `primary is on ${current || "a detached HEAD"}, not main` };
  }

  const merged = await exec(merge, 15_000);
  if (!merged.ok) {
    return { kind: "failed", reason: firstLine(merged.stderr) || "fast-forward refused" };
  }
  return { kind: "ok" };
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export async function listWorktrees(box: BoxDef, exec: Exec = execAsync): Promise<string[]> {
  if (!box.path) return [];
  const r = await exec(worktreeListCommand(box.path), 5000);
  if (!r.ok) return [];
  const all = parseWorktreeList(r.stdout);
  // Drop the primary checkout — it is never a session's worktree.
  return all.filter((p) => p !== box.path);
}

export type WorktreeOutcome =
  | { kind: "created"; path: string; branch: string }
  | { kind: "adopted"; path: string }
  | { kind: "failed"; reason: string };

/**
 * Create a fresh worktree off a just-fast-forwarded `origin/main`, or adopt one
 * that already exists on disk.
 *
 * Adoption is what makes a reboot recoverable: the tmux server dies and takes
 * every session with it, while the worktrees survive. Without this path you
 * would come back to a dozen orphaned worktrees and a wizard that refuses every
 * name matching your actual work.
 */
export async function ensureWorktree(
  box: BoxDef,
  slug: string,
  branchPrefix: string,
  opts: { adopt: boolean; exists: (p: string) => boolean },
  exec: Exec = execAsync,
): Promise<WorktreeOutcome> {
  const target = worktreePathFor(box, slug);
  if (!box.path || !target) return { kind: "failed", reason: "no folder for this box" };

  if (opts.exists(target)) {
    if (opts.adopt) return { kind: "adopted", path: target };
    return { kind: "failed", reason: `worktree already exists at ${target}` };
  }

  const branch = branchFor(slug, branchPrefix);
  const r = await exec(worktreeAddCommand(box.path, branch, target), 60_000);
  if (!r.ok) return { kind: "failed", reason: firstLine(r.stderr) || "worktree add failed" };
  return { kind: "created", path: target, branch };
}

// ---------------------------------------------------------------------------
// Worktree state
// ---------------------------------------------------------------------------

export async function currentBranch(worktree: string, exec: Exec = execAsync): Promise<string | null> {
  const r = await exec(currentBranchCommand(worktree), 5000);
  if (!r.ok) return null;
  return r.stdout.trim() || null;
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

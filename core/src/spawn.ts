/**
 * Creating a session: fast-forward, worktree, panes.
 *
 * The delivery mechanism is the load-bearing decision here. Creating a pane and
 * then typing the prompt into it races the login shell's startup and drops
 * characters, and a multi-line prompt additionally depends on the terminal
 * telling newline from submit. Both problems disappear if Claude is the
 * pane's own command with a one-line opening prompt.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execAsync, shellQuote, type Exec } from "./exec.ts";
import { append as appendHistory } from "./history.ts";
import {
  IMPL_PANE,
  OPT_CREATED,
  OPT_LABEL,
  OPT_WORKTREE,
  PLAN_PANE,
  formatSessionName,
  type BoxDef,
  type Mode,
} from "./model.ts";
import { openingPrompt, paneRoles, type Role } from "./prompt.ts";
import { ensureWorktree, fastForwardMain, type FfOutcome } from "./repos.ts";
import { createSession, setExtendedKeys, setOption, splitWindow } from "./tmux.ts";

export interface SpawnRequest {
  box: BoxDef;
  mode: Mode;
  /** Free-form, as typed. */
  label: string;
  /** Sanitised, tmux-safe. */
  slug: string;
  /** none: no git at all. new: fresh off origin/main. adopt: reuse what is there. */
  worktree: "none" | "new" | "adopt";
  /** From config.json's branchPrefix, e.g. "cc" -> branches "cc/<slug>". */
  branchPrefix: string;
  /** Typed at spawn time, empty by default. Appended to the end of the opening
   *  prompt of the pane that gets one (plan pane for work, the single pane for
   *  a question). For a box with no folder, which otherwise has no opener at
   *  all, this becomes the opener outright. */
  extraPrompt?: string;
}

export interface SpawnResult {
  ok: boolean;
  tmuxName: string;
  worktree: string | null;
  ff: FfOutcome | null;
  /** Non-fatal notes worth surfacing in the UI, e.g. a skipped fast-forward. */
  notes: string[];
  error?: string;
}

export interface SpawnDeps {
  exec?: Exec;
  /** Absolute path to the claude binary. Resolved absolutely because the pane
   *  command runs without a login shell, so PATH is not set up. */
  claudeBin?: string;
  exists?: (p: string) => boolean;
  now?: () => number;
}

export function resolveClaudeBin(): string {
  // A login shell would find it on PATH, but the pane command is exec'd
  // directly, so the path has to be absolute.
  const candidates = [
    path.join(process.env.HOME ?? "", ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // keep looking
    }
  }
  return "claude";
}

/** Default permission mode for a pane. Every pane gets this except the
 *  planning pane of a work session - see permissionModeFor. */
export const PERMISSION_MODE = "auto";

/**
 * Which permission mode a pane boots into, by mode and pane role.
 *
 * The planning pane of a work session should only ever explore and propose a
 * plan, never touch files itself - that is the implementation pane's job once
 * the plan is handed off. Starting it in "plan" mode enforces that structurally
 * instead of relying on the model to police itself, and read-only exploration
 * (Read/Glob/Grep, and read-only Bash) is unprompted in plan mode regardless,
 * so nothing is lost versus auto for that pane's actual job.
 *
 * Every single-pane class keeps auto, including the two that are not questions.
 * They exist to take action — a quick session writes the change itself, a
 * research session runs greps and reads across trees — and plan mode both blocks
 * that and ends at an ExitPlanMode ritual that makes no sense for a session
 * whose output is findings rather than a diff.
 */
export function permissionModeFor(mode: Mode, paneIndex: number): string {
  if (mode === "work" && paneIndex === PLAN_PANE) return "plan";
  return PERMISSION_MODE;
}

/** What a pane runs on. `null` for either field means "leave Claude's own
 *  default alone" rather than pinning it. */
export interface ModelChoice {
  model: string | null;
  effort: string | null;
}

/**
 * Which model and effort a pane gets, by pane role first and mode second.
 *
 * Questions are lookups and explanations: sonnet answers them well and much more
 * cheaply than opus, and high effort is enough for a question that is not
 * building anything.
 *
 * The implementation pane is executing an already-approved plan, which is
 * mechanical enough that sonnet keeps up with opus at a fraction of the cost —
 * so it runs sonnet at xhigh on every box.
 *
 * The planning pane is where judgment matters, so it always runs opus at
 * xhigh, on every box.
 *
 * quick and research both run opus at high. They are single panes with no
 * second half to check them: a quick session takes a change from nothing to a
 * PR by itself, and a research session's whole output is a judgment call —
 * neither has a plan/implement split to catch a cheap model's mistake. high
 * rather than xhigh because neither is building something large.
 */
export function modelFor(mode: Mode, paneIndex: number): ModelChoice {
  if (mode === "q") return { model: "sonnet", effort: "high" };
  if (mode === "quick" || mode === "research") return { model: "opus", effort: "high" };
  if (paneIndex === IMPL_PANE) return { model: "sonnet", effort: "xhigh" };
  return { model: "opus", effort: "xhigh" };
}

/**
 * The pane's command line: run Claude, optionally with a one-line opening
 * prompt, then drop to a login shell.
 *
 * A null prompt launches Claude with no opening turn at all. That is what the
 * implementation pane wants: it comes up empty, because anything it reads before
 * there is a plan to implement is context spent for nothing.
 *
 * The trailing shell matters. Without it, Claude exiting takes the pane with it,
 * and the last pane closing destroys the whole tmux session — so a stray Ctrl-D
 * would silently delete a session the dashboard is tracking.
 */
export function paneCommand(
  claudeBin: string,
  prompt: string | null,
  shell: string,
  choice: ModelChoice = { model: null, effort: null },
  permissionMode: string = PERMISSION_MODE,
): string {
  const flags = [`--permission-mode ${permissionMode}`];
  if (choice.model) flags.push(`--model ${choice.model}`);
  if (choice.effort) flags.push(`--effort ${choice.effort}`);
  const opener = prompt === null ? "" : ` ${shellQuote(prompt)}`;
  return `${claudeBin} ${flags.join(" ")}${opener}; exec ${shell} -l`;
}

export async function spawnSession(
  req: SpawnRequest,
  deps: SpawnDeps = {},
): Promise<SpawnResult> {
  const exec = deps.exec ?? execAsync;
  const claudeBin = deps.claudeBin ?? resolveClaudeBin();
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  const now = deps.now ?? (() => Date.now());
  const shell = process.env.SHELL || "/bin/zsh";

  const tmuxName = formatSessionName({ box: req.box.id, mode: req.mode, slug: req.slug });
  const notes: string[] = [];
  let worktree: string | null = null;
  let ff: FfOutcome | null = null;

  // A box with no folder behind it can have no worktree, whatever was asked
  // for. Enforced here rather than trusted from the caller: every git path
  // below would otherwise fail with "no folder for this box" and take the
  // whole spawn with it.
  const wantWorktree = req.box.path ? req.worktree : "none";

  if (wantWorktree !== "none") {
    // Fetch and fast-forward before branching, so a new worktree starts from
    // current main rather than whatever the primary happened to be on.
    ff = await fastForwardMain(req.box, exec);
    if (ff.kind === "skipped") notes.push(`main not fast-forwarded: ${ff.reason}`);
    if (ff.kind === "failed") notes.push(`fast-forward failed: ${ff.reason}`);

    const outcome = await ensureWorktree(
      req.box,
      req.slug,
      req.branchPrefix,
      { adopt: wantWorktree === "adopt", exists },
      exec,
    );
    if (outcome.kind === "failed") {
      return { ok: false, tmuxName, worktree: null, ff, notes, error: outcome.reason };
    }
    worktree = outcome.path;
    if (outcome.kind === "adopted") notes.push(`adopted existing worktree ${outcome.path}`);
  }

  // Where the panes start.
  const cwd = worktree ?? fallbackCwd(req.box);

  // Modifier-key passthrough, so a later send-keys into a live Claude pane can
  // distinguish newline from submit. Global and idempotent, so set it once here.
  await setExtendedKeys(exec);

  const roles = paneRoles(req.mode);

  // Collapsed to one line up front: the pane command is a single-line launch
  // string, and a multi-line prompt is what makes send-keys delivery ambiguous.
  const extraPrompt = (req.extraPrompt ?? "").replace(/\s+/g, " ").trim();

  /**
   * Only the first pane gets an opening prompt.
   *
   * In a work session that is the left, planning pane. The implementation
   * pane on the right comes up blank: it has nothing to do until a plan
   * exists, so priming it would spend context on a turn whose output is
   * thrown away, and the whole reason for splitting the two is to keep that
   * pane's window clean for the implementation itself.
   *
   * A box with no folder starts completely fresh otherwise - there is
   * nothing to plan against - so there `extraPrompt` becomes the entire
   * opener instead of being folded into one that does not exist.
   */
  const promptFor = (role: Role, index: number): string | null => {
    if (index > 0) return null;
    if (req.box.path === null) return extraPrompt || null;
    return openingPrompt(role, req.box, { task: extraPrompt });
  };

  const created = await createSession(
    {
      name: tmuxName,
      cwd,
      command: paneCommand(
        claudeBin,
        promptFor(roles[0], 0),
        shell,
        modelFor(req.mode, 0),
        permissionModeFor(req.mode, 0),
      ),
      windowName: req.slug,
    },
    exec,
  );
  if (!created) {
    return { ok: false, tmuxName, worktree, ff, notes, error: "tmux refused to create the session" };
  }

  // Side by side, so a work session reads plan | implement, left to right.
  for (let i = 1; i < roles.length; i++) {
    await splitWindow(
      {
        target: tmuxName,
        cwd,
        command: paneCommand(
          claudeBin,
          promptFor(roles[i], i),
          shell,
          modelFor(req.mode, i),
          permissionModeFor(req.mode, i),
        ),
        horizontal: true,
      },
      exec,
    );
  }

  await setOption(tmuxName, OPT_LABEL, req.label, exec);
  await setOption(tmuxName, OPT_CREATED, String(now()), exec);
  if (worktree) await setOption(tmuxName, OPT_WORKTREE, worktree, exec);

  appendHistory({
    at: now(),
    event: wantWorktree === "adopt" ? "adopted" : "created",
    tmuxName,
    box: req.box.id,
    mode: req.mode,
    label: req.label,
    worktree,
  });

  return { ok: true, tmuxName, worktree, ff, notes };
}

/**
 * Where a session with no worktree starts.
 *
 * A box with no folder starts at the home directory: it is ad-hoc work that
 * belongs to no repo, and scoping it to some other checkout would put the
 * wrong tree under its feet. A box with a folder but no worktree starts in
 * that folder directly.
 *
 * One consequence, worth knowing rather than discovering: Claude Code records
 * per-directory trust in ~/.claude.json and asks a blocking "is this a project
 * you trust?" question the first time it starts somewhere untrusted — writing no
 * session file while it waits, so the dashboard reads it as `permission`. The
 * home directory is not trusted by default, so the first no-folder session will
 * sit at that question. Answering it once persists, and trust is inherited by
 * subdirectories, so it is a one-time cost rather than a per-session one.
 */
export function fallbackCwd(box: BoxDef): string {
  return box.path ?? os.homedir();
}

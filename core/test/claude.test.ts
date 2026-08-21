import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
  deriveStatus,
  LAST_MESSAGE_MAX,
  awaySummary,
  lastAssistantText,
  latestTranscriptMtime,
  parseSessionFile,
  readClaudeSessions,
  readHookStatus,
  sessionsByPid,
  transcriptDirForCwd,
  transcriptPathsFor,
  type FsDeps,
  type HookStatus,
} from "../src/claude.ts";
import {
  CLAUDE_PROJECTS_DIR,
  CLAUDE_SESSIONS_DIR,
  IDLE_TRANSCRIPT_MS,
  STALE_STATUS_MS,
  STATUS_DIR,
  type ClaudeSession,
  type Status,
} from "../src/model.ts";

// ---------------------------------------------------------------------------
// Fixture seam. Tests must never touch the real ~/.claude: the dashboard is
// read-only there, but a test that depends on the developer's live sessions
// passes or fails depending on what they happen to be running.
// ---------------------------------------------------------------------------

function fakeFs(files: Record<string, string>, mtimes: Record<string, number> = {}): FsDeps {
  return {
    async readdir(dir) {
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        if (rest.includes(path.sep)) continue;
        names.add(rest);
      }
      if (names.size === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return [...names];
    },
    async readFile(file) {
      const text = files[file];
      if (text === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return text;
    },
    async stat(file) {
      if (!(file in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { mtimeMs: mtimes[file] ?? 0 };
    },
  };
}

/** Shaped exactly like the real files observed in ~/.claude/sessions. */
function sessionJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 21659,
    sessionId: "84c16fe0-5d88-472f-af7f-5d1c7ff2c391",
    cwd: "/Users/you/Documents/code/myrepo",
    startedAt: 1784846793923,
    version: "2.1.218",
    kind: "interactive",
    entrypoint: "cli",
    name: "you-f7",
    nameSource: "derived",
    status: "busy",
    updatedAt: 1784947790556,
    statusUpdatedAt: 1784947790556,
    ...over,
  });
}

function claude(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 21659,
    sessionId: "84c16fe0-5d88-472f-af7f-5d1c7ff2c391",
    cwd: "/Users/you/Documents/code/myrepo",
    rawStatus: "idle",
    statusUpdatedAt: 1784947790556,
    kind: "interactive",
    name: "you-f7",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Session files
// ---------------------------------------------------------------------------

test("readClaudeSessions: parses the real session-file shape", async () => {
  const fs = fakeFs({
    [path.join(CLAUDE_SESSIONS_DIR, "21659.json")]: sessionJson(),
  });
  const sessions = await readClaudeSessions(fs);
  assert.deepEqual(sessions, [
    {
      pid: 21659,
      sessionId: "84c16fe0-5d88-472f-af7f-5d1c7ff2c391",
      cwd: "/Users/you/Documents/code/myrepo",
      rawStatus: "busy",
      statusUpdatedAt: 1784947790556,
      kind: "interactive",
      name: "you-f7",
    },
  ]);
});

test("readClaudeSessions: excludes kind=bg so background agents are not phantom rows", async () => {
  // A bg agent inherits its parent's cwd verbatim, so if it were kept it would
  // render as a second session in the same repo box that the user cannot
  // attach to. Both real bg files observed had cwd /Users/you.
  const fs = fakeFs({
    [path.join(CLAUDE_SESSIONS_DIR, "21659.json")]: sessionJson({ pid: 21659 }),
    [path.join(CLAUDE_SESSIONS_DIR, "21433.json")]: sessionJson({
      pid: 21433,
      kind: "bg",
      jobId: "26f8a527",
      status: "idle",
    }),
    [path.join(CLAUDE_SESSIONS_DIR, "8022.json")]: sessionJson({
      pid: 8022,
      kind: "bg",
      name: "clear-git-worktrees",
    }),
  });
  const sessions = await readClaudeSessions(fs);
  assert.deepEqual(
    sessions.map((s) => s.pid),
    [21659],
  );
});

test("readClaudeSessions: skips unparseable and non-pid files silently", async () => {
  const fs = fakeFs({
    [path.join(CLAUDE_SESSIONS_DIR, "21659.json")]: sessionJson(),
    // A file caught mid-write. Normal, must not throw or blank the dashboard.
    [path.join(CLAUDE_SESSIONS_DIR, "21598.json")]: '{"pid":21598,"sessi',
    [path.join(CLAUDE_SESSIONS_DIR, "notapid.json")]: sessionJson({ pid: 4 }),
    [path.join(CLAUDE_SESSIONS_DIR, "README.txt")]: "ignore me",
  });
  const sessions = await readClaudeSessions(fs);
  assert.deepEqual(
    sessions.map((s) => s.pid),
    [21659],
  );
});

test("readClaudeSessions: a missing sessions directory yields no sessions", async () => {
  assert.deepEqual(await readClaudeSessions(fakeFs({})), []);
});

test("parseSessionFile: falls back to the filename pid when the file omits one", async () => {
  const parsed = parseSessionFile(sessionJson({ pid: undefined }), 5150);
  assert.equal(parsed?.pid, 5150);
  // The in-file pid still wins when present, since the process wrote it.
  assert.equal(parseSessionFile(sessionJson({ pid: 21659 }), 5150)?.pid, 21659);
});

test("sessionsByPid: keys sessions by pid for the pane resolver", () => {
  const map = sessionsByPid([claude({ pid: 1 }), claude({ pid: 2 })]);
  assert.equal(map.get(2)?.pid, 2);
  assert.equal(map.get(3), undefined);
});

// ---------------------------------------------------------------------------
// Transcript paths
// ---------------------------------------------------------------------------

test("transcriptDirForCwd: reproduces the real ~/.claude/projects directories", () => {
  // A primary checkout and one of its sibling worktrees.
  assert.equal(
    transcriptDirForCwd("/Users/you/Documents/code/myrepo"),
    "-Users-you-Documents-code-myrepo",
  );
  assert.equal(
    transcriptDirForCwd("/Users/you/Documents/code/myrepo_worktree-ec2"),
    "-Users-you-Documents-code-myrepo-worktree-ec2",
  );
});

test("transcriptDirForCwd: underscores become hyphens because ALL non-alphanumerics do", () => {
  // There is no underscore special case; `_` simply is not alphanumeric. Same
  // rule flattens dots and spaces, which is why the mapping is lossy and can
  // never be inverted.
  assert.equal(transcriptDirForCwd("/a/b_c.d e"), "-a-b-c-d-e");
});

test("transcriptDirForCwd: separator runs are not collapsed", () => {
  // A path segment that itself starts with a hyphen yields a literal "--".
  assert.equal(
    transcriptDirForCwd(
      "/private/tmp/claude-501/-Users-you/a293146b-26a5-4439-ae89-24fdf0ceaaaf/scratchpad/permtest",
    ),
    "-private-tmp-claude-501--Users-you-a293146b-26a5-4439-ae89-24fdf0ceaaaf-scratchpad-permtest",
  );
});

test("transcriptDirForCwd: over-long paths are truncated with a hash suffix", () => {
  // Claude Code caps the name at 200 chars and appends a base36 hash. Reproduce
  // it or deeply nested worktrees resolve to a directory that does not exist.
  const deep = "/Users/you/" + "x".repeat(400);
  const dir = transcriptDirForCwd(deep);
  assert.equal(dir.length > 200, true);
  assert.equal(dir.startsWith("-Users-you-" + "x".repeat(186)), true);
  assert.match(dir.slice(200), /^-[0-9a-z]+$/);
  // Distinct long paths must not collide on the truncated prefix alone.
  assert.notEqual(dir, transcriptDirForCwd(deep + "y"));
});

test("transcriptPathsFor: only .jsonl, newest mtime first", async () => {
  const cwd = "/Users/you/Documents/code/myrepo";
  const dir = path.join(CLAUDE_PROJECTS_DIR, transcriptDirForCwd(cwd));
  const old = path.join(dir, "old.jsonl");
  const recent = path.join(dir, "recent.jsonl");
  const fs = fakeFs(
    {
      [old]: "",
      [recent]: "",
      [path.join(dir, "notes.md")]: "",
    },
    { [old]: 1000, [recent]: 9000 },
  );
  assert.deepEqual(await transcriptPathsFor(cwd, fs), [recent, old]);
});

test("latestTranscriptMtime: newest mtime, or null when the cwd has no transcripts", async () => {
  const cwd = "/Users/you/Documents/code/myrepo";
  const dir = path.join(CLAUDE_PROJECTS_DIR, transcriptDirForCwd(cwd));
  const fs = fakeFs(
    { [path.join(dir, "a.jsonl")]: "", [path.join(dir, "b.jsonl")]: "" },
    { [path.join(dir, "a.jsonl")]: 100, [path.join(dir, "b.jsonl")]: 700 },
  );
  assert.equal(await latestTranscriptMtime(cwd, fs), 700);
  assert.equal(await latestTranscriptMtime("/Users/you/nowhere", fakeFs({})), null);
});

// ---------------------------------------------------------------------------
// Recap fallback
// ---------------------------------------------------------------------------

function assistantLine(content: unknown, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    uuid: "0f74590c",
    message: { id: "504ce417", role: "assistant", content },
    ...over,
  });
}

test("lastAssistantText: plain string content", () => {
  assert.equal(lastAssistantText(assistantLine("All tests pass.")), "All tests pass.");
});

test("lastAssistantText: array content takes the text blocks and ignores the rest", () => {
  // The real shape: assistant records are always arrays, and most carry only
  // thinking or tool_use blocks.
  const line = assistantLine([
    { type: "thinking", thinking: "internal reasoning that must not leak" },
    { type: "text", text: "Fixed the parser." },
    { type: "tool_use", id: "t1", name: "Edit", input: {} },
  ]);
  assert.equal(lastAssistantText(line), "Fixed the parser.");
});

test("lastAssistantText: scans past prose-free assistant records", () => {
  // Stopping at the first assistant record from the end would return nothing
  // almost every time, since tool_use turns vastly outnumber prose turns.
  const text = [
    assistantLine([{ type: "text", text: "Reading the transcript." }]),
    assistantLine([{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
    assistantLine([{ type: "thinking", thinking: "hmm" }]),
    JSON.stringify({ type: "user", message: { role: "user", content: "go on" } }),
  ].join("\n");
  assert.equal(lastAssistantText(text), "Reading the transcript.");
});

test("lastAssistantText: null when there is no assistant prose at all", () => {
  assert.equal(lastAssistantText(""), null);
  assert.equal(
    lastAssistantText(
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({ type: "last-prompt", lastPrompt: "hi" }),
      ].join("\n"),
    ),
    null,
  );
  assert.equal(lastAssistantText(assistantLine([{ type: "tool_use", id: "t", name: "Bash" }])), null);
});

test("lastAssistantText: skips sidechain records so subagent chatter is not the recap", () => {
  const text = [
    assistantLine([{ type: "text", text: "Main thread speaking." }]),
    assistantLine([{ type: "text", text: "Subagent speaking." }], { isSidechain: true }),
  ].join("\n");
  assert.equal(lastAssistantText(text), "Main thread speaking.");
});

test("lastAssistantText: keeps line breaks, collapses only spaces and tabs", () => {
  // The preview wraps this text and uses the breaks as paragraph boundaries. The
  // rows flatten it themselves, because a row is one line by construction.
  const out = lastAssistantText(assistantLine("first line\n\n  second   line\t"));
  assert.equal(out, "first line\n\nsecond line");
  // Runs of three or more breaks are markdown spacing, not structure.
  assert.equal(lastAssistantText(assistantLine("a\n\n\n\nb")), "a\n\nb");
});

test("lastAssistantText: long messages are bounded, but not to one line", () => {
  // 120 characters used to be the cap, sized for a dashboard row - so the preview
  // was handed a sentence and a half no matter how many rows it had to fill.
  const long = lastAssistantText(assistantLine("z".repeat(9000)));
  assert.equal(long?.length, LAST_MESSAGE_MAX);
  assert.equal(long?.endsWith("…"), true);
  assert.ok(LAST_MESSAGE_MAX > 1000, "enough for a screenful of wrapped text");

  // A caller that wants a shorter one says so.
  const short = lastAssistantText(assistantLine("z".repeat(500)), 40);
  assert.equal(short?.length, 40);
});

test("lastAssistantText: tolerates a partially written final line", () => {
  const text = [assistantLine("Complete record."), '{"type":"assistant","mes'].join("\n");
  assert.equal(lastAssistantText(text), "Complete record.");
});

// ---------------------------------------------------------------------------
// Hook status
// ---------------------------------------------------------------------------

test("readHookStatus: reads the hook file, null when absent or malformed", async () => {
  const id = "84c16fe0";
  const fs = fakeFs({
    [path.join(STATUS_DIR, `${id}.json`)]: JSON.stringify({
      status: "error",
      reason: "rate limit",
      at: 1784947790556,
    }),
    [path.join(STATUS_DIR, "broken.json")]: "{not json",
    [path.join(STATUS_DIR, "nostatus.json")]: JSON.stringify({ at: 1 }),
  });
  assert.deepEqual(await readHookStatus(id, fs), {
    status: "error",
    reason: "rate limit",
    at: 1784947790556,
  });
  assert.equal(await readHookStatus("broken", fs), null);
  assert.equal(await readHookStatus("nostatus", fs), null);
  assert.equal(await readHookStatus("missing", fs), null);
});

// ---------------------------------------------------------------------------
// deriveStatus: the truth table
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000;
const FRESH_HOOK = (status: string): HookStatus => ({ status, at: NOW - 1000 });
const STALE_HOOK = (status: string): HookStatus => ({
  status,
  at: NOW - STALE_STATUS_MS - 1,
});

/** Transcript touched a moment ago: mid-turn rather than settled. */
const FRESH_TRANSCRIPT = NOW - 1000;
const STALE_TRANSCRIPT = NOW - IDLE_TRANSCRIPT_MS - 1;

function derive(over: {
  rawStatus?: string;
  pidAlive?: boolean;
  hook?: HookStatus | null;
  transcriptMtime?: number | null;
  paneSuggestsPrompt?: boolean;
}): Status {
  return deriveStatus({
    claude: claude({ rawStatus: over.rawStatus ?? "idle" }),
    pidAlive: over.pidAlive ?? true,
    hook: over.hook ?? null,
    transcriptMtime: over.transcriptMtime ?? FRESH_TRANSCRIPT,
    now: NOW,
    ...(over.paneSuggestsPrompt !== undefined
      ? { paneSuggestsPrompt: over.paneSuggestsPrompt }
      : {}),
  });
}

test("deriveStatus: a dead pid beats absolutely everything", () => {
  // The load-bearing invariant. A crash writes no hook event and leaves the
  // session file frozen, so every "still working" signal below is exactly what
  // a crashed session looks like on disk. If this regresses, dead sessions
  // spin forever on the dashboard.
  for (const rawStatus of ["busy", "idle", "waiting", "", "something-new"]) {
    for (const hook of [
      null,
      FRESH_HOOK("working"),
      FRESH_HOOK("awaiting"),
      FRESH_HOOK("permission"),
      FRESH_HOOK("error"),
      STALE_HOOK("working"),
    ]) {
      for (const paneSuggestsPrompt of [false, true]) {
        assert.equal(
          derive({ rawStatus, pidAlive: false, hook, transcriptMtime: NOW, paneSuggestsPrompt }),
          "dead",
          `rawStatus=${rawStatus} hook=${hook?.status ?? "none"} prompt=${paneSuggestsPrompt}`,
        );
      }
    }
  }
});

test("deriveStatus: busy/idle/waiting x alive x hook variants", () => {
  const cases: [string, HookStatus | null, Status][] = [
    // busy is unambiguous and no hook state can soften it.
    ["busy", null, "working"],
    ["busy", FRESH_HOOK("awaiting"), "working"],
    ["busy", FRESH_HOOK("working"), "working"],
    // waiting is Claude telling us directly that the user has the turn.
    ["waiting", null, "awaiting"],
    ["waiting", FRESH_HOOK("working"), "awaiting"],
    // idle defers to a fresh hook that knows *why* it is idle.
    ["idle", null, "idle"],
    ["idle", FRESH_HOOK("awaiting"), "awaiting"],
    ["idle", FRESH_HOOK("working"), "idle"],
    // An unrecognised raw status must degrade to the quiet layer, not throw.
    ["", null, "idle"],
    ["something-new", FRESH_HOOK("awaiting"), "awaiting"],
  ];
  for (const [rawStatus, hook, expected] of cases) {
    assert.equal(
      derive({ rawStatus, hook }),
      expected,
      `rawStatus=${rawStatus} hook=${hook?.status ?? "none"}`,
    );
  }
});

test("deriveStatus: hook error is the only source of `error`, and outranks Claude's status", () => {
  for (const rawStatus of ["busy", "idle", "waiting"]) {
    assert.equal(derive({ rawStatus, hook: FRESH_HOOK("error") }), "error", rawStatus);
  }
  // Sticky by design: an error stays visible until the next hook event, since
  // ageing it out would quietly hide a rate-limited session.
  assert.equal(derive({ rawStatus: "idle", hook: STALE_HOOK("error") }), "error");
  // Claude's own status never produces error.
  assert.equal(derive({ rawStatus: "idle", hook: null }), "idle");
});

test("deriveStatus: hook `awaiting` is honoured however old it is", () => {
  // Deliberately NOT aged out. The status is self-correcting: replying fires
  // UserPromptSubmit and any tool call fires PreToolUse, either of which
  // overwrites the file with `working`. So an old `awaiting` does not mean the
  // signal decayed, it means nobody has answered yet - which is exactly when the
  // dashboard has to keep showing it. Ageing it out blanked the marker while you
  // were away from the desk, which is the case this tool exists for.
  assert.equal(derive({ rawStatus: "idle", hook: FRESH_HOOK("awaiting") }), "awaiting");
  assert.equal(derive({ rawStatus: "idle", hook: STALE_HOOK("awaiting") }), "awaiting");
});

test("deriveStatus: a dead pid still beats an old `awaiting`", () => {
  // The reason ageing is unnecessary: a crash can never leave a false
  // `awaiting` behind, because liveness has already answered `dead`.
  assert.equal(
    derive({ rawStatus: "idle", hook: STALE_HOOK("awaiting"), pidAlive: false }),
    "dead",
  );
});

test("deriveStatus: transcript age does not change a quiet session's status", () => {
  for (const transcriptMtime of [FRESH_TRANSCRIPT, STALE_TRANSCRIPT, null]) {
    assert.equal(derive({ rawStatus: "idle", transcriptMtime }), "idle", String(transcriptMtime));
  }
});

test("deriveStatus: hook `permission` outranks Claude's own `busy`", () => {
  // The whole point of routing permission through a hook. A prompt is raised
  // mid-turn, so Claude's session file still says busy - if rawStatus won here,
  // a pane blocked on a permission prompt would render as a working one, which
  // is the exact failure this replaced.
  assert.equal(derive({ rawStatus: "busy", hook: FRESH_HOOK("permission") }), "permission");
  for (const rawStatus of ["idle", "waiting", "", "something-new"]) {
    assert.equal(derive({ rawStatus, hook: FRESH_HOOK("permission") }), "permission", rawStatus);
  }
  // Self-correcting rather than aged out, same as `awaiting`: PostToolUse
  // (approved), Stop (declined) and UserPromptSubmit all overwrite the file.
  assert.equal(derive({ rawStatus: "busy", hook: STALE_HOOK("permission") }), "permission");
});

test("deriveStatus: `permission` still loses to liveness and to hook error", () => {
  assert.equal(
    derive({ rawStatus: "busy", hook: FRESH_HOOK("permission"), pidAlive: false }),
    "dead",
  );
  assert.equal(derive({ rawStatus: "busy", hook: FRESH_HOOK("error") }), "error");
});

test("deriveStatus: paneSuggestsPrompt upgrades only the quiet statuses", () => {
  // The last-resort layer, kept for the one case the Notification hook cannot
  // reach: a pane at the trust-this-folder question, where no Claude session
  // exists yet to fire a hook. It may sharpen a quiet row, never contradict
  // working or dead.
  assert.equal(derive({ rawStatus: "waiting", paneSuggestsPrompt: true }), "permission");
  assert.equal(derive({ rawStatus: "idle", paneSuggestsPrompt: true }), "permission");
  assert.equal(
    derive({ rawStatus: "idle", hook: FRESH_HOOK("awaiting"), paneSuggestsPrompt: true }),
    "permission",
  );
  assert.equal(derive({ rawStatus: "busy", paneSuggestsPrompt: true }), "working");
  assert.equal(derive({ rawStatus: "idle", hook: FRESH_HOOK("error"), paneSuggestsPrompt: true }), "error");
  assert.equal(derive({ rawStatus: "busy", pidAlive: false, paneSuggestsPrompt: true }), "dead");
});

test("deriveStatus: no Claude resolved for the pane is idle, not dead", () => {
  // The pane exists and is running something; we just found no Claude beneath
  // it. Calling that `dead` would mark every plain shell pane as a corpse.
  assert.equal(
    deriveStatus({
      claude: null,
      pidAlive: false,
      hook: null,
      transcriptMtime: null,
      now: NOW,
    }),
    "idle",
  );
});

test("deriveStatus: is a pure function of its input, including the clock", () => {
  // `error` is the state that still reads the clock's other side: it is sticky
  // regardless of age, so advancing the clock must not change it either. What
  // this proves is that nothing internal consults Date.now() - every time-based
  // decision comes from the injected `now`.
  const input = {
    claude: claude({ rawStatus: "busy" }),
    pidAlive: true,
    hook: null,
    transcriptMtime: FRESH_TRANSCRIPT,
    now: NOW,
  };
  assert.equal(deriveStatus(input), "working");
  assert.equal(deriveStatus({ ...input, now: NOW + STALE_STATUS_MS + 1 }), "working");

  // And a transcript that becomes stale as the clock advances still resolves
  // through the same branch, driven only by the passed-in clock.
  const quiet = { ...input, claude: claude({ rawStatus: "idle" }) };
  assert.equal(deriveStatus(quiet), "idle");
  assert.equal(deriveStatus({ ...quiet, now: NOW + IDLE_TRANSCRIPT_MS + 1 }), "idle");
});

// ---------------------------------------------------------------------------
// awaySummary — Claude's own recap
// ---------------------------------------------------------------------------

function awayLine(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "system", subtype: "away_summary", isMeta: false, content, ...extra });
}

test("awaySummary: reads Claude's own recap out of the transcript", () => {
  assert.equal(
    awaySummary(awayLine("Read the wiki and oriented. Next: awaiting instructions."))?.text,
    "Read the wiki and oriented. Next: awaiting instructions.",
  );
});

test("awaySummary: strips the '(disable recaps in /config)' note", () => {
  // Claude's own UI chrome, not part of what the session is doing.
  assert.equal(
    awaySummary(awayLine("Oriented on the codebase. (disable recaps in /config)"))?.text,
    "Oriented on the codebase.",
  );
});

test("awaySummary: newest wins", () => {
  const text = [awayLine("the older recap"), awayLine("the newer recap")].join("\n");
  assert.equal(awaySummary(text)?.text, "the newer recap");
});

test("awaySummary: keeps its line breaks for the caller to wrap", () => {
  assert.equal(awaySummary(awayLine("did this\nnext that"))?.text, "did this\nnext that");
});

test("awaySummary: null when the session has not written one", () => {
  assert.equal(awaySummary(""), null);
  assert.equal(awaySummary(assistantLine("just talking")), null);
  // Other system records are not recaps.
  assert.equal(
    awaySummary(JSON.stringify({ type: "system", subtype: "hook_result", content: "ran" })),
    null,
  );
});

test("awaySummary: a subagent's recap is not the session's own", () => {
  assert.equal(awaySummary(awayLine("subagent chatter", { isSidechain: true })), null);
});

test("awaySummary: tolerates a partial final line and an empty recap", () => {
  const good = awayLine("the real recap");
  assert.equal(awaySummary(`${good}\n{"type":"system","subtype":"away_su`)?.text, "the real recap");
  assert.equal(awaySummary(awayLine("   ")), null);
});

test("awaySummary: carries the record's own timestamp, for freshness comparisons", () => {
  assert.equal(
    awaySummary(awayLine("oriented", { timestamp: "2026-07-27T15:27:25.503Z" }))?.at,
    Date.parse("2026-07-27T15:27:25.503Z"),
  );
});

test("awaySummary: a missing or unparseable timestamp is null, not a throw", () => {
  assert.equal(awaySummary(awayLine("oriented"))?.at, null);
  assert.equal(awaySummary(awayLine("oriented", { timestamp: "not-a-date" }))?.at, null);
});

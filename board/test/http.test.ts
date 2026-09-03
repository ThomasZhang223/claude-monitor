/**
 * Every HTTP route, driven over real HTTP against a real server.
 *
 * tmux and the session data are injected (see `createServer`'s
 * `ServerOptions.tmux`/`sessionsDeps`/`rawDeps`), so these are fast and
 * deterministic and say nothing about what happens to be running on the
 * machine.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createServer, HOST, safeResolve, type ServerOptions } from "../src/http.ts";
import { resetPromptCache } from "../src/prompt.ts";
import { resetSessionsCache } from "../src/sessions.ts";
import type { ClaudeSession, PaneRecord, SessionRecord } from "../../core/src/model.ts";

const TOKEN = "test-token";
const FIX = path.join(import.meta.dirname, "fixtures");
const pane = (name: string): string => fs.readFileSync(path.join(FIX, `pane-${name}.txt`), "utf8");

function fakeClaude(over: Partial<ClaudeSession> = {}): ClaudeSession {
  return {
    pid: 111,
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: "/repo",
    rawStatus: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    name: null,
    ...over,
  };
}

function fakePane(over: Partial<PaneRecord> = {}): PaneRecord {
  return {
    windowIndex: 0,
    paneIndex: 0,
    panePid: 222,
    status: "idle",
    claude: null,
    auto: null,
    contextPct: null,
    ...over,
  };
}

function fakeRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    tmuxName: "happy",
    box: "general",
    mode: "work",
    slug: "thing",
    label: "thing",
    worktree: null,
    recap: null,
    planPath: null,
    createdAt: null,
    branch: null,
    status: "idle",
    panes: [fakePane()],
    contextPct: null,
    model: null,
    effort: null,
    runtimeMs: null,
    wrap: null,
    flagged: false,
    ...over,
  };
}

/** A no-op tmux fake for routes this test does not exercise the tmux side of. */
const noopTmux: NonNullable<ServerOptions["tmux"]> = {
  has: async () => true,
  run: async () => ({ ok: true, stdout: "", stderr: "" }),
};

interface Harness {
  base: string;
  go(p: string, init?: RequestInit & { noAuth?: boolean }): Promise<Response>;
}

async function serve(t: TestContext, over: Partial<ServerOptions> = {}): Promise<Harness> {
  resetSessionsCache();
  resetPromptCache();
  const server = createServer({
    token: TOKEN,
    tmux: noopTmux,
    sessionsDeps: { collectSessions: async () => [], readClaudeSessions: async () => [], snapshotPs: async () => new Map(), boxIds: ["general"] },
    rawDeps: { collectSessions: async () => [], readClaudeSessions: async () => [], boxIds: ["general"] },
    ...over,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => server.close());
  return {
    base,
    go: (p, init = {}) => {
      const { noAuth, ...rest } = init;
      return fetch(`${base}${p}`, {
        ...rest,
        headers: { ...(noAuth ? {} : { Authorization: `Bearer ${TOKEN}` }), ...(rest.headers ?? {}) },
      });
    },
  };
}

// --- auth --------------------------------------------------------------

test("api: no token is a 401, on every kind of route", async (t) => {
  const h = await serve(t);
  for (const p of ["/api/sessions", "/api/config", "/api/sessions/happy", "/"]) {
    assert.equal((await h.go(p, { noAuth: true })).status, 401, p);
  }
});

test("api: a wrong token is a 401, a right one is not", async (t) => {
  const h = await serve(t);
  assert.equal(
    (await h.go("/api/sessions", { noAuth: true, headers: { Authorization: "Bearer nope" } })).status,
    401,
  );
  assert.equal((await h.go("/api/sessions")).status, 200);
});

test("api: a browser without a token gets a page telling it what to do", async (t) => {
  const h = await serve(t);
  const res = await h.go("/", { noAuth: true, headers: { accept: "text/html" } });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /needs your token/);
});

test("api: a fetch without a token still gets JSON", async (t) => {
  const h = await serve(t);
  const res = await h.go("/api/sessions", { noAuth: true });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("api: identity gate — a matching header passes, a wrong one is refused", async (t) => {
  const gate = { header: "X-User", allow: "me@example.com" };
  const h = await serve(t, { identityGate: gate });
  assert.equal((await h.go("/api/sessions", { headers: { "x-user": "me@example.com" } })).status, 200);
  assert.equal((await h.go("/api/sessions", { headers: { "x-user": "someone-else" } })).status, 403);
  assert.equal((await h.go("/api/sessions")).status, 403, "an absent header is a denial, not trust");
});

// --- static files ------------------------------------------------------

test("api: a path traversal is refused", () => {
  assert.equal(safeResolve("/srv/web", "/../../etc/passwd"), null);
});

test("api: HOST binds loopback and nothing else", () => {
  assert.equal(HOST, "127.0.0.1");
});

// --- config --------------------------------------------------------------

test("api: GET /api/config reports the box palette", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-config-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1, branchPrefix: "cc", notifications: false,
    boxes: [{ id: "general", label: "General", color: "#C9A227", path: null }],
  }));
  const h = await serve(t, { configPath: file });
  const res = await h.go("/api/config");
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.boxes.length, 1);
  assert.equal(body.boxes[0].id, "general");
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the listing -----------------------------------------------------------

test("api: the listing carries a pending prompt on the pane that has one", async (t) => {
  const record = fakeRecord({
    tmuxName: "happy",
    panes: [fakePane({ status: "permission", claude: fakeClaude() })],
  });
  const h = await serve(t, {
    tmux: { has: async () => true, run: async (args) => (args[0] === "capture-pane" ? { ok: true, stdout: pane("permission"), stderr: "" } : { ok: true, stdout: "", stderr: "" }) },
    sessionsDeps: { collectSessions: async () => [record], readClaudeSessions: async () => [], snapshotPs: async () => new Map(), boxIds: ["general"] },
  });
  const body = await (await h.go("/api/sessions")).json() as any;
  assert.equal(body.boxed.length, 1);
  assert.ok(body.boxed[0].panes[0].prompt, "the pane's own prompt is attached");
  assert.equal(body.boxed[0].panes[0].prompt.question, "Do you want to create fixture-a.txt?");
});

test("api: the listing never reads a pane that is not waiting", async (t) => {
  let captured = false;
  const record = fakeRecord({ panes: [fakePane({ status: "working" })] });
  const h = await serve(t, {
    tmux: { has: async () => true, run: async (args) => { if (args[0] === "capture-pane") captured = true; return { ok: true, stdout: "", stderr: "" }; } },
    sessionsDeps: { collectSessions: async () => [record], readClaudeSessions: async () => [], snapshotPs: async () => new Map(), boxIds: ["general"] },
  });
  const body = await (await h.go("/api/sessions")).json() as any;
  assert.equal(body.boxed[0].panes[0].prompt, null);
  assert.equal(captured, false, "a busy pane is never scraped");
});

test("api: an unknown session is a 404, not a tmux call", async (t) => {
  const h = await serve(t);
  assert.equal((await h.go("/api/sessions/nope")).status, 404);
});

// --- interactive prompts -----------------------------------------------------

test("api: GET prompt returns the menu on the pane's screen", async (t) => {
  const h = await serve(t, {
    tmux: { has: async () => true, run: async (args) => (args[0] === "capture-pane" ? { ok: true, stdout: pane("permission"), stderr: "" } : { ok: true, stdout: "", stderr: "" }) },
  });
  const res = await h.go("/api/sessions/happy/panes/0/0/prompt");
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.prompt.options.length, 3);
});

test("api: GET prompt on an unknown session is a 404", async (t) => {
  const h = await serve(t, { tmux: { has: async () => false, run: async () => ({ ok: true, stdout: "", stderr: "" }) } });
  assert.equal((await h.go("/api/sessions/gone/panes/0/0/prompt")).status, 404);
});

test("api: a stale fingerprint is refused AND sends no keys", async (t) => {
  const calls: string[][] = [];
  const h = await serve(t, {
    tmux: {
      has: async () => true,
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "capture-pane") return { ok: true, stdout: pane("permission"), stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  });
  const res = await h.go("/api/sessions/happy/panes/0/0/answer?index=1&fingerprint=not-the-one", { method: "POST" });
  assert.equal(res.status, 409);
  assert.equal(calls.filter((c) => c[0] === "send-keys").length, 0, "no keys sent for a stale answer");
});

test("api: answering when the menu has gone is refused", async (t) => {
  const h = await serve(t, {
    tmux: { has: async () => true, run: async (args) => (args[0] === "capture-pane" ? { ok: true, stdout: "nothing here\n", stderr: "" } : { ok: true, stdout: "", stderr: "" }) },
  });
  const res = await h.go("/api/sessions/happy/panes/0/0/answer?index=1&fingerprint=x", { method: "POST" });
  assert.equal(res.status, 409);
});

test("api: answering sends the digit for that option, and reports cleared", async (t) => {
  let cleared = false;
  const h = await serve(t, {
    tmux: {
      has: async () => true,
      run: async (args) => {
        if (args[0] === "capture-pane") return { ok: true, stdout: cleared ? "gone\n" : pane("permission"), stderr: "" };
        if (args[0] === "send-keys") { cleared = true; return { ok: true, stdout: "", stderr: "" }; }
        return { ok: true, stdout: "", stderr: "" };
      },
    },
  });
  const before = await h.go("/api/sessions/happy/panes/0/0/prompt");
  const { prompt } = await before.json() as any;
  const res = await h.go(`/api/sessions/happy/panes/0/0/answer?index=1&fingerprint=${prompt.fingerprint}`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.ok, true);
  assert.equal(body.cleared, true);
});

test("api: an option that does not exist is refused", async (t) => {
  const h = await serve(t, {
    tmux: { has: async () => true, run: async (args) => (args[0] === "capture-pane" ? { ok: true, stdout: pane("permission"), stderr: "" } : { ok: true, stdout: "", stderr: "" }) },
  });
  const p = await (await h.go("/api/sessions/happy/panes/0/0/prompt")).json() as any;
  const res = await h.go(`/api/sessions/happy/panes/0/0/answer?index=99&fingerprint=${p.prompt.fingerprint}`, { method: "POST" });
  assert.equal(res.status, 400);
});

// --- steering a pane ---------------------------------------------------------

test("api: interrupt presses Escape in the pane", async (t) => {
  const calls: string[][] = [];
  const h = await serve(t, { tmux: { has: async () => true, run: async (args) => { calls.push([...args]); return { ok: true, stdout: "", stderr: "" }; } } });
  const res = await h.go("/api/sessions/happy/panes/0/0/interrupt", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], ["send-keys", "-t", "happy:0.0", "Escape"]);
});

test("api: interrupt is POST-only and needs a real session", async (t) => {
  const h1 = await serve(t, { tmux: { has: async () => true, run: async () => ({ ok: true, stdout: "", stderr: "" }) } });
  assert.notEqual((await h1.go("/api/sessions/happy/panes/0/0/interrupt")).status, 200, "GET must not interrupt");
  const h2 = await serve(t, { tmux: { has: async () => false, run: async () => ({ ok: true, stdout: "", stderr: "" }) } });
  assert.equal((await h2.go("/api/sessions/gone/panes/0/0/interrupt", { method: "POST" })).status, 404);
});

test("api: say pastes the message, one tmux invocation for the paste", async (t) => {
  const calls: string[][] = [];
  const h = await serve(t, { tmux: { has: async () => true, run: async (args) => { calls.push([...args]); return { ok: true, stdout: "", stderr: "" }; } } });
  const res = await h.go("/api/sessions/happy/panes/0/0/say", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.includes("set-buffer") && c.includes("hello")));
});

test("api: an empty message is refused and sends nothing", async (t) => {
  const calls: string[][] = [];
  const h = await serve(t, { tmux: { has: async () => true, run: async (args) => { calls.push([...args]); return { ok: true, stdout: "", stderr: "" }; } } });
  const res = await h.go("/api/sessions/happy/panes/0/0/say", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "   " }),
  });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test("api: a message reaches tmux verbatim, however hostile", async (t) => {
  const calls: string[][] = [];
  const h = await serve(t, { tmux: { has: async () => true, run: async (args) => { calls.push([...args]); return { ok: true, stdout: "", stderr: "" }; } } });
  const nasty = 'say "hi" $HOME --flag';
  await h.go("/api/sessions/happy/panes/0/0/say", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: nasty }),
  });
  assert.ok(calls.some((c) => c.includes(nasty)));
});

test("api: a message body over MAX_BODY is refused", async (t) => {
  const h = await serve(t, { tmux: { has: async () => true, run: async () => ({ ok: true, stdout: "", stderr: "" }) } });
  const res = await h.go("/api/sessions/happy/panes/0/0/say", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(80_000) }),
  });
  assert.equal(res.status, 500, "readJson throws, and the top-level catch turns it into a 500");
});

test("api: mode cycles and reads back the terminal's own footer", async (t) => {
  const h = await serve(t, {
    tmux: {
      has: async () => true,
      run: async (args) => (args[0] === "capture-pane" ? { ok: true, stdout: "⏵⏵ auto mode on (shift+tab to cycle)\n", stderr: "" } : { ok: true, stdout: "", stderr: "" }),
    },
  });
  const res = await h.go("/api/sessions/happy/panes/0/0/mode", { method: "POST" });
  const body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(body.permissionMode, "auto");
});

// --- lifecycle ---------------------------------------------------------------

test("api: close kills the tmux SESSION by name", async (t) => {
  const calls: string[][] = [];
  const h = await serve(t, { tmux: { has: async () => true, run: async (args) => { calls.push([...args]); return { ok: true, stdout: "", stderr: "" }; } } });
  const res = await h.go("/api/sessions/happy/close", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], ["kill-session", "-t", "happy"]);
});

test("api: close is POST-only — a link or a prefetch must not end a session", async (t) => {
  const calls: string[][] = [];
  const h = await serve(t, { tmux: { has: async () => true, run: async (args) => { calls.push([...args]); return { ok: true, stdout: "", stderr: "" }; } } });
  await h.go("/api/sessions/happy/close");
  assert.equal(calls.length, 0, "a GET must never reach kill-session");
});

test("api: detach closes the VIEW, not the session", async (t) => {
  const calls: string[][] = [];
  const h = await serve(t, { tmux: { has: async () => true, run: async (args) => { calls.push([...args]); return { ok: true, stdout: "", stderr: "" }; } } });
  const res = await h.go("/api/sessions/happy/detach", { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], ["kill-session", "-t", "board-happy"]);
});

test("api: detach on a session with no view is not an error", async (t) => {
  const h = await serve(t, { tmux: { has: async () => true, run: async () => ({ ok: false, stdout: "", stderr: "no such session" }) } });
  const res = await h.go("/api/sessions/happy/detach", { method: "POST" });
  assert.equal(res.status, 200, "a view that already went away satisfies the goal");
});

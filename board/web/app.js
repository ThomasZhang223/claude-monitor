/**
 * The dashboard.
 *
 * Polls /api/sessions and redraws. No framework and no build step: the whole
 * page is one list of cards, and a dependency-free page is one less thing to
 * audit in a tool that hands out terminals.
 *
 * Ported from claude-board (PR 81) and re-themed. The wire shape changed
 * along with the theme: `/api/sessions` now answers `{boxed, unboxed}` (see
 * board/src/sessions.ts's SessionView / UnboxedSessionView), not claude-board's
 * original `{live, ended, endedTotal}` — a boxed session carries a `panes[]`
 * array (core/src/model.ts's PaneRecord is one status per PANE now, not per
 * session) and a `box` id whose colour comes from GET /api/config, never a
 * hardcoded hex (core/src/palette.ts's box colours are user configuration).
 *
 * ceiling: several per-session facts claude-board's card format expects
 * (model, cost, per-session context%, a Claude session id, whether a PR list
 * or an on-screen prompt exists) are not yet on SessionView — Panel A's
 * prompt.ts/prs.ts are not wired into GET /api/sessions yet. toCardView()
 * below fills each with null/[]/false, which render.js's card() already
 * renders as "nothing to show" for each — the same graceful-absence path
 * askPanel/prBlock already had for a session that simply has none.
 */
import { card, esc, moreButton, section, unboxedSection } from "/render.js";

const POLL_MS = 2000;
const CONFIG_POLL_MS = 30_000;
/** How many ended sessions to show. Grows on "show more" and persists across
 *  polls, so the list does not collapse under you every two seconds. */
const PAGE = 12;
let endedLimit = PAGE;
const board = document.getElementById("board");
const counts = document.getElementById("counts");
const clock = document.getElementById("clock");
const errBar = document.getElementById("err");

/** Statuses that mean a session is blocked on the user — a client-side copy
 *  of core/src/model.ts's NEEDS_USER, duplicated because board/web has no
 *  build step to import a .ts module through. Keep the two in agreement by
 *  hand if that list ever changes. */
const NEEDS_USER = ["awaiting", "permission", "error"];

// --- the box palette (GET /api/config) --------------------------------------
//
// Box colours are user configuration (core/src/config.ts, core/src/palette.ts)
// and cannot be hardcoded in CSS, so they are fetched once and joined onto
// each card by id. Refetched occasionally rather than never, so a colour
// changed in the setup panel while board is open does not need a reload.
let boxesById = new Map();

async function loadConfig() {
  try {
    const res = await fetch("/api/config", { credentials: "same-origin" });
    if (!res.ok) return;
    const { boxes } = await res.json();
    boxesById = new Map((boxes ?? []).map((b) => [b.id, b]));
  } catch {
    // Cards still render without a box tint; the next poll tries again.
  }
}

/**
 * A SessionView (board/src/sessions.ts) into the shape render.js's card()
 * draws — see the module comment above for what is missing today and why.
 */
function toCardView(s) {
  const box = boxesById.get(s.box);
  return {
    sessionId: s.tmuxName,
    title: s.tmuxName,
    shortId: null,
    status: s.status,
    recap: s.recap,
    lastPrompt: null,
    prompt: null,
    repo: s.worktree,
    mode: s.mode,
    model: null,
    contextPct: null,
    costUsd: null,
    live: true,
    startedAt: null,
    updatedAt: null,
    // Boxed sessions are always tmux-backed by construction (the cc-<box>-
    // naming convention IS a tmux session), so there is no "fork"/"resume"/
    // "none" case to distinguish here the way claude-board's registry-backed
    // model had.
    attach: "tmux",
    // ceiling: board does not yet report whether a terminal view is already
    // open for a session, so "Reopen" vs "Open terminal" never distinguishes
    // itself here — every open reads as a fresh one.
    viewOpen: false,
    attached: false,
    forkOf: null,
    inheritedLabel: false,
    prs: [],
    panes: s.panes,
    boxColor: box ? box.color : null,
  };
}

function render(data) {
  const boxed = data.boxed ?? [];
  const unboxed = data.unboxed ?? [];
  const ended = data.ended ?? [];
  const needing = boxed.filter((s) => NEEDS_USER.includes(s.status)).length;

  counts.textContent = `${boxed.length + unboxed.length} live`
    + (needing ? ` · ${needing} need${needing === 1 ? "s" : ""} you` : "");

  // Box-grouped, as the TUI groups them (core/src/collect.ts). `boxed` is
  // already sorted needs-you-first, then by severity (sessions.ts's
  // compareSessionView), so grouping by first-seen order keeps a box with a
  // session that needs you ahead of one that only has idle sessions in it.
  const order = [];
  const groups = new Map();
  for (const s of boxed) {
    if (!groups.has(s.box)) {
      groups.set(s.box, []);
      order.push(s.box);
    }
    groups.get(s.box).push(s);
  }

  const parts = order.map((id) => {
    const box = boxesById.get(id);
    const label = box ? box.label : id;
    const items = groups.get(id).map(toCardView);
    return `<section><h2${box ? ` style="color:${esc(box.color)}"` : ""}>${esc(label)} · ${items.length}</h2>
      <div class="grid">${items.map(card).join("")}</div></section>`;
  });
  parts.push(unboxedSection("outside a box", unboxed));
  parts.push(section("recently ended — resumable", ended.map(toCardView), moreButton(ended.length, data.endedTotal ?? ended.length)));

  board.innerHTML = parts.join("") || `<p class="empty">No sessions found.</p>`;
}

async function poll() {
  try {
    const res = await fetch(`/api/sessions?limit=${endedLimit}`, { credentials: "same-origin" });
    if (res.status === 401) throw new Error("unauthorized — open the link printed by `board`, including its ?t= token");
    if (!res.ok) throw new Error(`server said ${res.status}`);
    render(await res.json());
    errBar.hidden = true;
  } catch (e) {
    errBar.textContent = String(e.message ?? e);
    errBar.hidden = false;
  } finally {
    clock.textContent = new Date().toLocaleTimeString();
  }
}

// --- confirming, without window.confirm --------------------------------------
//
// window.confirm blocks the whole tab and reads like a browser chrome dialog
// rather than part of the page — crude on a phone. index.html already carries
// a <dialog> for the new-session flow; this reuses the same native element for
// close/fork/resume (Task 3 defect 6).
const confirmDlg = document.getElementById("confirmdlg");
const confirmBody = document.getElementById("confirmbody");

function confirmAction(text) {
  return new Promise((resolve) => {
    confirmBody.textContent = text;
    confirmDlg.returnValue = "";
    confirmDlg.showModal();
    confirmDlg.addEventListener(
      "close",
      () => resolve(confirmDlg.returnValue === "ok"),
      { once: true },
    );
  });
}

/** POST a lifecycle action, then refresh so the card reflects reality rather
 *  than what we hoped happened. */
async function act(id, verb, confirmText) {
  if (confirmText && !(await confirmAction(confirmText))) return;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/${verb}`, {
      method: "POST",
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `${verb} failed (${res.status})`);
    errBar.hidden = true;
    // A resume or fork creates a tmux session too new for board's 900ms
    // listing cache to have picked up — `?fresh=` tells session.js to attach
    // directly (ws.ts's `/ws/tmux/<name>` path, skipping the findSession()
    // lookup `?tmux=` triggers), which is why the two query params differ.
    // Without this the action appeared to do nothing: it worked, but left you
    // on the board with nothing new to click, and clicking again then
    // collided with the session it had made.
    if (body.tmux) {
      window.location.href = `/session.html?fresh=${encodeURIComponent(body.tmux)}`;
      return;
    }
  } catch (e) {
    errBar.textContent = String(e.message ?? e);
    errBar.hidden = false;
  }
  poll();
}

/**
 * Send a choice, carrying the fingerprint the panel was drawn from.
 *
 * The server re-reads the pane and refuses on a mismatch. That matters because
 * the terminal is a second way to answer: if you answered there a moment ago,
 * a stale index sent now would type a literal digit into the chat box.
 *
 * Pane-addressed (window 0, pane 0): the dashboard card has no per-pane
 * picker of its own, so this targets a session's first pane, matching
 * `board/smoke/prompt.mts`'s own `/panes/:w/:p/answer` route shape.
 */
async function reply(id, index, fingerprint) {
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/panes/0/0/answer?index=${encodeURIComponent(index)}&fingerprint=${encodeURIComponent(fingerprint)}`,
      { method: "POST", credentials: "same-origin" },
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `could not answer (${res.status})`);
    errBar.hidden = true;
  } catch (e) {
    errBar.textContent = String(e.message ?? e);
    errBar.hidden = false;
  }
  poll();
}

/**
 * Send a message to a session from its card.
 *
 * Nothing here decides whether to queue: if the session is mid-turn, Claude
 * Code queues it and shows it under the running turn, exactly as it does for
 * anything typed into the terminal.
 */
board.addEventListener("submit", async (ev) => {
  const form = ev.target.closest("[data-say]");
  if (!form) return;
  ev.preventDefault();
  const input = form.querySelector("input");
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(form.dataset.say)}/say`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `could not send (${res.status})`);
    // Clear only on success, so a failed send does not lose what you typed.
    input.value = "";
    errBar.hidden = true;
  } catch (e) {
    errBar.textContent = String(e.message ?? e);
    errBar.hidden = false;
  } finally {
    input.disabled = false;
  }
  poll();
});

board.addEventListener("click", (ev) => {
  if (ev.target.closest("[data-more]")) {
    endedLimit += PAGE;
    poll();
    return;
  }

  // Answering a question the session is blocked on. No confirm: the whole
  // point is one tap to unblock, and the option text says what it does.
  const answer = ev.target.closest("[data-answer]");
  if (answer) return void reply(answer.dataset.answer, answer.dataset.index, answer.dataset.fp);

  // Stop the turn. No confirm: it is the Escape key, it loses no work, and
  // asking twice defeats the point of a button you reach for when a session is
  // already doing the wrong thing.
  const stop = ev.target.closest("[data-stop]");
  if (stop) return void act(stop.dataset.stop, "interrupt");

  const open = ev.target.closest("[data-open]");
  if (open) {
    window.location.href = `/session.html?tmux=${encodeURIComponent(open.dataset.open)}`;
    return;
  }
  // No confirm: closing a terminal view is not destructive - the session keeps
  // running, and reopening it is one click away.
  const detach = ev.target.closest("[data-detach]");
  if (detach) return void act(detach.dataset.detach, "detach");

  const close = ev.target.closest("[data-close]");
  if (close) {
    const card = close.closest(".card");
    const name = card?.querySelector(".title")?.textContent ?? "this session";
    return void act(close.dataset.close, "close",
      `End the session "${name}"?\n\nThe Claude process stops. Its transcript is kept, so you can resume it afterwards.`);
  }

  // Forking a LIVE session: be explicit that this branches rather than moves
  // it, because two Claudes in one repo can undo each other's work.
  const fork = ev.target.closest("[data-fork]");
  if (fork) {
    const card = fork.closest(".card");
    const name = card?.querySelector(".title")?.textContent ?? "this session";
    return void act(fork.dataset.fork, "resume",
      `Fork "${name}" into a terminal?\n\nThis opens a COPY of the conversation in a new tmux session. `
      + `The original keeps running where it is — you will have two Claudes on the same work, `
      + `so close one before letting them both edit.`);
  }

  const resume = ev.target.closest("[data-resume]");
  if (resume) {
    return void act(resume.dataset.resume, "resume",
      "Resume this session in a new tmux session?\n\nIt is forked, so the original conversation is left untouched.");
  }
});

// --- starting a new session -------------------------------------------------

const dlg = document.getElementById("newdlg");
const filter = document.getElementById("newfilter");
const list = document.getElementById("newlist");
let repos = [];

function drawRepos() {
  const q = filter.value.trim().toLowerCase();
  const shown = repos.filter((r) => !q || r.path.toLowerCase().includes(q));
  // An absolute path that matches nothing is still offered: the list is a
  // convenience, not a restriction, so you can always start work somewhere new.
  const typed = filter.value.trim();
  const extra = typed.startsWith("/") && !shown.some((r) => r.path === typed)
    ? [{ path: typed, name: typed, git: false, typed: true }]
    : [];
  list.innerHTML = [...extra, ...shown].map((r) =>
    `<li><button data-cwd="${esc(r.path)}">
       <span class="rname">${esc(r.name)}</span>
       <span class="rpath">${esc(r.path)}</span>
       ${r.typed ? `<span class="rgit">use this path</span>` : r.git ? "" : `<span class="rgit">not a git repo</span>`}
     </button></li>`).join("") || `<li class="empty">nothing matches</li>`;
}

async function openNew() {
  list.innerHTML = `<li class="empty">looking…</li>`;
  dlg.showModal();
  filter.value = "";
  try {
    const res = await fetch("/api/repos", { credentials: "same-origin" });
    repos = (await res.json()).repos ?? [];
  } catch {
    repos = [];
  }
  drawRepos();
  filter.focus();
}

document.getElementById("new").addEventListener("click", openNew);
filter.addEventListener("input", drawRepos);
list.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-cwd]");
  if (!btn) return;
  ev.preventDefault();
  dlg.close();
  try {
    const res = await fetch(`/api/spawn?cwd=${encodeURIComponent(btn.dataset.cwd)}`, {
      method: "POST",
      credentials: "same-origin",
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `spawn failed (${res.status})`);
    // Straight into the terminal it just made — `?fresh=` for the same
    // direct-attach reason as the resume/fork case above.
    window.location.href = `/session.html?fresh=${encodeURIComponent(body.tmux)}`;
  } catch (e) {
    errBar.textContent = String(e.message ?? e);
    errBar.hidden = false;
  }
});

// --- push notifications (Task 4: the hand-off board/src/push.ts left) -------
//
// push.ts exports PUSH_INSECURE_CONTEXT_MESSAGE but deliberately never reads
// window.isSecureContext or renders anything — that check, and the control it
// gates, are this file's job. Duplicated here rather than imported: there is
// no bundler to share a constant between board/src (Node/TS) and board/web
// (plain browser JS) with, so the two must be kept in agreement by hand if
// this wording ever changes.
const PUSH_INSECURE_CONTEXT_MESSAGE = "Push needs HTTPS — put a tunnel in front of board.";

const pushBtn = document.getElementById("push");

/** base64url -> the Uint8Array pushManager.subscribe() wants for
 *  applicationServerKey. */
function urlBase64ToUint8Array(base64url) {
  const padded = base64url + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enablePush() {
  pushBtn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    const keyRes = await fetch("/api/push/vapid-key", { credentials: "same-origin" });
    if (!keyRes.ok) throw new Error(`could not fetch the push key (${keyRes.status})`);
    const { publicKey } = await keyRes.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    const subRes = await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!subRes.ok) throw new Error(`could not save the subscription (${subRes.status})`);
    pushBtn.textContent = "Notifications on";
  } catch (e) {
    errBar.textContent = `push: ${e.message ?? e}`;
    errBar.hidden = false;
    pushBtn.disabled = false;
  }
}

function setUpPushControl() {
  // Feature-detect BEFORE offering the control. A page served over plain
  // HTTP (board's own default — it binds 127.0.0.1 with no --host flag) has
  // no PushManager or ServiceWorkerContainer at all; tapping a button that
  // silently does nothing is the exact failure this hand-off exists to
  // prevent.
  const supported = window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window;
  pushBtn.hidden = false;
  if (!supported) {
    pushBtn.disabled = true;
    pushBtn.title = PUSH_INSECURE_CONTEXT_MESSAGE;
    return;
  }
  pushBtn.title = "";
  pushBtn.addEventListener("click", enablePush, { once: true });
}

setUpPushControl();
loadConfig().then(poll);
setInterval(poll, POLL_MS);
setInterval(loadConfig, CONFIG_POLL_MS);

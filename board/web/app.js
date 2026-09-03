/**
 * The dashboard.
 *
 * Polls /api/sessions and redraws. No framework and no build step: the whole
 * page is one list of cards, and a dependency-free page is one less thing to
 * audit in a tool that hands out terminals.
 */

import { card, esc, moreButton, section } from "/render.js";

const POLL_MS = 2000;
/** How many ended sessions to show. Grows on "show more" and persists across
 *  polls, so the list does not collapse under you every two seconds. */
const PAGE = 12;
let endedLimit = PAGE;
const board = document.getElementById("board");
const counts = document.getElementById("counts");
const clock = document.getElementById("clock");
const errBar = document.getElementById("err");

function render(data) {
  const live = data.live ?? [];
  const ended = data.ended ?? [];
  counts.textContent = `${live.length} live · ${data.endedTotal ?? ended.length} ended`;

  // Two sections, not one per repo. Every card already names its repo, and
  // splitting by it separated sessions you are actively working in from each
  // other for no gain — what you want to see together is what is running.
  const parts = [
    section("in progress", live),
    section("recently ended — resumable", ended, moreButton(ended.length, data.endedTotal ?? ended.length)),
  ];
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

/** POST a lifecycle action, then refresh so the card reflects reality rather
 *  than what we hoped happened. */
async function act(id, verb, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/${verb}`, {
      method: "POST",
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `${verb} failed (${res.status})`);
    errBar.hidden = true;
    // A resume or fork creates a tmux session whose Claude id nobody knows
    // yet, so go straight there by tmux name. Without this the action appeared
    // to do nothing: it worked, but left you on the board with nothing new to
    // click, and clicking again then collided with the session it had made.
    if (body.tmux) {
      window.location.href = `/session.html?tmux=${encodeURIComponent(body.tmux)}`;
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
 */
async function reply(id, index, fingerprint) {
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(id)}/answer?index=${encodeURIComponent(index)}&fingerprint=${encodeURIComponent(fingerprint)}`,
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
    window.location.href = `/session.html?id=${encodeURIComponent(open.dataset.open)}`;
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
    // Straight into the terminal it just made — the new session has no Claude
    // id yet, so it is addressed by tmux name.
    window.location.href = `/session.html?tmux=${encodeURIComponent(body.tmux)}`;
  } catch (e) {
    errBar.textContent = String(e.message ?? e);
    errBar.hidden = false;
  }
});

poll();
setInterval(poll, POLL_MS);

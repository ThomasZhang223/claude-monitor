/**
 * One session: its PRs, the conversation, and a terminal behind a toggle.
 *
 * The conversation is the DEFAULT view and is read from the transcript, not
 * from the screen — so it renders identically for a session that ended days
 * ago, which a terminal cannot do at all.
 *
 * The terminal is still here, one click away, because some things only exist
 * there: slash-commands, plan approval, and any prompt the picker cannot drive.
 * It is a websocket to a pty running `tmux attach`, and closing this tab is a
 * DETACH, not a stop — the tmux session keeps running. That is not code here;
 * it is what tmux does.
 *
 * Addressing changed from claude-board's original port: board's own model
 * (board/src/sessions.ts's SessionView) has no per-pane Claude session id on
 * the wire, so this page addresses everything by tmux session name, not a
 * Claude id — matching board/src/ws.ts, which already resolves a terminal
 * that way. Two query params carry it, for the two attach paths ws.ts has:
 *   ?tmux=<name>   an EXISTING session (opened from the dashboard) — the
 *                  grouped /ws/term/<name> path, resolved via findSession().
 *   ?fresh=<name>  a session board just spawned/resumed/forked, too new for
 *                  the 900ms listing cache to have picked up — the direct
 *                  /ws/tmux/<name> attach path, skipping that lookup.
 * A push notification's #s=&w=&p= hash (board/web/sw.js's own scheme) is a
 * third way in, aliased onto the "existing session" case.
 */
import { Terminal } from "/vendor/xterm/xterm.mjs";
import { FitAddon } from "/vendor/xterm-fit/addon-fit.mjs";
// The same split the dashboard cards use, so the two cannot disagree about
// what counts as done or how it is summarised.
import { askPanel, prBlock } from "/render.js";
import { composerState, conversation, groupHtml, groups, statusBar } from "/chat.js";

const params = new URLSearchParams(location.search);
const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const freshName = params.get("fresh");
/** The tmux session name this page addresses everything by. */
const tmuxName = freshName || params.get("tmux") || hashParams.get("s");
/** A specific pane within it — a push notification or a dashboard card names
 *  one; absent, this defaults to the session's first pane. */
const paneWindow = Number(params.get("w") ?? hashParams.get("w") ?? 0);
const panePane = Number(params.get("p") ?? hashParams.get("p") ?? 0);
const titleEl = document.getElementById("title");
const stateEl = document.getElementById("state");
const prsEl = document.getElementById("prs");
const barEl = document.getElementById("bar");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** A secondary line in the status bar, appended rather than replacing the
 *  terminal's own message. */
let noted = "";
function note(text) {
  // One note at a time, replaced rather than accumulated: these describe the
  // CURRENT state, and a bar that only ever grows stops being readable.
  if (text === noted) return;
  const base = (barEl.textContent ?? "").split(" · ")[0];
  noted = text;
  barEl.textContent = text ? `${base} · ${text}` : base;
}

function say(text, bad = false) {
  barEl.textContent = text;
  barEl.classList.toggle("bad", bad);
}

const term = new Terminal({
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 13,
  cursorBlink: true,
  scrollback: 5000,
  theme: { background: "#0b0e13", foreground: "#d6deeb", cursor: "#7fffd4" },
});
const fit = new FitAddon();
term.loadAddon(fit);

/**
 * Output is held back while text is selected.
 *
 * xterm drops a selection as soon as the buffer scrolls, and a live session
 * scrolls constantly — so a drag was being cancelled by the session's own
 * output before the mouse came up, and a completed selection vanished within a
 * second. Buffering while a selection exists is what terminal emulators do for
 * the same reason.
 *
 * Bounded, because a paused terminal must not become a memory leak: past the
 * cap the oldest output is dropped, which is the same thing scrollback does.
 */
const HOLD_CAP = 512 * 1024;
let held = [];
let heldBytes = 0;

function writeOrHold(text) {
  if (!term.hasSelection()) return term.write(text);
  held.push(text);
  heldBytes += text.length;
  while (heldBytes > HOLD_CAP && held.length > 1) heldBytes -= held.shift().length;
}

term.onSelectionChange(() => {
  if (term.hasSelection()) {
    note("output paused while selected — click to resume");
    return;
  }
  // Nothing selected: resume. Guarded against re-entry, because writing here
  // can itself change the selection state.
  if (held.length) {
    const pending = held.join("");
    held = [];
    heldBytes = 0;
    term.write(pending);
  }
});
term.open(document.getElementById("term"));
// A test seam. The UI smoke needs to drive and inspect a real terminal —
// selection especially, which cannot be judged from the DOM — and there is no
// other handle on it from outside the module.
window.__boardTerm = term;
fit.fit();

async function loadSession() {
  const res = await fetch(`/api/by-tmux/${encodeURIComponent(tmuxName)}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`session lookup failed (${res.status})`);
  const s = await res.json();
  titleEl.textContent = s.title;
  stateEl.textContent = s.status;
  stateEl.className = `status ${s.status}`;
  document.title = `${s.title} · board`;
  return s;
}

async function loadPrs() {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(tmuxName)}/prs`, { credentials: "same-origin" });
    if (!res.ok) return note(`no PR list: server said ${res.status}`);
    const { prs } = await res.json();
    // The dashboard card's renderer, not a second one of our own. It already
    // folds the finished PRs, colours by phase, and is unit-tested.
    prsEl.innerHTML = prBlock({ prs });
    if (prs.length === 0) note("no PRs linked to this session yet");
  } catch (e) {
    // PR detail is a nicety — it must never stop the terminal opening — but
    // its absence should still be explained rather than looking like a blank.
    note(`no PR list: ${e.message ?? e}`);
  }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // `?fresh=` is too new for findSession()'s listing cache — attach directly,
  // skipping the lookup /ws/term/ makes. Everything else goes through the
  // grouped view, which is what lets more than one tab watch the same pane.
  const path = freshName
    ? `/ws/tmux/${encodeURIComponent(tmuxName)}`
    : `/ws/term/${encodeURIComponent(tmuxName)}`;
  const ws = new WebSocket(`${proto}//${location.host}${path}`);
  ws.binaryType = "arraybuffer";

  const sendResize = () => {
    fit.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send("\x00" + JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  };

  // The wheel AND the two scroll buttons share one path: both are a tmux
  // scroll COMMAND, never keystrokes. tmux is a full-screen application, so
  // xterm has no scrollback of its own to move — left alone it converts the
  // wheel into arrow keys, and Claude Code reads those as "previous prompt".
  // Batched on a frame so a fast flick, or a held button, is one tmux call
  // rather than many.
  let pendingLines = 0;
  let flush = null;
  function queueScroll(lines) {
    pendingLines += lines;
    if (!flush) {
      flush = setTimeout(() => {
        const n = pendingLines;
        pendingLines = 0;
        flush = null;
        if (n && ws.readyState === WebSocket.OPEN) {
          ws.send("\x00" + JSON.stringify({ type: "scroll", lines: n }));
        }
      }, 40);
    }
  }

  ws.onopen = () => say("connecting…");
  ws.onmessage = (ev) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    if (text[0] === "\x00") {
      const msg = JSON.parse(text.slice(1));
      if (msg.type === "ready") {
        // The shift note is not optional detail: with tmux taking the wheel it
        // also takes drag-select, and shift is how you get the browser's own
        // selection back.
        // The shift hint is not a nicety. Claude Code turns on mouse
        // tracking (xterm reports `mouseTrackingMode: "any"`), so xterm hands
        // every drag to the application and a plain drag selects NOTHING.
        // Shift is xterm's documented override, and without being told, the
        // terminal simply appears to refuse selection.
        // "if a plain drag does not" rather than "use shift": which gesture
        // works depends on whether the application is holding mouse tracking
        // at that moment, and it changes as the session works. Shift is the
        // override for when it IS — measured both ways.
        say(`attached to ${msg.session} — scroll or use the up/down buttons for history, drag to select `
          + `(SHIFT-drag if a plain drag does not); `
          + `closing this tab detaches and the session keeps running`);
        sendResize();
      } else if (msg.type === "error") {
        say(msg.message, true);
      } else if (msg.type === "scrolled") {
        // Say what state the terminal is in. Scrolled back, tmux swallows
        // typing as copy-mode commands, and without a word about it the
        // terminal simply appears to have stopped responding.
        note(msg.back ? "scrolled back — type to return to the prompt" : "");
      } else if (msg.type === "exit") {
        say("terminal closed", true);
      }
      return;
    }
    writeOrHold(text);
  };
  ws.onerror = () => say("connection failed", true);
  ws.onclose = () => say(barEl.classList.contains("bad") ? barEl.textContent : "detached — the session is still running");

  term.onData((d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d);
  });

  // wheel-up is negative deltaY, and scrolls back.
  term.attachCustomWheelEventHandler((ev) => {
    const lines = Math.round(ev.deltaY / 40) || (ev.deltaY > 0 ? 1 : -1);
    queueScroll(-lines);
    return false;
  });

  // Touch has no wheel to repurpose (Task 3 defect 5) — these two buttons
  // drive the same {type:"scroll"} frame. Held down, they repeat like a
  // scrollbar's own arrows rather than firing once per tap.
  function holdToScroll(btn, lines) {
    let timer = null;
    const fire = () => queueScroll(lines);
    const start = (ev) => {
      ev.preventDefault();
      fire();
      timer = setInterval(fire, 120);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointerleave", stop);
    btn.addEventListener("pointercancel", stop);
  }
  holdToScroll(document.getElementById("scrollup"), -3);
  holdToScroll(document.getElementById("scrolldown"), 3);

  window.addEventListener("resize", sendResize);
  return ws;
}

// --- the question this session is blocked on --------------------------------
//
// The terminal below can answer any of these by keystroke, but only if you can
// read it and know which key. The panel is here so the choice is a tap, and so
// it works the same way from the dashboard and from a phone.
//
// This polls, unlike everything else on this page: the prompt appears and
// disappears in the terminal without any websocket frame saying so.
//
// Pane-addressed (tmux name, window, pane), matching board/smoke/prompt.mts's
// own /panes/:w/:p/{prompt,answer} route shape — a permission prompt belongs
// to one specific pane, not to the session as a whole.
const askEl = document.getElementById("ask");
const ASK_POLL_MS = 2000;
const PROMPT_PATH = `/api/sessions/${encodeURIComponent(tmuxName)}/panes/${paneWindow}/${panePane}/prompt`;
const answerPath = (index, fingerprint) =>
  `/api/sessions/${encodeURIComponent(tmuxName)}/panes/${paneWindow}/${panePane}/answer` +
  `?index=${encodeURIComponent(index)}&fingerprint=${encodeURIComponent(fingerprint)}`;
let watchingAsk = false;

async function pollAsk() {
  if (!watchingAsk) return;
  try {
    const res = await fetch(PROMPT_PATH, { credentials: "same-origin" });
    if (!res.ok) return;
    const body = await res.json();
    askEl.innerHTML = askPanel(body.prompt, tmuxName);
  } catch {
    // A failed poll leaves the last panel up rather than blanking it. The
    // terminal is right there and still authoritative.
  }
}

askEl.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-answer]");
  if (!btn) return;
  try {
    const res = await fetch(answerPath(btn.dataset.index, btn.dataset.fp), { method: "POST", credentials: "same-origin" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `could not answer (${res.status})`);
    askEl.innerHTML = "";
  } catch (e) {
    say(String(e.message ?? e), true);
  }
  pollAsk();
});

/** Start watching for questions once the session is known to be a live tmux
 *  one — an ended or non-tmux session has no pane for a prompt to be on. */
function watchAsk() {
  watchingAsk = true;
  pollAsk();
  setInterval(pollAsk, ASK_POLL_MS);
}

// --- the conversation -------------------------------------------------------
//
// Polled rather than pushed: Claude Code appends to the transcript as a turn
// progresses (a row per message and per tool result, measured), and there is no
// event to subscribe to. A byte cursor means each poll reads only what is new,
// so this stays cheap on a 49 MB transcript.
const chatEl = document.getElementById("chat");
const emptyEl = document.getElementById("chatempty");
const termwrapEl = document.getElementById("termwrap");
const composerEl = document.getElementById("composer");
const sayEl = document.getElementById("say");
const stopEl = document.getElementById("stop");
const toggleEl = document.getElementById("toggle");
const workingEl = document.getElementById("working");
const workingLabel = document.getElementById("workinglabel");
const statusBarEl = document.getElementById("status");
const CHAT_POLL_MS = 1500;

const earlierWrap = document.getElementById("earlierwrap");
const earlierBtn = document.getElementById("earlier");

let watchingChat = false;
let cursor = null;
/** Where the loaded window BEGINS. "Load earlier" reads backwards from here. */
let earliest = null;
/**
 * The conversation as DATA, not as DOM.
 *
 * Appending each poll's window as its own rendered block was wrong in a way
 * only visible on a LIVE turn: a turn in flight arrives a few items at a time,
 * so every poll drew a fresh group and one turn became a stack of "claude
 * 00:19" headers, one per tool call. History looked right because it arrives in
 * a single window.
 *
 * Keeping the items lets grouping run over the whole turn, and only the last
 * group — the one still growing — is redrawn.
 */
let committed = [];
let provisional = [];
/**
 * Messages handed to the terminal but not yet seen in the transcript.
 *
 * Measured: POST /say returns in 20ms and the row appears about two seconds
 * later — Claude Code has to accept the paste, take the Enter, and write it.
 * Waiting for that made your own message look like it had gone nowhere, so it
 * is echoed here and dropped the moment the real row arrives.
 */
let outbox = [];
/** How long before an unconfirmed message is called out rather than spun on. */
const SEND_CONFIRM_MS = 30_000;
/** How many groups have been rendered forward of anything "load earlier" put
 *  above them. */
let renderedGroups = 0;
let session = null;
let pinned = true;

/** Only auto-scroll when already at the bottom, so reading history is not
 *  yanked away every time a row lands. */
function atBottom() {
  return chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - 40;
}

let polling = false;

async function pollChat() {
  if (!watchingChat) return;
  // One poll at a time. The interval is 1.5s and a request can take longer —
  // /api/sessions/:id/messages reads a file and the server may be reading panes
  // — so two polls can be in flight at once. Both then see the same cursor,
  // both append the same window, and a turn appears twice. That is the
  // duplication that survived the first two fixes.
  if (polling) return;
  polling = true;
  try {
    const q = cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`;
    const res = await fetch(`/api/sessions/${encodeURIComponent(tmuxName)}/messages${q}`, {
      credentials: "same-origin",
    });
    if (!res.ok) return;
    const body = await res.json();
    pinned = atBottom();
    if (cursor === null) {
      // First load. Keep the "load earlier" control, drop any previous items.
      // Keep the page's own furniture — the "load earlier" control and the
      // empty-state line. Removing everything except one of them silently
      // deleted the other, which is why an empty session rendered blank with
      // nothing saying why.
      for (const el of [...chatEl.children]) {
        if (el !== earlierWrap && el !== emptyEl) el.remove();
      }
      committed = [];
      provisional = [];
      renderedGroups = 0;
      earliest = body.start;
      // A transcript reaches 7 MB here and one window is the last few percent
      // of it; without this the rest of the session is on disk and unreachable.
      earlierWrap.hidden = body.atStart !== false;
    }
    // A window holding a pending tool is NOT committed: its cursor does not
    // advance, so the next poll returns the same rows again with the result
    // filled in. Those rows replace the provisional set rather than adding to
    // it — appending them is what made turns appear twice.
    const pending = body.items.some((i) => i.kind === "tool" && i.pending);
    if (pending) {
      provisional = body.items;
    } else {
      // The window from an uncommitted cursor repeats the provisional items and
      // adds the new ones, so concatenating it after clearing provisional is
      // the whole reconciliation.
      committed = committed.concat(body.items);
      provisional = [];
      cursor = body.cursor;
    }

    // Drop echoes that have arrived for real. Matching on the text is enough:
    // it is what was pasted, so the row Claude Code writes carries it verbatim.
    if (outbox.length) {
      const arrived = new Set(
        committed.concat(provisional)
          .filter((i) => i.kind === "user")
          .map((i) => i.text.trim()),
      );
      outbox = outbox.filter((o) => !arrived.has(o.text.trim()));
    }
    drawTail();
    if (cursor === null) cursor = body.cursor;
    if (pinned) chatEl.scrollTop = chatEl.scrollHeight;
    if (body.status) applyComposer({ ...session, status: body.status, live: body.live });
    // Rows land per tool and per message, so a long tool call and an idle
    // session look identical in the transcript. The session's own status is
    // what distinguishes them — except during a compaction, where the status
    // stays `idle` for the whole minute it runs and only the terminal knows.
    const busy = body.live && (body.status === "busy" || body.status === "working");
    workingEl.hidden = !(busy || body.activity);
    workingLabel.textContent = body.activity ?? "Claude is working…";
  } catch {
    // A failed poll leaves what is on screen; the next one catches up.
  } finally {
    polling = false;
  }
}

/**
 * Read further into the past and put it above what is already shown.
 *
 * Scroll position is restored by height difference rather than left alone: the
 * browser keeps `scrollTop` where it was, so prepending content silently
 * scrolls you backwards away from what you were reading.
 */
async function loadEarlier() {
  if (earliest === null || earliest <= 0) return;
  earlierBtn.disabled = true;
  earlierBtn.textContent = "loading…";
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(tmuxName)}/messages?before=${encodeURIComponent(earliest)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) throw new Error(`could not read earlier (${res.status})`);
    const body = await res.json();
    const before = chatEl.scrollHeight;
    if (body.items.length) earlierWrap.insertAdjacentHTML("afterend", conversation(body.items));
    chatEl.scrollTop += chatEl.scrollHeight - before;
    // A window that yielded nothing and moved nowhere is the beginning.
    if (body.atStart || body.start === earliest) earlierWrap.hidden = true;
    earliest = body.start;
  } catch (e) {
    say(String(e.message ?? e), true);
  } finally {
    earlierBtn.disabled = false;
    earlierBtn.textContent = "load earlier";
  }
}

earlierBtn.addEventListener("click", loadEarlier);

// Catch up the moment a selection is released, rather than making you wait for
// the next poll to see what arrived while you were reading.
document.addEventListener("selectionchange", () => {
  if (!selectingInChat() && watchingChat) drawTail();
});

// Cycling the permission mode. The terminal binds shift+tab for this and there
// is no one-shot way to set a mode, so board cycles too and shows what it
// landed on rather than what it hoped for.
statusBarEl.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-mode]");
  if (!btn) return;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(tmuxName)}/mode`, {
      method: "POST",
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `could not change mode (${res.status})`);
    if (body.permissionMode) applyComposer({ ...session, permissionMode: body.permissionMode });
  } catch (e) {
    say(String(e.message ?? e), true);
  } finally {
    btn.disabled = false;
  }
});

/** Re-read the session so the meters and mode stay current. */
async function refreshSession() {
  try {
    const res = await fetch(`/api/by-tmux/${encodeURIComponent(tmuxName)}`, { credentials: "same-origin" });
    if (res.ok) applyComposer(await res.json());
  } catch {
    // The bar keeps its last values; nothing here is worth an error for.
  }
}

/**
 * Redraw the tail of the conversation.
 *
 * Only the last group is rewritten, because it is the only one that can still
 * change: a turn in flight gains items poll by poll. Everything above it is
 * finished and is left alone, which keeps opened tool groups open and the
 * scroll position where you put it.
 */
/** Is the user selecting text inside the conversation right now? */
function selectingInChat() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  return node ? chatEl.contains(node.nodeType === 1 ? node : node.parentNode) : false;
}

/** What to render: everything loaded, plus anything still in flight. */
function allItems() {
  const now = Date.now();
  return committed.concat(provisional, outbox.map((o) => ({
    kind: "user",
    text: o.text,
    at: o.at,
    sending: true,
    stalled: now - o.at > SEND_CONFIRM_MS,
  })));
}

function drawTail() {
  // Never redraw under a selection. The last group is rewritten on every poll
  // because a turn in flight keeps growing, and replacing the element your
  // selection lives in silently drops it — which reads as text deselecting
  // itself a second after you drag over it.
  //
  // Nothing is lost by waiting: the items are held in `committed` and
  // `provisional`, so the next poll after you let go draws everything.
  if (selectingInChat()) return;
  const gs = groups(allItems());
  // The final rendered group may have grown, so it is always redrawn.
  if (renderedGroups > 0) {
    const last = chatEl.lastElementChild;
    if (last && last !== earlierWrap) { last.remove(); renderedGroups--; }
  }
  const html = gs.slice(renderedGroups).map(groupHtml).join("");
  if (html) chatEl.insertAdjacentHTML("beforeend", html);
  renderedGroups = gs.length;

  // A session that has not taken a turn yet has no transcript at all — common
  // right after a reboot, and true of any terminal you have opened but not
  // talked to. It used to render as a blank area with nothing saying why.
  emptyEl.hidden = gs.length > 0 || cursor === null;
}

/** Enable, disable, and label the composer for what this session can do. */
function applyComposer(s) {
  session = s ?? session;
  statusBarEl.innerHTML = statusBar(session);
  const state = composerState(session);
  sayEl.disabled = !state.enabled;
  sayEl.placeholder = state.placeholder;
  stopEl.hidden = !state.busy;
  if (state.note) note(state.note);
}

composerEl.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = sayEl.value.trim();
  if (!text) return;
  sayEl.disabled = true;
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(tmuxName)}/say`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `could not send (${res.status})`);
    sayEl.value = "";
    // Echo it straight away. The server has taken it; the transcript has not
    // caught up, and two seconds of nothing reads as a message that failed.
    outbox.push({ text, at: Date.now() });
    drawTail();
    chatEl.scrollTop = chatEl.scrollHeight;
  } catch (e) {
    say(String(e.message ?? e), true);
  } finally {
    sayEl.disabled = false;
    sayEl.focus();
  }
  pollChat();
});

// Enter sends; Shift+Enter is a newline. The same bargain the terminal makes,
// so muscle memory carries over.
sayEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    composerEl.requestSubmit();
  }
});

stopEl.addEventListener("click", async () => {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(tmuxName)}/interrupt`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "could not stop");
  } catch (e) {
    say(String(e.message ?? e), true);
  }
  pollChat();
});

/** The terminal is the escape hatch, not the default. It only attaches when
 *  first shown, so an unused terminal costs no pty and no tmux client. */
let termStarted = false;
toggleEl.addEventListener("click", () => {
  const showTerm = termwrapEl.hidden;
  termwrapEl.hidden = !showTerm;
  chatEl.hidden = showTerm;
  composerEl.hidden = showTerm;
  toggleEl.textContent = showTerm ? "conversation" : "terminal";
  if (showTerm && !termStarted) {
    termStarted = true;
    connect();
  }
});

function watchChat() {
  watchingChat = true;
  cursor = null;
  pollChat();
  setInterval(pollChat, CHAT_POLL_MS);
  // Slower than the conversation: quota meters move on the order of minutes,
  // and this re-reads the whole session view rather than a byte range.
  setInterval(refreshSession, 15_000);
}

if (!tmuxName) {
  say("no session named — open this page from the board", true);
} else if (freshName) {
  // Connect first — the terminal is why you are here, and it must not wait on
  // a lookup. Title and PRs fill in behind it.
  titleEl.textContent = tmuxName;
  stateEl.textContent = "live";
  document.title = `${tmuxName} · board`;
  say(`attached to ${tmuxName}`);
  loadSession()
    .then((s) => {
      applyComposer(s);
      watchAsk();
      watchChat();
      return loadPrs();
    })
    // Reported, not swallowed. A silent catch here meant that when the lookup
    // failed the strip was simply empty, with nothing anywhere saying why —
    // which is exactly the state that has to be diagnosed from a screenshot.
    .catch((e) => note(`no PR list: ${e.message ?? e}`));
} else {
  // Start reading the conversation IMMEDIATELY — the tmux name is right there
  // in the URL, so this does not need the session lookup, which resolves
  // through the whole listing and is about a second cold. Chaining them left
  // the page empty for that second before it even asked for the messages.
  watchChat();
  loadSession()
    .then((s) => {
      loadPrs();
      applyComposer(s);
      if (s.attach === "tmux") {
        watchAsk();
        say("live — the terminal is one click away");
      } else if (s.attach === "resume") {
        // Not an error any more: you can read the whole conversation here.
        say("This session has ended — reading its transcript. Resume it from the board to continue.");
        toggleEl.hidden = true;
      } else if (s.attach === "fork") {
        say("This session runs outside tmux, so it can be read but not typed into. Fork it from the board to continue.");
        toggleEl.hidden = true;
      } else {
        say("No terminal is available for this session.");
        toggleEl.hidden = true;
      }
    })
    .catch((e) => say(String(e.message ?? e), true));
}

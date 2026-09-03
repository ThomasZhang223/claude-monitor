/**
 * Turning a session into HTML. No DOM, no fetch, no globals — app.js owns all
 * of that.
 *
 * Split out so it can be tested: this is where the PR folding, the status
 * wording and the HTML escaping live, and none of it was reachable from a test
 * while it sat inside a module that touches `document` at import time.
 */

/** Escape before interpolating: titles and prompts are arbitrary user text and
 *  go into innerHTML. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function repoShort(repo) {
  return repo ? repo.split("/").pop() : "—";
}

/**
 * The "what is this about" line.
 *
 * The session's own recap first — it is a summary of the work, written by the
 * session, and reads as a sentence. `lastPrompt` is the fallback: it is only
 * the most recent thing asked, so out of context it is often a fragment
 * ("it's ok, you can ignore PLT-1").
 */
function describe(s) {
  if (s.recap) return `<div class="prompt recap">${esc(s.recap)}</div>`;
  if (s.lastPrompt) return `<div class="prompt">${esc(s.lastPrompt)}</div>`;
  return "";
}

/**
 * The word shown next to the status colour.
 *
 * Colour alone is not enough — red and yellow are the most common pair to be
 * unable to separate — so the label states the meaning rather than echoing the
 * internal token. "busy" and "working" are the same thing from two different
 * sources; the user should not have to know that.
 */
const STATUS_LABEL = {
  awaiting: "waiting for you",
  permission: "needs permission",
  error: "error",
  busy: "working",
  working: "working",
  idle: "idle",
  shell: "shell",
  ended: "ended",
};

/**
 * Split PRs into the ones still needing something and the ones that are done.
 *
 * A long session accumulates PRs — one here links 16, of which most are
 * already merged. Showing all of them equally buries the few that still need
 * you, so anything terminal folds away behind a summary.
 *
 * Shared by the dashboard card and the session page's strip, so the two cannot
 * disagree about what "done" means or how it is counted.
 */
function splitPrs(prs) {
  const done = prs.filter((p) => p.phase === "merged" || p.phase === "closed");
  const live = prs.filter((p) => !done.includes(p));
  const summary = [
    done.filter((p) => p.phase === "merged").length && `${done.filter((p) => p.phase === "merged").length} merged`,
    done.filter((p) => p.phase === "closed").length && `${done.filter((p) => p.phase === "closed").length} closed`,
  ].filter(Boolean).join(", ");
  return { live, done, summary };
}

/**
 * PR badges for a dashboard card: live ones shown, finished ones folded away.
 */
function prBlock(s) {
  if (!s.prs.length) return "";
  const { live, done, summary } = splitPrs(s.prs);

  const badge = (p) => {
    const phase = p.phase ?? "unknown";
    const label = p.phase === "queued" ? " · queued" : p.phase === "draft" ? " · draft" : "";
    // Title and checks ride in the tooltip: they are what you want AFTER
    // deciding a PR is worth looking at, and inline they turned a strip of
    // links into a stack of full-width bars.
    const title = [p.title, p.checks].filter(Boolean).join(" — ");
    return `<a class="pr ph-${esc(phase)}" href="${esc(p.url)}" target="_blank" rel="noreferrer"
      title="${esc(title || p.url)}"><span class="prdot"></span>${esc(repoShort(p.repository))}#${p.number}${esc(label)}</a>`;
  };

  return `<div class="prs">${live.map(badge).join("")}${
    done.length
      ? `<details class="done"><summary>${esc(summary)}</summary><div class="prs">${done.map(badge).join("")}</div></details>`
      : ""
  }</div>`;
}

/**
 * Says who has this session open, which is what explains its colour: an idle
 * session with a terminal on it is red because it is waiting for whoever is
 * sitting in front of it.
 *
 * `viewOpen` is a terminal board itself opened; `attached` also covers the
 * window the session was started in, which board knows nothing about beyond
 * tmux reporting a client on its group.
 */
function attachNote(s) {
  if (s.viewOpen) return `<div class="viewnote">terminal open here</div>`;
  if (s.attached) return `<div class="viewnote elsewhere">open in another window</div>`;
  return "";
}

function card(s) {
  const facts = [
    repoShort(s.repo),
    s.model,
    s.contextPct != null ? `ctx ${s.contextPct}%` : null,
    s.costUsd != null ? `$${s.costUsd.toFixed(2)}` : null,
    s.live ? (s.startedAt ? `up ${ago(s.startedAt)}` : null) : (s.updatedAt ? `${ago(s.updatedAt)} ago` : null),
  ].filter(Boolean);

  const prs = prBlock(s);

  // Only offer what the session can actually do. A live session outside tmux
  // has no attachable pty, and saying so beats a button that fails.
  //
  // The two closing verbs are deliberately separate words, because they do
  // very different things and the wrong one loses work:
  //   Close terminal — ends the TERMINAL VIEW; the session keeps running
  //   End session    — ends the SESSION; the Claude process stops
  const id = esc(s.sessionId);
  const actions = {
    tmux: [
      `<button data-open="${id}">${s.viewOpen ? "Reopen" : "Open"} terminal</button>`,
      s.viewOpen ? `<button data-detach="${id}" title="Close the terminal view. The session keeps running.">Close terminal</button>` : "",
      `<button class="danger" data-close="${id}" title="Stop this Claude session. The transcript is kept, so you can resume it.">End session</button>`,
    ].join(""),
    // Live but outside tmux: its own terminal cannot be joined, but the
    // conversation can be forked into one that can.
    fork: `<button data-fork="${id}" title="Open this conversation in a new tmux session with a terminal. The original keeps running where it is.">Fork to terminal</button>`,
    resume: `<button data-resume="${id}">Resume</button>`,
    none: `<button disabled title="No transcript to open.">No terminal</button>`,
  }[s.attach];

  return `<article class="card ${esc(s.status)}">
    <div class="card-top">
      <span class="title">${esc(s.title)}${s.shortId ? `<span class="shortid"> ${esc(s.shortId)}</span>` : ""}</span>
      <span class="status ${esc(s.status)}">${esc(STATUS_LABEL[s.status] ?? s.status)}</span>
    </div>
    ${s.forkOf ? `<div class="forkof">forked from ${esc(s.forkOf)}${s.inheritedLabel ? " · showing its PRs and recap" : ""}</div>` : ""}
    ${describe(s)}
    ${askPanel(s.prompt, s.sessionId)}
    <div class="facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
    ${prs}
    ${attachNote(s)}
    <div class="actions">${actions}</div>
    ${steer(s)}
  </article>`;
}

/**
 * The picker for a session blocked on a question.
 *
 * This is the one thing on the page asking for a decision, so it is the one
 * loud thing: its own surface, a red rail, options as full-width hit targets.
 * Everything around it stays quiet.
 *
 * The numbers are not decoration and not an ordering flourish — they are
 * literally the keys you would press in the terminal, which is why they are
 * shown and why the keyboard shortcuts match them.
 *
 * Options board cannot deliver are rendered anyway, disabled, with the reason.
 * Hiding them would make the picker disagree with the terminal about what the
 * choices are.
 */
/**
 * Stop the turn, and say something without opening the session.
 *
 * Both are ordinary keystrokes into the session's own terminal — Escape, and a
 * bracketed paste plus Enter — so the session behaves exactly as it does when
 * you type at it directly. In particular board implements no queue of its own:
 * a message sent to a busy session is queued by Claude Code and shown under the
 * running turn, which is what it does with anything typed mid-turn.
 */
function steer(s) {
  if (s.attach !== "tmux") return "";
  const id = esc(s.sessionId);
  const busy = s.status === "busy" || s.status === "working";
  return `<form class="steer" data-say="${id}">
    <input name="text" placeholder="${busy ? "queue a message…" : "say something…"}" autocomplete="off" aria-label="Send a message to this session">
    <button type="submit" title="Send this to the session. If it is mid-turn, Claude Code queues it.">Send</button>
    ${busy ? `<button type="button" class="danger" data-stop="${id}" title="Press Escape in this session, ending the turn it is running. The session stays open.">Stop</button>` : ""}
  </form>`;
}

function askPanel(prompt, sessionId) {
  if (!prompt) return "";
  const id = esc(sessionId);
  const fp = esc(prompt.fingerprint);
  const options = prompt.options.map((o) => {
    const n = `<span class="asknum">${esc(o.index)}</span>`;
    const text = `<span class="asktext"><span class="asklabel">${esc(o.label)}</span>${
      o.description ? `<span class="askdesc">${esc(o.description)}</span>` : ""
    }</span>`;
    if (!o.drivable) {
      return `<div class="askopt off" title="${esc(o.reason)}">${n}${text}<span class="askwhy">${esc(o.reason)}</span></div>`;
    }
    return `<button class="askopt" data-answer="${id}" data-index="${esc(o.index)}" data-fp="${fp}">${n}${text}</button>`;
  }).join("");

  // No "waiting for you" label here: the card header and the session page's
  // status pill both already say it, and three words for one fact is how a
  // dense card stops being scannable.
  return `<div class="ask" data-ask="${fp}">
    ${prompt.header ? `<div class="askhead"><span class="askeyebrow">${esc(prompt.header)}</span></div>` : ""}
    <div class="askq">${esc(prompt.question)}</div>
    <div class="askopts">${options}</div>
  </div>`;
}

function section(title, items, extra = "") {
  if (items.length === 0) return "";
  return `<section><h2>${esc(title)} · ${items.length}</h2>
    <div class="grid">${items.map(card).join("")}</div>${extra}</section>`;
}

/**
 * The "show more" control under the ended list.
 *
 * Rendered only while there is more to show, and it says HOW MUCH more —
 * "showing 12 of 115" is the difference between a button you know what to do
 * with and one you press to find out.
 */
function moreButton(shown, total) {
  if (shown >= total) return "";
  return `<div class="more">
    <button data-more="1">show more</button>
    <span class="morecount">showing ${shown} of ${total}</span>
  </div>`;
}


export { esc, ago, repoShort, STATUS_LABEL, describe, splitPrs, prBlock, attachNote, askPanel, steer, card, section, moreButton };

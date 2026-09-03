/**
 * The conversation, as HTML. No DOM, no fetch, no globals — session.js owns
 * all of that, and this stays testable in node.
 *
 * The session page used to be a mirrored tmux terminal. It is a chat now
 * because the transcript was always the real thing and the terminal was one
 * rendering of it — a rendering built for a keyboard, which is a poor fit for a
 * phone over Tailscale and an awkward one in a browser tab.
 */

/** Escape before interpolating: every string here is arbitrary user, model, or
 *  tool output and goes into innerHTML. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function clock(at) {
  if (!at) return "";
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Light markdown, and deliberately not a full renderer.
 *
 * These turns are written IN markdown — headings, bold, fences, backticks — so
 * leaving it raw puts literal `**` and `##` through the middle of every
 * paragraph, which is what the first version did and it read as broken. But a
 * real markdown library is a dependency plus an injection surface for output
 * nobody controls, so this handles the four things that actually appear and
 * leaves the rest as text.
 *
 * Escaping happens FIRST and everything below only ever inserts fixed tags, so
 * no input can introduce markup of its own.
 */
/**
 * Turn URLs into links.
 *
 * Runs BEFORE code and emphasis so a URL's own punctuation cannot be eaten as
 * markup, and skips anything already inside a tag this function built.
 *
 * Only http and https: a `javascript:` or `data:` URL in model or tool output
 * would be a script someone else wrote running on this page. Trailing
 * punctuation is left out of the href — "see https://x/y." should not link to
 * a path ending in a full stop — and a markdown [label](url) keeps its label.
 */
/**
 * Markdown links and bare URLs, in ONE pass.
 *
 * Two passes is the obvious way to write this and it is wrong: the second pass
 * matches the URL inside the anchor the first pass just built, so a markdown
 * link came out as `href="<a href="…`, and clicking it navigated to
 * `/%3Ca%20href=`. One alternation cannot re-enter its own output.
 *
 * The character class also excludes `*` and a backtick. A URL at the end of a
 * bold run — "…updated: https://x/y**" — otherwise swallows the closing
 * markers, and the bold pass that follows then rewrites INSIDE the href, giving
 * `href="https://x/y</strong>"`. Emphasis markers are punctuation around a URL,
 * never part of one.
 */
const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\bhttps?:\/\/[^\s<>"')\]*`]+/g;

const anchor = (href, text) =>
  `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;

function autolink(t) {
  return t.replace(LINK_RE, (whole, label, href) => {
    // A markdown link: the label is what to show.
    if (label !== undefined) return anchor(href, label);
    // A bare URL. Trailing punctuation belongs to the sentence, not the
    // address — "see https://x/y." must not link to a path ending in a stop.
    const trimmed = whole.replace(/[.,;:!?]+$/, "");
    return anchor(trimmed, trimmed) + whole.slice(trimmed.length);
  });
}

function inline(t) {
  return autolink(t)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    // Bold BEFORE italic, or `**x**` is eaten as two empty italics.
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

/** A markdown pipe table — these turns use them constantly for comparisons,
 *  and rendered as raw pipes they are unreadable. */
function table(lines) {
  const cells = (row) => row.replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
  // Row 2 is the `|---|---|` separator; it carries no content.
  const head = cells(lines[0]);
  const body = lines.slice(2).map(cells);
  return `<table class="md"><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>`
    + `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

const TABLE_SEP = /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/;

function isTable(lines) {
  return lines.length >= 2 && lines[0].includes("|") && TABLE_SEP.test(lines[1]) && lines[1].includes("-");
}

function block(part) {
  return part
    .split(/\n{2,}/)
    .map((para) => {
      const t = para.trim();
      if (!t) return "";
      const lines = t.split("\n");
      if (isTable(lines)) return table(lines);
      const h = /^(#{1,4})\s+(.*)$/.exec(t);
      // Headings are how these turns signal structure, and a run of them is
      // the difference between a wall of text and something skimmable.
      if (h) return `<h${h[1].length + 2} class="mdh">${inline(h[2])}</h${h[1].length + 2}>`;
      return `<p>${inline(t).replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

/**
 * A fenced block, as a titled figure.
 *
 * The fence's info string is the only label there is — ```python, or
 * ```path/to/file.ts — so it becomes the header rather than being stripped and
 * thrown away, which is what happened before.
 */
function codeFigure(part) {
  const nl = part.indexOf("\n");
  const info = (nl === -1 ? "" : part.slice(0, nl)).trim();
  const body = nl === -1 ? part : part.slice(nl + 1);
  // A path is a name; a bare word is a language. Both are worth showing, on
  // opposite ends of the header, and neither is worth inventing when absent.
  const isPath = /[/.]/.test(info);
  const head = info
    ? `<figcaption><span class="codename">${isPath ? info : ""}</span><span class="codelang">${isPath ? "" : info}</span></figcaption>`
    : "";
  return `<figure class="code">${head}<pre>${body.replace(/\n$/, "")}</pre></figure>`;
}

function formatText(text) {
  // Odd-numbered parts are inside a fence. An unclosed fence therefore renders
  // its remainder as code, which is right: that is what it is.
  return esc(text)
    .split(/```/)
    .map((part, i) => (i % 2 === 1 ? codeFigure(part) : block(part)))
    .join("");
}

/**
 * One tool call, folded.
 *
 * Folded by default because a session makes hundreds of these and the output is
 * usually only interesting when something went wrong — which is why a failed
 * one is marked, and why the summary line carries the command rather than just
 * the tool's name.
 */
function toolItem(t) {
  const state = t.pending ? "running" : t.error ? "failed" : "done";
  return `<div class="toolrow ${state}" title="${esc(t.result || (t.pending ? "running" : "no output"))}">
    <span class="toolname">${esc(t.name)}</span>
    <span class="toolsum">${esc(t.summary)}</span>
    <span class="tooldot"></span>
  </div>`;
}

function item(it) {
  if (it.kind === "tool") return toolItem(it);
  if (it.kind === "note") {
    // One quiet line. These carry real information — "MERGED: calder_tasks#633"
    // arrives this way — but they are events, not conversation, so they read as
    // marginalia rather than as somebody speaking.
    return `<div class="note" title="${esc(it.full ?? it.label)}">
      <span class="notelabel">${esc(it.label)}</span>${it.detail ? `<span class="notedetail">${esc(it.detail)}</span>` : ""}${
        clock(it.at) ? `<span class="when">${clock(it.at)}</span>` : ""
      }</div>`;
  }
  if (it.kind === "thinking") {
    // Folded: it is genuinely useful when following a decision and pure noise
    // when skimming what happened.
    return `<details class="msg thinking"><summary>thought${clock(it.at) ? ` · ${clock(it.at)}` : ""}</summary>${formatText(it.text)}</details>`;
  }
  // No speaker label here: it belongs to the turn, which draws it once.
  //
  // `sending` is a message this page has handed to the terminal but has not yet
  // seen come back in the transcript. Claude Code takes about two seconds to
  // write the row, and without an echo your own message appears to vanish for
  // that long.
  const state = it.sending ? (it.stalled ? " unconfirmed" : " sending") : "";
  return `<div class="msg ${esc(it.kind)}${state}">${formatText(it.text)}${
    it.stalled ? `<span class="sendnote">not confirmed — check the terminal</span>` : ""
  }</div>`;
}

/**
 * Group consecutive items by who produced them.
 *
 * A single Claude turn is many items — text, a tool, more text, another tool —
 * and labelling each one repeated "CLAUDE 20:52" eight times down the page.
 * The label belongs to the TURN, so one header per turn is both less furniture
 * and a truer description of what happened.
 *
 * Tools and thinking belong to Claude's turn, not to a group of their own.
 */
function groups(items) {
  const out = [];
  for (const it of items) {
    // A note is not anybody's turn — it is the harness talking — so it never
    // gets a speaker label, and it does not break a turn in two either.
    const who = it.kind === "note" ? "note" : it.kind === "user" ? "you" : "claude";
    const last = out[out.length - 1];
    if (last && last.who === who) last.items.push(it);
    else out.push({ who, at: it.at, items: [it] });
  }
  return out;
}

/**
 * Consecutive tool calls, as one folded log rather than a stack of cards.
 *
 * A turn routinely makes six or eight in a row. Eight separate disclosure
 * widgets is eight pieces of furniture around content that is, most of the
 * time, evidence you do not need to read — so they become one, labelled with
 * what happened, and opened by default only when something failed.
 */
function toolGroup(tools) {
  const failed = tools.filter((t) => t.error);
  const running = tools.some((t) => t.pending);

  // One call is its own summary. Wrapping a single row in a disclosure widget
  // costs a line of furniture to hide a line of content.
  if (tools.length === 1 && !failed.length) {
    return `<div class="toolrows lone">${toolItem(tools[0])}</div>`;
  }

  // Name what the calls WERE, not just how many. A turn is usually one kind of
  // work, and "58 Bash" says more about it than "60 tool calls" does.
  const counts = new Map();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const named = kinds.length === 1
    ? `${tools.length} ${kinds[0][0]}`
    : `${tools.length} tool calls · ${kinds.slice(0, 2).map(([n, c]) => `${c} ${n}`).join(", ")}`;
  const label = named + (failed.length ? ` · ${failed.length} failed` : running ? " · running" : "");

  // ALWAYS folded. Opening on failure was the first rule and it was wrong at
  // scale: one bad call in a run of sixty opened all sixty, and the tools then
  // took more vertical space than the writing they were evidence for.
  //
  // The failures surface on their own instead — you see what broke without
  // being handed the whole log to find it in.
  const surfaced = failed.length
    ? `<div class="toolrows surfaced">${failed.map(toolItem).join("")}</div>`
    : "";

  return `<details class="toolgroup${failed.length ? " hasfailed" : ""}">
    <summary><span class="chev"></span>${esc(label)}</summary>
    <div class="toolrows">${tools.map(toolItem).join("")}</div>
  </details>${surfaced}`;
}

/**
 * Fold ALL of a turn's tool calls into one group, at the position of the first.
 *
 * Folding only CONSECUTIVE runs was the first attempt, and it barely helped:
 * a turn typically alternates a sentence, a tool, a sentence, a tool, so eight
 * calls became six separate widgets and the tools still dominated the page.
 *
 * The trade is small and worth naming: text that came between two calls now
 * reads after them. Tools are evidence for what the turn SAYS, so keeping the
 * prose contiguous is the better half of that bargain.
 */
function foldTools(items) {
  const tools = items.filter((it) => it.kind === "tool");
  if (tools.length === 0) return items;
  const out = [];
  let placed = false;
  for (const it of items) {
    if (it.kind !== "tool") { out.push(it); continue; }
    if (!placed) { out.push({ tools }); placed = true; }
  }
  return out;
}

/**
 * One turn, as one top-level element.
 *
 * Exactly one element per group matters: the page renders incrementally, and
 * the caller redraws the LAST group each poll because a turn in flight keeps
 * growing. That is only tractable if a group is one thing to remove.
 */
function groupHtml(g) {
  if (g.who === "note") return `<div class="notes">${g.items.map(item).join("")}</div>`;
  return `<section class="turn ${g.who === "you" ? "mine" : "theirs"}">
    <div class="who"><span class="speaker">${g.who}</span>${clock(g.at) ? `<span class="when">${clock(g.at)}</span>` : ""}</div>
    <div class="body">${foldTools(g.items).map((x) => (x.tools ? toolGroup(x.tools) : item(x))).join("")}</div>
  </section>`;
}

/** The whole conversation. */
function conversation(items) {
  if (!items.length) return `<p class="empty">Nothing in this conversation yet.</p>`;
  return groups(items).map(groupHtml).join("");
}

/** "in 1h 48m" — how long until a quota window refills. */
function until(epochSeconds, now = Date.now()) {
  if (!epochSeconds) return "";
  const mins = Math.round((epochSeconds * 1000 - now) / 60000);
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m` : `${Math.round(h / 24)}d ${h % 24}h`;
}

/** A tiny bar. Percentages are hard to feel; a filled length is not. */
function meter(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  // Warn only where it changes what you would do: a window nearly spent means
  // finish the thought rather than start something.
  const level = p >= 90 ? "hot" : p >= 70 ? "warm" : "";
  return `<span class="meter ${level}"><span style="width:${p}%"></span></span>`;
}

/**
 * The status bar: what this session is spending, and how it will behave.
 *
 * These four exist in the terminal's own footer, and losing them was a real
 * cost of leaving the terminal behind — knowing a quota window is nearly spent
 * or that a session will act without asking changes what you do next.
 */
function statusBar(s, now = Date.now()) {
  if (!s) return "";
  const stat = (label, pct, resets) => pct == null ? "" : `<span class="stat">
      <span class="statlabel">${esc(label)}</span>${meter(pct)}<span class="statpct">${Math.round(pct)}%</span>${
        resets ? `<span class="statreset">${esc(until(resets, now))}</span>` : ""
      }</span>`;
  const mode = s.permissionMode
    ? `<button class="modeswitch" data-mode="${esc(s.sessionId)}" title="Cycle this session's permission mode — the same shift+tab the terminal binds.">${esc(s.permissionMode)} mode</button>`
    : "";
  return [
    stat("context", s.contextPct, null),
    stat("5h", s.fiveHourPct, s.fiveHourResetsAt),
    stat("week", s.sevenDayPct, s.sevenDayResetsAt),
    s.model ? `<span class="stat muted">${esc(s.model)}</span>` : "",
    mode,
  ].filter(Boolean).join("");
}

/**
 * What the composer says about itself.
 *
 * An ended session has no process to receive anything, and a session outside
 * tmux has no pane to paste into — in both cases the box is disabled and says
 * why, rather than being a control that silently fails.
 */
function composerState(s) {
  if (!s) return { enabled: false, note: "loading…", placeholder: "loading…" };
  if (!s.live) {
    return { enabled: false, note: "This session has ended. Resume it from the board to continue.", placeholder: "ended — resume it from the board to continue" };
  }
  if (s.attach !== "tmux") {
    return { enabled: false, note: "This session runs outside tmux, so board cannot type into it.", placeholder: "runs outside tmux — board cannot type into it" };
  }
  const busy = s.status === "busy" || s.status === "working";
  return {
    enabled: true,
    note: "",
    placeholder: busy ? "queue a message…" : "say something…",
    busy,
  };
}

export { esc, clock, until, meter, statusBar, autolink, codeFigure, foldTools, toolGroup, groupHtml, formatText, toolItem, item, groups, conversation, composerState };

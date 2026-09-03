/**
 * The conversation itself, read out of the transcript Claude Code writes.
 *
 * This is what lets the session page show the work as a chat rather than as a
 * mirrored terminal. Nothing here parses screen output: the transcript rows are
 * already typed and structured, and the terminal was only ever a rendering of
 * them.
 *
 * Transcripts reach tens of megabytes, so nothing reads a whole one. The
 * first load takes a tail; every poll after that reads forward from a byte
 * offset the client hands back, so a long-lived page costs a few KB per poll no
 * matter how big the file has grown.
 *
 * Ported unchanged from the reference implementation's server/src/messages.ts —
 * it operates on a transcript file path only, and carries no dependency on
 * any particular session model.
 */
import * as fs from "fs";

/** Enough for a screenful of conversation without reading a 49 MB file. */
export const TAIL_BYTES = 512 * 1024;

/** Tool output can be a whole file; the UI folds it, so it does not need it
 *  all, and shipping megabytes of it per poll would defeat the tail read. */
export const MAX_RESULT = 4_000;
/** Long assistant turns are shown in full — this only guards against a
 *  pathological single block. */
export const MAX_TEXT = 40_000;
/** A note is marginalia. A task summary can run to a paragraph — a stopped
 *  background shell reports one — and a paragraph is not a label. */
export const NOTE_LABEL = 160;

/**
 * The harness wrappers that arrive as "user" turns but are not things a person
 * said: background-task notifications, slash-command plumbing, and the
 * reminders injected for the model's benefit.
 *
 * Rendered raw they are the worst content on the page — angle brackets and ids
 * in the middle of a conversation — and dropped entirely they take real
 * information with them ("MERGED: proj_tasks#633"). So they become notes.
 */
const NOTE_TAGS = [
  "task-notification",
  "command-name",
  "local-command-caveat",
  "local-command-stdout",
  "system-reminder",
] as const;

const tag = (text: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1].trim() : null;
};

/**
 * Classify a harness block, or return null if this is ordinary text.
 *
 * Requires the block to OPEN with a known wrapper, so a message that merely
 * quotes one of these tags is still a message.
 */
export function harnessNote(text: string): { label: string; detail: string } | null {
  const t = text.trim();
  const which = NOTE_TAGS.find((n) => t.startsWith(`<${n}>`));
  if (!which) return null;

  if (which === "task-notification") {
    // The summary says what it was; the event or status says what happened.
    //
    // A summary is usually a short title ("CI verdict on 6354"), but it is not
    // always: a stopped background shell reports a whole paragraph. So it is
    // capped here rather than assumed short — the UI puts the full text in a
    // tooltip.
    const summary = tag(t, "summary") ?? "background task";
    const detail = tag(t, "event") ?? tag(t, "status") ?? "";
    return { label: summary, detail };
  }
  if (which === "command-name") {
    const name = tag(t, "command-name") ?? "command";
    const args = tag(t, "command-args") ?? "";
    return { label: name, detail: args };
  }
  if (which === "local-command-stdout") {
    return { label: "command output", detail: tag(t, "local-command-stdout") ?? "" };
  }
  // A caveat or a reminder is addressed to the model, not to anyone reading
  // this, and carries nothing a person needs.
  return { label: "", detail: "" };
}

export type Item =
  | { kind: "user"; text: string; at: number | null }
  | { kind: "assistant"; text: string; at: number | null }
  | { kind: "thinking"; text: string; at: number | null }
  | { kind: "note"; label: string; detail: string; full: string; at: number | null }
  | {
      kind: "tool";
      name: string;
      /** A one-line "what did it do" — the command, the path, the pattern. */
      summary: string;
      result: string;
      error: boolean;
      /** Still running: a tool_use whose tool_result has not been written. */
      pending: boolean;
      at: number | null;
    };

export interface Page {
  items: Item[];
  /** Byte offset to read from next. Hand it back to poll for what is new. */
  cursor: number;
  /** Where this window BEGINS. Hand it back as `before` to read further into
   *  the past — a 7 MB transcript is mostly older than any one window. */
  start: number;
  /** Nothing older exists; the UI stops offering to load more. */
  atStart: boolean;
}

/**
 * Remove terminal colour codes.
 *
 * Command output and slash-command echoes carry SGR sequences, and a browser
 * has no idea what to do with them — one arrived as a literal "[2mCompacted
 * (ctrl+o to see full summary)[22m" in the middle of a note. The page has its
 * own styling; the terminal's is noise here.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

function clip(s: string, max: number): string {
  const t = stripAnsi(s);
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t;
}

/** Whatever a tool_result carries, as text. Sometimes a string, sometimes
 *  content blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * The one line worth showing next to a tool's name when it is folded.
 *
 * Keyed on the input field that actually says what happened, per tool, because
 * "Bash" alone tells you nothing and the whole input is too much.
 */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const s = first("command", "file_path", "path", "pattern", "query", "url", "prompt", "description");
  return s.split("\n")[0].slice(0, 200);
}

/**
 * Turn transcript lines into a flat list of things to render.
 *
 * Flat on purpose: a message can hold text, thinking and several tool calls,
 * and the UI wants them in the order they happened rather than nested inside a
 * message object it then has to take apart again.
 */
/** A text block becomes a note, a turn, or nothing at all. */
function pushText(items: Item[], type: "user" | "assistant", text: string, at: number | null): void {
  if (!text.trim()) return;
  const note = harnessNote(text);
  if (!note) {
    items.push({ kind: type, text: clip(text, MAX_TEXT), at });
    return;
  }
  // A wrapper with nothing worth showing is dropped rather than rendered as an
  // empty note.
  if (note.label || note.detail) {
    items.push({
      kind: "note",
      label: clip(note.label, NOTE_LABEL),
      detail: clip(note.detail, 600),
      // The whole thing, for the tooltip, since the label above is a summary
      // of a summary.
      full: stripAnsi(`${note.label}${note.detail ? ` — ${note.detail}` : ""}`).slice(0, 1200),
      at,
    });
  }
}

export function parseItems(chunk: string): Item[] {
  const items: Item[] = [];
  /** tool_use id -> the item waiting for its result. */
  const waiting = new Map<string, Extract<Item, { kind: "tool" }>>();

  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try {
      row = JSON.parse(line);
    } catch {
      // A truncated first or last line is expected when reading a window of a
      // file that is still being written.
      continue;
    }
    // Subagent turns are a conversation of their own and would interleave
    // confusingly with this one.
    if (row.isSidechain) continue;
    const type = row.type;
    if (type !== "user" && type !== "assistant") continue;

    const at = row.timestamp ? Date.parse(row.timestamp) || null : null;
    const content = row.message?.content;

    if (typeof content === "string") {
      pushText(items, type, content, at);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && String(b.text ?? "").trim()) {
        pushText(items, type, String(b.text), at);
      } else if (b.type === "thinking" && String(b.thinking ?? "").trim()) {
        items.push({ kind: "thinking", text: clip(String(b.thinking), MAX_TEXT), at });
      } else if (b.type === "tool_use") {
        const item: Extract<Item, { kind: "tool" }> = {
          kind: "tool",
          name: String(b.name ?? "tool"),
          summary: toolSummary(String(b.name ?? ""), (b.input ?? {}) as Record<string, unknown>),
          result: "",
          error: false,
          pending: true,
          at,
        };
        if (b.id) waiting.set(String(b.id), item);
        items.push(item);
      } else if (b.type === "tool_result") {
        // Attach to the call it answers. A result whose call is off the top of
        // the window has nothing to attach to and is dropped rather than
        // rendered as an orphan.
        const item = waiting.get(String(b.tool_use_id));
        if (!item) continue;
        item.result = clip(resultText(b.content), MAX_RESULT);
        item.error = b.is_error === true;
        item.pending = false;
        waiting.delete(String(b.tool_use_id));
      }
    }
  }
  return items;
}

/**
 * Read a window of a transcript.
 *
 * `after` is a byte offset from a previous call. Omit it for the first load and
 * the last {@link TAIL_BYTES} are read instead, with the first (probably
 * partial) line dropped.
 */
export function readPage(file: string, after?: number): Page {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    // An ended session whose transcript has been deleted is empty, not broken.
    return { items: [], cursor: 0, start: 0, atStart: true };
  }

  // A transcript that shrank was rewritten under us, so an old offset now means
  // something else; start over rather than read from the middle of a row.
  // A negative offset would become a negative read position and throw; an
  // offset past the end belongs to a transcript that has since been rewritten.
  // Neither is trustworthy, so both fall back to reading the tail.
  const resume = after !== undefined && after >= 0 && after <= size;
  const from = resume ? after! : Math.max(0, size - TAIL_BYTES);
  if (from >= size) return { items: [], cursor: size, start: from, atStart: from === 0 };

  const fd = fs.openSync(file, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
  } finally {
    fs.closeSync(fd);
  }

  // Everything below counts BYTES, not characters: the cursor is a file offset,
  // and a transcript full of box-drawing and emoji has plenty of multi-byte
  // characters to make those disagree.
  let start = 0;
  if (!resume && from > 0) {
    // A tail read lands mid-row; drop that partial first line.
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { items: [], cursor: size, start: size, atStart: false };
    start = nl + 1;
  }
  // Stop at the last complete line, so a row still being written is read whole
  // on the next poll instead of half now and half later.
  const end = buf.lastIndexOf(0x0a);
  if (end < start) return { items: [], cursor: from + start, start: from + start, atStart: from + start === 0 };

  return {
    items: parseItems(buf.subarray(start, end + 1).toString("utf8")),
    cursor: from + end + 1,
    start: from + start,
    atStart: from + start === 0,
  };
}

/**
 * Read the window of conversation immediately BEFORE an offset.
 *
 * This is what "load earlier" runs on. Without it the page can only ever show
 * the last {@link TAIL_BYTES}, which on a 7 MB transcript is the last few
 * percent of the work — the session's history is there on disk and simply
 * unreachable.
 */
export function readBefore(file: string, before: number): Page {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { items: [], cursor: 0, start: 0, atStart: true };
  }
  const end = Math.min(Math.max(0, before), size);
  if (end === 0) return { items: [], cursor: 0, start: 0, atStart: true };
  const from = Math.max(0, end - TAIL_BYTES);

  const fd = fs.openSync(file, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(end - from);
    fs.readSync(fd, buf, 0, buf.length, from);
  } finally {
    fs.closeSync(fd);
  }

  // Unless this window reaches the start of the file, it opens mid-row; drop
  // that partial line so the next window ends exactly where this one begins.
  let begin = 0;
  if (from > 0) {
    const nl = buf.indexOf(0x0a);
    if (nl < 0) return { items: [], cursor: end, start: from, atStart: false };
    begin = nl + 1;
  }
  return {
    items: parseItems(buf.subarray(begin).toString("utf8")),
    cursor: end,
    start: from + begin,
    atStart: from + begin === 0,
  };
}

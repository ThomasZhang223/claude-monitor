/**
 * Wrapping a session before killing it.
 *
 * Killing a session throws away everything it learned. `/wrap` is what turns that
 * into a wiki note, and doing it by hand means attaching, typing, waiting, and
 * only then coming back to the dashboard — which is exactly the sequence that
 * gets skipped when there are eight sessions to clear. So the dashboard can do
 * it: send `/wrap`, watch until the session goes quiet, then kill.
 *
 * The load-bearing rule is that a timeout NEVER kills. Killing a session
 * mid-wrap destroys the very note the wrap exists to produce, so a wrap that
 * stalls leaves the session alive and says so. The session is still there to
 * attach to; nothing is lost but the automation.
 */
import type { PaneRecord, PendingWrap, Status } from "./model.ts";
import { sendSlashCommand, type SendDeps } from "./send.ts";

export { CLEAR_GAP_MS, SUBMIT_GAP_MS, RESEND_GAP_MS } from "./send.ts";

/** What gets typed into the pane. */
export const WRAP_COMMAND = "/wrap";

/**
 * Idleness inside this window after submitting is ignored.
 *
 * Claude is idle in the instant before it starts a turn as well as after
 * finishing one, and the status files are polled, not pushed. Without a floor the
 * first tick after sending would read "idle" and kill the session before the
 * wrap had written a word.
 */
export const WRAP_SETTLE_MS = 15_000;

/** How long a wrap may run before the dashboard stops waiting on it. Generous:
 *  a wrap reads a session's whole transcript and writes notes. */
export const WRAP_TIMEOUT_MS = 15 * 60_000;

/**
 * An outstanding wrap the dashboard is waiting on.
 *
 * The `PendingWrap` half is what rides the tmux session in `@cc_wrap`; the two
 * fields added here are addressing and display, both re-derivable from the
 * record, so neither is persisted. `next` is what lets a work session's plan
 * pane finish writing its note before the implement pane's wrap folds
 * review-round changes into it.
 */
export interface WrapJob extends PendingWrap {
  tmuxName: string;
  /** For the message shown while waiting. */
  label: string;
}

/** Field separator for the encoded option. */
const FIELD_SEP = ":";
/** Stands in for a null `next`. Not the empty string: `a::b` is easy to
 *  produce by accident and hard to see. */
const NO_NEXT = "-";

/**
 * The `@cc_wrap` value for a job: `pane:next:sentAt`.
 *
 * Not JSON. The value is interpolated through a tmux `-F` format string on
 * every poll, so a shape with no braces, quotes or `#` in it is one less thing
 * that can be eaten in transit.
 */
export function encodeWrap(wrap: PendingWrap): string {
  return [wrap.pane, wrap.next ?? NO_NEXT, wrap.sentAt].join(FIELD_SEP);
}

/**
 * Parse a `@cc_wrap` value, or null if it is not one.
 *
 * Runs on the poll path against a value anyone can set by hand, so every
 * malformed shape has to come back as null rather than throw — a bad option
 * must cost that session's kill, not the whole dashboard.
 */
export function decodeWrap(value: string | null | undefined): PendingWrap | null {
  if (!value) return null;
  const fields = value.split(FIELD_SEP);
  if (fields.length !== 3) return null;

  const pane = Number(fields[0]);
  const sentAt = Number(fields[2]);
  if (!Number.isInteger(pane) || pane < 0) return null;
  if (!Number.isFinite(sentAt) || sentAt <= 0) return null;

  let next: number | null = null;
  if (fields[1] !== NO_NEXT) {
    next = Number(fields[1]);
    if (!Number.isInteger(next) || next < 0) return null;
  }

  return { pane, next, sentAt };
}

export type WrapStep =
  | { kind: "wait" }
  | { kind: "kill" }
  | { kind: "giveup"; reason: string };

/**
 * Whether a wrap has finished, is still going, or has to be abandoned.
 *
 * Called once per tick per outstanding wrap, with the session's current status.
 * Callers drop the job first if the session no longer exists at all.
 */
export function decideWrap(job: WrapJob, status: Status, now: number): WrapStep {
  const elapsed = now - job.sentAt;

  if (status === "error") {
    return { kind: "giveup", reason: `${job.label}: wrap hit an error, session left alive` };
  }
  // Nothing to wait for: the process is gone, so the wrap either finished or
  // never started, and either way the tmux session is now an empty shell.
  if (status === "dead") return { kind: "kill" };
  if (elapsed < WRAP_SETTLE_MS) return { kind: "wait" };
  // Quiet is checked BEFORE the timeout, not after. What the timeout protects
  // against is killing a wrap that is still going; a pane that has stopped is
  // not that, so a wrap which overran the deadline but did finish still gets
  // its kill instead of being abandoned a second before the payoff.
  if (status === "idle" || status === "awaiting") return { kind: "kill" };
  if (elapsed > WRAP_TIMEOUT_MS) {
    // Deliberately not a kill. See the module comment.
    return {
      kind: "giveup",
      reason: `${job.label}: wrap still running after ${Math.round(WRAP_TIMEOUT_MS / 60_000)}m, session left alive`,
    };
  }
  // working, or blocked on a permission prompt the user can answer.
  return { kind: "wait" };
}

/**
 * The order panes wrap in: plan before implement.
 *
 * A work session has two, and wrapping both at once would have two Claudes
 * writing into the same wiki inbox simultaneously — a known way to lose one of
 * the two notes. So they wrap one at a time, plan first, so its note exists
 * before the implement pane's wrap folds in whatever fixes and review rounds
 * came after planning. A pane with no Claude in it is skipped — there is
 * nothing there to wrap.
 */
export function wrapOrder(panes: readonly PaneRecord[]): number[] {
  return panes
    .filter((p) => p.claude !== null)
    .map((p) => p.paneIndex)
    .sort((a, b) => a - b);
}

/** Structurally identical to `SendDeps` - kept as its own name because it is
 *  the one every caller of `sendWrap` already imports. */
export type SendWrapDeps = SendDeps;

/**
 * Type `/wrap` into a pane and submit it. Returns an error string, or null.
 *
 * A thin formatter over `sendSlashCommand`: the choreography (clear, gap,
 * type, gap, verify, submit, resend) and the reasons a send can fail now live
 * in send.ts, generic over the command. This keeps `sendWrap`'s exact
 * existing message strings, which the tests assert on by regex - always
 * clearing first (`clear: true`) is what makes every failure here reachable
 * only through the two-attempt retry path.
 */
export async function sendWrap(
  tmuxName: string,
  pane: number,
  deps: SendWrapDeps = {},
): Promise<string | null> {
  const target = `${tmuxName}.${pane}`;
  const fail = await sendSlashCommand(tmuxName, pane, WRAP_COMMAND, { clear: true, deps });
  if (!fail) return null;

  switch (fail.kind) {
    case "unreachable":
      return `could not send ${WRAP_COMMAND} to ${target}`;
    case "unsubmitted":
      return `sent ${WRAP_COMMAND} to ${target} but could not submit it`;
    case "mangled":
      return (
        `${target}: composer still reads ${JSON.stringify(fail.staged)} after clearing ` +
        `twice - ${WRAP_COMMAND} not submitted, session left alive`
      );
  }
}

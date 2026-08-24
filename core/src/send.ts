/**
 * Typing a command into a pane's composer, submitting it, and checking that
 * what actually landed is what was meant.
 *
 * Lifted out of wrap.ts, which used to be the only caller: the choreography
 * itself (clear, gap, type, gap, verify, submit, resend) has nothing to do
 * with `/wrap` specifically, and Remote Control's handoff needs the same
 * verify-before-submit safety with a different command and a different clear
 * policy. The three gap constants below were measured over 19 live trials
 * (see their own comments) and move here unchanged - they are not retuned.
 */
import { capturePane, clearDraft, composerText, sendEnter, sendText } from "./tmux.ts";
import { type Exec } from "./exec.ts";

/**
 * Gap between clearing the composer and typing into it. The whole reason a
 * wrap once arrived as `sho/wrap`.
 *
 * Measured rather than reasoned about, because the obvious explanation (that
 * `send-keys Escape Escape` batches two presses into one key event) is wrong:
 * batched, it clears a real draft 3 times out of 3. The variable that decides
 * it is this gap alone. With no gap the escapes and the text land in the same
 * read and the clear is simply lost - 5 of 5 trials produced `sho/wrap`,
 * whether the escapes were sent batched or as two separate presses. With any
 * gap at all it clears - 14 of 14 across 50ms, 100ms and 200ms, again either
 * way. So 200ms is the smallest tested value with real margin, and splitting
 * the escapes buys nothing.
 */
export const CLEAR_GAP_MS = 200;

/** Gap between the text and the Enter. Claude's input needs the line to land
 *  before submit; sending both together is what delivers half a command. */
export const SUBMIT_GAP_MS = 400;

/** Gap before a second, defensive Enter. If the first arrived before Claude's
 *  UI had finished processing the typed text and got dropped, this is what
 *  submits it instead - a stray Enter on an already-submitted, empty composer
 *  is a no-op (confirmed live, including mid-turn), so resending costs nothing
 *  when the first one landed fine. */
export const RESEND_GAP_MS = 300;

/** Rows of pane tail to read when checking what is staged. The composer sits
 *  just above the status line, so this only has to clear that chrome. */
const COMPOSER_TAIL_ROWS = 20;

export interface SendDeps {
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Why a command did not get submitted. Structured, not prose, so each caller
 * owns its own wording: "session left alive" is a fact about wrap-then-kill,
 * not about typing into a composer.
 */
export type SendFailure =
  | { kind: "unreachable" }
  | { kind: "mangled"; staged: string }
  | { kind: "unsubmitted" };

/**
 * Optionally clear the composer, then type `command` into it and report what
 * is actually staged on the line: null when it reads exactly `command`, the
 * offending text when it does not, and null when the pane cannot be read at
 * all (see sendSlashCommand - not being able to look is not evidence of a
 * problem).
 */
async function stageCommand(
  target: string,
  command: string,
  clear: boolean,
  deps: SendDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<{ sent: boolean; mangled: string | null }> {
  if (clear) {
    await clearDraft(target, deps.exec);
    await sleep(CLEAR_GAP_MS);
  }
  if (!(await sendText(target, command, deps.exec))) return { sent: false, mangled: null };
  await sleep(SUBMIT_GAP_MS);
  const staged = composerText((await capturePane(target, COMPOSER_TAIL_ROWS, deps.exec)) ?? "");
  return { sent: true, mangled: staged !== null && staged !== command ? staged : null };
}

/**
 * Type `command` into a pane and submit it. Returns a structured failure, or
 * null on success.
 *
 * `opts.clear` decides whether the composer is cleared first, whatever is
 * sitting in it, before typing. That is the right thing on an idle/awaiting/
 * permission pane - a stale draft left over from earlier would otherwise get
 * the command glued onto the end of it, and once the command isn't the first
 * character on the line it stops being a slash command at all. It is the
 * WRONG thing on a working pane: the first Escape interrupts the turn, while
 * merely typing queues and runs when the turn ends - so a caller sending into
 * a busy pane passes `clear: false` and accepts that a stale draft will be
 * caught by the verify step below instead of prevented up front.
 *
 * Either way, this looks before submitting, because a clear has silently
 * failed before and submitting prose is worse than not submitting: the line
 * has to read exactly `command` or the Enter is never sent. That check fails
 * OPEN - only a line that was read AND differs blocks the submit; an
 * unreadable pane or an unrecognised composer (a release that moves the
 * prompt glyph) submits anyway. Inverting that would let one cosmetic UI
 * change quietly disable every caller of this at once.
 *
 * When `clear` is true and the first attempt comes back mangled, one retry is
 * made (the cheap explanation is a draft that outlived its clear, and
 * clearing again costs a second) before giving up and leaving the pane
 * cleared. When `clear` is false, there is nothing to retry - the draft that
 * mangled the line is still sitting there, and resending the text without
 * clearing would reproduce the same mangled line - so a mangled result on a
 * no-clear send fails immediately, with the pane left exactly as found.
 */
export async function sendSlashCommand(
  tmuxName: string,
  pane: number,
  command: string,
  opts: { clear?: boolean; deps?: SendDeps } = {},
): Promise<SendFailure | null> {
  const target = `${tmuxName}.${pane}`;
  const deps = opts.deps ?? {};
  const clear = opts.clear ?? false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let staged = await stageCommand(target, command, clear, deps, sleep);
  if (!staged.sent) return { kind: "unreachable" };

  if (staged.mangled !== null) {
    if (!clear) return { kind: "mangled", staged: staged.mangled };

    staged = await stageCommand(target, command, clear, deps, sleep);
    if (!staged.sent) return { kind: "unreachable" };
    if (staged.mangled !== null) {
      // Leave the pane as we would like to have found it, not holding our mess.
      await clearDraft(target, deps.exec);
      return { kind: "mangled", staged: staged.mangled };
    }
  }

  if (!(await sendEnter(target, deps.exec))) return { kind: "unsubmitted" };
  await sleep(RESEND_GAP_MS);
  await sendEnter(target, deps.exec);
  return null;
}

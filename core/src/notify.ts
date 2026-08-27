/**
 * Desktop notifications on session/pane status transitions.
 *
 * A work session runs two independent Claude processes (plan pane 0, implement
 * pane 1); `SessionRecord.status` is already a worst-of aggregate across them
 * (see `collect.ts`'s `worstStatus`), which is correct for the dashboard row
 * but wrong here — a notification needs to know WHICH pane changed, so the
 * summary is that pane's own words rather than the other pane's stale recap.
 * So state, edge-detection and content are all tracked per pane.
 */
import { fileURLToPath } from "url";
import * as path from "path";
import { execAsync, shellQuote, type Exec } from "./exec.ts";
import {
  IMPL_PANE,
  PLAN_PANE,
  STATUS_STYLES,
  type PaneRecord,
  type SessionRecord,
  type Status,
} from "./model.ts";

/** The four statuses worth a desktop notification. Deliberately not the same
 *  list as `NEEDS_USER` in model.ts, which excludes `dead` for a different
 *  reason (header counts / preview branch) - a pane dying unexpectedly is
 *  still worth knowing about. */
export const NOTIFY_STATUSES = ["awaiting", "permission", "error", "dead"] as const;
export type NotifyStatus = (typeof NOTIFY_STATUSES)[number];

export function isNotifyStatus(status: Status): status is NotifyStatus {
  return (NOTIFY_STATUSES as readonly Status[]).includes(status);
}

/** How long a transitioned-into status must persist before it's treated as
 *  real, so a flicker between turns doesn't fire a false alert. Modeled on
 *  the wrap-before-kill settle window (`WRAP_SETTLE_MS`, 15s) but shorter: a
 *  notification is non-destructive, unlike a kill, so there is less to lose
 *  from occasionally firing a beat early. */
export const NOTIFY_SETTLE_MS = 5_000;

const TITLES: Record<NotifyStatus, string> = {
  awaiting: "Awaiting Input",
  permission: "Needs Permission",
  error: "Error",
  dead: "Process Ended",
};

/** libnotify urgency per status. `critical` is reserved for the two that stall
 *  work outright — on GNOME it is the only level that stays on screen until
 *  dismissed, so spending it on `awaiting` would leave a wall of banners. */
const URGENCIES: Record<NotifyStatus, "low" | "normal" | "critical"> = {
  awaiting: "normal",
  permission: "critical",
  error: "critical",
  dead: "normal",
};

const SOUNDS: Record<NotifyStatus, string> = {
  awaiting: "Glass",
  permission: "Ping",
  error: "Basso",
  dead: "Funk",
};

// ---------------------------------------------------------------------------
// Edge detection
// ---------------------------------------------------------------------------

export interface PaneNotifyState {
  status: Status;
  /** When this status was first observed for this pane. */
  since: number;
  /** Whether a notification has already fired for this streak. */
  notified: boolean;
}

export type NotifyStateMap = Map<string, PaneNotifyState>;

export interface NotifyDecision {
  record: SessionRecord;
  pane: PaneRecord;
}

export interface PlanNotificationsResult {
  nextState: NotifyStateMap;
  fire: NotifyDecision[];
}

export function paneNotifyKey(tmuxName: string, windowIndex: number, paneIndex: number): string {
  return `${tmuxName}:${windowIndex}.${paneIndex}`;
}

/**
 * One tick of edge detection, over every pane of every current session.
 *
 * Pure and DI-free on purpose - state in, state out, no clock or IO of its
 * own - so it is testable against fixture records the same way the rest of
 * `core/` is. Rebuilds the map from scratch each call: a pane belonging to a
 * session that no longer exists is simply not carried forward, which is all
 * the cleanup a killed session needs.
 */
export function planNotifications(
  prev: NotifyStateMap,
  records: readonly SessionRecord[],
  now: number,
): PlanNotificationsResult {
  const nextState: NotifyStateMap = new Map();
  const fire: NotifyDecision[] = [];

  for (const record of records) {
    for (const pane of record.panes) {
      const key = paneNotifyKey(record.tmuxName, pane.windowIndex, pane.paneIndex);
      const prior = prev.get(key);
      const status = pane.status;

      if (!prior || prior.status !== status) {
        // A transition (or the first tick this pane has been seen): reset the
        // settle clock, and never fire on the same tick a transition is seen.
        nextState.set(key, { status, since: now, notified: false });
        continue;
      }

      const settled = now - prior.since >= NOTIFY_SETTLE_MS;
      const shouldFire = !prior.notified && settled && isNotifyStatus(status);
      nextState.set(key, { status, since: prior.since, notified: prior.notified || shouldFire });
      if (shouldFire) fire.push({ record, pane });
    }
  }

  return { nextState, fire };
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface NotificationContent {
  title: string;
  subtitle: string;
  message: string;
  sound: string;
  /** libnotify urgency. macOS has no equivalent, so `terminal-notifier`
   *  ignores it and expresses the same distinction through `sound`. */
  urgency: "low" | "normal" | "critical";
  /** terminal-notifier group id. Notifications sharing a group replace one
   *  another, so this is per PANE, never per session: grouping by session would
   *  make a work session's two panes silently overwrite each other, which is
   *  the exact bug this whole module is written around. */
  group: string;
}

/** `plan`/`implement` for a work session's first two panes, `panel N` for
 *  every pane past that (a work session that outgrew two panes, or any other
 *  class that has grown more than one) — disambiguating them in the subtitle
 *  since they notify independently. Null for a single-pane session, where
 *  there is nothing to disambiguate. */
export function paneLabelFor(record: SessionRecord, paneIndex: number): string | null {
  if (record.panes.length <= 1) return null;
  if (record.mode === "work" && paneIndex === PLAN_PANE) return "plan";
  if (record.mode === "work" && paneIndex === IMPL_PANE) return "implement";
  return `panel ${paneIndex + 1}`;
}

/** A pane's own one-line account of itself: its auto-recap if it has one,
 *  else the reason it doesn't. Exported because monitor-serve's state
 *  projection wants the exact same text a desktop notification would show,
 *  not a second, differently-worded read of the same underlying field. */
export function paneSummary(pane: PaneRecord): string {
  if (!pane.claude) return "no summary available";
  // Already resolved on the collect tick, cached against the transcript's
  // mtime. Re-reading it here would be a second 256 KB read of a file the
  // record in hand was just built from.
  return pane.auto?.text ?? "nothing published yet";
}

/** Null when the pane's status isn't one of the four notify-worthy ones -
 *  callers loop over `planNotifications`'s `fire` list, which already only
 *  contains notify-worthy transitions, so this should not normally happen,
 *  but the check keeps the function honest on its own. */
export function buildNotificationContent(
  record: SessionRecord,
  pane: PaneRecord,
): NotificationContent | null {
  if (!isNotifyStatus(pane.status)) return null;
  const label = paneLabelFor(record, pane.paneIndex);
  // The pane goes in the TITLE, not only the subtitle. Four statuses across two
  // panes produced banners that differed by one word in the smaller, greyer
  // line, so a plan and an implement notification read as the same alert - the
  // reason implement notifications registered as "not firing" even when they
  // had fired.
  const title = label ? `${TITLES[pane.status]} — ${label}` : TITLES[pane.status];
  const worktreeLine = record.worktree ?? "No worktree — this box has no folder behind it";
  return {
    title,
    subtitle: record.tmuxName,
    message: `${worktreeLine}\n${paneSummary(pane)}`,
    sound: SOUNDS[pane.status],
    urgency: URGENCIES[pane.status],
    group: paneNotifyKey(record.tmuxName, pane.windowIndex, pane.paneIndex),
  };
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

// bin/monitor-attach is two directories up from this file (core/src/notify.ts
// -> core/src -> core -> repo root), resolved from the module's own location
// rather than assumed, so this keeps working regardless of where the repo is
// checked out.
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const ATTACH_BIN = path.join(REPO_ROOT, "bin", "monitor-attach");

/**
 * The notifier this machine has, or `none`.
 *
 * One per platform, and not interchangeable: `terminal-notifier` is a macOS
 * binary, `notify-send` speaks the freedesktop D-Bus spec. Both are optional —
 * a missing one warns once and no-ops, the same fail-open spirit as the shell
 * hooks in `hooks/`, since an optional dependency should never break the
 * dashboard around it.
 */
export type NotifierKind = "terminal-notifier" | "notify-send" | "none";

export async function detectNotifier(
  exec: Exec = execAsync,
  platform: string = process.platform,
): Promise<NotifierKind> {
  const bin: NotifierKind = platform === "darwin" ? "terminal-notifier" : "notify-send";
  const found = await exec(`command -v ${bin}`, 2000);
  return found.ok && found.stdout.trim() ? bin : "none";
}

/**
 * The `terminal-notifier` command line.
 *
 * Clicking the notification body attaches. There are deliberately no Attach /
 * Dismiss BUTTONS: `-actions` is not a terminal-notifier flag at all (it
 * belongs to `alerter`, and to some terminal-notifier forks), and 2.0.0
 * silently ignores unknown flags - so passing it produced a command that
 * looked right, tested green against the composed string, and rendered no
 * buttons whatsoever. `-execute` is the real supported mechanism, and one
 * click on the banner is the same gesture the buttons were there to provide.
 */
export function terminalNotifierCommand(
  content: NotificationContent,
  attachCmd: string,
): string {
  return [
    "terminal-notifier",
    "-title",
    shellQuote(content.title),
    "-subtitle",
    shellQuote(content.subtitle),
    "-message",
    shellQuote(content.message),
    "-sound",
    shellQuote(content.sound),
    "-group",
    shellQuote(content.group),
    "-execute",
    shellQuote(attachCmd),
  ].join(" ");
}

/**
 * The `notify-send` command line.
 *
 * Three things differ from the macOS shape, all forced by libnotify:
 *
 *  - **No subtitle.** The spec has a summary and a body, nothing between, so
 *    the session name leads the body instead of sitting in its own line.
 *  - **Grouping is a hint, not a flag.** `x-canonical-private-synchronous`
 *    makes a later notification replace an earlier one carrying the same key,
 *    which is what `-group` buys on macOS. Servers that do not implement it
 *    ignore it and simply stack — degraded, not broken.
 *  - **`-A` implies `--wait`**, so notify-send BLOCKS until the notification is
 *    clicked or dismissed, printing the chosen action. That is what makes
 *    click-to-attach possible at all here, and it is also why the whole thing
 *    is wrapped in `setsid ... &`: waiting inline would stall the collect tick
 *    for as long as a banner sits unread.
 */
export function notifySendCommand(
  content: NotificationContent,
  attachCmd: string,
): string {
  const body = `${content.subtitle}\n${content.message}`;
  const send = [
    "notify-send",
    "-a",
    "claude-monitor",
    "-u",
    content.urgency,
    "-h",
    shellQuote(`string:x-canonical-private-synchronous:${content.group}`),
    "-A",
    "attach=Attach",
    shellQuote(content.title),
    shellQuote(body),
  ].join(" ");
  // `exec` on the tail so the detached shell becomes the attach rather than
  // lingering as a second process per notification.
  const script = `if [ "$(${send})" = attach ]; then exec ${attachCmd}; fi`;
  return `setsid sh -c ${shellQuote(script)} </dev/null >/dev/null 2>&1 &`;
}

/** Builds this pane's notification content and shells out to whichever
 *  notifier this platform has. No-ops (with a console warning) when neither is
 *  installed. */
export async function fireNotification(
  record: SessionRecord,
  pane: PaneRecord,
  exec: Exec = execAsync,
  platform: string = process.platform,
): Promise<void> {
  const content = buildNotificationContent(record, pane);
  if (!content) return;

  const notifier = await detectNotifier(exec, platform);
  if (notifier === "none") {
    console.error(
      platform === "darwin"
        ? "terminal-notifier not found on PATH - desktop notifications are disabled " +
            "(install with `brew install terminal-notifier`)"
        : "notify-send not found on PATH - desktop notifications are disabled " +
            "(install libnotify-bin)",
    );
    return;
  }

  // tmuxName is a sanitised identifier by construction (see naming.ts), not
  // free-form text, so it needs no quoting of its own - only the combined
  // inner command needs one layer of quoting, for whichever flag carries it.
  const attachCmd = `${ATTACH_BIN} ${record.tmuxName}`;
  const cmd =
    notifier === "terminal-notifier"
      ? terminalNotifierCommand(content, attachCmd)
      : notifySendCommand(content, attachCmd);

  await exec(cmd, 5000);
}

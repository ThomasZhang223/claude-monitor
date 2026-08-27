/**
 * Where the cursor is: a box, and a row inside that box.
 *
 * The obvious alternative — one index into a flattened list of every session —
 * was the first implementation and it was wrong in a way that only shows up
 * with real data. Moving between boxes had to find a session in the next box to
 * move to, so an empty box was unreachable: left/right silently skipped it, and
 * because "which box does `n` create in" was derived from the focused session,
 * an empty box could never be created in either. With sessions in two boxes the
 * cursor appeared to bounce between exactly those two.
 *
 * Making the box the primary coordinate fixes both: every box is always
 * reachable, whether or not anything is running in it, and the box the cursor is
 * on is a fact about the cursor rather than a fact about the sessions.
 */
import { GROUP_ORDER, groupOf, type BoxId, type DisplayGroup, type SessionRecord } from "./model.ts";

export interface Focus {
  box: BoxId;
  /** Index into `boxRows(records, box)`. Meaningless when that list is empty,
   *  which is why every read goes through clampFocus or focusedRecord. */
  row: number;
}

/** Where the cursor starts: the first configured box, in config order. */
export function initialFocus(boxIds: readonly string[]): Focus {
  return { box: boxIds[0], row: 0 };
}

/**
 * A box's sessions in the order they are drawn: one group per display group, in
 * GROUP_ORDER. Up/down has to walk the rows in the order the eye sees them, so
 * both the renderer and the cursor read that one constant rather than each
 * deriving its own order — which is what kept this correct when two more classes
 * were added.
 */
export function boxRows(records: readonly SessionRecord[], box: BoxId): SessionRecord[] {
  const inBox = records.filter((r) => r.box === box);
  return GROUP_ORDER.flatMap((g) =>
    inBox.filter((r) => groupOf(r.mode, r.panes.length) === g));
}

/** The groups a box actually draws a heading for, in order. Shared with the
 *  renderer and with the height allocator, so all three agree on how many rows
 *  the box wants. */
export function boxGroups(records: readonly SessionRecord[], box: BoxId): DisplayGroup[] {
  const inBox = records.filter((r) => r.box === box);
  return GROUP_ORDER.filter((g) =>
    inBox.some((r) => groupOf(r.mode, r.panes.length) === g));
}

/** The session under the cursor, or null when its box is empty. */
export function focusedRecord(
  records: readonly SessionRecord[],
  focus: Focus,
): SessionRecord | null {
  const rows = boxRows(records, focus.box);
  if (rows.length === 0) return null;
  return rows[Math.min(Math.max(0, focus.row), rows.length - 1)];
}

/** Pull the row back inside the box's range, so a session dying underneath the
 *  cursor cannot leave it pointing past the end. */
export function clampFocus(focus: Focus, records: readonly SessionRecord[]): Focus {
  const count = boxRows(records, focus.box).length;
  const row = count === 0 ? 0 : Math.min(Math.max(0, focus.row), count - 1);
  return row === focus.row ? focus : { box: focus.box, row };
}

/**
 * Step to the next or previous box, wrapping, unconditionally.
 *
 * Never skips an empty box: an empty box is exactly where you are about to
 * create something, so it is the one you most need to be able to select.
 *
 * `boxIds` is config.boxes' ids, in config order — the same order the layout
 * draws them in, so left/right always agrees with what the eye sees. When the
 * focused box is not in `boxIds` at all (it was just deleted in the setup
 * panel), lands on the first configured box rather than throwing.
 */
export function moveBox(focus: Focus, dir: 1 | -1, boxIds: readonly string[]): Focus {
  if (boxIds.length === 0) return focus;
  const i = boxIds.indexOf(focus.box);
  if (i === -1) return { box: boxIds[0], row: 0 };
  const next = boxIds[(i + dir + boxIds.length) % boxIds.length];
  return { box: next, row: 0 };
}

/** Step within the current box, clamped rather than wrapped — wrapping from the
 *  last row to the first reads as a jump when the box is a visible list. */
export function moveRow(focus: Focus, dir: 1 | -1, rowCount: number): Focus {
  if (rowCount <= 0) return { box: focus.box, row: 0 };
  const row = Math.min(rowCount - 1, Math.max(0, focus.row + dir));
  return { box: focus.box, row };
}

/** Where a named session sits, so the cursor can land on a session that was
 *  just created. Null when it is not in the records yet. */
export function focusFor(records: readonly SessionRecord[], tmuxName: string): Focus | null {
  const record = records.find((r) => r.tmuxName === tmuxName);
  if (!record) return null;
  const row = boxRows(records, record.box).findIndex((r) => r.tmuxName === tmuxName);
  return row < 0 ? null : { box: record.box, row };
}

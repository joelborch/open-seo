/**
 * Slot arithmetic for scheduled crawls, shared by the scheduler, the upsert
 * server function, and the UI copy that names the next run.
 *
 * Both cadences sit on a fixed UTC grid — quick daily at `quickHourUtc`, deep
 * weekly on `deepDowUtc` at `deepHourUtc` — so a slot is fully determined by
 * the config. The previous slot is still used as the anchor (same shape as
 * `computeNextCheckAt`): stepping whole intervals from it keeps a schedule on
 * its original grid across ticks, an anchor that is still in the future is
 * already the next slot and comes back unchanged, and an anchor that no longer
 * matches the config (the user moved the hour or weekday) falls back to the next
 * slot measured from now.
 */

export type AuditCadence = "quick" | "deep";

/** Only reason the scheduler records on a schedule row today. */
export type AuditScheduleSkipReason = "already_running";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Next daily slot at `quickHourUtc`. `previousNextQuickAt` is the anchor; it is
 * ignored unless it already sits on this hour, so an hour change takes effect
 * immediately instead of dragging the old slot forward forever.
 */
export function computeNextQuickAt(
  quickHourUtc: number,
  previousNextQuickAt?: string | null,
): string {
  const now = Date.now();
  const anchor = onGridAnchor(previousNextQuickAt, quickHourUtc, null);
  if (anchor !== null) {
    return new Date(
      anchor + stepsFromAnchor(anchor, now, DAY_MS) * DAY_MS,
    ).toISOString();
  }
  return nextSlotFromNow(now, quickHourUtc, null);
}

/** Next weekly slot on `deepDowUtc` (0 = Sunday) at `deepHourUtc`. */
export function computeNextDeepAt(
  deepDowUtc: number,
  deepHourUtc: number,
  previousNextDeepAt?: string | null,
): string {
  const now = Date.now();
  const anchor = onGridAnchor(previousNextDeepAt, deepHourUtc, deepDowUtc);
  if (anchor !== null) {
    return new Date(
      anchor + stepsFromAnchor(anchor, now, WEEK_MS) * WEEK_MS,
    ).toISOString();
  }
  return nextSlotFromNow(now, deepHourUtc, deepDowUtc);
}

/**
 * Whole intervals to advance an on-grid anchor by. An anchor still in the future
 * is already the next slot, so it stays put — stepping it would push the run a
 * full day (or week) further out every time the schedule is saved. A due or
 * missed anchor advances to the first slot after now.
 */
function stepsFromAnchor(
  anchor: number,
  now: number,
  intervalMs: number,
): number {
  if (anchor > now) return 0;
  return Math.floor((now - anchor) / intervalMs) + 1;
}

/** The anchor's epoch ms, or null when it is absent, unparseable, or off-grid. */
function onGridAnchor(
  previous: string | null | undefined,
  hourUtc: number,
  dowUtc: number | null,
): number | null {
  if (!previous) return null;
  const parsed = new Date(previous);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return null;
  if (parsed.getUTCHours() !== hourUtc) return null;
  if (parsed.getUTCMinutes() !== 0 || parsed.getUTCSeconds() !== 0) return null;
  if (dowUtc !== null && parsed.getUTCDay() !== dowUtc) return null;
  return ms;
}

function nextSlotFromNow(
  now: number,
  hourUtc: number,
  dowUtc: number | null,
): string {
  const slot = new Date(now);
  slot.setUTCHours(hourUtc, 0, 0, 0);
  if (dowUtc === null) {
    if (slot.getTime() <= now) slot.setUTCDate(slot.getUTCDate() + 1);
    return slot.toISOString();
  }
  let daysAhead = (dowUtc - slot.getUTCDay() + 7) % 7;
  if (daysAhead === 0 && slot.getTime() <= now) daysAhead = 7;
  slot.setUTCDate(slot.getUTCDate() + daysAhead);
  return slot.toISOString();
}

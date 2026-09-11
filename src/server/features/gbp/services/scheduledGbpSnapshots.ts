/**
 * Cron body for scheduled Google Business Profile snapshots. Wrapped in
 * `withPgClient` at the entrypoint (src/server/lib/cron-loops.ts), same as the
 * rank-check, crawl and grid loops.
 *
 * Two phases, cheapest first: drain the reviews tasks earlier captures queued
 * (collection is free at DataForSEO), then capture the locations whose cadence is
 * due. Draining first means a tick that runs out of budget still finishes the work
 * already paid for.
 */
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { GbpRepository } from "@/server/features/gbp/repositories/GbpRepository";
import {
  captureGbpSnapshot,
  collectSnapshotReviews,
} from "@/server/features/gbp/services/GbpService";
import { computeNextCheckAt } from "@/shared/rank-tracking";

/**
 * Locations captured per tick. Each is two provider requests (one live profile
 * read, one queued reviews post), so 50 locations is ~100 requests — an order of
 * magnitude under the grid loop's cell budget it shares the tick with, which is
 * right for a weekly cadence that only ever has a handful of locations due.
 */
const SCHEDULED_LOCATION_BUDGET = 50;

/** Queued reviews tasks collected per tick. Free, so this only bounds wall time. */
const REVIEW_DRAIN_BUDGET = 50;

/**
 * How long a posted reviews task stays worth collecting. DataForSEO purges a
 * completed task's result after a few days, so past this the collection attempt
 * spends a subrequest and recovers nothing.
 */
const REVIEW_RETENTION_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Wall-clock guard: sub-hourly crons are killed at 15 minutes and this loop shares
 * the tick with the crawl, rank-check, grid and projection loops. Stopping early is
 * safe — unclaimed schedules are still due next tick.
 */
const TICK_DEADLINE_MS = 90_000;

/** The scheduler acts as itself, not as any member of the org. */
function systemBillingCustomer(input: {
  organizationId: string;
  projectId: string;
}): BillingCustomerContext {
  return {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId: input.organizationId,
    projectId: input.projectId,
  };
}

/**
 * Collect the reviews tasks still owed. Failures are counted, not thrown: the task
 * stays uncollected and the next tick tries again, and one dead task id must not
 * stop the phase.
 */
async function drainPendingReviews(deadline: number) {
  const pending = await GbpRepository.getSnapshotsAwaitingReviews({
    since: new Date(Date.now() - REVIEW_RETENTION_WINDOW_MS).toISOString(),
    limit: REVIEW_DRAIN_BUDGET,
  });
  let collected = 0;
  let stillQueued = 0;
  let errors = 0;

  for (const snapshot of pending) {
    if (Date.now() >= deadline) break;
    try {
      const done = await collectSnapshotReviews({
        snapshotId: snapshot.id,
        providerTaskId: snapshot.providerTaskId,
      });
      if (done) collected++;
      else stillQueued++;
    } catch (err) {
      errors++;
      console.error(
        `[cron] Failed to collect GBP reviews for snapshot ${snapshot.id}:`,
        err,
      );
    }
  }
  return { candidates: pending.length, collected, stillQueued, errors };
}

export async function runScheduledGbpSnapshots() {
  const deadline = Date.now() + TICK_DEADLINE_MS;
  const reviews = await drainPendingReviews(deadline);

  const nowIso = new Date().toISOString();
  const due = await GbpRepository.getDueSchedules(nowIso);

  let captured = 0;
  let stoppedByBudget = false;
  let stoppedByDeadline = false;
  let skippedAlreadyCaptured = 0;
  let concurrentChangeSkips = 0;
  let captureErrors = 0;
  let scheduleErrors = 0;

  for (const schedule of due) {
    if (captured >= SCHEDULED_LOCATION_BUDGET) {
      stoppedByBudget = true;
      break;
    }
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    // Per-schedule containment: one bad row (a malformed cursor sorts first and
    // would head every scan) must not starve the tick or suppress the summary.
    try {
      // Unreachable — the due query excludes manual schedules and NULL cursors.
      // Narrow rather than assert so a query change can't produce a capture with
      // no schedule anchor.
      if (
        schedule.scheduleInterval === "manual" ||
        schedule.nextRunAt === null
      ) {
        continue;
      }

      const observedNextRunAt = schedule.nextRunAt;
      const nextRunAt = computeNextCheckAt(
        schedule.scheduleInterval,
        observedNextRunAt,
      );
      // Claim the slot before spending, and clear any stale skip badge.
      const claimed = await GbpRepository.claimDueSchedule({
        scheduleId: schedule.id,
        observedNextRunAt,
        nextRunAt,
        lastSkipReason: null,
        lastRunAt: nowIso,
      });
      if (!claimed) {
        concurrentChangeSkips++;
        continue;
      }

      let result;
      try {
        result = await captureGbpSnapshot({
          locationId: schedule.locationId,
          projectId: schedule.projectId,
          billingCustomer: systemBillingCustomer(schedule),
        });
      } catch (err) {
        // Leave the cursor advanced: a systemic provider outage must not make
        // every schedule due again on the next tick.
        captureErrors++;
        await GbpRepository.claimDueSchedule({
          scheduleId: schedule.id,
          observedNextRunAt: nextRunAt,
          nextRunAt,
          lastSkipReason: "capture_failed",
        });
        console.error(
          `[cron] Failed to capture GBP snapshot for location ${schedule.locationId} (project ${schedule.projectId}):`,
          err,
        );
        continue;
      }

      if (result.created) {
        captured++;
      } else {
        // Someone captured this location by hand earlier today, so the cadence's
        // reading already exists and nothing was bought.
        skippedAlreadyCaptured++;
        await GbpRepository.claimDueSchedule({
          scheduleId: schedule.id,
          observedNextRunAt: nextRunAt,
          nextRunAt,
          lastSkipReason: "already_captured",
        });
      }
    } catch (err) {
      scheduleErrors++;
      console.error(
        `[cron] Error processing GBP schedule ${schedule.id} (project ${schedule.projectId}):`,
        err,
      );
    }
  }

  // Oldest by the due query's next_run_at ASC ordering. Object argument (not an
  // interpolated string) so Workers Logs indexes the fields; error level when
  // anything failed, so ticks needing attention surface in error-filtered views.
  const oldestDue = due[0]?.nextRunAt;
  const logSummary =
    captureErrors + scheduleErrors + reviews.errors > 0
      ? console.error
      : console.log;
  logSummary({
    event: "gbp_scheduler_summary",
    candidates: due.length,
    captured,
    budget: SCHEDULED_LOCATION_BUDGET,
    stoppedByBudget,
    stoppedByDeadline,
    skippedAlreadyCaptured,
    concurrentChangeSkips,
    captureErrors,
    scheduleErrors,
    reviewTasksPending: reviews.candidates,
    reviewTasksCollected: reviews.collected,
    reviewTasksStillQueued: reviews.stillQueued,
    reviewCollectErrors: reviews.errors,
    oldestDueAgeMs: oldestDue
      ? Date.now() - new Date(oldestDue).getTime()
      : null,
  });
}

/**
 * Cron body for scheduled grid runs: start a local-pack grid for every config
 * whose cadence is due. Wrapped in `withPgClient` at the entrypoint
 * (src/server.ts), same as the rank-check and crawl loops.
 */
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { startGridRun } from "@/server/features/maps-grid/services/MapsGridService";
import { computeNextCheckAt } from "@/shared/rank-tracking";

/**
 * Provider requests admitted per tick, in cells (keywords × grid points).
 * Admission control rather than a hard limit: the first start of a tick is
 * always admitted, so a config bigger than the whole budget can never starve,
 * and unadmitted configs stay due for the next tick's oldest-first scan.
 *
 * Sized well under DataForSEO's 2,000 requests/min account cap and against the
 * rank-check loop it shares the cron with: a tick's cells are posted in batches
 * of 100 and then polled once per ready-check, so 1,500 cells is roughly 15 posts
 * plus a few hundred collects spread over a 20-minute window.
 */
const SCHEDULED_CELL_BUDGET = 1_500;

/**
 * Wall-clock guard for the per-config loop: sub-hourly crons are killed at 15
 * minutes and this loop shares the tick with the rank-check and crawl loops.
 * Stopping early is safe — unclaimed configs are still due next tick.
 */
const TICK_DEADLINE_MS = 2 * 60_000;

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

export async function runScheduledGridRuns() {
  const nowIso = new Date().toISOString();
  const due = await MapsGridRepository.getDueConfigsWithOrganization(nowIso);

  const deadline = Date.now() + TICK_DEADLINE_MS;
  let cellsAdmitted = 0;
  let started = 0;
  let stoppedByBudget = false;
  let stoppedByDeadline = false;
  let skippedNoKeywords = 0;
  let skippedAlreadyRunning = 0;
  let concurrentChangeSkips = 0;
  let startErrors = 0;
  let configErrors = 0;

  for (const config of due) {
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    // Per-config containment: one bad row (a malformed cursor sorts first and
    // would head every scan) must not starve the tick or suppress the summary.
    try {
      // Unreachable — the due query excludes manual configs and NULL cursors.
      // Narrow rather than assert so a query change can't produce a run with no
      // schedule anchor.
      if (config.scheduleInterval === "manual" || config.nextRunAt === null) {
        continue;
      }

      const keywordCount = (
        await MapsGridRepository.getKeywordsForConfig(config.id)
      ).length;
      const cells = keywordCount * config.gridSize * config.gridSize;
      // Projected stop: admit only what fits. The first start of a tick is
      // exempt so an oversized config can never starve, and zero-cell configs
      // always advance.
      if (started > 0 && cellsAdmitted + cells > SCHEDULED_CELL_BUDGET) {
        stoppedByBudget = true;
        break;
      }

      const observedNextRunAt = config.nextRunAt;
      const nextRunAt = computeNextCheckAt(
        config.scheduleInterval,
        observedNextRunAt,
      );

      if (keywordCount === 0) {
        const claimed = await MapsGridRepository.claimDueConfig({
          configId: config.id,
          observedNextRunAt,
          nextRunAt,
          lastSkipReason: "no_keywords",
        });
        if (claimed) skippedNoKeywords++;
        else concurrentChangeSkips++;
        continue;
      }

      // Claim the slot before starting, and clear any stale skip badge — the run
      // only writes null on a successful finalize.
      const claimed = await MapsGridRepository.claimDueConfig({
        configId: config.id,
        observedNextRunAt,
        nextRunAt,
        lastSkipReason: null,
      });
      if (!claimed) {
        concurrentChangeSkips++;
        continue;
      }

      let result;
      try {
        result = await startGridRun({
          configId: config.id,
          projectId: config.projectId,
          billingCustomer: systemBillingCustomer(config),
          trigger: "scheduled",
        });
      } catch (err) {
        // Leave the cursor advanced: a systemic Workflows outage must not make
        // every config due again on the next tick.
        startErrors++;
        console.error(
          `[cron] Failed to start scheduled grid run for config ${config.id} (project ${config.projectId}):`,
          err,
        );
        continue;
      }

      if (result.dryRun || result.ok) {
        cellsAdmitted += cells;
        started++;
        continue;
      }

      // Nothing was started, so give the slot back and retry next tick once the
      // blocking run clears. A manual edit landing in between wins the CAS.
      skippedAlreadyRunning++;
      const restored = await MapsGridRepository.claimDueConfig({
        configId: config.id,
        observedNextRunAt: nextRunAt,
        nextRunAt: observedNextRunAt,
      });
      if (!restored) concurrentChangeSkips++;
    } catch (err) {
      configErrors++;
      console.error(
        `[cron] Error processing grid config ${config.id} (project ${config.projectId}):`,
        err,
      );
    }
  }

  // Oldest by the due query's next_run_at ASC ordering. Object argument (not an
  // interpolated string) so Workers Logs indexes the fields; error level when
  // anything failed, so ticks needing attention surface in error-filtered views.
  const oldestDue = due[0]?.nextRunAt;
  const logSummary =
    startErrors + configErrors > 0 ? console.error : console.log;
  logSummary({
    event: "maps_grid_scheduler_summary",
    candidates: due.length,
    started,
    cellsAdmitted,
    budget: SCHEDULED_CELL_BUDGET,
    stoppedByBudget,
    stoppedByDeadline,
    skippedNoKeywords,
    skippedAlreadyRunning,
    concurrentChangeSkips,
    startErrors,
    configErrors,
    oldestDueAgeMs: oldestDue
      ? Date.now() - new Date(oldestDue).getTime()
      : null,
  });
}

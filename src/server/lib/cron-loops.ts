/**
 * The cron tick's scheduled loops, in the order they run.
 *
 * Every loop is independent work on a shared budget, so each one is held and
 * rethrown rather than allowed to abort the tick: a failing loop must not skip
 * the loops after it (they would then not run again until the next tick) and must
 * not discard an error an earlier loop already captured. The first held error is
 * rethrown at the end in loop order so the invocation still reports as failed.
 *
 * Lives beside the loops instead of inside `src/server.ts` so the ordering and
 * the hold-and-rethrow contract are testable without the Worker entry's whole
 * request-handling graph.
 */
import { withPgClient } from "@/db";
import { reconcileStaleAudits } from "@/server/features/audit/services/auditReconciler";
import { runScheduledCrawls } from "@/server/features/audit-schedules/services/scheduledCrawls";
import { runPendingProjections } from "@/server/features/bigquery-projection/services/BigqueryProjectionService";
import { runScheduledGridRuns } from "@/server/features/maps-grid/services/scheduledGridRuns";
import { runScheduledRankChecks } from "@/server/features/rank-tracking/services/scheduledRankChecks";

export async function runCronLoops(env: Env): Promise<void> {
  // Watchdog first: reconcile audits stuck in "running" whose workflow died
  // without reaching mark-failed (OOM/CPU kills, expired instances). Runs before
  // the rank loop so a slow tick can't delay or starve it.
  let watchdogError: unknown;
  try {
    await withPgClient(() => reconcileStaleAudits());
  } catch (err) {
    watchdogError = err;
    console.error("[cron] Stale-audit reconcile failed:", err);
  }
  // Scheduled crawls next: they start Workflow instances and do no metered
  // provider work, so a slow rank tick shouldn't delay them.
  let crawlSchedulerError: unknown;
  try {
    await withPgClient(() => runScheduledCrawls());
  } catch (err) {
    crawlSchedulerError = err;
    console.error("[cron] Scheduled crawls failed:", err);
  }
  // Rank checks, each loop in its own per-request Postgres client (a no-op in D1
  // mode).
  let rankCheckError: unknown;
  try {
    await withPgClient(() => runScheduledRankChecks(env));
  } catch (err) {
    rankCheckError = err;
    console.error("[cron] Scheduled rank checks failed:", err);
  }
  // Scheduled local-pack grids: metered like the rank checks, so they run after
  // them and behind their own cell budget.
  let gridSchedulerError: unknown;
  try {
    await withPgClient(() => runScheduledGridRuns());
  } catch (err) {
    gridSchedulerError = err;
    console.error("[cron] Scheduled grid runs failed:", err);
  }
  // BigQuery projection last: it reads runs the loops above just completed, and
  // it spends nothing of ours, so it gets whatever is left of the tick.
  let projectionError: unknown;
  try {
    await withPgClient(() => runPendingProjections());
  } catch (err) {
    projectionError = err;
    console.error("[cron] BigQuery projection failed:", err);
  }
  if (watchdogError) throw watchdogError;
  if (crawlSchedulerError) throw crawlSchedulerError;
  if (rankCheckError) throw rankCheckError;
  if (gridSchedulerError) throw gridSchedulerError;
  if (projectionError) throw projectionError;
}

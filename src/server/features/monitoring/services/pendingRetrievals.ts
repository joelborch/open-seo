/**
 * Cron body that collects results a finished run paid for and never picked up.
 *
 * A rank check or grid run posts queued DataForSEO tasks and then polls for them
 * in its own workflow. When that workflow dies — or a bug drops the results on the
 * floor — the run lands in `completed`/`failed` with its ledger rows still in state
 * `submitted`: charged at the provider, absent from our database, and until now
 * recoverable only by a human pressing "Collect results".
 *
 * Both services this calls are retrieve-only by construction: they read the
 * provider task ids already in the ledger and never post a task or fall back to a
 * live endpoint, and `task_get` is free because the charge landed at `task_post`.
 * So this loop can only ever recover spend, never add to it.
 *
 * Lives in its own feature because it spans two: one shared backlog across the rank
 * and grid ledgers, one budget, one summary.
 */
import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { MapsGridService } from "@/server/features/maps-grid/services/MapsGridService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { retrieveRankCheckRun } from "@/server/features/rank-tracking/services/rankCheckRetrieval";

/**
 * How far back a run stays worth retrying. DataForSEO purges a completed task's
 * result after a few days, so past this the collection attempt spends subrequests
 * and recovers nothing — the run's spend stays a floor and the loop moves on.
 */
const RETENTION_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Runs retrieved per kind per tick. A rank run's retrieval is up to 400 `task_get`
 * calls and a grid run's is a few hundred, so ten of each is already the bulk of a
 * Worker invocation's subrequest budget; the rest stay in the backlog for the next
 * tick.
 */
const RUNS_PER_KIND_PER_TICK = 10;

/**
 * Wall-clock guard: sub-hourly crons are killed at 15 minutes and this loop shares
 * the tick with the schedulers around it. Stopping early is free — an uncollected
 * run is still in the backlog next tick.
 */
const TICK_DEADLINE_MS = 2 * 60_000;

type RetrievalTally = {
  candidates: number;
  retrieved: number;
  collected: number;
  stillPending: number;
  errors: number;
  stoppedByDeadline: boolean;
};

/**
 * Retrieve one kind's backlog. Per-run containment: a run whose config or location
 * was deleted throws NOT_FOUND, and that must not stop the runs behind it.
 */
async function drain<T extends { runId: string; projectId: string }>(
  runs: T[],
  deadline: number,
  retrieve: (run: T) => Promise<{ collected: number; stillPending: number }>,
  label: string,
): Promise<RetrievalTally> {
  const tally: RetrievalTally = {
    candidates: runs.length,
    retrieved: 0,
    collected: 0,
    stillPending: 0,
    errors: 0,
    stoppedByDeadline: false,
  };

  for (const run of runs) {
    if (Date.now() >= deadline) {
      tally.stoppedByDeadline = true;
      break;
    }
    try {
      const outcome = await retrieve(run);
      tally.retrieved++;
      tally.collected += outcome.collected;
      tally.stillPending += outcome.stillPending;
    } catch (err) {
      tally.errors++;
      console.error(
        `[cron] Failed to retrieve ${label} ${run.runId} (project ${run.projectId}):`,
        err,
      );
    }
  }
  return tally;
}

/**
 * Age of the oldest run either backlog is waiting on, which is the number that
 * says whether this loop is keeping up. Null when nothing is waiting.
 */
function oldestCandidateAgeMs(
  startedAt: Array<string | undefined>,
): number | null {
  const ages = startedAt
    .filter((stamp): stamp is string => stamp != null)
    .map((stamp) => Date.now() - new Date(stamp).getTime());
  return ages.length > 0 ? Math.max(...ages) : null;
}

export async function runPendingRetrievals(): Promise<void> {
  const since = new Date(Date.now() - RETENTION_WINDOW_MS).toISOString();
  const deadline = Date.now() + TICK_DEADLINE_MS;

  const [rankRuns, gridRuns] = await Promise.all([
    RankTrackingRepository.getRunsWithSubmittedTasks({
      since,
      limit: RUNS_PER_KIND_PER_TICK,
    }),
    MapsGridRepository.getRunsWithSubmittedCells({
      since,
      limit: RUNS_PER_KIND_PER_TICK,
    }),
  ]);

  const rank = await drain(
    rankRuns,
    deadline,
    (run) =>
      retrieveRankCheckRun({ runId: run.runId, projectId: run.projectId }),
    "rank check run",
  );
  const grid = await drain(
    gridRuns,
    deadline,
    async (run) => {
      const outcome = await MapsGridService.retrieveGridRun({
        runId: run.runId,
        projectId: run.projectId,
      });
      return {
        collected: outcome.collected,
        stillPending: outcome.outstanding,
      };
    },
    "grid run",
  );

  // Object argument (not an interpolated string) so Workers Logs indexes the
  // fields; error level when anything failed, so ticks needing attention surface
  // in error-filtered views.
  const logSummary =
    rank.errors + grid.errors > 0 ? console.error : console.log;
  logSummary({
    event: "pending_retrieval_summary",
    retentionWindowHours: RETENTION_WINDOW_MS / 3_600_000,
    budgetPerKind: RUNS_PER_KIND_PER_TICK,
    rankRunCandidates: rank.candidates,
    rankRunsRetrieved: rank.retrieved,
    rankSnapshotsCollected: rank.collected,
    rankTasksStillPending: rank.stillPending,
    rankRunErrors: rank.errors,
    gridRunCandidates: grid.candidates,
    gridRunsRetrieved: grid.retrieved,
    gridCellsCollected: grid.collected,
    gridCellsStillPending: grid.stillPending,
    gridRunErrors: grid.errors,
    stoppedByDeadline: rank.stoppedByDeadline || grid.stoppedByDeadline,
    oldestCandidateAgeMs: oldestCandidateAgeMs([
      rankRuns[0]?.startedAt,
      gridRuns[0]?.startedAt,
    ]),
  });
}

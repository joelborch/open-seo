import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { resolveBrandTerms } from "@/server/features/rank-tracking/services/brandTerms";
import {
  persistRankCheckResults,
  type RankCheckResultWithDevice,
} from "@/server/features/rank-tracking/services/rankSnapshotWriter";
import { fetchRankCheckTaskResult } from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";

/** Concurrent task_get requests. Matches the workflow's collect loop. */
const TASK_GET_CONCURRENCY = 25;

/**
 * Ceiling on task_get calls per retrieval. One request handler has a bounded
 * subrequest budget on Workers, so a large run is drained over several calls
 * and the response says how many are still outstanding.
 */
const MAX_TASK_GETS = 400;

interface RankCheckRetrievalResult {
  runId: string;
  /** Snapshots written from stored provider task ids. */
  collected: number;
  /** Tasks DataForSEO still hasn't finished, plus any left over the per-call
   *  ceiling — call again later. */
  stillPending: number;
  /** Tasks DataForSEO reported as failed. */
  failed: number;
  spentCostMicros: number;
  costStatus: "known" | "known_minimum";
}

/**
 * Collect a run's outstanding queued tasks from the provider task ids already
 * in the ledger, and write their snapshots.
 *
 * This buys nothing: it never posts new tasks and never falls back to the live
 * endpoint. task_get is free (the charge landed at task_post), so this is the
 * safe way to rescue results from a run whose workflow died mid-poll — the
 * alternative, re-running the check, pays for the same SERPs twice.
 */
export async function retrieveRankCheckRun(input: {
  runId: string;
  projectId: string;
}): Promise<RankCheckRetrievalResult> {
  const run = await RankTrackingRepository.getRunById(input.runId);
  if (!run || run.projectId !== input.projectId) {
    throw new AppError("NOT_FOUND", "Rank check run not found");
  }

  const outstanding = (
    await RankTrackingRepository.getSubmittedRankCheckTasks(input.runId)
  ).filter(
    (task): task is typeof task & { providerTaskId: string } =>
      task.providerTaskId !== null,
  );

  if (outstanding.length === 0) {
    return {
      runId: run.id,
      collected: 0,
      stillPending: 0,
      failed: 0,
      spentCostMicros: run.spentCostMicros ?? 0,
      costStatus: run.costStatus ?? "known",
    };
  }

  const config = await RankTrackingRepository.getConfigById({
    configId: run.configId,
    projectId: input.projectId,
  });
  if (!config) {
    throw new AppError("NOT_FOUND", "Rank tracking config not found");
  }

  // Snapshot rows carry the keyword text, which the ledger doesn't store.
  const keywordById = new Map(
    (await RankTrackingRepository.getKeywordsForConfig(run.configId)).map(
      (kw) => [kw.id, kw.keyword],
    ),
  );

  // One read pair for the whole retrieval, not one per task — the terms are a
  // property of the project, and only the AI Overview check reads them.
  const brandTerms = config.trackAiOverview
    ? await resolveBrandTerms({
        projectId: input.projectId,
        domain: config.domain,
      })
    : [];

  const batch = outstanding.slice(0, MAX_TASK_GETS);
  let stillPending = outstanding.length - batch.length;
  let failed = 0;
  const completed: RankCheckResultWithDevice[] = [];
  const ledgerUpdates: Parameters<
    typeof RankTrackingRepository.markRankCheckTasksCollected
  >[0] = [];

  for (let i = 0; i < batch.length; i += TASK_GET_CONCURRENCY) {
    const chunk = batch.slice(i, i + TASK_GET_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((task) => {
        const keyword = keywordById.get(task.trackingKeywordId);
        if (keyword === undefined) {
          // Keyword was removed from tracking after the task was posted; there
          // is nothing to write a snapshot against.
          return Promise.resolve(null);
        }
        return fetchRankCheckTaskResult({
          taskId: task.providerTaskId,
          keywordId: task.trackingKeywordId,
          keyword,
          targetDomain: config.domain,
          trackCompetitors: config.trackCompetitors,
          trackAiOverview: config.trackAiOverview,
          brandTerms,
        });
      }),
    );
    settled.forEach((result, index) => {
      const task = chunk[index];
      if (result.status === "rejected") {
        console.warn(
          `[rank-check] ${input.runId} retrieval task_get failed:`,
          result.reason,
        );
        stillPending++;
        return;
      }
      const outcome = result.value;
      if (outcome === null) return;
      if (outcome.status === "pending") {
        stillPending++;
        return;
      }
      if (outcome.status === "failed") {
        failed++;
        ledgerUpdates.push({
          providerTaskId: task.providerTaskId,
          status: "failed",
          providerStatusCode: outcome.providerStatusCode,
          providerStatusMessage: outcome.message,
        });
        return;
      }
      completed.push({ ...outcome.result, device: task.device });
      ledgerUpdates.push({
        providerTaskId: task.providerTaskId,
        status: outcome.isEmpty ? "terminal_empty" : "retrieved",
        providerStatusCode: outcome.providerStatusCode,
      });
    });
  }

  if (ledgerUpdates.length > 0) {
    await RankTrackingRepository.markRankCheckTasksCollected(ledgerUpdates);
  }

  let keywordsChecked = run.keywordsChecked;
  if (completed.length > 0) {
    keywordsChecked = await persistRankCheckResults(input.runId, completed);
  }

  // Re-read the ledger so the run's spend reflects the rows just settled.
  const ledger = await RankTrackingRepository.getRankCheckTaskCostSummary(
    input.runId,
  );
  // Never below what the run already recorded: finalize may have added
  // live-fallback spend that lives outside the ledger, and retrieval settles
  // rows whose charge was captured at submit time, so it can only hold or add.
  const spentCostMicros = Math.max(
    run.spentCostMicros ?? 0,
    ledger.actualCostMicros,
  );
  const costStatus: "known" | "known_minimum" =
    ledger.submissionUnknown > 0 || ledger.outstanding > 0
      ? "known_minimum"
      : "known";

  await RankTrackingRepository.updateRun(input.runId, {
    keywordsChecked,
    spentCostMicros,
    costStatus,
  });

  return {
    runId: run.id,
    collected: completed.length,
    stillPending,
    failed,
    spentCostMicros,
    costStatus,
  };
}

import type { WorkflowStep } from "cloudflare:workers";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  persistRankCheckResults,
  type RankCheckResultWithDevice,
} from "@/server/features/rank-tracking/services/rankSnapshotWriter";
import {
  fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST,
} from "@/server/lib/dataforseo";
import type {
  createDataforseoClient,
  PostedRankCheckTask,
  RankCheckTaskInput,
} from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import {
  costPerSerpAtDepth,
  KEYWORDS_PER_BATCH,
  usdToMicros,
} from "@/shared/rank-tracking";
import { pgStep } from "@/server/workflows/pgStep";

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

/** DataForSEO endpoint each ledger row accounts for. */
const TASK_POST_ENDPOINT = "/v3/serp/google/organic/task_post";

type KeywordEntry = { id: string; keyword: string };

interface CheckContext {
  client: ReturnType<typeof createDataforseoClient>;
  keywords: KeywordEntry[];
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  domain: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  /** Config opt-ins; both change what each request buys. */
  trackCompetitors: boolean;
  trackAiOverview: boolean;
  /** Brand strings an AI Overview's text is checked against, resolved once for
   *  the run in the prepare step. */
  brandTerms: string[];
  runId: string;
}

/** Expand keywords into one task input per keyword/device pair. */
function expandToTaskInputs(
  keywords: KeywordEntry[],
  devices: RankTrackingConfig["devices"],
): RankCheckTaskInput[] {
  const deviceList: Array<"desktop" | "mobile"> =
    devices === "both" ? ["desktop", "mobile"] : [devices];
  return keywords.flatMap((kw) =>
    deviceList.map((device) => ({
      keyword: kw.keyword,
      keywordId: kw.id,
      device,
    })),
  );
}

/** What one live or queued sub-batch cost and produced. */
interface BatchOutcome {
  /** Snapshots written. */
  written: number;
  /** Provider spend, in micro-dollars, as reported on each response. */
  costMicros: number;
}

/**
 * Per-run accounting the *caller* owns, in keyword/device task units.
 *
 * Both check paths fold each step's outcome into this object as it returns
 * rather than building a total to return at the end, so a step that throws
 * halfway cannot take the earlier numbers with it: the workflow still finalizes
 * with every micro-dollar the run has already spent. Queued task spend lives in
 * the rank_check_tasks ledger; only live-endpoint calls (the live path and the
 * queued path's fallback) are counted here.
 */
export interface RankCheckTally {
  /** Live-endpoint spend, in provider micro-dollars. */
  liveCostMicros: number;
  /** Tasks accepted into DataForSEO's queue. */
  queueTasks: number;
  /** Task results collected from the queue within the polling window. */
  queueCollected: number;
  /** Tasks routed to the live fallback (rejected, failed, or timed out). */
  fallbackTasks: number;
  /** Fallback tasks that produced a snapshot. */
  fallbackChecked: number;
}

export function createRankCheckTally(): RankCheckTally {
  return {
    liveCostMicros: 0,
    queueTasks: 0,
    queueCollected: 0,
    fallbackTasks: 0,
    fallbackChecked: 0,
  };
}

// ---------------------------------------------------------------------------
// Step bodies. Each runs inside a single step.do: inputs are its parameters,
// the return value is what the workflow engine persists and replays. They must
// not touch any mutable state outside their arguments.
// ---------------------------------------------------------------------------

/**
 * Check keyword/device pairs against the live endpoint and persist snapshots.
 * Per-call failures are logged and skipped (the metered client already charged
 * or refused each call individually).
 *
 * The live path writes no ledger rows: there is no queued task to reconcile,
 * and each call's charge is known the moment it returns — so the run-level
 * spend rollup is the whole accounting story here.
 */
async function checkBatchLive(
  ctx: CheckContext,
  tasks: RankCheckTaskInput[],
): Promise<BatchOutcome> {
  const settled = await Promise.allSettled(
    tasks.map((task) =>
      ctx.client.serp
        .rankCheck({
          keyword: task.keyword,
          keywordId: task.keywordId,
          locationCode: ctx.locationCode,
          languageCode: ctx.languageCode,
          locationName: ctx.locationName,
          device: task.device,
          targetDomain: ctx.domain,
          depth: ctx.serpDepth,
          trackCompetitors: ctx.trackCompetitors,
          trackAiOverview: ctx.trackAiOverview,
          brandTerms: ctx.brandTerms,
        })
        .then((r) => ({ ...r, device: task.device })),
    ),
  );
  const results: RankCheckResultWithDevice[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
      return;
    }
    const reason: unknown = outcome.reason;
    const code = reason instanceof AppError ? reason.code : "UNKNOWN";
    const message = reason instanceof Error ? reason.message : String(reason);
    // DataForSEO erring on its own side is a provider flake, not our bug: the
    // keyword just misses this run and finalize reports it to the user. Every
    // other rejection (no credits, bad API key) is ours and stays at error.
    const log = code === "UPSTREAM_UNAVAILABLE" ? console.warn : console.error;
    const task = tasks[index];
    log(
      `[rank-check] ${ctx.runId} live call failed (${code}) keyword="${task.keyword}" device=${task.device}: ${message}`,
    );
  });

  const costMicros = results.reduce(
    (total, result) => total + usdToMicros(result.providerCostUsd ?? 0),
    0,
  );
  if (results.length === 0) return { written: 0, costMicros };

  await persistRankCheckResults(ctx.runId, results);
  return { written: results.length, costMicros };
}

/**
 * Check keywords via Live API, parallel devices per keyword, real-time progress.
 * Snapshots are written incrementally after each batch so partial results
 * survive batch failures. ~6s per keyword batch.
 * Billing is handled per-call by the metered client; each batch's charge is
 * folded into `tally` as the step returns, so a batch that throws later still
 * leaves the run reporting what the earlier ones bought.
 */
export async function runLiveCheck(
  step: WorkflowStep,
  ctx: CheckContext,
  tally: RankCheckTally,
): Promise<void> {
  for (let i = 0; i < ctx.keywords.length; i += KEYWORDS_PER_BATCH) {
    const keywordBatch = ctx.keywords.slice(i, i + KEYWORDS_PER_BATCH);
    const batchTasks = expandToTaskInputs(keywordBatch, ctx.devices);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);
    const keywordsChecked = i + keywordBatch.length;

    const outcome = await pgStep(
      step,
      `live-batch-${batchIndex}`,
      SINGLE_ATTEMPT_STEP_CONFIG,
      async () => {
        const batchOutcome = await checkBatchLive(ctx, batchTasks);
        // Progress for the UI; finalize recounts from the DB anyway.
        await RankTrackingRepository.updateRun(ctx.runId, {
          keywordsChecked,
        });
        return batchOutcome;
      },
    );
    tally.liveCostMicros += outcome.costMicros;
  }
}

// Poll cadence for queued tasks. Standard-priority tasks complete in ~5
// minutes on average, so the first check waits 4 minutes; cumulative waits are
// 4 / 6 / 8 / 10 / 12 / 15 minutes, after which stragglers fall back to the
// live endpoint.
const QUEUED_POLL_INTERVALS = [
  "4 minutes",
  "2 minutes",
  "2 minutes",
  "2 minutes",
  "2 minutes",
  "3 minutes",
] as const;

/** Concurrent task_get requests within a collect step. */
const TASK_GET_CONCURRENCY = 25;

/** Max task_get calls per collect round (bounds one round's fan-out). */
const TASK_GETS_PER_COLLECT = 500;

// Collect steps may issue hundreds of task_get calls, so they get more room
// than SINGLE_ATTEMPT_STEP_CONFIG's 2-minute timeout. Unlike the metered
// steps, retrying is safe and free: task_get isn't charged and snapshot
// inserts are onConflictDoNothing.
const COLLECT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

interface CollectRoundOutcome {
  /** Snapshots written this round. */
  collected: number;
  /** Tasks still in DataForSEO's queue — poll again next round. */
  stillPending: PostedRankCheckTask[];
  /** Tasks DataForSEO failed — route to the live fallback. */
  failed: PostedRankCheckTask[];
}

/**
 * Fetch results for queued tasks (one free task_get each), persist completed
 * snapshots, settle each task's ledger row, and update run progress. Transient
 * task_get failures stay pending for the next round with their ledger row
 * untouched, so they remain collectable.
 */
async function collectQueuedRound(
  ctx: CheckContext,
  tasks: PostedRankCheckTask[],
): Promise<CollectRoundOutcome> {
  const completed: RankCheckResultWithDevice[] = [];
  const stillPending: PostedRankCheckTask[] = [];
  const failed: PostedRankCheckTask[] = [];
  const ledgerUpdates: Parameters<
    typeof RankTrackingRepository.markRankCheckTasksCollected
  >[0] = [];

  for (let i = 0; i < tasks.length; i += TASK_GET_CONCURRENCY) {
    const chunk = tasks.slice(i, i + TASK_GET_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((task) =>
        fetchRankCheckTaskResult({
          taskId: task.taskId,
          keywordId: task.keywordId,
          keyword: task.keyword,
          targetDomain: ctx.domain,
          trackCompetitors: ctx.trackCompetitors,
          trackAiOverview: ctx.trackAiOverview,
          brandTerms: ctx.brandTerms,
        }),
      ),
    );
    settled.forEach((result, index) => {
      const task = chunk[index];
      if (result.status === "rejected") {
        // Transient fetch failure — try again next round.
        console.warn(
          `[rank-check] ${ctx.runId} task_get failed:`,
          result.reason,
        );
        stillPending.push(task);
      } else if (result.value.status === "pending") {
        stillPending.push(task);
      } else if (result.value.status === "failed") {
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} failed: ${result.value.message}`,
        );
        failed.push(task);
        ledgerUpdates.push({
          providerTaskId: task.taskId,
          status: "failed",
          providerStatusCode: result.value.providerStatusCode,
          providerStatusMessage: result.value.message,
        });
      } else {
        completed.push({ ...result.value.result, device: task.device });
        ledgerUpdates.push({
          providerTaskId: task.taskId,
          status: result.value.isEmpty ? "terminal_empty" : "retrieved",
          providerStatusCode: result.value.providerStatusCode,
        });
      }
    });
  }

  if (completed.length > 0) {
    const keywordsChecked = await persistRankCheckResults(ctx.runId, completed);
    // Progress for the UI; finalize recounts from the DB anyway.
    await RankTrackingRepository.updateRun(ctx.runId, { keywordsChecked });
  }
  if (ledgerUpdates.length > 0) {
    await RankTrackingRepository.markRankCheckTasksCollected(ledgerUpdates);
  }

  return { collected: completed.length, stillPending, failed };
}

/** Reserve ledger rows for a chunk, then post it. Order matters: the rows must
 *  exist before the request so a crash can't lose the fact that we may have
 *  bought something. */
async function reserveAndPostChunk(
  ctx: CheckContext,
  chunk: RankCheckTaskInput[],
): Promise<PostedRankCheckTask[]> {
  const reservedCostMicros = usdToMicros(
    costPerSerpAtDepth(ctx.serpDepth, "queued", ctx.trackAiOverview),
  );
  await RankTrackingRepository.reserveRankCheckTasks(
    chunk.map((task) => ({
      id: crypto.randomUUID(),
      runId: ctx.runId,
      trackingKeywordId: task.keywordId,
      device: task.device,
      tag: `${task.keywordId}:${task.device}`,
      endpoint: TASK_POST_ENDPOINT,
      status: "reserved" as const,
      reservedCostMicros,
    })),
  );

  // The post and the writes that settle it share one non-retrying step, so
  // every failure from here on is treated the same way: the request may have
  // reached DataForSEO, and these pairs are neither re-postable nor safe to
  // re-buy live. Parking the chunk is what records that — the mark only moves
  // rows still at "reserved", so a pair whose task id did land keeps it and
  // stays collectable.
  try {
    const result = await ctx.client.serp.rankCheckTaskPost({
      tasks: chunk,
      locationCode: ctx.locationCode,
      languageCode: ctx.languageCode,
      locationName: ctx.locationName,
      depth: ctx.serpDepth,
      targetDomain: ctx.domain,
      trackCompetitors: ctx.trackCompetitors,
      trackAiOverview: ctx.trackAiOverview,
    });

    await RankTrackingRepository.markRankCheckTasksSubmitted(
      ctx.runId,
      result.posted.map((task) => ({
        trackingKeywordId: task.keywordId,
        device: task.device,
        providerTaskId: task.taskId,
        actualCostMicros: usdToMicros(task.costUsd),
      })),
    );
    if (result.rejected.length > 0) {
      await RankTrackingRepository.markRankCheckTasksOutcome(
        ctx.runId,
        result.rejected.map((task) => ({
          trackingKeywordId: task.keywordId,
          device: task.device,
          status: "failed" as const,
          providerStatusCode: task.statusCode,
          providerStatusMessage: task.statusMessage,
        })),
      );
    }

    return result.posted;
  } catch (error) {
    try {
      await RankTrackingRepository.markRankCheckTasksOutcome(
        ctx.runId,
        chunk.map((task) => ({
          trackingKeywordId: task.keywordId,
          device: task.device,
          status: "submission_unknown" as const,
          providerStatusMessage:
            error instanceof Error ? error.message.slice(0, 500) : null,
        })),
      );
    } catch (parkError) {
      // Even the parking write failed: the rows stay at "reserved", which the
      // run's finalize sweep converts, and the cost summary already counts them
      // as outstanding. Surface the original failure.
      console.error(
        `[rank-check] ${ctx.runId} could not park an unsettled post chunk:`,
        parkError,
      );
    }
    throw error;
  }
}

/**
 * Check keywords via DataForSEO's standard task queue (~30% of live cost).
 * Posts every keyword/device pair as a queued task, then polls task_get for
 * ~15 minutes, writing snapshots incrementally as tasks complete. Anything
 * still unfinished after the polling window — plus tasks DataForSEO rejected
 * or failed — gets one shot at the live endpoint so a run never hangs on a
 * stuck queue. Billing happens at task_post (and per live-fallback call), and
 * every task's reservation and settled charge is recorded in rank_check_tasks.
 *
 * Progress is folded into `tally` as each step returns rather than returned at
 * the end, so a throw anywhere in the loop still leaves the caller holding the
 * fallback spend already incurred.
 */
export async function runQueuedCheck(
  step: WorkflowStep,
  ctx: CheckContext,
  tally: RankCheckTally,
): Promise<void> {
  const taskInputs = expandToTaskInputs(ctx.keywords, ctx.devices);

  // Post all tasks to the queue, <=100 per request, one metered step each.
  // A failed chunk must not abort the run — earlier chunks were already
  // charged at DataForSEO, so their results have to be collected.
  let pending: PostedRankCheckTask[] = [];
  const fallback: RankCheckTaskInput[] = [];
  for (let i = 0; i < taskInputs.length; i += MAX_TASKS_PER_POST) {
    const chunk = taskInputs.slice(i, i + MAX_TASKS_PER_POST);
    const postIndex = Math.floor(i / MAX_TASKS_PER_POST);
    let posted: PostedRankCheckTask[];
    try {
      posted = await pgStep(
        step,
        `post-tasks-${postIndex}`,
        SINGLE_ATTEMPT_STEP_CONFIG,
        () => reserveAndPostChunk(ctx, chunk),
      );
    } catch (error) {
      // Deliberately NOT added to the live fallback: the chunk's ledger rows
      // are submission_unknown (or still reserved, which finalize sweeps), and
      // buying the same pairs again could be a second charge for results
      // DataForSEO may already be holding. The ledger — not a counter here — is
      // what finalize reports, so a chunk that half-settled is counted exactly.
      console.warn(
        `[rank-check] ${ctx.runId} post-tasks-${postIndex} failed:`,
        error,
      );
      continue;
    }
    pending.push(...posted);
    if (posted.length < chunk.length) {
      const acceptedKeys = new Set(
        posted.map((t) => `${t.keywordId}:${t.device}`),
      );
      fallback.push(
        ...chunk.filter((t) => !acceptedKeys.has(`${t.keywordId}:${t.device}`)),
      );
    }
  }

  tally.queueTasks = pending.length;

  // Poll until everything is collected or the ~15 minute window closes. A
  // collect failure (past its retries) leaves that round's tasks pending for
  // the next round — or the live fallback — instead of failing the run; the
  // posted tasks are already paid for.
  for (
    let round = 0;
    round < QUEUED_POLL_INTERVALS.length && pending.length > 0;
    round++
  ) {
    await step.sleep(`wait-${round}`, QUEUED_POLL_INTERVALS[round]);

    // Cap task_gets per round so one collect step stays well inside the
    // per-invocation subrequest limit at the 1000-keyword config ceiling.
    const batch = pending.slice(0, TASK_GETS_PER_COLLECT);
    const overflow = pending.slice(TASK_GETS_PER_COLLECT);

    let outcome: CollectRoundOutcome;
    try {
      outcome = await pgStep(
        step,
        `collect-${round}`,
        COLLECT_STEP_CONFIG,
        () => collectQueuedRound(ctx, batch),
      );
    } catch (error) {
      console.warn(`[rank-check] ${ctx.runId} collect-${round} failed:`, error);
      continue;
    }

    tally.queueCollected += outcome.collected;
    pending = [...outcome.stillPending, ...overflow];
    fallback.push(...outcome.failed);
  }

  // Live fallback: queued tasks that never finished, failed, or were rejected
  // at post time. A straggler is double-billed (customer was metered the
  // queued post cost and now the live call too — fractions of a cent).
  // Progress isn't updated here; finalize recounts keywordsChecked from the
  // DB.
  const stragglers: RankCheckTaskInput[] = [...fallback, ...pending];
  tally.fallbackTasks = stragglers.length;
  if (stragglers.length === 0) return;

  console.log(
    `[rank-check] ${ctx.runId} live fallback for ${stragglers.length} task(s)`,
  );

  for (let i = 0; i < stragglers.length; i += KEYWORDS_PER_BATCH) {
    const batch = stragglers.slice(i, i + KEYWORDS_PER_BATCH);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);

    const outcome = await pgStep(
      step,
      `fallback-batch-${batchIndex}`,
      SINGLE_ATTEMPT_STEP_CONFIG,
      () => checkBatchLive(ctx, batch),
    );
    tally.fallbackChecked += outcome.written;
    tally.liveCostMicros += outcome.costMicros;
  }
}

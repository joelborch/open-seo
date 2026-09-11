import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { withPgClient } from "@/db";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { collectGridCells } from "@/server/features/maps-grid/services/mapsGridCollector";
import { computeRunRollups } from "@/server/features/maps-grid/services/mapsGridRollups";
import { matchIdentityForLocation } from "@/server/features/maps-grid/services/MapsGridService";
import {
  createDataforseoClient,
  fetchMapsTasksReady,
  MAX_TASKS_PER_POST,
} from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { pgStep } from "@/server/workflows/pgStep";
import type { MatchIdentity } from "@/shared/maps-grid";
import { usdToMicros } from "@/shared/rank-tracking";

/**
 * One local-pack grid run: post every (keyword, grid point) as a queued Google
 * Maps task, then poll until the packs come back and write each cell's ranked
 * results and the client's position in it.
 *
 * There is no live fallback, unlike the rank-check workflow. A 7×7 grid is 49
 * requests per keyword and the live Maps endpoint costs roughly three times the
 * queue, so a straggler is left as an uncollected cell — visible as a gap in the
 * heatmap and recoverable for free through the manual retrieval pass — rather
 * than re-bought at triple price.
 */

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

// Collect steps are free (task_get isn't charged) and idempotent (results are
// replaced per cell), so unlike the metered post steps they may retry, and they
// get room for hundreds of subrequests.
const COLLECT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

/**
 * Standard-priority Maps tasks settle in ~2-5 minutes, so the first poll waits
 * 90 seconds and then checks every 45. 90s + 24 × 45s ≈ 19.5 minutes, which is
 * the ~20-minute window a grid run is allowed before its cells are left to the
 * retrieval pass.
 */
const INITIAL_WAIT = "90 seconds";
const COLLECT_WAIT = "45 seconds";
const MAX_COLLECT_ROUNDS = 24;

/** task_get calls per collect round — bounds one step's subrequest fan-out. */
const TASK_GETS_PER_ROUND = 400;

interface MapsGridParams {
  runId: string;
  configId: string;
  projectId: string;
  locationId: string;
  billingCustomer: BillingCustomerContext;
  trigger: "manual" | "scheduled";
}

/** A reserved cell, trimmed to what the task_post payload needs. */
interface PendingCell {
  tag: string;
  keyword: string;
  lat: number;
  lng: number;
}

interface GridRunContext {
  identity: MatchIdentity;
  zoom: string;
  languageCode: string;
  device: "desktop" | "mobile";
  depth: number | null;
  gridSize: number;
  cells: PendingCell[];
}

/**
 * Read everything the run needs in one step: the matching identity, the request
 * parameters, and the cells startGridRun already reserved. Reading the cell list
 * once (rather than re-querying per post step) keeps the chunk boundaries stable
 * across a replay, so a chunk is never posted twice under a different name.
 */
async function loadGridRunContext(
  params: MapsGridParams,
): Promise<GridRunContext> {
  const config = await MapsGridRepository.getConfigForRun(params.configId);
  const location = await MapsGridRepository.getLocationForRun(
    params.locationId,
  );
  if (!config || !location) {
    throw new AppError(
      "NOT_FOUND",
      "Grid config or location no longer exists for this run",
    );
  }
  await MapsGridRepository.updateRun(params.runId, { status: "running" });

  const reserved = await MapsGridRepository.getReservedCells(params.runId);
  return {
    identity: matchIdentityForLocation(location),
    zoom: config.zoom,
    languageCode: config.languageCode,
    device: config.device,
    depth: config.depth,
    gridSize: config.gridSize,
    cells: reserved.map((cell) => ({
      tag: cell.tag,
      keyword: cell.keyword,
      lat: cell.lat,
      lng: cell.lng,
    })),
  };
}

/**
 * Post one chunk of cells. The cells are already in state "reserved" (written by
 * startGridRun before the workflow existed), so a crash here can only lose the
 * *outcome* of the charge, never the record of it: the catch parks the chunk as
 * submission_unknown, which is the one state this pipeline never re-posts from —
 * the request may have reached DataForSEO, and buying it again would be a second
 * charge for results the provider is already holding.
 */
async function postCellChunk(input: {
  runId: string;
  billingCustomer: BillingCustomerContext;
  ctx: GridRunContext;
  chunk: PendingCell[];
}): Promise<{ posted: number; rejected: number }> {
  const { ctx, chunk } = input;
  const client = createDataforseoClient(input.billingCustomer);

  let result: Awaited<ReturnType<typeof client.serp.mapsGridTaskPost>>;
  try {
    result = await client.serp.mapsGridTaskPost({
      tasks: chunk.map((cell) => ({
        tag: cell.tag,
        keyword: cell.keyword,
        lat: cell.lat,
        lng: cell.lng,
        zoom: ctx.zoom,
        languageCode: ctx.languageCode,
        device: ctx.device,
        depth: ctx.depth ?? undefined,
      })),
    });
  } catch (error) {
    await MapsGridRepository.markCellsOutcome(
      chunk.map((cell) => ({
        tag: cell.tag,
        status: "submission_unknown" as const,
      })),
    );
    throw error;
  }

  await MapsGridRepository.markCellsSubmitted(
    result.posted.map((task) => ({
      tag: task.tag,
      providerTaskId: task.taskId,
      actualCostMicros: usdToMicros(task.costUsd),
    })),
  );
  if (result.rejected.length > 0) {
    await MapsGridRepository.markCellsOutcome(
      result.rejected.map((task) => ({
        tag: task.tag,
        status: "failed" as const,
        providerStatusCode: task.statusCode,
      })),
    );
  }
  return { posted: result.posted.length, rejected: result.rejected.length };
}

/**
 * Ask which of the account's tasks are finished, then collect the ones belonging
 * to this run. One tasks_ready call per round is what keeps a poll from spending
 * hundreds of task_get requests on tasks still sitting in the queue.
 */
async function collectRound(input: {
  runId: string;
  identity: MatchIdentity;
}): Promise<{ collected: number; failed: number; outstanding: number }> {
  const readyTaskIds = new Set(await fetchMapsTasksReady());
  const outcome = await collectGridCells({
    runId: input.runId,
    identity: input.identity,
    readyTaskIds,
    maxGets: TASK_GETS_PER_ROUND,
  });
  const summary = await MapsGridRepository.getCellCostSummary(input.runId);
  return {
    collected: outcome.collected,
    failed: outcome.failed,
    outstanding: summary.outstanding,
  };
}

/**
 * Settle the run: spend comes from the cell ledger (the sum of what DataForSEO
 * actually charged per task), and the status says whether that figure is final —
 * a post whose outcome we never learned, or a cell still outstanding, makes it a
 * floor rather than a settled amount.
 */
async function finalizeGridRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  gridSize: number;
  billingCustomer: BillingCustomerContext;
  trigger: MapsGridParams["trigger"];
  postError: string | null;
}) {
  const run = await MapsGridRepository.getRunById(input.runId);
  if (!run || run.status === "completed" || run.status === "failed") {
    console.warn(
      `[maps-grid] ${input.runId} no longer active (status=${run?.status ?? "missing"}), skipping finalization`,
    );
    return;
  }

  const summary = await MapsGridRepository.getCellCostSummary(input.runId);
  const [cells, results] = await Promise.all([
    MapsGridRepository.getCellsForRun(input.runId),
    MapsGridRepository.getCellResultsForRuns([input.runId]),
  ]);
  const rollups = computeRunRollups({
    gridSize: input.gridSize,
    cells,
    results,
  });

  const missing = run.cellsTotal - summary.collected;
  const errorMessage = input.postError
    ? `Collected ${summary.collected} of ${run.cellsTotal} cell(s). Error: ${input.postError}`
    : missing > 0
      ? `${missing} cell(s) could not be collected`
      : null;
  // A run that collected nothing bought nothing usable, so it reads as failed.
  // Anything partial completes: the heatmap is still worth showing, with the
  // gaps named in the error line.
  const status = summary.collected === 0 ? "failed" : "completed";

  await MapsGridRepository.updateRun(input.runId, {
    status,
    cellsCollected: summary.collected,
    completedAt: new Date().toISOString(),
    spentCostMicros: summary.actualCostMicros,
    costStatus:
      summary.submissionUnknown > 0 || summary.outstanding > 0
        ? "known_minimum"
        : "known",
    ...(errorMessage ? { errorMessage } : {}),
  });
  await MapsGridRepository.updateConfig(
    { configId: input.configId, projectId: input.projectId },
    { lastRunAt: new Date().toISOString(), lastSkipReason: null },
  );

  // One indexed line per run so collection rates and spend are visible in
  // Workers Logs without opening the app.
  console.log({
    event: "maps_grid_run_complete",
    run_id: input.runId,
    project_id: input.projectId,
    status,
    trigger: input.trigger,
    cells_total: run.cellsTotal,
    cells_collected: summary.collected,
    submission_unknown: summary.submissionUnknown,
    outstanding: summary.outstanding,
    spent_micros: summary.actualCostMicros,
    visibility_score: Math.round(rollups.visibilityScore),
    error: errorMessage,
  });

  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "maps_grid:run_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status,
      trigger: input.trigger,
      cells_total: run.cellsTotal,
      cells_collected: summary.collected,
      spent_cost_micros: summary.actualCostMicros,
      visibility_score: Math.round(rollups.visibilityScore),
    },
  });
}

async function markGridRunFailed(input: { runId: string; error: unknown }) {
  const run = await MapsGridRepository.getRunById(input.runId);
  if (!run || run.status === "completed" || run.status === "failed") return;
  await MapsGridRepository.updateRun(input.runId, {
    status: "failed",
    errorMessage:
      input.error instanceof Error
        ? input.error.message.slice(0, 500)
        : "Unknown error",
    completedAt: new Date().toISOString(),
  });
}

export class MapsGridWorkflow extends WorkflowEntrypoint<Env, MapsGridParams> {
  async run(event: WorkflowEvent<MapsGridParams>, step: WorkflowStep) {
    // Scope a per-invocation Postgres client (no-op in D1 mode); each step opens
    // its own through pgStep, since a step body runs outside this scope.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<MapsGridParams>,
    step: WorkflowStep,
  ) {
    const params = event.payload;

    try {
      const ctx = await pgStep(step, "load", SINGLE_ATTEMPT_STEP_CONFIG, () =>
        loadGridRunContext(params),
      );

      // Post in chunks of <=100. A failed chunk must not abort the run: earlier
      // chunks were already charged, so their results still have to be collected.
      let postError: string | null = null;
      for (let i = 0; i < ctx.cells.length; i += MAX_TASKS_PER_POST) {
        const chunk = ctx.cells.slice(i, i + MAX_TASKS_PER_POST);
        const chunkIndex = Math.floor(i / MAX_TASKS_PER_POST);
        try {
          await pgStep(
            step,
            `post-${chunkIndex}`,
            SINGLE_ATTEMPT_STEP_CONFIG,
            () =>
              postCellChunk({
                runId: params.runId,
                billingCustomer: params.billingCustomer,
                ctx,
                chunk,
              }),
          );
        } catch (error) {
          postError = error instanceof Error ? error.message : String(error);
          console.warn(
            `[maps-grid] ${params.runId} post-${chunkIndex} failed: ${postError}`,
          );
        }
      }

      await step.sleep("wait-initial", INITIAL_WAIT);

      for (let round = 0; round < MAX_COLLECT_ROUNDS; round++) {
        let outcome;
        try {
          outcome = await pgStep(
            step,
            `collect-${round}`,
            COLLECT_STEP_CONFIG,
            () => collectRound({ runId: params.runId, identity: ctx.identity }),
          );
        } catch (error) {
          // Past its retries: the cells stay submitted and the next round (or
          // the retrieval pass) picks them up. The tasks are already paid for.
          console.warn(
            `[maps-grid] ${params.runId} collect-${round} failed:`,
            error,
          );
          await step.sleep(`wait-${round}`, COLLECT_WAIT);
          continue;
        }
        if (outcome.outstanding === 0) break;
        await step.sleep(`wait-${round}`, COLLECT_WAIT);
      }

      await pgStep(step, "finalize", SINGLE_ATTEMPT_STEP_CONFIG, () =>
        finalizeGridRun({
          runId: params.runId,
          configId: params.configId,
          projectId: params.projectId,
          gridSize: ctx.gridSize,
          billingCustomer: params.billingCustomer,
          trigger: params.trigger,
          postError,
        }),
      );
    } catch (error) {
      console.error(`[maps-grid] ${params.runId} failed:`, error);
      await pgStep(step, "mark-failed", SINGLE_ATTEMPT_STEP_CONFIG, () =>
        markGridRunFailed({ runId: params.runId, error }),
      );
      throw error;
    }
  }
}

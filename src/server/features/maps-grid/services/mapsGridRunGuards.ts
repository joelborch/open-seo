import { env } from "cloudflare:workers";
import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";

/**
 * Keeping a dead grid run from blocking its config forever.
 *
 * The partial unique index on maps_grid_runs(config_id) WHERE status IN
 * ('pending','running') is what stops a config from being bought twice at once,
 * so the active row *is* the lock — and a run whose workflow died without ever
 * finalizing holds that lock indefinitely. The Workflows instance is the
 * authority on whether a run is still alive, so that is what decides here, the
 * same way rankCheckRunGuards decides for rank checks.
 */

type GridRunRow = NonNullable<
  Awaited<ReturnType<typeof MapsGridRepository.getRunById>>
>;

/** Statuses that mean the Workflows runtime still owns the instance. */
const ACTIVE_WORKFLOW_STATUSES = new Set([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
]);

/**
 * How long a run may look active before its instance is questioned. A grid run
 * posts, then polls for ~20 minutes, so anything past 30 has either finalized or
 * lost its workflow — and the window doubles as the startup grace period, since
 * instance metadata can lag a create by seconds.
 */
export const GRID_RUN_STALE_AFTER_MS = 30 * 60_000;

interface GridWorkflowStatus {
  status: string;
  error?: { message: string };
}

/**
 * Why this run should be given up on, or null to leave it alone. Pure so the
 * decision is testable without a Workflows binding: the caller supplies the
 * instance status it read.
 */
export function gridRunStaleReason(input: {
  runStatus: GridRunRow["status"];
  workflowStatus: GridWorkflowStatus | null;
  ageMs: number;
}): string | null {
  // Already settled: the index slot is free and there is nothing to clear.
  if (input.runStatus !== "pending" && input.runStatus !== "running") {
    return null;
  }
  if (input.ageMs < GRID_RUN_STALE_AFTER_MS) return null;

  const workflow = input.workflowStatus;
  if (workflow && ACTIVE_WORKFLOW_STATUSES.has(workflow.status)) return null;
  if (!workflow) return "Grid workflow instance was not found";
  if (workflow.status === "errored" || workflow.status === "terminated") {
    return workflow.error?.message ?? `Grid workflow ${workflow.status}`;
  }
  if (workflow.status === "complete") {
    return "Grid workflow completed without finalizing the run";
  }
  return `Grid workflow is no longer active (${workflow.status})`;
}

async function getGridWorkflowStatus(
  runId: string,
): Promise<GridWorkflowStatus | null> {
  try {
    const instance = await env.MAPS_GRID_WORKFLOW.get(runId);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the binding's status union is wider than the fields read here
    return (await instance.status()) as GridWorkflowStatus;
  } catch {
    // No such instance (or the binding refused): treated as "not found" by the
    // decision above, which only matters past the stale window anyway.
    return null;
  }
}

/**
 * Ask the Workflows runtime whether an apparently-active run is really alive.
 * The instance is only queried once the run is old enough for the answer to
 * change anything, so a healthy tick costs no extra calls.
 */
export async function staleGridRunReason(
  run: GridRunRow,
): Promise<string | null> {
  if (run.status !== "pending" && run.status !== "running") return null;
  const ageMs = Date.now() - new Date(run.startedAt).getTime();
  if (ageMs < GRID_RUN_STALE_AFTER_MS) return null;

  return gridRunStaleReason({
    runStatus: run.status,
    workflowStatus: await getGridWorkflowStatus(run.id),
    ageMs,
  });
}

/**
 * Mark an active run failed and record what its cells say it spent. Idempotent —
 * a run already completed or failed is left as it is.
 *
 * The spend comes from the cell ledger rather than being written as null,
 * because a run reaped mid-flight has usually already been charged for every
 * cell it posted; anything still outstanding or unaccounted makes that figure a
 * floor.
 */
export async function failGridRunWithLedger(runId: string, reason: string) {
  const run = await MapsGridRepository.getRunById(runId);
  if (!run || run.status === "completed" || run.status === "failed") return;

  const summary = await MapsGridRepository.getCellCostSummary(runId);
  await MapsGridRepository.updateRun(runId, {
    status: "failed",
    errorMessage: reason.slice(0, 500),
    completedAt: new Date().toISOString(),
    cellsCollected: summary.collected,
    spentCostMicros: summary.actualCostMicros,
    costStatus:
      summary.submissionUnknown > 0 || summary.outstanding > 0
        ? "known_minimum"
        : "known",
  });
}

import { env } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  MapsGridRepository,
  type MapsGridLocation,
} from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { collectGridCells } from "@/server/features/maps-grid/services/mapsGridCollector";
import {
  getGridRun,
  getGridRuns,
  getGridTrend,
} from "@/server/features/maps-grid/services/mapsGridReads";
import {
  failGridRunWithLedger,
  staleGridRunReason,
} from "@/server/features/maps-grid/services/mapsGridRunGuards";
import { AppError } from "@/server/lib/errors";
import { buildGridPoints, type MatchIdentity } from "@/shared/maps-grid";
import { costPerSerpAtDepth, usdToMicros } from "@/shared/rank-tracking";

/**
 * The grid's application layer: pricing a run before it is bought, starting one,
 * recovering a stranded one, and the read models the UI renders.
 */

/** Pack depth a cell buys when the config doesn't name one. */
const DEFAULT_GRID_DEPTH = 20;

/** Cells one manual retrieval pass will collect. */
const RETRIEVE_MAX_GETS = 400;

type MapsGridStartResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "already_running"; blockingRunId: string | null };

/** What a run will buy, and what it will cost, before anything is posted. */
interface MapsGridRunPlan {
  configId: string;
  projectId: string;
  locationId: string;
  locationName: string;
  centerLat: number;
  centerLng: number;
  gridSize: number;
  radiusMiles: number;
  zoom: string;
  languageCode: string;
  device: "desktop" | "mobile";
  depth: number;
  keywords: Array<{ id: string; keyword: string }>;
  cellsTotal: number;
  /** Provider cost of one grid point, in micro-dollars. */
  reservedCostMicrosPerCell: number;
  /** Provider cost of the whole run, in micro-dollars. */
  totalCostMicros: number;
}

/** The location identity the matcher scores every pack row against. */
export function matchIdentityForLocation(
  location: MapsGridLocation,
): MatchIdentity {
  return {
    brandName: location.brandName,
    domain: location.domain,
    slug: location.slug,
    phone: location.phone,
    street: location.street,
    postalCode: location.postalCode,
    matchTerms: location.matchTerms,
  };
}

/**
 * Price a run and enumerate its cells: every keyword × every grid point.
 *
 * A 7×7 grid at five keywords is 245 charged provider requests, so the count and
 * the price are shown before the user commits — this is the function behind both
 * the preview and the authorization check on the real start.
 */
async function planGridRun(input: {
  configId: string;
  projectId: string;
}): Promise<MapsGridRunPlan> {
  const config = await MapsGridRepository.getConfigById(input);
  if (!config) {
    throw new AppError("NOT_FOUND", "Grid config not found");
  }
  const location = await MapsGridRepository.getLocationById({
    locationId: config.locationId,
    projectId: input.projectId,
  });
  if (!location) {
    throw new AppError("NOT_FOUND", "Grid location not found");
  }
  const keywords = await MapsGridRepository.getKeywordsForConfig(config.id);
  const depth = config.depth ?? DEFAULT_GRID_DEPTH;

  // Every cell is one queued task at the same depth, so the per-cell price is
  // the unit the ledger reserves in and the run's authorization is measured in.
  const reservedCostMicrosPerCell = usdToMicros(
    costPerSerpAtDepth(depth, "queued"),
  );
  const cellsTotal = keywords.length * config.gridSize * config.gridSize;

  return {
    configId: config.id,
    projectId: config.projectId,
    locationId: location.id,
    locationName: location.name,
    centerLat: location.lat,
    centerLng: location.lng,
    gridSize: config.gridSize,
    radiusMiles: config.radiusMiles,
    zoom: config.zoom,
    languageCode: config.languageCode,
    device: config.device,
    depth,
    keywords: keywords.map((row) => ({ id: row.id, keyword: row.keyword })),
    cellsTotal,
    reservedCostMicrosPerCell,
    totalCostMicros: reservedCostMicrosPerCell * cellsTotal,
  };
}

/**
 * Start a grid run, or price one without buying it.
 *
 * `dryRun` returns the plan and stops — no run row, no cells, no provider call —
 * which is what the "Preview run" button reads. Otherwise the run row and all of
 * its cells are written in state "reserved" BEFORE the workflow is created, so a
 * crash anywhere after this point still leaves a complete record of what the run
 * intended to buy.
 */
export async function startGridRun(input: {
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  trigger: "manual" | "scheduled";
  authorizedCostMicros?: number;
  dryRun?: boolean;
}): Promise<
  | { dryRun: true; plan: MapsGridRunPlan }
  | ({ dryRun: false; plan: MapsGridRunPlan } & MapsGridStartResult)
> {
  const plan = await planGridRun(input);
  // A preview of an empty config is a legitimate question ("what would this
  // cost?"), so the keyword guard sits after the dry-run return and only blocks
  // a run that would actually buy nothing.
  if (input.dryRun) return { dryRun: true, plan };
  if (plan.keywords.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Add at least one keyword before running the grid",
    );
  }

  if (
    input.authorizedCostMicros !== undefined &&
    plan.totalCostMicros > input.authorizedCostMicros
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      `This grid run costs ${plan.totalCostMicros} micro-dollars, above the approved ${input.authorizedCostMicros}. Preview the run again and approve the updated amount.`,
    );
  }

  // At most two attempts: once normally, once after clearing a blocker whose
  // workflow died. Without the second pass a run that lost its instance holds
  // the config's one-active slot forever, and every later trigger — cron
  // included — reports already_running.
  for (let attempt = 0; attempt < 2; attempt++) {
    const runId = crypto.randomUUID();
    const created = await MapsGridRepository.tryCreateRun({
      id: runId,
      configId: plan.configId,
      projectId: plan.projectId,
      trigger: input.trigger,
      cellsTotal: plan.cellsTotal,
      authorizedCostMicros: input.authorizedCostMicros ?? plan.totalCostMicros,
    });

    if (!created) {
      // The partial unique index rejected the insert: another run is in flight.
      const blocker = await MapsGridRepository.getActiveRunForConfig(
        plan.configId,
      );
      // Raced: the blocker settled between the insert and this read. Loop.
      if (!blocker) continue;

      if (attempt === 0) {
        const staleReason = await staleGridRunReason(blocker);
        if (staleReason) {
          await failGridRunWithLedger(blocker.id, staleReason);
          continue; // the slot is free now — retry the insert
        }
      }

      return {
        dryRun: false,
        plan,
        ok: false,
        reason: "already_running",
        blockingRunId: blocker.id,
      };
    }

    try {
      await MapsGridRepository.reserveCells(buildReservedCells(plan, runId));
      await env.MAPS_GRID_WORKFLOW.create({
        id: runId,
        params: {
          runId,
          configId: plan.configId,
          projectId: plan.projectId,
          locationId: plan.locationId,
          billingCustomer: input.billingCustomer,
          trigger: input.trigger,
        },
      });
    } catch (error) {
      // Covers the cell reservation as well as the workflow create: either way
      // nothing was posted, so flip the run to failed to release the
      // partial-index slot, then best-effort clean up any zombie instance.
      await MapsGridRepository.updateRun(runId, {
        status: "failed",
        errorMessage: "Failed to start the grid workflow",
        completedAt: new Date().toISOString(),
      });
      try {
        const instance = await env.MAPS_GRID_WORKFLOW.get(runId);
        await instance.terminate();
      } catch {
        // The instance may never have been created.
      }
      throw error;
    }

    return { dryRun: false, plan, ok: true, runId };
  }

  // Exhausted both attempts (rapid churn on this config). Report the blocker.
  const final = await MapsGridRepository.getActiveRunForConfig(plan.configId);
  return {
    dryRun: false,
    plan,
    ok: false,
    reason: "already_running",
    blockingRunId: final?.id ?? null,
  };
}

/**
 * One cell row per keyword × grid point. The tag is what DataForSEO echoes
 * back, so it carries everything needed to route a result home without relying
 * on response order.
 */
function buildReservedCells(plan: MapsGridRunPlan, runId: string) {
  const points = buildGridPoints({
    centerLat: plan.centerLat,
    centerLng: plan.centerLng,
    gridSize: plan.gridSize,
    radiusMiles: plan.radiusMiles,
  });
  return plan.keywords.flatMap((keyword) =>
    points.map((point) => ({
      runId,
      keywordId: keyword.id,
      keyword: keyword.keyword,
      locationId: plan.locationId,
      gridRow: point.row,
      gridCol: point.col,
      lat: point.lat,
      lng: point.lng,
      direction: point.direction,
      distanceMiles: point.distanceMiles,
      tag: `${runId}:${keyword.id}:r${point.row}c${point.col}`,
      taskStatus: "reserved" as const,
      reservedCostMicros: plan.reservedCostMicrosPerCell,
    })),
  );
}

/**
 * Collect a run's outstanding cells without buying anything.
 *
 * The recovery path for a run whose workflow died mid-poll: every task id is
 * already in the ledger, and task_get is free, so this settles whatever the
 * provider is holding and leaves the run's own finalize (or the next call) to
 * finish the accounting.
 *
 * Refused while the run is still active. A collect pass replaces each cell's
 * ranked rows by deleting and re-inserting them, so running one against a
 * workflow that is mid-collect interleaves two delete/insert pairs on the same
 * cells and can leave a pack duplicated. A stranded run reaches
 * completed/failed on its own — the workflow finalizes it, or the reaper does.
 */
async function retrieveGridRun(input: { runId: string; projectId: string }) {
  const run = await MapsGridRepository.getRunForProject(input);
  if (!run) throw new AppError("NOT_FOUND", "Grid run not found");
  if (run.status === "pending" || run.status === "running") {
    throw new AppError(
      "CONFLICT",
      "This run is still collecting its cells. Wait for it to finish, then collect whatever is left over.",
    );
  }

  const config = await MapsGridRepository.getConfigForRun(run.configId);
  const location = config
    ? await MapsGridRepository.getLocationForRun(config.locationId)
    : null;
  if (!config || !location) {
    throw new AppError(
      "NOT_FOUND",
      "The grid config this run belongs to no longer exists",
    );
  }

  const outcome = await collectGridCells({
    runId: run.id,
    identity: matchIdentityForLocation(location),
    maxGets: RETRIEVE_MAX_GETS,
  });
  const summary = await MapsGridRepository.getCellCostSummary(run.id);
  return { ...outcome, outstanding: summary.outstanding };
}

export const MapsGridService = {
  planGridRun,
  startGridRun,
  retrieveGridRun,
  getGridRuns,
  getGridRun,
  getGridTrend,
  matchIdentityForLocation,
} as const;

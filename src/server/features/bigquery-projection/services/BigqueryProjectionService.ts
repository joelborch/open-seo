/**
 * Projects completed monitoring runs into a client's BigQuery dataset.
 *
 * One run becomes a handful of compact rows per table (see `projectionRows.ts`)
 * and exactly one MERGE per table, because BigQuery allows only 1,500 DML
 * statements per table per day. Every attempt is written to the
 * `bigquery_projections` ledger, and the cron's pending query is "a completed run
 * that does not yet have a success row for each of its tables" — so a failure is
 * retried on the next tick and nothing retries inside a single tick.
 */
import { sort } from "remeda";
import {
  BQ_TABLE_SPECS,
  INTERNAL_DATASET,
  mergeRows,
} from "@/server/lib/bigquery";
import {
  BigqueryProjectionRepository,
  type BigqueryTarget,
} from "@/server/features/bigquery-projection/repositories/BigqueryProjectionRepository";
import {
  buildAuditProjection,
  buildGbpProjection,
  buildMapsProjection,
  buildProjectionObservation,
  buildRankProjection,
  TABLES_BY_RUN_KIND,
  type ProjectionResult,
  type ProjectionRunKind,
  type ProjectionTableName,
} from "@/server/features/bigquery-projection/projectionRows";
import type { BqInputRow } from "@/server/lib/bigquery";

/** Runs projected per cron tick. Each is a few MERGE statements. */
const RUNS_PER_TICK = 20;
/**
 * Wall-clock guard: sub-hourly crons are killed at 15 minutes and this tick is
 * shared with the audit and rank-check loops. Stopping early is free — an
 * unprojected run is still pending next tick.
 */
const TICK_DEADLINE_MS = 2 * 60_000;
/**
 * How far back the cron looks for unprojected runs. A first deployment must not
 * try to backfill every run ever recorded; anything older is projected on demand
 * from the project's BigQuery settings card.
 */
const LOOKBACK_DAYS = 30;

function lookbackCutoff(): string {
  return new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
}

type ProjectedTable = {
  table: ProjectionTableName | "observations";
  dataset: string;
  rows: number;
  error: string | null;
};

type ProjectRunResult = {
  runKind: ProjectionRunKind;
  runId: string;
  /** Set when nothing was projected, and why. */
  skipped: "run_not_found" | "no_bigquery_target" | null;
  tables: ProjectedTable[];
};

async function loadSource(
  runKind: ProjectionRunKind,
  runId: string,
): Promise<{
  projectId: string;
  build: (pulledAt: string) => ProjectionResult;
} | null> {
  switch (runKind) {
    case "audit_schedule_run": {
      const loaded =
        await BigqueryProjectionRepository.getAuditRunSource(runId);
      return (
        loaded && {
          projectId: loaded.projectId,
          build: (pulledAt) =>
            buildAuditProjection({ source: loaded.source, pulledAt }),
        }
      );
    }
    case "rank_check_run": {
      const loaded = await BigqueryProjectionRepository.getRankRunSource(runId);
      return (
        loaded && {
          projectId: loaded.projectId,
          build: (pulledAt) =>
            buildRankProjection({ source: loaded.source, pulledAt }),
        }
      );
    }
    case "maps_grid_run": {
      const loaded = await BigqueryProjectionRepository.getMapsRunSource(runId);
      return (
        loaded && {
          projectId: loaded.projectId,
          build: (pulledAt) =>
            buildMapsProjection({ source: loaded.source, pulledAt }),
        }
      );
    }
    case "gbp_snapshot": {
      const loaded =
        await BigqueryProjectionRepository.getGbpSnapshotSource(runId);
      return (
        loaded && {
          projectId: loaded.projectId,
          build: (pulledAt) =>
            buildGbpProjection({ source: loaded.source, pulledAt }),
        }
      );
    }
  }
}

/**
 * One MERGE into one table, with the ledger row written either way. Returns the
 * outcome instead of throwing so a failing table cannot stop the others: each is
 * independently retried on a later tick.
 */
async function projectTable(input: {
  projectId: string;
  runKind: ProjectionRunKind;
  runId: string;
  table: ProjectionTableName | "observations";
  dataset: string;
  rows: BqInputRow[];
}): Promise<ProjectedTable> {
  let rowsWritten = 0;
  let error: string | null = null;
  try {
    // An empty table is a real outcome (a rank run where nothing was evaluated
    // for AI Overview), and it must still be recorded or the run stays pending
    // forever. No MERGE is sent, so it does not even need credentials.
    if (input.rows.length > 0) {
      const result = await mergeRows({
        dataset: input.dataset,
        spec: BQ_TABLE_SPECS[input.table],
        rows: input.rows,
      });
      rowsWritten = result.sourceRows;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(
      `[bigquery-projection] MERGE into ${input.dataset}.${input.table} failed for ${input.runKind} ${input.runId}:`,
      err,
    );
  }

  await BigqueryProjectionRepository.recordProjection({
    projectId: input.projectId,
    runKind: input.runKind,
    runId: input.runId,
    tableName: input.table,
    dataset: input.dataset,
    rows: rowsWritten,
    error,
  });

  return {
    table: input.table,
    dataset: input.dataset,
    rows: rowsWritten,
    error,
  };
}

/**
 * Project one completed run. Silently skipped (with a log line) when the project
 * has no `project_bigquery_targets` row — most projects don't, and that is not a
 * failure.
 */
export async function projectRun(input: {
  runKind: ProjectionRunKind;
  runId: string;
  /**
   * Authorization guard for the on-demand path: a run belonging to another
   * project reads as "not found" rather than being projected into whatever
   * dataset its own project points at.
   */
  expectedProjectId?: string;
}): Promise<ProjectRunResult> {
  const loaded = await loadSource(input.runKind, input.runId);
  if (
    !loaded ||
    (input.expectedProjectId !== undefined &&
      loaded.projectId !== input.expectedProjectId)
  ) {
    return {
      runKind: input.runKind,
      runId: input.runId,
      skipped: "run_not_found",
      tables: [],
    };
  }

  const target: BigqueryTarget | null =
    await BigqueryProjectionRepository.getTarget(loaded.projectId);
  if (!target) {
    console.log({
      event: "bigquery_projection_skipped",
      reason: "no_bigquery_target",
      runKind: input.runKind,
      runId: input.runId,
      projectId: loaded.projectId,
    });
    return {
      runKind: input.runKind,
      runId: input.runId,
      skipped: "no_bigquery_target",
      tables: [],
    };
  }

  const pulledAt = new Date().toISOString();
  const projection = loaded.build(pulledAt);
  const tables: ProjectedTable[] = [];

  for (const table of TABLES_BY_RUN_KIND[input.runKind]) {
    tables.push(
      await projectTable({
        projectId: loaded.projectId,
        runKind: input.runKind,
        runId: input.runId,
        table,
        dataset: target.dataset,
        rows: projection.rowsByTable[table] ?? [],
      }),
    );
  }

  // The internal observation counts what the client tables actually received,
  // and goes last so it never claims rows a failed MERGE never wrote.
  const observation = await buildProjectionObservation({
    clientKey: target.clientKey,
    runKind: input.runKind,
    runId: input.runId,
    projectId: loaded.projectId,
    reportDate: projection.reportDate,
    rowCount: tables.reduce((total, table) => total + table.rows, 0),
    pulledAt,
  });
  tables.push(
    await projectTable({
      projectId: loaded.projectId,
      runKind: input.runKind,
      runId: input.runId,
      table: "observations",
      dataset: INTERNAL_DATASET,
      rows: [observation],
    }),
  );

  return {
    runKind: input.runKind,
    runId: input.runId,
    skipped: null,
    tables,
  };
}

type BigqueryStatus = {
  target: {
    clientKey: string;
    dataset: string;
    gscExportDataset: string | null;
  } | null;
  /** Most recent attempt per table, newest first. */
  lastProjections: Array<{
    table: string;
    dataset: string;
    runKind: ProjectionRunKind;
    runId: string;
    rows: number;
    projectedAt: string;
    error: string | null;
  }>;
  /** Completed runs the cron has not finished projecting yet, oldest first. */
  pendingRuns: Array<{
    runKind: ProjectionRunKind;
    runId: string;
    completedAt: string;
  }>;
};

/** Target, the latest ledger row per table, and the backlog — the settings card. */
export async function getBigQueryStatus(
  projectId: string,
): Promise<BigqueryStatus> {
  const target = await BigqueryProjectionRepository.getTarget(projectId);
  if (!target) return { target: null, lastProjections: [], pendingRuns: [] };

  // The ledger comes back newest first, so the first row seen for a table is its
  // latest attempt.
  const latestByTable = new Map<
    string,
    BigqueryStatus["lastProjections"][number]
  >();
  for (const row of await BigqueryProjectionRepository.getLedgerForProject(
    projectId,
  )) {
    if (!latestByTable.has(row.tableName)) {
      latestByTable.set(row.tableName, { ...row, table: row.tableName });
    }
  }

  const pendingRuns = await BigqueryProjectionRepository.getPendingRuns({
    cutoff: lookbackCutoff(),
    limit: RUNS_PER_TICK,
    projectId,
  });

  return {
    target: {
      clientKey: target.clientKey,
      dataset: target.dataset,
      gscExportDataset: target.gscExportDataset,
    },
    lastProjections: sort([...latestByTable.values()], (a, b) =>
      b.projectedAt.localeCompare(a.projectedAt),
    ),
    pendingRuns: pendingRuns.map((run) => ({
      runKind: run.runKind,
      runId: run.runId,
      completedAt: run.completedAt,
    })),
  };
}

/**
 * Cron body: project the oldest unprojected runs across every kind. Takes
 * no Env — everything it needs is the ambient `cloudflare:workers` env (the
 * BigQuery client's KV token cache) and the database.
 */
export async function runPendingProjections(): Promise<void> {
  const pending = await BigqueryProjectionRepository.getPendingRuns({
    cutoff: lookbackCutoff(),
    limit: RUNS_PER_TICK,
  });

  const deadline = Date.now() + TICK_DEADLINE_MS;
  let projected = 0;
  let rowsMerged = 0;
  let tableErrors = 0;
  let runErrors = 0;
  let skippedNoTarget = 0;
  let stoppedByDeadline = false;

  for (const run of pending) {
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    try {
      const result = await projectRun(run);
      if (result.skipped === "no_bigquery_target") {
        skippedNoTarget++;
        continue;
      }
      projected++;
      for (const table of result.tables) {
        rowsMerged += table.rows;
        if (table.error) tableErrors++;
      }
    } catch (err) {
      // Only a failure outside `projectTable` reaches here (a source read), so
      // there is no ledger row to write and the run stays pending.
      runErrors++;
      console.error(
        `[bigquery-projection] Failed to project ${run.runKind} ${run.runId}:`,
        err,
      );
    }
  }

  const logSummary = tableErrors + runErrors > 0 ? console.error : console.log;
  logSummary({
    event: "bigquery_projection_summary",
    candidates: pending.length,
    projected,
    rowsMerged,
    tableErrors,
    runErrors,
    skippedNoTarget,
    stoppedByDeadline,
    oldestPendingAgeMs: pending[0]?.completedAt
      ? Date.now() - new Date(pending[0].completedAt).getTime()
      : null,
  });
}

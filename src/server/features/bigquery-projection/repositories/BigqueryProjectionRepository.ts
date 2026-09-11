/**
 * Reads the run rows a BigQuery projection is built from, and owns the
 * `bigquery_projections` ledger that says what has already been projected.
 *
 * One repository rather than one per run kind: the three source reads and the
 * ledger are always used together by the projection service, and the "what is
 * still pending" query has to span all three run tables anyway.
 */
import { and, asc, desc, eq, lt, sql, type SQLWrapper } from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import {
  auditRunIssueCounts,
  auditScheduleRuns,
  bigqueryProjections,
  mapsGridCellResults,
  mapsGridCells,
  mapsGridConfigs,
  mapsGridLocations,
  mapsGridRuns,
  projectBigqueryTargets,
  rankCheckRuns,
  rankSnapshotFeatures,
  rankSnapshots,
  rankTrackingConfigs,
} from "@/db/schema";
import type {
  AuditRunSource,
  MapsRunSource,
  ProjectionRunKind,
  ProjectionTableName,
  RankRunSource,
} from "@/server/features/bigquery-projection/projectionRows";

/** Ledger rows shown on the settings card; one project's history is small. */
const LEDGER_HISTORY_LIMIT = 60;

export type BigqueryTarget = {
  projectId: string;
  clientKey: string;
  dataset: string;
  gscExportDataset: string | null;
};

export type PendingRun = {
  runKind: ProjectionRunKind;
  runId: string;
  projectId: string;
  /** Completion timestamp, used only to project the oldest backlog first. */
  completedAt: string;
};

export type ProjectionLedgerRow = {
  runKind: ProjectionRunKind;
  runId: string;
  tableName: string;
  dataset: string;
  rows: number;
  projectedAt: string;
  error: string | null;
};

async function getTarget(projectId: string): Promise<BigqueryTarget | null> {
  const [target] = await db
    .select({
      projectId: projectBigqueryTargets.projectId,
      clientKey: projectBigqueryTargets.clientKey,
      dataset: projectBigqueryTargets.dataset,
      gscExportDataset: projectBigqueryTargets.gscExportDataset,
    })
    .from(projectBigqueryTargets)
    .where(eq(projectBigqueryTargets.projectId, projectId))
    .limit(1);
  return target ?? null;
}

/**
 * Count of distinct tables already projected successfully for one run. Written
 * as a correlated subquery so "is this run finished" is decided inside the same
 * scan as the run listing, on both SQLite and Postgres.
 */
function projectedTableCount(runKind: ProjectionRunKind, runId: SQLWrapper) {
  return sql<number>`(select count(distinct ${bigqueryProjections.tableName})
    from ${bigqueryProjections}
    where ${bigqueryProjections.runKind} = ${runKind}
      and ${bigqueryProjections.runId} = ${runId}
      and ${bigqueryProjections.error} is null)`;
}

async function getPendingAuditRuns(
  cutoff: string,
  limit: number,
  projectId?: string,
) {
  return db
    .select({
      runId: auditScheduleRuns.id,
      projectId: auditScheduleRuns.projectId,
      completedAt: auditScheduleRuns.completedAt,
    })
    .from(auditScheduleRuns)
    .innerJoin(
      projectBigqueryTargets,
      eq(projectBigqueryTargets.projectId, auditScheduleRuns.projectId),
    )
    .where(
      and(
        eq(auditScheduleRuns.status, "completed"),
        sql`${auditScheduleRuns.completedAt} is not null`,
        sql`${auditScheduleRuns.completedAt} >= ${cutoff}`,
        // weekly_health_metrics + observations.
        lt(projectedTableCount("audit_schedule_run", auditScheduleRuns.id), 2),
        projectId ? eq(auditScheduleRuns.projectId, projectId) : undefined,
      ),
    )
    .orderBy(asc(auditScheduleRuns.completedAt))
    .limit(limit);
}

async function getPendingRankRuns(
  cutoff: string,
  limit: number,
  projectId?: string,
) {
  return db
    .select({
      runId: rankCheckRuns.id,
      projectId: rankCheckRuns.projectId,
      completedAt: rankCheckRuns.completedAt,
    })
    .from(rankCheckRuns)
    .innerJoin(
      projectBigqueryTargets,
      eq(projectBigqueryTargets.projectId, rankCheckRuns.projectId),
    )
    .where(
      and(
        eq(rankCheckRuns.status, "completed"),
        // Subset runs re-check a handful of keywords; projecting them would add
        // a sparse run_id that skews any per-date average in the dataset. Same
        // exclusion the in-app trend queries make.
        eq(rankCheckRuns.isSubsetRun, false),
        sql`${rankCheckRuns.completedAt} is not null`,
        sql`${rankCheckRuns.completedAt} >= ${cutoff}`,
        // keyword_rankings + aio_tracking + observations.
        lt(projectedTableCount("rank_check_run", rankCheckRuns.id), 3),
        projectId ? eq(rankCheckRuns.projectId, projectId) : undefined,
      ),
    )
    .orderBy(asc(rankCheckRuns.completedAt))
    .limit(limit);
}

async function getPendingMapsRuns(
  cutoff: string,
  limit: number,
  projectId?: string,
) {
  return db
    .select({
      runId: mapsGridRuns.id,
      projectId: mapsGridRuns.projectId,
      completedAt: mapsGridRuns.completedAt,
    })
    .from(mapsGridRuns)
    .innerJoin(
      projectBigqueryTargets,
      eq(projectBigqueryTargets.projectId, mapsGridRuns.projectId),
    )
    .where(
      and(
        eq(mapsGridRuns.status, "completed"),
        sql`${mapsGridRuns.completedAt} is not null`,
        sql`${mapsGridRuns.completedAt} >= ${cutoff}`,
        // maps_rankings + observations.
        lt(projectedTableCount("maps_grid_run", mapsGridRuns.id), 2),
        projectId ? eq(mapsGridRuns.projectId, projectId) : undefined,
      ),
    )
    .orderBy(asc(mapsGridRuns.completedAt))
    .limit(limit);
}

/**
 * Completed runs of all three kinds that still owe at least one table, oldest
 * first. Only projects with a `project_bigquery_targets` row are considered, and
 * only runs inside the lookback window — a first deployment must not try to
 * backfill every run ever recorded (the settings card projects an older run on
 * demand).
 */
async function getPendingRuns(input: {
  cutoff: string;
  limit: number;
  /** Set by the on-demand path to scope the backlog to one project. */
  projectId?: string;
}): Promise<PendingRun[]> {
  const [audit, rank, maps] = await Promise.all([
    getPendingAuditRuns(input.cutoff, input.limit, input.projectId),
    getPendingRankRuns(input.cutoff, input.limit, input.projectId),
    getPendingMapsRuns(input.cutoff, input.limit, input.projectId),
  ]);
  const kinds: Array<[ProjectionRunKind, typeof audit]> = [
    ["audit_schedule_run", audit],
    ["rank_check_run", rank],
    ["maps_grid_run", maps],
  ];
  const all = kinds.flatMap(([runKind, runs]) =>
    runs.map((run) => ({
      runKind,
      runId: run.runId,
      projectId: run.projectId,
      completedAt: run.completedAt ?? "",
    })),
  );
  return sort(all, (a, b) => a.completedAt.localeCompare(b.completedAt)).slice(
    0,
    input.limit,
  );
}

async function getAuditRunSource(
  runId: string,
): Promise<{ projectId: string; source: AuditRunSource } | null> {
  const [run] = await db
    .select({
      id: auditScheduleRuns.id,
      projectId: auditScheduleRuns.projectId,
      cadence: auditScheduleRuns.cadence,
      triggeredAt: auditScheduleRuns.triggeredAt,
      completedAt: auditScheduleRuns.completedAt,
      pagesCrawled: auditScheduleRuns.pagesCrawled,
      pagesWithErrors: auditScheduleRuns.pagesWithErrors,
      pagesWithWarnings: auditScheduleRuns.pagesWithWarnings,
      pagesWithNotices: auditScheduleRuns.pagesWithNotices,
      pagesBlocked: auditScheduleRuns.pagesBlocked,
      healthScore: auditScheduleRuns.healthScore,
      healthScoreDelta: auditScheduleRuns.healthScoreDelta,
    })
    .from(auditScheduleRuns)
    .where(eq(auditScheduleRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const issueCounts = await db
    .select({
      issueType: auditRunIssueCounts.issueType,
      severity: auditRunIssueCounts.severity,
      pages: auditRunIssueCounts.pages,
    })
    .from(auditRunIssueCounts)
    .where(eq(auditRunIssueCounts.runId, runId));

  return { projectId: run.projectId, source: { run, issueCounts } };
}

async function getRankRunSource(
  runId: string,
): Promise<{ projectId: string; source: RankRunSource } | null> {
  const [run] = await db
    .select({
      id: rankCheckRuns.id,
      projectId: rankCheckRuns.projectId,
      startedAt: rankCheckRuns.startedAt,
      completedAt: rankCheckRuns.completedAt,
      locationName: rankTrackingConfigs.locationName,
      locationCode: rankTrackingConfigs.locationCode,
    })
    .from(rankCheckRuns)
    .innerJoin(
      rankTrackingConfigs,
      eq(rankTrackingConfigs.id, rankCheckRuns.configId),
    )
    .where(eq(rankCheckRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const snapshots = await db
    .select({
      id: rankSnapshots.id,
      keyword: rankSnapshots.keyword,
      device: rankSnapshots.device,
      position: rankSnapshots.position,
      url: rankSnapshots.url,
      aioPresent: rankSnapshots.aioPresent,
      aioClientCited: rankSnapshots.aioClientCited,
      aioCitationPosition: rankSnapshots.aioCitationPosition,
    })
    .from(rankSnapshots)
    .where(eq(rankSnapshots.runId, runId));

  const features = await db
    .select({
      snapshotId: rankSnapshotFeatures.snapshotId,
      featureType: rankSnapshotFeatures.featureType,
      rankAbsolute: rankSnapshotFeatures.rankAbsolute,
      clientPresent: rankSnapshotFeatures.clientPresent,
    })
    .from(rankSnapshotFeatures)
    .innerJoin(
      rankSnapshots,
      eq(rankSnapshots.id, rankSnapshotFeatures.snapshotId),
    )
    .where(eq(rankSnapshots.runId, runId));

  return {
    projectId: run.projectId,
    source: {
      run,
      config: {
        locationName: run.locationName,
        locationCode: run.locationCode,
      },
      snapshots,
      features,
    },
  };
}

async function getMapsRunSource(
  runId: string,
): Promise<{ projectId: string; source: MapsRunSource } | null> {
  const [run] = await db
    .select({
      id: mapsGridRuns.id,
      projectId: mapsGridRuns.projectId,
      startedAt: mapsGridRuns.startedAt,
      completedAt: mapsGridRuns.completedAt,
      locationSlug: mapsGridLocations.slug,
    })
    .from(mapsGridRuns)
    .innerJoin(mapsGridConfigs, eq(mapsGridConfigs.id, mapsGridRuns.configId))
    .innerJoin(
      mapsGridLocations,
      eq(mapsGridLocations.id, mapsGridConfigs.locationId),
    )
    .where(eq(mapsGridRuns.id, runId))
    .limit(1);
  if (!run) return null;

  const cells = await db
    .select({
      id: mapsGridCells.id,
      keyword: mapsGridCells.keyword,
      lat: mapsGridCells.lat,
      lng: mapsGridCells.lng,
      clientRank: mapsGridCells.clientRank,
      providerTaskId: mapsGridCells.providerTaskId,
    })
    .from(mapsGridCells)
    .where(eq(mapsGridCells.runId, runId));

  const cellResults = await db
    .select({
      cellId: mapsGridCellResults.cellId,
      name: mapsGridCellResults.name,
      rank: mapsGridCellResults.rank,
      rating: mapsGridCellResults.rating,
      url: mapsGridCellResults.url,
      isClient: mapsGridCellResults.isClient,
    })
    .from(mapsGridCellResults)
    .innerJoin(mapsGridCells, eq(mapsGridCells.id, mapsGridCellResults.cellId))
    .where(eq(mapsGridCells.runId, runId));

  return {
    projectId: run.projectId,
    source: { run, locationSlug: run.locationSlug, cells, cellResults },
  };
}

/**
 * Record one (run, table) projection attempt. Upsert on the unique index so a
 * retry after a failure replaces the error row in place, which is also what
 * makes the pending query converge.
 */
async function recordProjection(input: {
  projectId: string;
  runKind: ProjectionRunKind;
  runId: string;
  tableName: ProjectionTableName | "observations";
  dataset: string;
  rows: number;
  error: string | null;
}): Promise<void> {
  const projectedAt = new Date().toISOString();
  await db
    .insert(bigqueryProjections)
    .values({ ...input, projectedAt })
    .onConflictDoUpdate({
      target: [
        bigqueryProjections.runKind,
        bigqueryProjections.runId,
        bigqueryProjections.tableName,
      ],
      set: {
        projectId: input.projectId,
        dataset: input.dataset,
        rows: input.rows,
        error: input.error,
        projectedAt,
      },
    });
}

async function getLedgerForProject(
  projectId: string,
): Promise<ProjectionLedgerRow[]> {
  return db
    .select({
      runKind: bigqueryProjections.runKind,
      runId: bigqueryProjections.runId,
      tableName: bigqueryProjections.tableName,
      dataset: bigqueryProjections.dataset,
      rows: bigqueryProjections.rows,
      projectedAt: bigqueryProjections.projectedAt,
      error: bigqueryProjections.error,
    })
    .from(bigqueryProjections)
    .where(eq(bigqueryProjections.projectId, projectId))
    .orderBy(desc(bigqueryProjections.projectedAt))
    .limit(LEDGER_HISTORY_LIMIT);
}

export const BigqueryProjectionRepository = {
  getTarget,
  getPendingRuns,
  getAuditRunSource,
  getRankRunSource,
  getMapsRunSource,
  recordProjection,
  getLedgerForProject,
};

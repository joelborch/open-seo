/**
 * The run rows each BigQuery projection is built from, one read per run kind.
 *
 * Split out of BigqueryProjectionRepository, which re-exports these: the backlog
 * query and the projection ledger are one concern, and "load the source for this
 * run" is another that grows with every new run kind.
 */
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  auditRunIssueCounts,
  auditScheduleRuns,
  gbpSnapshotAttributes,
  gbpSnapshots,
  mapsGridCellResults,
  mapsGridCells,
  mapsGridConfigs,
  mapsGridLocations,
  mapsGridRuns,
  rankCheckRuns,
  rankSnapshotFeatures,
  rankSnapshots,
  rankTrackingConfigs,
} from "@/db/schema";
import type {
  AuditRunSource,
  GbpSnapshotSource,
  MapsRunSource,
  RankRunSource,
} from "@/server/features/bigquery-projection/projectionRows";

export async function getAuditRunSource(
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

export async function getRankRunSource(
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

export async function getMapsRunSource(
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
 * One GBP snapshot with the location it belongs to. The join is a LEFT join
 * because `gbp_snapshots.location_id` has no foreign key — the history outlives
 * the location row — and `location_slug` is a merge key, so a deleted location
 * falls back to its id rather than projecting a null.
 */
export async function getGbpSnapshotSource(
  snapshotId: string,
): Promise<{ projectId: string; source: GbpSnapshotSource } | null> {
  const [row] = await db
    .select({
      id: gbpSnapshots.id,
      projectId: gbpSnapshots.projectId,
      locationId: gbpSnapshots.locationId,
      runDate: gbpSnapshots.runDate,
      name: gbpSnapshots.name,
      placeId: gbpSnapshots.placeId,
      cid: gbpSnapshots.cid,
      primaryCategory: gbpSnapshots.primaryCategory,
      rating: gbpSnapshots.rating,
      reviewsCount: gbpSnapshots.reviewsCount,
      isClaimed: gbpSnapshots.isClaimed,
      address: gbpSnapshots.address,
      phone: gbpSnapshots.phone,
      website: gbpSnapshots.website,
      photosCount: gbpSnapshots.photosCount,
      providerTaskId: gbpSnapshots.providerTaskId,
      locationSlug: mapsGridLocations.slug,
      locationName: mapsGridLocations.name,
    })
    .from(gbpSnapshots)
    .leftJoin(
      mapsGridLocations,
      eq(mapsGridLocations.id, gbpSnapshots.locationId),
    )
    .where(eq(gbpSnapshots.id, snapshotId))
    .limit(1);
  if (!row) return null;

  const [previous] = await db
    .select({ reviewsCount: gbpSnapshots.reviewsCount })
    .from(gbpSnapshots)
    .where(
      and(
        eq(gbpSnapshots.locationId, row.locationId),
        lt(gbpSnapshots.runDate, row.runDate),
      ),
    )
    .orderBy(desc(gbpSnapshots.runDate))
    .limit(1);

  const attributes = await db
    .select({
      key: gbpSnapshotAttributes.key,
      value: gbpSnapshotAttributes.value,
    })
    .from(gbpSnapshotAttributes)
    .where(eq(gbpSnapshotAttributes.snapshotId, snapshotId))
    .orderBy(asc(gbpSnapshotAttributes.id));

  return {
    projectId: row.projectId,
    source: {
      snapshot: row,
      locationSlug: row.locationSlug ?? row.locationId,
      locationName: row.locationName,
      previousReviewsCount: previous?.reviewsCount ?? null,
      attributes,
    },
  };
}

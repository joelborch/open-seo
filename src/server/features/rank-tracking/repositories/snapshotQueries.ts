import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
  max,
  min,
  sql,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import {
  rankCheckRuns,
  rankSnapshots,
  rankSnapshotFeatures,
  rankSnapshotAioCitations,
} from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";
import { toSqliteTimestamp } from "@/server/features/rank-tracking/rankTrackingTimestamps";

function completedRunIdsForConfig(configId: string) {
  return db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        eq(rankCheckRuns.status, "completed"),
      ),
    );
}

function cutoffTimestamp(sinceDays: number): string {
  return toSqliteTimestamp(
    new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000),
  );
}

/**
 * Flat per-keyword position series across completed runs, ordered oldest first.
 * `null` position = checked but not found within serpDepth (a real event, not a
 * missing check). The client pivots these rows per device.
 */
export async function getKeywordHistory(
  configId: string,
  trackingKeywordId: string,
  sinceDays: number,
) {
  return db
    .select({
      device: rankSnapshots.device,
      checkedAt: rankSnapshots.checkedAt,
      position: rankSnapshots.position,
    })
    .from(rankSnapshots)
    .where(
      and(
        inArray(rankSnapshots.runId, completedRunIdsForConfig(configId)),
        eq(rankSnapshots.trackingKeywordId, trackingKeywordId),
        gte(rankSnapshots.checkedAt, cutoffTimestamp(sinceDays)),
      ),
    )
    .orderBy(asc(rankSnapshots.checkedAt));
}

/**
 * Per-run keyword-position distribution for one device, oldest first. Grouped
 * by runId (not checkedAt — snapshots in a run don't share an exact insert
 * time); the run's startedAt is the x-axis timestamp. The buckets are disjoint
 * and cover every tracked keyword: a position past 20, or null (not found in
 * the tracked depth), falls into "not ranking" (derived from `total`).
 */
export async function getConfigTrend(
  configId: string,
  device: "desktop" | "mobile",
  sinceDays: number,
) {
  return db
    .select({
      runId: rankSnapshots.runId,
      checkedAt: rankCheckRuns.startedAt,
      total: count(),
      top3: sql<number>`sum(case when ${rankSnapshots.position} between 1 and 3 then 1 else 0 end)`,
      top4to10: sql<number>`sum(case when ${rankSnapshots.position} between 4 and 10 then 1 else 0 end)`,
      top11to20: sql<number>`sum(case when ${rankSnapshots.position} between 11 and 20 then 1 else 0 end)`,
    })
    .from(rankSnapshots)
    .innerJoin(rankCheckRuns, eq(rankSnapshots.runId, rankCheckRuns.id))
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        eq(rankCheckRuns.status, "completed"),
        eq(rankCheckRuns.isSubsetRun, false),
        eq(rankSnapshots.device, device),
        gte(rankSnapshots.checkedAt, cutoffTimestamp(sinceDays)),
      ),
    )
    .groupBy(rankSnapshots.runId, rankCheckRuns.startedAt)
    .orderBy(asc(rankCheckRuns.startedAt));
}

/**
 * Recent per-keyword positions for one device as a flat list, for the "by date"
 * history matrix. Bounded to the last `runLimit` completed runs; the client
 * pivots these into keyword rows × run (date) columns.
 */
export async function getPositionMatrix(
  configId: string,
  device: "desktop" | "mobile",
  runLimit: number,
) {
  const recentRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        eq(rankCheckRuns.status, "completed"),
        eq(rankCheckRuns.isSubsetRun, false),
      ),
    )
    .orderBy(desc(rankCheckRuns.startedAt))
    .limit(runLimit);

  return db
    .select({
      runId: rankSnapshots.runId,
      checkedAt: rankCheckRuns.startedAt,
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      position: rankSnapshots.position,
    })
    .from(rankSnapshots)
    .innerJoin(rankCheckRuns, eq(rankSnapshots.runId, rankCheckRuns.id))
    .where(
      and(
        inArray(rankSnapshots.runId, recentRunIds),
        eq(rankSnapshots.device, device),
      ),
    )
    .orderBy(asc(rankCheckRuns.startedAt));
}

/**
 * Pick one snapshot per keyword+device from completed runs, using SQL GROUP BY
 * + self-join instead of loading all snapshots into JS memory.
 *
 * No keywordIds needed — scoped to the config via a completed-runs subquery,
 * so subset runs are included automatically.
 */
export async function getSnapshotsForConfig(
  configId: string,
  opts: { beforeDate?: string; order: "latest" | "earliest" },
) {
  const completedRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        eq(rankCheckRuns.status, "completed"),
      ),
    );

  const aggFn = opts.order === "latest" ? max : min;

  const conditions = [inArray(rankSnapshots.runId, completedRunIds)];
  if (opts.beforeDate) {
    conditions.push(lte(rankSnapshots.checkedAt, opts.beforeDate));
  }

  const grouped = db
    .select({
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      device: rankSnapshots.device,
      targetCheckedAt: aggFn(rankSnapshots.checkedAt).as("target_checked_at"),
    })
    .from(rankSnapshots)
    .where(and(...conditions))
    .groupBy(rankSnapshots.trackingKeywordId, rankSnapshots.device)
    .as("grouped");

  return db
    .select({
      id: rankSnapshots.id,
      runId: rankSnapshots.runId,
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      keyword: rankSnapshots.keyword,
      device: rankSnapshots.device,
      position: rankSnapshots.position,
      rankAbsolute: rankSnapshots.rankAbsolute,
      localPackPosition: rankSnapshots.localPackPosition,
      aioPresent: rankSnapshots.aioPresent,
      aioClientCited: rankSnapshots.aioClientCited,
      aioCitationPosition: rankSnapshots.aioCitationPosition,
      aioSnippet: rankSnapshots.aioSnippet,
      url: rankSnapshots.url,
      serpFeatures: rankSnapshots.serpFeatures,
      checkedAt: rankSnapshots.checkedAt,
    })
    .from(rankSnapshots)
    .innerJoin(
      grouped,
      and(
        eq(rankSnapshots.trackingKeywordId, grouped.trackingKeywordId),
        eq(rankSnapshots.device, grouped.device),
        eq(rankSnapshots.checkedAt, grouped.targetCheckedAt),
      ),
    )
    .where(inArray(rankSnapshots.runId, completedRunIds));
}

export async function getLatestSnapshotsForKeywords(configId: string) {
  return getSnapshotsForConfig(configId, { order: "latest" });
}

export async function getSnapshotsBeforeDate(
  configId: string,
  beforeDate: string,
) {
  return getSnapshotsForConfig(configId, { beforeDate, order: "latest" });
}

export async function getEarliestSnapshotsForKeywords(
  configId: string,
  keywordIds: string[],
) {
  if (keywordIds.length === 0) return [];

  const completedRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        eq(rankCheckRuns.status, "completed"),
      ),
    );

  // D1 caps bound parameters at 100 per statement. The query binds N keyword
  // IDs plus 4 params from the completedRunIds subquery (referenced twice).
  // (Postgres allows far more, but the chunking is harmless there.)
  const CHUNK_SIZE = 90;
  const allResults: Awaited<ReturnType<typeof getSnapshotsForConfig>> = [];

  for (let i = 0; i < keywordIds.length; i += CHUNK_SIZE) {
    const chunk = keywordIds.slice(i, i + CHUNK_SIZE);

    const grouped = db
      .select({
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        device: rankSnapshots.device,
        targetCheckedAt: min(rankSnapshots.checkedAt).as("target_checked_at"),
      })
      .from(rankSnapshots)
      .where(
        and(
          inArray(rankSnapshots.runId, completedRunIds),
          inArray(rankSnapshots.trackingKeywordId, chunk),
        ),
      )
      .groupBy(rankSnapshots.trackingKeywordId, rankSnapshots.device)
      .as("grouped");

    const rows = await db
      .select({
        id: rankSnapshots.id,
        runId: rankSnapshots.runId,
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        keyword: rankSnapshots.keyword,
        device: rankSnapshots.device,
        position: rankSnapshots.position,
        rankAbsolute: rankSnapshots.rankAbsolute,
        localPackPosition: rankSnapshots.localPackPosition,
        aioPresent: rankSnapshots.aioPresent,
        aioClientCited: rankSnapshots.aioClientCited,
        aioCitationPosition: rankSnapshots.aioCitationPosition,
        aioSnippet: rankSnapshots.aioSnippet,
        url: rankSnapshots.url,
        serpFeatures: rankSnapshots.serpFeatures,
        checkedAt: rankSnapshots.checkedAt,
      })
      .from(rankSnapshots)
      .innerJoin(
        grouped,
        and(
          eq(rankSnapshots.trackingKeywordId, grouped.trackingKeywordId),
          eq(rankSnapshots.device, grouped.device),
          eq(rankSnapshots.checkedAt, grouped.targetCheckedAt),
        ),
      )
      .where(inArray(rankSnapshots.runId, completedRunIds));

    allResults.push(...rows);
  }

  return allResults;
}

export async function insertSnapshots(
  snapshots: Array<
    Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt">
  >,
) {
  // Target the (run, keyword, device) unique index explicitly. An UNtargeted
  // ON CONFLICT DO NOTHING also swallows a primary-key collision, which would
  // silently drop every row if the `id` serial sequence ever drifts behind
  // max(id) (e.g. after a data import that copied explicit ids). Scoping the
  // clause to the intended dedupe index keeps re-runs idempotent while letting
  // a pk collision surface as a loud duplicate-key error instead of data loss.
  await executeInBatches(snapshots, (tx, snapshot) =>
    tx
      .insert(rankSnapshots)
      .values(snapshot)
      .onConflictDoNothing({
        target: [
          rankSnapshots.runId,
          rankSnapshots.trackingKeywordId,
          rankSnapshots.device,
        ],
      }),
  );
}

export async function getSnapshotsForRun(runId: string) {
  return db.select().from(rankSnapshots).where(eq(rankSnapshots.runId, runId));
}

/** (keyword, device) -> snapshot id for a run, so features can be attached. */
export async function getSnapshotIdsForRun(runId: string) {
  return db
    .select({
      id: rankSnapshots.id,
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      device: rankSnapshots.device,
    })
    .from(rankSnapshots)
    .where(eq(rankSnapshots.runId, runId));
}

/**
 * Rewrite the normalized detail rows for a set of snapshots: the SERP features
 * observed and the sources an AI Overview cited. Delete-then-insert rather than
 * upsert because a replayed workflow step must not double the rows, and both
 * tables are rewritten together so a retried write can never leave a snapshot
 * with this round's features beside the last round's citations.
 */
export async function replaceSnapshotDetail(
  snapshotIds: number[],
  rows: {
    features: Array<InferInsertModel<typeof rankSnapshotFeatures>>;
    aioCitations: Array<InferInsertModel<typeof rankSnapshotAioCitations>>;
  },
) {
  if (snapshotIds.length === 0) return;
  // One extra bind is unused here, but keep the IN list under D1's ~100
  // bound-parameter ceiling.
  const deleteBatchSize = 90;
  for (let i = 0; i < snapshotIds.length; i += deleteBatchSize) {
    const ids = snapshotIds.slice(i, i + deleteBatchSize);
    await db
      .delete(rankSnapshotFeatures)
      .where(inArray(rankSnapshotFeatures.snapshotId, ids));
    await db
      .delete(rankSnapshotAioCitations)
      .where(inArray(rankSnapshotAioCitations.snapshotId, ids));
  }
  await executeInBatches(rows.features, (tx, row) =>
    tx.insert(rankSnapshotFeatures).values(row),
  );
  await executeInBatches(rows.aioCitations, (tx, row) =>
    tx.insert(rankSnapshotAioCitations).values(row),
  );
}

/**
 * The AI Overview citations recorded for a set of snapshots, in citation order.
 * Chunked for the same D1 bound-parameter ceiling as the rewrite above.
 */
export async function getAioCitationsForSnapshots(snapshotIds: number[]) {
  const rows: Array<{
    snapshotId: number;
    position: number;
    domain: string;
    url: string | null;
    isClient: boolean;
  }> = [];
  const batchSize = 90;
  for (let i = 0; i < snapshotIds.length; i += batchSize) {
    rows.push(
      ...(await db
        .select({
          snapshotId: rankSnapshotAioCitations.snapshotId,
          position: rankSnapshotAioCitations.position,
          domain: rankSnapshotAioCitations.domain,
          url: rankSnapshotAioCitations.url,
          isClient: rankSnapshotAioCitations.isClient,
        })
        .from(rankSnapshotAioCitations)
        .where(
          inArray(
            rankSnapshotAioCitations.snapshotId,
            snapshotIds.slice(i, i + batchSize),
          ),
        )
        .orderBy(rankSnapshotAioCitations.position)),
    );
  }
  return rows;
}

import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import type { RankCheckResult } from "@/server/lib/dataforseo";

export type RankCheckResultWithDevice = RankCheckResult & {
  device: "desktop" | "mobile";
};

/**
 * Write one batch of check results: the snapshot rows plus their normalized
 * SERP-feature rows, and report the run's distinct keyword count so callers can
 * update progress without a second read.
 *
 * The feature rows need the snapshot ids, which the batched insert doesn't
 * return, so the ids are read back for the whole run — the same read that
 * yields the progress count. Shared by the live path, the queued collect loop
 * and the on-demand retrieval pass so all three persist identical detail.
 */
export async function persistRankCheckResults(
  runId: string,
  results: RankCheckResultWithDevice[],
): Promise<number> {
  if (results.length === 0) return 0;

  await RankTrackingRepository.insertSnapshots(
    results.map((result) => ({
      runId,
      trackingKeywordId: result.keywordId,
      keyword: result.keyword,
      device: result.device,
      position: result.position,
      rankAbsolute: result.rankAbsolute,
      localPackPosition: result.localPackPosition,
      aioPresent: result.aioPresent,
      aioClientCited: result.aioClientCited,
      aioCitationPosition: result.aioCitationPosition,
      url: result.url,
      serpFeatures:
        result.serpFeatures.length > 0
          ? JSON.stringify(result.serpFeatures)
          : null,
    })),
  );

  const snapshots = await RankTrackingRepository.getSnapshotIdsForRun(runId);
  const idByKey = new Map(
    snapshots.map((snapshot) => [
      `${snapshot.trackingKeywordId}:${snapshot.device}`,
      snapshot.id,
    ]),
  );

  const touchedIds: number[] = [];
  const featureRows = [];
  for (const result of results) {
    const snapshotId = idByKey.get(`${result.keywordId}:${result.device}`);
    // Absent only if the insert was skipped by the (run, keyword, device)
    // conflict target for a row this batch didn't own — nothing to attach to.
    if (snapshotId === undefined) continue;
    touchedIds.push(snapshotId);
    for (const feature of result.features) {
      featureRows.push({
        snapshotId,
        featureType: feature.featureType,
        rankAbsolute: feature.rankAbsolute,
        clientPresent: feature.clientPresent,
      });
    }
  }
  await RankTrackingRepository.replaceSnapshotFeatures(touchedIds, featureRows);

  return new Set(snapshots.map((snapshot) => snapshot.trackingKeywordId)).size;
}

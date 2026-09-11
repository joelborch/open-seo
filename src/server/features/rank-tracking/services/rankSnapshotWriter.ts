import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import type { RankCheckResult } from "@/server/lib/dataforseo";

export type RankCheckResultWithDevice = RankCheckResult & {
  device: "desktop" | "mobile";
};

/**
 * Write one batch of check results: the snapshot rows plus their normalized
 * SERP-feature and AI-Overview-citation rows, and report the run's distinct
 * keyword count so callers can update progress without a second read.
 *
 * The detail rows need the snapshot ids, which the batched insert doesn't
 * return, so the ids are read back for the whole run — the same read that
 * yields the progress count. Shared by the live path, the queued collect loop
 * and the on-demand retrieval pass so all three persist identical detail.
 *
 * Snapshot rows are inserted on-conflict-do-nothing per (run, keyword, device),
 * so a result whose row already existed keeps the *earlier* row's values. Its
 * features and citations are therefore left alone too: rewriting them would bolt
 * a live fallback's SERP detail onto a queued snapshot's position, and the keys
 * that already existed before this call are what identifies those.
 */
export async function persistRankCheckResults(
  runId: string,
  results: RankCheckResultWithDevice[],
): Promise<number> {
  if (results.length === 0) return 0;

  const preExisting = new Set(
    (await RankTrackingRepository.getSnapshotIdsForRun(runId)).map(
      (snapshot) => `${snapshot.trackingKeywordId}:${snapshot.device}`,
    ),
  );

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
      aioBrandMentioned: result.aioBrandMentioned,
      aioSnippet: result.aioSnippet,
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
  const features = [];
  const aioCitations = [];
  for (const result of results) {
    const key = `${result.keywordId}:${result.device}`;
    // The base row belongs to an earlier write, so its detail rows do too.
    if (preExisting.has(key)) continue;
    const snapshotId = idByKey.get(key);
    // Absent only if the insert was skipped by the (run, keyword, device)
    // conflict target for a row this batch didn't own — nothing to attach to.
    if (snapshotId === undefined) continue;
    touchedIds.push(snapshotId);
    for (const feature of result.features) {
      features.push({
        snapshotId,
        featureType: feature.featureType,
        rankAbsolute: feature.rankAbsolute,
        clientPresent: feature.clientPresent,
      });
    }
    for (const citation of result.aioCitations) {
      aioCitations.push({
        snapshotId,
        position: citation.position,
        domain: citation.domain,
        url: citation.url,
        isClient: citation.isClient,
      });
    }
  }
  await RankTrackingRepository.replaceSnapshotDetail(touchedIds, {
    features,
    aioCitations,
  });

  return new Set(snapshots.map((snapshot) => snapshot.trackingKeywordId)).size;
}

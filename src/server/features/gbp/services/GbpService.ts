/**
 * Captures and reads Google Business Profile snapshots for a project's locations.
 *
 * A capture is two provider calls: the live profile read, and a queued reviews
 * task whose result the cron collects for free on a later tick. The day's slot in
 * `gbp_snapshots` is claimed BEFORE either call, so a concurrent capture — a user
 * pressing "Capture now" while the scheduler is mid-tick — reads the existing row
 * instead of buying the profile twice, and a capture that fails deletes its own
 * claim so the location stays retryable.
 */
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  GbpRepository,
  HISTORY_PER_LOCATION,
  type GbpLocationWithSchedule,
  type GbpReviewRow,
} from "@/server/features/gbp/repositories/GbpRepository";
import {
  createDataforseoClient,
  fetchBusinessDataTaskResult,
} from "@/server/lib/dataforseo";
import {
  formatGbpCoordinate,
  parseGbpReviews,
} from "@/server/lib/dataforseo/gbpSnapshot";
import { AppError } from "@/server/lib/errors";
import { computeNextCheckAt, usdToMicros } from "@/shared/rank-tracking";

/**
 * Language the profile is read in. A single constant rather than a per-location
 * setting: `language_code` only picks which translation of Google's own labels
 * comes back, and every field a snapshot stores (rating, counts, NAP) is
 * language-independent.
 */
const PROFILE_LANGUAGE_CODE = "en";

type GbpCaptureResult = {
  snapshotId: string;
  runDate: string;
  /** False when a snapshot for this location and date already existed. */
  created: boolean;
  /** False when DataForSEO charged for a lookup that matched no profile. */
  profileFound: boolean;
  reviewsCollected: boolean;
  /** What the two provider calls cost, 0 on the idempotent path. */
  costMicros: number;
};

/** Today, as the snapshot's `run_date`. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Collect a snapshot's queued reviews. Free at DataForSEO — the task was charged
 * at post — so this is safe to call on every tick and on every repeat capture.
 * Returns false while the task is still in the provider's queue.
 */
export async function collectSnapshotReviews(input: {
  snapshotId: string;
  providerTaskId: string;
}): Promise<boolean> {
  const outcome = await fetchBusinessDataTaskResult({
    endpoint: "reviews",
    taskId: input.providerTaskId,
  });
  if (outcome.status === "pending") return false;

  await GbpRepository.replaceReviews({
    snapshotId: input.snapshotId,
    reviews: parseGbpReviews(outcome.result),
    collectedAt: new Date().toISOString(),
  });
  return true;
}

/**
 * The identifier the profile lookup is pinned to, most precise first. A cid a
 * previous snapshot resolved beats the location's `place_id` because Google keys
 * its own profile on it. Office labels are not business identities: never buy
 * a lookup for a city or neighborhood when neither precise identifier exists.
 */
function profileKeyword(target: {
  lastCid: string | null;
  placeId: string | null;
  name: string;
}): string {
  if (target.lastCid) return `cid:${target.lastCid}`;
  if (target.placeId) return `place_id:${target.placeId}`;
  throw new AppError(
    "VALIDATION_ERROR",
    "GBP capture requires a verified Place ID or previously resolved CID",
  );
}

/**
 * Snapshot one location's profile. Idempotent per (location, day): a second call
 * on the same date spends nothing and instead tries to collect the reviews the
 * first call queued.
 */
export async function captureGbpSnapshot(input: {
  locationId: string;
  /** Authorization scope — a location in another project reads as not found. */
  projectId: string;
  billingCustomer: BillingCustomerContext;
}): Promise<GbpCaptureResult> {
  const target = await GbpRepository.getCaptureTarget(input.locationId);
  if (!target || target.projectId !== input.projectId) {
    throw new AppError("NOT_FOUND", "Location not found");
  }

  const runDate = today();
  const snapshotId = crypto.randomUUID();
  const claimed = await GbpRepository.claimSnapshot({
    id: snapshotId,
    projectId: target.projectId,
    locationId: target.locationId,
    runDate,
  });

  if (!claimed) {
    const existing = await GbpRepository.getSnapshotForDate(
      target.locationId,
      runDate,
    );
    // Unreachable: the insert can only conflict on (location_id, run_date).
    if (!existing) {
      throw new AppError("CONFLICT", "Snapshot for today is being written");
    }
    const reviewsCollected =
      existing.reviewsCollectedAt !== null
        ? true
        : existing.providerTaskId !== null &&
          (await collectSnapshotReviews({
            snapshotId: existing.id,
            providerTaskId: existing.providerTaskId,
          }));
    return {
      snapshotId: existing.id,
      runDate,
      created: false,
      profileFound: existing.name !== null,
      reviewsCollected,
      costMicros: 0,
    };
  }

  try {
    const client = createDataforseoClient(input.billingCustomer);
    const locationCoordinate = formatGbpCoordinate(
      target.lat,
      target.lng,
      target.radiusMiles,
    );
    const queryIdentity = profileKeyword(target);
    const { profile, costUsd, profileTaskId, profileStatusCode } =
      await client.business.gbpProfile({
        keyword: queryIdentity,
        locationCoordinate,
        languageCode: PROFILE_LANGUAGE_CODE,
      });

    let costMicros = usdToMicros(costUsd);
    await GbpRepository.updateSnapshot(snapshotId, {
      queryIdentity,
      profileTaskId,
      profileStatusCode,
      placeId: profile?.placeId ?? target.placeId,
      cid: profile?.cid ?? null,
      name: profile?.name ?? null,
      primaryCategory: profile?.primaryCategory ?? null,
      rating: profile?.rating ?? null,
      reviewsCount: profile?.reviewsCount ?? null,
      isClaimed: profile?.isClaimed ?? null,
      address: profile?.address ?? null,
      phone: profile?.phone ?? null,
      website: profile?.website ?? null,
      photosCount: profile?.photosCount ?? null,
      costMicros,
    });

    if (!profile) {
      // Google has no profile at this identity. A billed empty result is a real
      // observation, so the row stays — but there are no reviews to buy.
      return {
        snapshotId,
        runDate,
        created: true,
        profileFound: false,
        reviewsCollected: false,
        costMicros,
      };
    }

    await GbpRepository.replaceAttributes(snapshotId, [
      ...profile.availableAttributes,
      // Additional categories ride in the attributes table under their own key;
      // see the schema comment for why they don't get a table of their own.
      ...profile.additionalCategories.map((value) => ({
        key: "additional_category",
        value,
      })),
    ]);

    // Reviews are queued at standard priority, so they almost never land inside
    // this call. The cron drains them on a later tick at no extra cost; a failure
    // here must not discard the profile we already paid for.
    try {
      const posted = await client.business.gbpReviewsTaskPost({
        cid: profile.cid ?? undefined,
        placeId: profile.cid ? undefined : (profile.placeId ?? undefined),
        keyword:
          profile.cid || profile.placeId
            ? undefined
            : (profile.name ?? undefined),
        locationCoordinate,
        languageCode: PROFILE_LANGUAGE_CODE,
      });
      costMicros += usdToMicros(posted.costUsd);
      await GbpRepository.updateSnapshot(snapshotId, {
        providerTaskId: posted.taskId,
        costMicros,
      });
    } catch (err) {
      console.error(
        `[gbp] Failed to queue reviews for location ${target.locationId} (project ${target.projectId}):`,
        err,
      );
    }

    return {
      snapshotId,
      runDate,
      created: true,
      profileFound: true,
      reviewsCollected: false,
      costMicros,
    };
  } catch (err) {
    // Give the day's slot back: a transient provider failure must not wedge this
    // location until tomorrow. Nothing references the row yet, so the delete
    // cascades nothing.
    await GbpRepository.deleteSnapshot(snapshotId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/**
 * Create or edit one location's snapshot cadence. A paused or manual schedule
 * carries no cursor at all, which is what keeps it out of the scheduler's due
 * query; an existing cursor is preserved so saving the form doesn't push the next
 * capture a whole interval further out.
 */
export async function upsertGbpSchedule(input: {
  projectId: string;
  locationId: string;
  scheduleInterval: "weekly" | "monthly" | "manual";
  isActive: boolean;
}) {
  const location = await GbpRepository.getLocation(input.locationId);
  if (!location || location.projectId !== input.projectId) {
    throw new AppError("NOT_FOUND", "Location not found");
  }
  const existing = await GbpRepository.getScheduleForLocation(input.locationId);
  const interval = input.scheduleInterval;
  const nextRunAt =
    input.isActive && interval !== "manual"
      ? (existing?.nextRunAt ?? computeNextCheckAt(interval))
      : null;
  return GbpRepository.upsertSchedule({
    id: existing?.id ?? crypto.randomUUID(),
    projectId: input.projectId,
    locationId: input.locationId,
    scheduleInterval: interval,
    isActive: input.isActive,
    nextRunAt,
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type GbpSnapshotSummary = Awaited<
  ReturnType<typeof GbpRepository.getRecentSnapshots>
>[number];

type GbpLocationHistory = {
  location: GbpLocationWithSchedule;
  /** Newest first, at most {@link HISTORY_PER_LOCATION} entries. */
  snapshots: GbpSnapshotSummary[];
  /** Reviews attached to `snapshots[0]`, newest first. */
  reviews: Array<Omit<GbpReviewRow, "snapshotId">>;
};

/**
 * Every location in a project with its cadence, its recent snapshots and the
 * newest snapshot's reviews — the Business Profile section reads this once and
 * derives the rating and review-count deltas from consecutive snapshots.
 */
export async function getGbpHistory(
  projectId: string,
): Promise<GbpLocationHistory[]> {
  const [locations, snapshots] = await Promise.all([
    GbpRepository.getLocationsWithSchedules(projectId),
    GbpRepository.getRecentSnapshots(projectId),
  ]);

  const byLocation = new Map<string, GbpSnapshotSummary[]>();
  for (const snapshot of snapshots) {
    const group = byLocation.get(snapshot.locationId);
    if (group) group.push(snapshot);
    else byLocation.set(snapshot.locationId, [snapshot]);
  }

  const latestIds = locations.flatMap((location) => {
    const latest = byLocation.get(location.locationId)?.[0];
    return latest ? [latest.id] : [];
  });
  const reviews = await GbpRepository.getReviewsForSnapshots(latestIds);
  const reviewsBySnapshot = new Map<string, GbpReviewRow[]>();
  for (const review of reviews) {
    const group = reviewsBySnapshot.get(review.snapshotId);
    if (group) group.push(review);
    else reviewsBySnapshot.set(review.snapshotId, [review]);
  }

  return locations.map((location) => {
    const locationSnapshots = (byLocation.get(location.locationId) ?? []).slice(
      0,
      HISTORY_PER_LOCATION,
    );
    const latestId = locationSnapshots[0]?.id;
    return {
      location,
      snapshots: locationSnapshots,
      reviews: (latestId ? (reviewsBySnapshot.get(latestId) ?? []) : []).map(
        ({ snapshotId: _snapshotId, ...review }) => review,
      ),
    };
  });
}

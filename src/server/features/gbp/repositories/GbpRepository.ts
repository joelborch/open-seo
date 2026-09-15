/**
 * Storage for the Google Business Profile snapshot: the per-location cadence
 * (`gbp_schedules`), the daily profile reading (`gbp_snapshots`) and its two
 * child tables.
 *
 * The location registry is `maps_grid_locations` — the same physical offices the
 * local-pack grid is centred on — so a snapshot never needs a second copy of a
 * client's addresses. `gbp_snapshots.location_id` therefore carries no foreign
 * key, the same convention as `maps_grid_cells`: the rating and review-count
 * history is the point of the table and has to outlive the location row.
 */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import {
  gbpSchedules,
  gbpSnapshotAttributes,
  gbpSnapshotReviews,
  gbpSnapshots,
  mapsGridLocations,
  projects,
} from "@/db/schema";

/** Schedules examined per cron tick, before the loop's own location budget. */
const DUE_SCHEDULES_PER_TICK = 200;

/** Snapshots per project the history read returns, newest first. */
const HISTORY_SNAPSHOT_LIMIT = 400;

/** Snapshots kept per location in the history read. */
export const HISTORY_PER_LOCATION = 12;

type GbpCaptureTarget = {
  locationId: string;
  projectId: string;
  name: string;
  brandName: string;
  slug: string;
  lat: number;
  lng: number;
  radiusMiles: number;
  placeId: string | null;
  /**
   * The cid the most recent snapshot resolved for this location. A cid is the
   * most precise identifier Google exposes, so reusing it pins later snapshots to
   * the same profile even for a location that was first matched by name.
   */
  lastCid: string | null;
};

type GbpSnapshotRow = typeof gbpSnapshots.$inferSelect;

type GbpLocation = Omit<GbpCaptureTarget, "lastCid">;

/** The location row, by id. Null when it does not exist. */
async function getLocation(locationId: string): Promise<GbpLocation | null> {
  const [location] = await db
    .select({
      locationId: mapsGridLocations.id,
      projectId: mapsGridLocations.projectId,
      name: mapsGridLocations.name,
      brandName: mapsGridLocations.brandName,
      slug: mapsGridLocations.slug,
      lat: mapsGridLocations.lat,
      lng: mapsGridLocations.lng,
      radiusMiles: mapsGridLocations.radiusMiles,
      placeId: mapsGridLocations.placeId,
    })
    .from(mapsGridLocations)
    .where(eq(mapsGridLocations.id, locationId))
    .limit(1);
  return location ?? null;
}

/**
 * Everything a capture needs about one location, including the cid a previous
 * snapshot resolved. Null when the location does not exist.
 */
async function getCaptureTarget(
  locationId: string,
): Promise<GbpCaptureTarget | null> {
  const location = await getLocation(locationId);
  if (!location) return null;

  const [previous] = await db
    .select({ cid: gbpSnapshots.cid })
    .from(gbpSnapshots)
    .where(
      and(
        eq(gbpSnapshots.locationId, locationId),
        sql`${gbpSnapshots.cid} is not null`,
      ),
    )
    .orderBy(desc(gbpSnapshots.runDate))
    .limit(1);

  return { ...location, lastCid: previous?.cid ?? null };
}

/**
 * Take the day's snapshot slot for one location before spending anything. The
 * unique (location_id, run_date) is what makes a capture idempotent: the second
 * caller gets false and reads the existing row instead of buying the profile
 * again. A capture that then fails deletes its claim (`deleteSnapshot`) so the
 * location is retryable rather than wedged until tomorrow.
 *
 * `created_at` is written explicitly rather than left to the column default:
 * SQLite's `current_timestamp` is "YYYY-MM-DD HH:MM:SS" and Postgres's default is
 * ISO-8601, and this column is both the projection backlog's cursor and the
 * reviews drain's age bound, so the two dialects have to sort it identically.
 */
async function claimSnapshot(input: {
  id: string;
  projectId: string;
  locationId: string;
  runDate: string;
}): Promise<boolean> {
  const claimed = await db
    .insert(gbpSnapshots)
    .values({ ...input, createdAt: new Date().toISOString() })
    .onConflictDoNothing()
    .returning({ id: gbpSnapshots.id });
  return claimed.length > 0;
}

async function deleteSnapshot(id: string): Promise<void> {
  await db.delete(gbpSnapshots).where(eq(gbpSnapshots.id, id));
}

async function updateSnapshot(
  id: string,
  fields: Partial<typeof gbpSnapshots.$inferInsert>,
): Promise<void> {
  await db.update(gbpSnapshots).set(fields).where(eq(gbpSnapshots.id, id));
}

async function getSnapshotForDate(
  locationId: string,
  runDate: string,
): Promise<GbpSnapshotRow | null> {
  const [snapshot] = await db
    .select()
    .from(gbpSnapshots)
    .where(
      and(
        eq(gbpSnapshots.locationId, locationId),
        eq(gbpSnapshots.runDate, runDate),
      ),
    )
    .limit(1);
  return snapshot ?? null;
}

async function replaceAttributes(
  snapshotId: string,
  rows: Array<{ key: string; value: string }>,
): Promise<void> {
  await db
    .delete(gbpSnapshotAttributes)
    .where(eq(gbpSnapshotAttributes.snapshotId, snapshotId));
  if (rows.length === 0) return;
  // A profile can list the same label under two groups; the unique index would
  // reject the duplicate and take the whole insert with it.
  await db
    .insert(gbpSnapshotAttributes)
    .values(rows.map((row) => ({ ...row, snapshotId })))
    .onConflictDoNothing();
}

export type GbpReviewRow = {
  snapshotId: string;
  reviewId: string | null;
  rating: number | null;
  author: string | null;
  publishedAt: string | null;
  text: string | null;
  ownerReply: boolean;
};

/**
 * Swap in a snapshot's reviews and mark the queued task collected.
 * `reviews_collected_at` is what stops the cron re-collecting a task that
 * returned nothing, which is indistinguishable from one still in the queue.
 */
async function replaceReviews(input: {
  snapshotId: string;
  reviews: Array<Omit<GbpReviewRow, "snapshotId">>;
  collectedAt: string;
}): Promise<void> {
  // One review per statement stays below D1's 100-parameter limit. Keep the
  // replacement and completion marker atomic so a failed insert loses nothing.
  await runBatch((tx) => [
    tx
      .delete(gbpSnapshotReviews)
      .where(eq(gbpSnapshotReviews.snapshotId, input.snapshotId)),
    ...input.reviews.map((review) =>
      tx
        .insert(gbpSnapshotReviews)
        .values({ ...review, snapshotId: input.snapshotId }),
    ),
    tx
      .update(gbpSnapshots)
      .set({ reviewsCollectedAt: input.collectedAt })
      .where(eq(gbpSnapshots.id, input.snapshotId)),
  ]);
}

/**
 * Reviews for the given snapshots in the order they were written, which is the
 * provider's newest-first order. Ordering on `published_at` instead would not be
 * stable across dialects — SQLite and Postgres disagree about where NULLs sort.
 */
async function getReviewsForSnapshots(
  snapshotIds: string[],
): Promise<GbpReviewRow[]> {
  if (snapshotIds.length === 0) return [];
  return db
    .select({
      snapshotId: gbpSnapshotReviews.snapshotId,
      reviewId: gbpSnapshotReviews.reviewId,
      rating: gbpSnapshotReviews.rating,
      author: gbpSnapshotReviews.author,
      publishedAt: gbpSnapshotReviews.publishedAt,
      text: gbpSnapshotReviews.text,
      ownerReply: gbpSnapshotReviews.ownerReply,
    })
    .from(gbpSnapshotReviews)
    .where(inArray(gbpSnapshotReviews.snapshotId, snapshotIds))
    .orderBy(asc(gbpSnapshotReviews.id));
}

/**
 * Snapshots whose reviews task was posted but never collected, oldest first.
 * Collection is free at DataForSEO, so the cron drains these before it captures
 * anything new.
 *
 * `since` is the caller's retention floor: DataForSEO purges a completed task's
 * result after a few days, and without the bound a task whose result is gone would
 * be retried once per tick forever and crowd the collectable ones out of the
 * budget.
 */
async function getSnapshotsAwaitingReviews(input: {
  since: string;
  limit: number;
}): Promise<Array<{ id: string; providerTaskId: string }>> {
  const rows = await db
    .select({
      id: gbpSnapshots.id,
      providerTaskId: gbpSnapshots.providerTaskId,
    })
    .from(gbpSnapshots)
    .where(
      and(
        isNull(gbpSnapshots.reviewsCollectedAt),
        sql`${gbpSnapshots.providerTaskId} is not null`,
        gte(gbpSnapshots.createdAt, input.since),
      ),
    )
    .orderBy(asc(gbpSnapshots.createdAt))
    .limit(input.limit);
  // The `is not null` guard above is the real filter; this narrows the type.
  return rows.flatMap((row) =>
    row.providerTaskId
      ? [{ id: row.id, providerTaskId: row.providerTaskId }]
      : [],
  );
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

type GbpScheduleRow = typeof gbpSchedules.$inferSelect;

async function getScheduleForLocation(
  locationId: string,
): Promise<GbpScheduleRow | null> {
  const [schedule] = await db
    .select()
    .from(gbpSchedules)
    .where(eq(gbpSchedules.locationId, locationId))
    .limit(1);
  return schedule ?? null;
}

/**
 * One schedule per location, so the unique index is the upsert target. The
 * cadence and the active flag are the only fields a user edits; the cursor is the
 * scheduler's and is only written here when the caller supplies one.
 */
async function upsertSchedule(input: {
  id: string;
  projectId: string;
  locationId: string;
  scheduleInterval: "weekly" | "monthly" | "manual";
  isActive: boolean;
  nextRunAt: string | null;
}): Promise<GbpScheduleRow> {
  const [schedule] = await db
    .insert(gbpSchedules)
    .values(input)
    .onConflictDoUpdate({
      target: gbpSchedules.locationId,
      set: {
        scheduleInterval: input.scheduleInterval,
        isActive: input.isActive,
        nextRunAt: input.nextRunAt,
      },
    })
    .returning();
  return schedule;
}

async function getDueSchedules(nowIso: string) {
  return (
    db
      .select({
        id: gbpSchedules.id,
        projectId: gbpSchedules.projectId,
        locationId: gbpSchedules.locationId,
        scheduleInterval: gbpSchedules.scheduleInterval,
        nextRunAt: gbpSchedules.nextRunAt,
        organizationId: projects.organizationId,
      })
      .from(gbpSchedules)
      .innerJoin(projects, eq(gbpSchedules.projectId, projects.id))
      .where(
        and(
          eq(gbpSchedules.isActive, true),
          // A manual schedule can keep a stale non-null cursor; without this it
          // would be selected every tick and never advanced.
          ne(gbpSchedules.scheduleInterval, "manual"),
          lte(gbpSchedules.nextRunAt, nowIso),
          isNull(projects.archivedAt),
        ),
      )
      // Oldest first so a backlog drains in order. `lte` already excludes NULL, so
      // both ordering columns are non-null and SQLite/Postgres agree.
      .orderBy(asc(gbpSchedules.nextRunAt), asc(gbpSchedules.id))
      .limit(DUE_SCHEDULES_PER_TICK)
  );
}

/**
 * Conditionally advance a due schedule's cursor, returning false when the row
 * changed underneath us (an edit, or a deactivation). The observed `next_run_at`
 * is the compare-and-set token, exactly as the grid and rank-check schedulers do.
 *
 * `lastSkipReason` and `lastRunAt` are written only when passed, so the restore
 * path cannot clobber a reason — or a run timestamp — written in the meantime.
 */
async function claimDueSchedule(input: {
  scheduleId: string;
  observedNextRunAt: string;
  nextRunAt: string;
  lastSkipReason?: string | null;
  lastRunAt?: string;
}): Promise<boolean> {
  const claimed = await db
    .update(gbpSchedules)
    .set({
      nextRunAt: input.nextRunAt,
      ...(input.lastSkipReason !== undefined && {
        lastSkipReason: input.lastSkipReason,
      }),
      ...(input.lastRunAt !== undefined && { lastRunAt: input.lastRunAt }),
    })
    .where(
      and(
        eq(gbpSchedules.id, input.scheduleId),
        eq(gbpSchedules.isActive, true),
        eq(gbpSchedules.nextRunAt, input.observedNextRunAt),
      ),
    )
    .returning({ id: gbpSchedules.id });
  return claimed.length > 0;
}

// ---------------------------------------------------------------------------
// Project reads
// ---------------------------------------------------------------------------

export type GbpLocationWithSchedule = {
  locationId: string;
  name: string;
  slug: string;
  placeId: string | null;
  scheduleId: string | null;
  scheduleInterval: "weekly" | "monthly" | "manual" | null;
  isActive: boolean | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastSkipReason: string | null;
};

/** Every location in a project with its snapshot cadence, if it has one yet. */
async function getLocationsWithSchedules(
  projectId: string,
): Promise<GbpLocationWithSchedule[]> {
  return db
    .select({
      locationId: mapsGridLocations.id,
      name: mapsGridLocations.name,
      slug: mapsGridLocations.slug,
      placeId: mapsGridLocations.placeId,
      scheduleId: gbpSchedules.id,
      scheduleInterval: gbpSchedules.scheduleInterval,
      isActive: gbpSchedules.isActive,
      lastRunAt: gbpSchedules.lastRunAt,
      nextRunAt: gbpSchedules.nextRunAt,
      lastSkipReason: gbpSchedules.lastSkipReason,
    })
    .from(mapsGridLocations)
    .leftJoin(gbpSchedules, eq(gbpSchedules.locationId, mapsGridLocations.id))
    .where(eq(mapsGridLocations.projectId, projectId))
    .orderBy(asc(mapsGridLocations.name));
}

/**
 * A project's snapshots, newest first. One flat query rather than a per-location
 * window function: the service groups and trims to {@link HISTORY_PER_LOCATION},
 * which keeps the SQL identical on SQLite and Postgres.
 */
async function getRecentSnapshots(projectId: string) {
  return db
    .select({
      id: gbpSnapshots.id,
      locationId: gbpSnapshots.locationId,
      runDate: gbpSnapshots.runDate,
      name: gbpSnapshots.name,
      primaryCategory: gbpSnapshots.primaryCategory,
      rating: gbpSnapshots.rating,
      reviewsCount: gbpSnapshots.reviewsCount,
      isClaimed: gbpSnapshots.isClaimed,
      address: gbpSnapshots.address,
      phone: gbpSnapshots.phone,
      website: gbpSnapshots.website,
      photosCount: gbpSnapshots.photosCount,
      costMicros: gbpSnapshots.costMicros,
      queryIdentity: gbpSnapshots.queryIdentity,
      profileTaskId: gbpSnapshots.profileTaskId,
      profileStatusCode: gbpSnapshots.profileStatusCode,
      reviewsCollectedAt: gbpSnapshots.reviewsCollectedAt,
      providerTaskId: gbpSnapshots.providerTaskId,
    })
    .from(gbpSnapshots)
    .where(eq(gbpSnapshots.projectId, projectId))
    .orderBy(desc(gbpSnapshots.runDate), asc(gbpSnapshots.locationId))
    .limit(HISTORY_SNAPSHOT_LIMIT);
}

export const GbpRepository = {
  getLocation,
  getCaptureTarget,
  claimSnapshot,
  deleteSnapshot,
  updateSnapshot,
  getSnapshotForDate,
  replaceAttributes,
  replaceReviews,
  getReviewsForSnapshots,
  getSnapshotsAwaitingReviews,
  getScheduleForLocation,
  upsertSchedule,
  getDueSchedules,
  claimDueSchedule,
  getLocationsWithSchedules,
  getRecentSnapshots,
} as const;

import { createServerFn } from "@tanstack/react-start";
import {
  captureGbpSnapshot,
  getGbpHistory,
  upsertGbpSchedule as saveGbpSchedule,
} from "@/server/features/gbp/services/GbpService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  captureGbpSnapshotNowSchema,
  getGbpSnapshotsSchema,
  upsertGbpScheduleSchema,
} from "@/types/schemas/gbp";

// Server functions for the Google Business Profile snapshot. Project scope comes
// from requireProjectContext — the validated `projectId` is never trusted as the
// scope, and a location in another project reads as not found.

export const getGbpSnapshots = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGbpSnapshotsSchema)
  .handler(async ({ context }) => getGbpHistory(context.projectId));

/**
 * Capture one location's profile now. Idempotent for the day: pressing it again
 * spends nothing and instead collects the reviews the first capture queued, which
 * is also how a user pulls in reviews without waiting for the next cron tick.
 */
export const captureGbpSnapshotNow = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(captureGbpSnapshotNowSchema)
  .handler(async ({ data, context }) =>
    captureGbpSnapshot({
      locationId: data.locationId,
      projectId: context.projectId,
      billingCustomer: context,
    }),
  );

export const upsertGbpSchedule = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(upsertGbpScheduleSchema)
  .handler(async ({ data, context }) =>
    saveGbpSchedule({
      projectId: context.projectId,
      locationId: data.locationId,
      scheduleInterval: data.scheduleInterval,
      isActive: data.isActive,
    }),
  );

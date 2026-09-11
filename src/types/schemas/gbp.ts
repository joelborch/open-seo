import { z } from "zod";

/**
 * Boundary schemas for the scheduled Google Business Profile snapshot. A capture
 * buys two charged provider requests, so the only thing a client may send is which
 * location to read and how often — never anything that shapes the request itself.
 */

const projectId = z.string().min(1);
const locationId = z.string().min(1);

export const getGbpSnapshotsSchema = z.object({ projectId });

export const captureGbpSnapshotNowSchema = z.object({ projectId, locationId });

export const upsertGbpScheduleSchema = z.object({
  projectId,
  locationId,
  scheduleInterval: z.enum(["weekly", "monthly", "manual"]),
  isActive: z.boolean(),
});

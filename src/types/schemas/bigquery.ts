import { z } from "zod";

/** Run tables the projection pipeline can read from, mirroring `run_kind`. */
const projectionRunKindSchema = z.enum([
  "audit_schedule_run",
  "rank_check_run",
  "maps_grid_run",
  "gbp_snapshot",
]);

export const getBigQueryStatusSchema = z.object({
  projectId: z.string().min(1),
});

export const projectRunNowSchema = z.object({
  projectId: z.string().min(1),
  runKind: projectionRunKindSchema,
  runId: z.string().min(1),
});

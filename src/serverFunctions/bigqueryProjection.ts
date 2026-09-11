import { createServerFn } from "@tanstack/react-start";
import {
  getBigQueryStatus as readBigQueryStatus,
  projectRun,
} from "@/server/features/bigquery-projection/services/BigqueryProjectionService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  getBigQueryStatusSchema,
  projectRunNowSchema,
} from "@/types/schemas/bigquery";

export const getBigQueryStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getBigQueryStatusSchema)
  .handler(async ({ context }) => {
    return readBigQueryStatus(context.projectId);
  });

export const projectRunNow = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectRunNowSchema)
  .handler(async ({ data, context }) => {
    // `expectedProjectId` is the authorization check: a run id from another
    // project resolves to "not found" instead of being projected.
    return projectRun({
      runKind: data.runKind,
      runId: data.runId,
      expectedProjectId: context.projectId,
    });
  });

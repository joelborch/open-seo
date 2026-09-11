import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { requireOrgPermission } from "@/server/auth/org-gate";
import {
  addKeywords,
  createConfig,
  createLocation,
  deleteConfig,
  deleteLocation,
  getConfigs,
  getKeywords,
  getLocations,
  removeKeywords,
  updateConfig,
  updateLocation,
} from "@/server/features/maps-grid/services/mapsGridManagement";
import { MapsGridService } from "@/server/features/maps-grid/services/MapsGridService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  addGridKeywordsSchema,
  createGridConfigSchema,
  createGridLocationSchema,
  deleteGridConfigSchema,
  deleteGridLocationSchema,
  getGridConfigsSchema,
  getGridKeywordsSchema,
  getGridLocationsSchema,
  getGridRunSchema,
  getGridRunsSchema,
  getGridTrendSchema,
  previewGridRunSchema,
  removeGridKeywordsSchema,
  retrieveGridRunSchema,
  startGridRunSchema,
  updateGridConfigSchema,
  updateGridLocationSchema,
} from "@/types/schemas/maps-grid";

// Server functions for the local-pack geo grid. Project scope comes from
// requireProjectContext — the validated `projectId` is never trusted as the scope.

export const getGridLocations = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGridLocationsSchema)
  .handler(async ({ context }) => getLocations(context.projectId));

export const createGridLocation = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createGridLocationSchema)
  .handler(async ({ data, context }) => {
    const { projectId: _projectId, ...fields } = data;
    return createLocation({ projectId: context.projectId, fields });
  });

export const updateGridLocation = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateGridLocationSchema)
  .handler(async ({ data, context }) => {
    const { projectId: _projectId, locationId, ...fields } = data;
    return updateLocation({
      projectId: context.projectId,
      locationId,
      fields,
    });
  });

export const deleteGridLocation = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(deleteGridLocationSchema)
  .handler(async ({ data, context }) => {
    // Deleting a location cascades its configs, keywords and every run's
    // history, so it gets the same destructive-action gate as archiving.
    requireOrgPermission(context, { project: ["delete"] });
    return deleteLocation({
      projectId: context.projectId,
      locationId: data.locationId,
    });
  });

export const getGridConfigs = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGridConfigsSchema)
  .handler(async ({ context }) => getConfigs(context.projectId));

export const createGridConfig = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createGridConfigSchema)
  .handler(async ({ data, context }) => {
    const { projectId: _projectId, locationId, ...fields } = data;
    return createConfig({ projectId: context.projectId, locationId, fields });
  });

export const updateGridConfig = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateGridConfigSchema)
  .handler(async ({ data, context }) => {
    const { projectId: _projectId, configId, ...fields } = data;
    return updateConfig({ projectId: context.projectId, configId, fields });
  });

export const deleteGridConfig = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(deleteGridConfigSchema)
  .handler(async ({ data, context }) => {
    requireOrgPermission(context, { project: ["delete"] });
    return deleteConfig({
      projectId: context.projectId,
      configId: data.configId,
    });
  });

export const getGridKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGridKeywordsSchema)
  .handler(async ({ data, context }) =>
    getKeywords({ projectId: context.projectId, configId: data.configId }),
  );

export const addGridKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(addGridKeywordsSchema)
  .handler(async ({ data, context }) =>
    addKeywords({
      projectId: context.projectId,
      configId: data.configId,
      keywords: data.keywords,
      category: data.category,
    }),
  );

export const removeGridKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(removeGridKeywordsSchema)
  .handler(async ({ data, context }) =>
    removeKeywords({
      projectId: context.projectId,
      configId: data.configId,
      keywordIds: data.keywordIds,
    }),
  );

/**
 * Price and size the run without posting anything or creating a run row. Goes
 * through the same `startGridRun` the confirm button uses, so the preview can
 * never quote a plan the real start would compute differently.
 */
export const previewGridRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(previewGridRunSchema)
  .handler(async ({ data, context }) => {
    const result = await MapsGridService.startGridRun({
      configId: data.configId,
      projectId: context.projectId,
      billingCustomer: context,
      trigger: "manual",
      dryRun: true,
    });
    return result.plan;
  });

export const startGridRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startGridRunSchema)
  .handler(async ({ data, context }) => {
    const result = await MapsGridService.startGridRun({
      configId: data.configId,
      projectId: context.projectId,
      billingCustomer: context,
      trigger: "manual",
      authorizedCostMicros: data.authorizedCostMicros,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "maps_grid:run_start",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          cells_total: result.plan.cellsTotal,
          grid_size: result.plan.gridSize,
          keywords: result.plan.keywords.length,
          authorized_cost_micros: result.plan.totalCostMicros,
          started: result.dryRun ? false : result.ok,
        },
      }),
    );

    return result;
  });

/**
 * Collect a run's outstanding cells from the task ids already in the ledger.
 * Buys nothing — the recovery path for a run whose workflow died mid-poll.
 */
export const retrieveGridRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(retrieveGridRunSchema)
  .handler(async ({ data, context }) =>
    MapsGridService.retrieveGridRun({
      runId: data.runId,
      projectId: context.projectId,
    }),
  );

export const getGridRuns = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGridRunsSchema)
  .handler(async ({ data, context }) =>
    MapsGridService.getGridRuns({
      configId: data.configId,
      projectId: context.projectId,
    }),
  );

export const getGridRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGridRunSchema)
  .handler(async ({ data, context }) =>
    MapsGridService.getGridRun({
      runId: data.runId,
      projectId: context.projectId,
    }),
  );

export const getGridTrend = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getGridTrendSchema)
  .handler(async ({ data, context }) =>
    MapsGridService.getGridTrend({
      configId: data.configId,
      projectId: context.projectId,
    }),
  );

import { useQuery } from "@tanstack/react-query";
import {
  getGridConfigs,
  getGridKeywords,
  getGridLocations,
  getGridRun,
  getGridRuns,
  getGridTrend,
} from "@/serverFunctions/mapsGrid";

/**
 * Server state for the local-pack grid page. One hook per read so the config
 * panel and the results view can invalidate independently — a keyword edit
 * shouldn't refetch a 49-cell run detail.
 */

export type GridLocation = Awaited<ReturnType<typeof getGridLocations>>[number];
export type GridConfig = Awaited<ReturnType<typeof getGridConfigs>>[number];
export type GridRunDetail = Awaited<ReturnType<typeof getGridRun>>;
export type GridRunCell = GridRunDetail["cells"][number];
export type GridRollups = GridRunDetail["rollups"];

export const gridQueryKeys = {
  locations: (projectId: string) => ["maps-grid-locations", projectId] as const,
  configs: (projectId: string) => ["maps-grid-configs", projectId] as const,
  keywords: (configId: string) => ["maps-grid-keywords", configId] as const,
  runs: (configId: string) => ["maps-grid-runs", configId] as const,
  run: (runId: string) => ["maps-grid-run", runId] as const,
  trend: (configId: string) => ["maps-grid-trend", configId] as const,
};

export function useGridLocations(projectId: string) {
  return useQuery({
    queryKey: gridQueryKeys.locations(projectId),
    queryFn: () => getGridLocations({ data: { projectId } }),
  });
}

export function useGridConfigs(projectId: string) {
  return useQuery({
    queryKey: gridQueryKeys.configs(projectId),
    queryFn: () => getGridConfigs({ data: { projectId } }),
  });
}

export function useGridKeywords(projectId: string, configId: string | null) {
  return useQuery({
    queryKey: gridQueryKeys.keywords(configId ?? "none"),
    queryFn: () =>
      getGridKeywords({ data: { projectId, configId: configId ?? "" } }),
    enabled: configId !== null,
  });
}

export function useGridRuns(projectId: string, configId: string | null) {
  return useQuery({
    queryKey: gridQueryKeys.runs(configId ?? "none"),
    queryFn: () =>
      getGridRuns({ data: { projectId, configId: configId ?? "" } }),
    enabled: configId !== null,
    // A run posts, sleeps 90s, then polls: refresh while one is in flight so the
    // collected count climbs without the user reloading.
    refetchInterval: (query) =>
      query.state.data?.some(
        (run) => run.status === "pending" || run.status === "running",
      )
        ? 20_000
        : false,
  });
}

export function useGridRun(projectId: string, runId: string | null) {
  return useQuery({
    queryKey: gridQueryKeys.run(runId ?? "none"),
    queryFn: () => getGridRun({ data: { projectId, runId: runId ?? "" } }),
    enabled: runId !== null,
  });
}

export function useGridTrend(projectId: string, configId: string | null) {
  return useQuery({
    queryKey: gridQueryKeys.trend(configId ?? "none"),
    queryFn: () =>
      getGridTrend({ data: { projectId, configId: configId ?? "" } }),
    enabled: configId !== null,
  });
}

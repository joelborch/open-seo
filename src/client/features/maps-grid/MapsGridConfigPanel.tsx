import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  gridQueryKeys,
  useGridKeywords,
  type GridConfig,
  type GridLocation,
} from "@/client/features/maps-grid/useMapsGridQueries";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  addGridKeywords,
  createGridConfig,
  deleteGridConfig,
  previewGridRun,
  removeGridKeywords,
  startGridRun,
  updateGridConfig,
} from "@/serverFunctions/mapsGrid";
import { formatMicrosUsd } from "@/shared/rank-tracking";
import {
  GridKeywordList,
  GridSettingsFields,
  gridSettingsFrom,
  type GridSettings,
} from "@/client/features/maps-grid/MapsGridConfigFields";

/**
 * Grid shape, cadence and keyword set for one location, plus the two buttons
 * that spend money. "Preview run" prices the run without buying it, and "Run
 * now" passes that exact price back as the authorization — so a keyword added
 * between the two is refused rather than charged silently.
 */

type GridPlan = Awaited<ReturnType<typeof previewGridRun>>;

export function MapsGridConfigPanel({
  projectId,
  location,
  config,
  onRunStarted,
}: {
  projectId: string;
  location: GridLocation;
  config: GridConfig | null;
  onRunStarted: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const keywordsQuery = useGridKeywords(projectId, config?.id ?? null);
  const [plan, setPlan] = useState<GridPlan | null>(null);

  const [settings, setSettings] = useState<GridSettings>(() =>
    gridSettingsFrom({
      gridSize: config?.gridSize ?? 7,
      radiusMiles: config?.radiusMiles ?? location.radiusMiles,
      zoom: config?.zoom ?? "13z",
      device: config?.device ?? "mobile",
      scheduleInterval: config?.scheduleInterval ?? "weekly",
    }),
  );

  const saveMutation = useMutation({
    mutationFn: () => {
      const fields = {
        gridSize: settings.gridSize,
        radiusMiles: Number(settings.radiusMiles) || location.radiusMiles,
        zoom: settings.zoom,
        languageCode: config?.languageCode ?? "en",
        device: settings.device,
        depth: config?.depth ?? null,
        scheduleInterval: settings.scheduleInterval,
        isActive: config?.isActive ?? true,
      };
      return config
        ? updateGridConfig({
            data: { projectId, configId: config.id, ...fields },
          })
        : createGridConfig({
            data: { projectId, locationId: location.id, ...fields },
          });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: gridQueryKeys.configs(projectId),
      });
      setPlan(null);
      toast.success("Grid settings saved");
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't save the grid")),
  });

  const addKeywordsMutation = useMutation({
    mutationFn: (keywords: string[]) =>
      addGridKeywords({
        data: { projectId, configId: config?.id ?? "", keywords },
      }),
    onSuccess: async () => {
      setPlan(null);
      await queryClient.invalidateQueries({
        queryKey: gridQueryKeys.keywords(config?.id ?? "none"),
      });
    },
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Couldn't add those keywords"),
      ),
  });

  const removeKeywordMutation = useMutation({
    mutationFn: (keywordId: string) =>
      removeGridKeywords({
        data: {
          projectId,
          configId: config?.id ?? "",
          keywordIds: [keywordId],
        },
      }),
    onSuccess: async () => {
      setPlan(null);
      await queryClient.invalidateQueries({
        queryKey: gridQueryKeys.keywords(config?.id ?? "none"),
      });
    },
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      previewGridRun({ data: { projectId, configId: config?.id ?? "" } }),
    onSuccess: setPlan,
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't price the run")),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      startGridRun({
        data: {
          projectId,
          configId: config?.id ?? "",
          authorizedCostMicros: plan?.totalCostMicros,
        },
      }),
    onSuccess: async (result) => {
      if (result.dryRun) return;
      if (!result.ok) {
        toast.error("A grid run for this location is already in flight.");
        return;
      }
      setPlan(null);
      await queryClient.invalidateQueries({
        queryKey: gridQueryKeys.runs(config?.id ?? "none"),
      });
      toast.success("Grid run started — results land as cells report back.");
      onRunStarted(result.runId);
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't start the run")),
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      deleteGridConfig({ data: { projectId, configId: config?.id ?? "" } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: gridQueryKeys.configs(projectId),
      });
      setPlan(null);
      toast.success("Grid deleted");
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't delete the grid")),
  });

  const keywords = keywordsQuery.data ?? [];

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title text-base">Grid settings</h2>
          <div className="flex items-center gap-2">
            {config ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-error"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  // The grid's keywords and every run's history go with it.
                  if (!confirm("Delete this grid and all of its run history?"))
                    return;
                  deleteMutation.mutate();
                }}
              >
                <Trash2 className="size-4" /> Delete grid
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {config ? "Save grid" : "Create grid"}
            </button>
          </div>
        </div>

        <GridSettingsFields settings={settings} onChange={setSettings} />

        {config ? (
          <>
            <GridKeywordList
              keywords={keywords}
              isLoading={keywordsQuery.isPending}
              isAdding={addKeywordsMutation.isPending}
              onAdd={(words) => addKeywordsMutation.mutate(words)}
              onRemove={(keywordId) => removeKeywordMutation.mutate(keywordId)}
            />

            <div className="flex flex-wrap items-center gap-2 border-t border-base-300 pt-3">
              <button
                type="button"
                className="btn btn-sm"
                disabled={previewMutation.isPending}
                onClick={() => previewMutation.mutate()}
              >
                {previewMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Preview run
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={runMutation.isPending || keywords.length === 0}
                onClick={() => runMutation.mutate()}
              >
                {runMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Run now
              </button>
              {plan ? (
                <p className="text-sm text-base-content/70">
                  {plan.cellsTotal.toLocaleString()} cells (
                  {plan.keywords.length} keyword
                  {plan.keywords.length === 1 ? "" : "s"} &times;{" "}
                  {plan.gridSize}&times;{plan.gridSize}) &mdash;{" "}
                  <span className="font-mono">
                    {formatMicrosUsd(plan.totalCostMicros)}
                  </span>{" "}
                  at the data provider.
                </p>
              ) : (
                <p className="text-sm text-base-content/50">
                  Each cell is one charged Google Maps request.
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-base-content/60">
            Create the grid to add keywords and run it.
          </p>
        )}
      </div>
    </div>
  );
}

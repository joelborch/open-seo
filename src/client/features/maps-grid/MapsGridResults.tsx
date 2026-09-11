import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { MapsGridHeatmap } from "@/client/features/maps-grid/MapsGridHeatmap";
import { MapsGridVisibilityTrend } from "@/client/features/maps-grid/MapsGridVisibilityTrend";
import {
  gridQueryKeys,
  useGridRun,
  useGridRuns,
  useGridTrend,
  type GridRollups,
  type GridRunDetail,
} from "@/client/features/maps-grid/useMapsGridQueries";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { retrieveGridRun } from "@/serverFunctions/mapsGrid";
import { formatMicrosUsd } from "@/shared/rank-tracking";

/**
 * Everything read off a finished grid: the heatmap for the selected keyword, the
 * headline numbers, who else owns the map, and how visibility has moved across
 * runs.
 */

export function MapsGridResults({
  projectId,
  configId,
  selectedRunId,
}: {
  projectId: string;
  configId: string;
  /** Set by the panel above when a run starts, so the picker jumps to it. */
  selectedRunId: string | null;
}) {
  const runsQuery = useGridRuns(projectId, configId);
  const trendQuery = useGridTrend(projectId, configId);
  const [runId, setRunId] = useState<string | null>(null);
  const [keywordId, setKeywordId] = useState<string | null>(null);

  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  // Default to the newest run, and follow it as new runs land, until the user
  // picks one explicitly.
  useEffect(() => {
    if (runId === null && runs.length > 0) setRunId(runs[0].id);
  }, [runId, runs]);

  // A run just started here jumps to the top of the picker.
  useEffect(() => {
    if (selectedRunId !== null) setRunId(selectedRunId);
  }, [selectedRunId]);

  const runQuery = useGridRun(projectId, runId);
  const detail = runQuery.data ?? null;

  useEffect(() => {
    if (!detail) return;
    if (keywordId && detail.keywords.some((kw) => kw.id === keywordId)) return;
    setKeywordId(detail.keywords[0]?.id ?? null);
  }, [detail, keywordId]);

  if (runs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-base-300 p-10 text-center text-sm text-base-content/55">
        No grid runs yet. Preview a run above to see what it will cost, then run
        it.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
            Run
          </span>
          <select
            className="select select-bordered select-sm"
            value={runId ?? ""}
            onChange={(event) => setRunId(event.target.value)}
          >
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {new Date(run.startedAt).toLocaleString()} — {run.status} (
                {run.cellsCollected}/{run.cellsTotal} cells)
              </option>
            ))}
          </select>
        </label>

        {detail && detail.keywords.length > 0 ? (
          <label className="block space-y-1">
            <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
              Keyword
            </span>
            <select
              className="select select-bordered select-sm"
              value={keywordId ?? ""}
              onChange={(event) => setKeywordId(event.target.value)}
            >
              {detail.keywords.map((keyword) => (
                <option key={keyword.id} value={keyword.id}>
                  {keyword.keyword}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {runId ? (
          <RetrieveButton
            projectId={projectId}
            runId={runId}
            configId={configId}
          />
        ) : null}
      </div>

      {runQuery.isPending ? (
        <div className="skeleton h-72 w-full" />
      ) : detail ? (
        <RunDetail detail={detail} keywordId={keywordId} />
      ) : null}

      <MapsGridVisibilityTrend
        points={(trendQuery.data ?? []).map((point) => ({
          startedAt: new Date(point.startedAt).getTime(),
          visibility:
            keywordId === null
              ? point.rollups.visibilityScore
              : (point.byKeyword.find((entry) => entry.id === keywordId)
                  ?.rollups.visibilityScore ?? null),
        }))}
      />
    </div>
  );
}

function RunDetail({
  detail,
  keywordId,
}: {
  detail: GridRunDetail;
  keywordId: string | null;
}) {
  const keywordRollups =
    detail.rollupsByKeyword.find((entry) => entry.id === keywordId)?.rollups ??
    detail.rollups;
  const cells = detail.cells.filter(
    (cell) => keywordId === null || cell.keywordId === keywordId,
  );
  const previousCells = detail.previousRun
    ? detail.previousRun.cellRanks.filter(
        (cell) => keywordId === null || cell.keywordId === keywordId,
      )
    : null;

  return (
    <div className="space-y-4">
      <KpiRow rollups={keywordRollups} run={detail.run} />
      <div className="card bg-base-100 border border-base-300">
        <div className="card-body gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="card-title text-base">
              {detail.keywords.find((kw) => kw.id === keywordId)?.keyword ??
                "All keywords"}
            </h3>
            <p className="text-xs text-base-content/50">
              {previousCells
                ? "Deltas compare the previous run of the same panel."
                : "No comparable previous run — deltas are hidden."}
            </p>
          </div>
          <MapsGridHeatmap
            cells={cells}
            gridSize={detail.gridSize}
            previousCells={previousCells}
          />
          <Legend />
        </div>
      </div>
      <CompetitorTable rollups={keywordRollups} />
    </div>
  );
}

function KpiRow({
  rollups,
  run,
}: {
  rollups: GridRollups;
  run: GridRunDetail["run"];
}) {
  const spentPrefix = run.costStatus === "known_minimum" ? "≥" : "";
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      <Kpi
        label="Visibility"
        value={rollups.visibilityScore.toFixed(0)}
        hint="0–100"
      />
      <Kpi
        label="Share of local voice"
        value={`${(rollups.shareOfLocalVoice * 100).toFixed(0)}%`}
        hint="cells in the top 3"
      />
      <Kpi
        label="Avg rank (found)"
        value={rollups.avgRankWhenFound?.toFixed(1) ?? "—"}
        hint={`${rollups.top20Percent.toFixed(0)}% of cells`}
      />
      <Kpi
        label="Avg rank (miss = 21)"
        value={rollups.avgRankNotFoundAs21?.toFixed(1) ?? "—"}
        hint="whole grid"
      />
      <Kpi
        label="Centre rank"
        value={rollups.centerRank?.toFixed(1) ?? "—"}
        hint="single-point view"
      />
      <Kpi
        label="Spent"
        value={
          run.spentCostMicros === null
            ? "—"
            : `${spentPrefix}${formatMicrosUsd(run.spentCostMicros)}`
        }
        hint={
          run.costStatus === "known_minimum"
            ? "at least — some cells never reported"
            : "data provider cost"
        }
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-lg border border-base-300 bg-base-100 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-base-content/55">
        {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      <p className="text-[0.65rem] text-base-content/45">{hint}</p>
    </div>
  );
}

function Legend() {
  const bands = [
    { label: "1–3", className: "bg-emerald-500/90" },
    { label: "4–10", className: "bg-amber-400/90" },
    { label: "11–20", className: "bg-orange-500/90" },
    { label: "Not found", className: "bg-red-500/85" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-base-content/60">
      {bands.map((band) => (
        <span key={band.label} className="inline-flex items-center gap-1.5">
          <span className={`inline-block size-3 rounded ${band.className}`} />
          {band.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block size-3 rounded ring-2 ring-base-content" />
        Centre cell
      </span>
    </div>
  );
}

function CompetitorTable({ rollups }: { rollups: GridRollups }) {
  const rows = rollups.competitors.slice(0, 10);
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-base-300">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Competitor</th>
            <th className="text-right">Cells seen</th>
            <th className="text-right">Top-3 cells</th>
            <th className="text-right">Share of local voice</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="font-medium">{row.name || "Unnamed listing"}</td>
              <td className="text-right tabular-nums">{row.cells}</td>
              <td className="text-right tabular-nums">{row.top3Cells}</td>
              <td className="text-right tabular-nums">
                {(row.shareOfLocalVoice * 100).toFixed(0)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Free recovery for a run whose cells are still outstanding: every task id is
 * already in the ledger and task_get costs nothing, so this buys nothing.
 */
function RetrieveButton({
  projectId,
  runId,
  configId,
}: {
  projectId: string;
  runId: string;
  configId: string;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => retrieveGridRun({ data: { projectId, runId } }),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: gridQueryKeys.run(runId) }),
        queryClient.invalidateQueries({
          queryKey: gridQueryKeys.runs(configId),
        }),
      ]);
      toast.success(
        result.collected > 0
          ? `Collected ${result.collected} more cell(s).`
          : "Nothing new is ready yet.",
      );
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't collect the run")),
  });

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
      title="Collect any cells still outstanding. Costs nothing."
    >
      {mutation.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RefreshCw className="size-4" />
      )}
      Collect outstanding
    </button>
  );
}

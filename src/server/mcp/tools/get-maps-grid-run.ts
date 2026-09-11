import { z } from "zod";
import { MapsGridService } from "@/server/features/maps-grid/services/MapsGridService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMicrosUsd } from "@/shared/rank-tracking";

/** Competitors reported per cell — enough to name who owns a cell the client
 *  lost, without shipping the whole 20-deep pack for all 49 cells. */
const COMPETITORS_PER_CELL = 3;

type GridRunDetail = Awaited<ReturnType<typeof MapsGridService.getGridRun>>;
type DetailCell = GridRunDetail["cells"][number];

type CellSummary = {
  keywordId: string;
  keyword: string;
  gridRow: number;
  gridCol: number;
  lat: number;
  lng: number;
  direction: string;
  distanceMiles: number;
  clientRank: number | null;
  taskStatus: string;
  topCompetitors: Array<{
    name: string;
    rank: number;
    placeId: string | null;
    rating: number | null;
    reviewsCount: number | null;
  }>;
};

function summarizeCell(cell: DetailCell): CellSummary {
  return {
    keywordId: cell.keywordId,
    keyword: cell.keyword,
    gridRow: cell.gridRow,
    gridCol: cell.gridCol,
    lat: cell.lat,
    lng: cell.lng,
    direction: cell.direction,
    distanceMiles: cell.distanceMiles,
    clientRank: cell.clientRank,
    taskStatus: cell.taskStatus,
    topCompetitors: cell.results
      .filter((result) => !result.isClient)
      .slice(0, COMPETITORS_PER_CELL)
      .map((result) => ({
        name: result.name,
        rank: result.rank,
        placeId: result.placeId,
        rating: result.rating,
        reviewsCount: result.reviewsCount,
      })),
  };
}

/**
 * One keyword's panel as an ASCII heatmap, north at the top — the same reading
 * as get_local_rank_grid's renderGrid, over stored cells instead of live SERPs.
 * Rows and columns are 1-based in the database; a cell the provider never
 * returned reads "x" rather than an unranked "–", because the two mean different
 * things.
 */
function renderGrid(
  cells: CellSummary[],
  gridSize: number,
  keywordId: string,
): string {
  const byPosition = new Map(
    cells
      .filter((cell) => cell.keywordId === keywordId)
      .map((cell) => [`${cell.gridRow}:${cell.gridCol}`, cell] as const),
  );
  const lines: string[] = [];
  for (let row = 1; row <= gridSize; row++) {
    const rendered: string[] = [];
    for (let col = 1; col <= gridSize; col++) {
      const cell = byPosition.get(`${row}:${col}`);
      const value =
        cell == null
          ? " "
          : cell.clientRank != null
            ? String(cell.clientRank)
            : cell.taskStatus === "retrieved" ||
                cell.taskStatus === "terminal_empty"
              ? "–"
              : "x";
      rendered.push(value.padStart(2, " "));
    }
    lines.push(rendered.join(" "));
  }
  return lines.join("\n");
}

const inputSchema = {
  projectId: projectIdSchema,
  runId: z
    .string()
    .describe(
      "Maps grid run ID (from list_monitoring_runs or get_monitoring_status).",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getMapsGridRunTool = {
  name: "get_maps_grid_run",
  config: {
    title: "Get Maps grid run",
    description:
      "One Maps grid run in full: every cell's client rank and its top competitors, the run-level rollups (visibility score, top-3/10/20 share, share of local voice, average rank, centre rank, busiest competitors) and the same rollups per keyword. The text renders each keyword's panel as an ASCII heatmap with north at the top. Reads stored results — uses no credits and posts nothing.",
    inputSchema,
    outputSchema: z
      .object({
        run: looseObjectOutputSchema,
        gridSize: z.number(),
        keywords: z.array(looseObjectOutputSchema),
        rollups: looseObjectOutputSchema,
        rollupsByKeyword: z.array(looseObjectOutputSchema),
        cells: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const detail = await MapsGridService.getGridRun({
      runId: args.runId,
      projectId: args.projectId,
    });
    const cells = detail.cells.map(summarizeCell);
    const run = {
      runId: detail.run.id,
      configId: detail.run.configId,
      status: detail.run.status,
      trigger: detail.run.trigger,
      cellsTotal: detail.run.cellsTotal,
      cellsCollected: detail.run.cellsCollected,
      spentCostMicros: detail.run.spentCostMicros,
      costStatus: detail.run.costStatus,
      errorMessage: detail.run.errorMessage,
      startedAt: detail.run.startedAt,
      completedAt: detail.run.completedAt,
      gridSize: detail.gridSize,
      radiusMiles: detail.radiusMiles,
      zoom: detail.zoom,
      device: detail.device,
      location: detail.location,
      previousRunId: detail.previousRun?.runId ?? null,
    };

    const text = [
      `Grid run ${run.runId} (${run.status}, ${detail.gridSize}x${detail.gridSize}, ${run.cellsCollected}/${run.cellsTotal} cells collected${
        run.spentCostMicros == null
          ? ""
          : `, spend ${formatMicrosUsd(run.spentCostMicros)}${run.costStatus === "known_minimum" ? " (floor)" : ""}`
      }).`,
      detail.location
        ? `Location: ${detail.location.name} (${detail.location.brandName}) at ${detail.location.lat},${detail.location.lng}, radius ${detail.radiusMiles ?? "—"} mi.`
        : "Location: no longer configured.",
      `Run rollups: visibility ${detail.rollups.visibilityScore.toFixed(1)}, top3 ${detail.rollups.top3Percent.toFixed(1)}%, top10 ${detail.rollups.top10Percent.toFixed(1)}%, top20 ${detail.rollups.top20Percent.toFixed(1)}%, share of local voice ${(detail.rollups.shareOfLocalVoice * 100).toFixed(1)}%, avg rank where found ${detail.rollups.avgRankWhenFound?.toFixed(2) ?? "—"}, centre rank ${detail.rollups.centerRank?.toFixed(2) ?? "—"}.`,
      'Rank per cell, north at the top ("–" = collected but the client did not rank there, "x" = the cell was never collected):',
      ...detail.rollupsByKeyword.flatMap((keyword) => [
        `"${keyword.keyword}" — visibility ${keyword.rollups.visibilityScore.toFixed(1)}, share of local voice ${(keyword.rollups.shareOfLocalVoice * 100).toFixed(1)}%, centre rank ${keyword.rollups.centerRank?.toFixed(2) ?? "—"}`,
        renderGrid(cells, detail.gridSize, keyword.id),
        keyword.rollups.competitors.length === 0
          ? "  top competitors: none recorded"
          : `  top competitors: ${keyword.rollups.competitors
              .slice(0, COMPETITORS_PER_CELL)
              .map(
                (competitor) =>
                  `${competitor.name} (top3 in ${competitor.top3Cells} cells)`,
              )
              .join(", ")}`,
      ]),
    ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/maps-grid`,
      ),
      structuredContent: {
        run,
        gridSize: detail.gridSize,
        keywords: detail.keywords,
        rollups: detail.rollups,
        rollupsByKeyword: detail.rollupsByKeyword,
        cells,
      },
    });
  }),
};

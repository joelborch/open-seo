import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { computeRunRollups } from "@/server/features/maps-grid/services/mapsGridRollups";
import { AppError } from "@/server/lib/errors";
import { sort } from "remeda";

/**
 * Read models for the grid. Every number the UI shows is aggregated here from
 * the cells and their packs rather than stored — a 49-cell panel is cheap to
 * re-roll and impossible to leave stale.
 */

/** Runs offered in the run picker, and the window the trend chart covers. */
const RUN_HISTORY_LIMIT = 24;

export async function getGridRuns(input: {
  configId: string;
  projectId: string;
}) {
  const config = await MapsGridRepository.getConfigById(input);
  if (!config) throw new AppError("NOT_FOUND", "Grid config not found");
  return MapsGridRepository.getRunsForConfig(config.id, RUN_HISTORY_LIMIT);
}

interface GridRunCell {
  id: number;
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
  results: Array<{
    name: string;
    rank: number;
    isClient: boolean;
    placeId: string | null;
    rating: number | null;
    reviewsCount: number | null;
    url: string | null;
  }>;
}

/**
 * One run in full: its cells with their packs, the run-level rollups, and the
 * same rollups per keyword (each keyword is its own 7×7 panel, so a run-wide
 * visibility score alone would hide a keyword that lost the whole map).
 *
 * `previousRun` carries the prior run's ranks for week-over-week deltas, and is
 * null unless that run covered the same keywords on the same grid — comparing
 * across a changed panel would report movement that never happened.
 */
export async function getGridRun(input: { runId: string; projectId: string }) {
  const run = await MapsGridRepository.getRunForProject(input);
  if (!run) throw new AppError("NOT_FOUND", "Grid run not found");

  const config = await MapsGridRepository.getConfigForRun(run.configId);
  const location = config
    ? await MapsGridRepository.getLocationForRun(config.locationId)
    : null;

  const [cells, results] = await Promise.all([
    MapsGridRepository.getCellsForRun(run.id),
    MapsGridRepository.getCellResultsForRuns([run.id]),
  ]);

  const gridSize = config?.gridSize ?? inferGridSize(cells);
  const resultsByCell = new Map<number, GridRunCell["results"]>();
  for (const row of results) {
    const rows = resultsByCell.get(row.cellId) ?? [];
    rows.push({
      name: row.name,
      rank: row.rank,
      isClient: row.isClient,
      placeId: row.placeId,
      rating: row.rating,
      reviewsCount: row.reviewsCount,
      url: row.url,
    });
    resultsByCell.set(row.cellId, rows);
  }

  const detailCells: GridRunCell[] = cells.map((cell) => ({
    id: cell.id,
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
    results: resultsByCell.get(cell.id) ?? [],
  }));

  const keywords = dedupeKeywords(detailCells);
  const rollupInput = { gridSize, cells: detailCells, results };

  return {
    run,
    gridSize,
    radiusMiles: config?.radiusMiles ?? null,
    zoom: config?.zoom ?? null,
    device: config?.device ?? null,
    location: location
      ? {
          id: location.id,
          name: location.name,
          lat: location.lat,
          lng: location.lng,
          brandName: location.brandName,
        }
      : null,
    keywords,
    cells: detailCells,
    rollups: computeRunRollups(rollupInput),
    rollupsByKeyword: keywords.map((keyword) => ({
      ...keyword,
      rollups: computeRunRollups({
        gridSize,
        cells: detailCells.filter((cell) => cell.keywordId === keyword.id),
        results: results.filter((row) => row.keywordId === keyword.id),
      }),
    })),
    previousRun: await getComparablePreviousRun({
      run,
      gridSize,
      keywordIds: keywords.map((keyword) => keyword.id),
    }),
  };
}

/**
 * Visibility over time, per keyword and for the run as a whole. Ranks alone
 * drive every number here, so the ranked packs are never read — a 24-run trend
 * stays one cells query.
 */
export async function getGridTrend(input: {
  configId: string;
  projectId: string;
}) {
  const config = await MapsGridRepository.getConfigById(input);
  if (!config) throw new AppError("NOT_FOUND", "Grid config not found");

  // Oldest first: a trend line reads left to right, and the history query
  // returns newest first for the run picker.
  const runs = sort(
    (
      await MapsGridRepository.getRunsForConfig(config.id, RUN_HISTORY_LIMIT)
    ).filter((run) => run.status === "completed"),
    (a, b) => a.startedAt.localeCompare(b.startedAt),
  );
  const cells = await MapsGridRepository.getCellsForRuns(
    runs.map((run) => run.id),
  );

  return runs.map((run) => {
    const runCells = cells.filter((cell) => cell.runId === run.id);
    const keywords = dedupeKeywords(runCells);
    return {
      runId: run.id,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      rollups: computeRunRollups({
        gridSize: config.gridSize,
        cells: runCells,
        results: [],
      }),
      byKeyword: keywords.map((keyword) => ({
        ...keyword,
        rollups: computeRunRollups({
          gridSize: config.gridSize,
          cells: runCells.filter((cell) => cell.keywordId === keyword.id),
          results: [],
        }),
      })),
    };
  });
}

/**
 * The run before this one, but only when its panel is comparable: the same
 * keyword ids and the same number of cells per keyword. Anything else and a
 * per-cell delta would be comparing different questions.
 */
async function getComparablePreviousRun(input: {
  run: { id: string; configId: string; startedAt: string };
  gridSize: number;
  keywordIds: string[];
}) {
  const history = await MapsGridRepository.getRunsForConfig(
    input.run.configId,
    RUN_HISTORY_LIMIT,
  );
  // History is newest first, so anything after this run's slot is older. A run
  // that has aged out of the window has no comparable predecessor to offer —
  // without this guard `slice(0)` would hand back the whole list and pick a
  // *newer* run as the baseline.
  const index = history.findIndex((run) => run.id === input.run.id);
  if (index === -1) return null;
  const previous = history
    .slice(index + 1)
    .find((run) => run.status === "completed");
  if (!previous) return null;

  const cells = await MapsGridRepository.getCellsForRuns([previous.id]);
  const previousKeywordIds = new Set(cells.map((cell) => cell.keywordId));
  const sameKeywords =
    previousKeywordIds.size === input.keywordIds.length &&
    input.keywordIds.every((id) => previousKeywordIds.has(id));
  const sameGrid =
    cells.length === previousKeywordIds.size * input.gridSize * input.gridSize;
  if (!sameKeywords || !sameGrid) return null;

  return {
    runId: previous.id,
    startedAt: previous.startedAt,
    cellRanks: cells.map((cell) => ({
      keywordId: cell.keywordId,
      gridRow: cell.gridRow,
      gridCol: cell.gridCol,
      clientRank: cell.clientRank,
    })),
  };
}

function dedupeKeywords(
  cells: Array<{ keywordId: string; keyword: string }>,
): Array<{ id: string; keyword: string }> {
  const byId = new Map<string, string>();
  for (const cell of cells) byId.set(cell.keywordId, cell.keyword);
  const entries = [...byId.entries()].map(([id, keyword]) => ({ id, keyword }));
  return sort(entries, (a, b) => a.keyword.localeCompare(b.keyword));
}

/** Grid size read back off the cells, for a run whose config was since deleted. */
function inferGridSize(cells: Array<{ gridRow: number }>): number {
  return cells.reduce((max, cell) => Math.max(max, cell.gridRow), 0);
}

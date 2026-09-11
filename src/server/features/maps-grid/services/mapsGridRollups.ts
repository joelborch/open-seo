import { sort } from "remeda";

/**
 * Grid rollups: the numbers a local-pack report is actually written from.
 *
 * A pure function over one run's cells and their ranked packs, so the same
 * arithmetic serves the run detail, the trend chart and the finalize log without
 * a rollup table to keep in sync — 49 cells per keyword is cheap to re-aggregate
 * and impossible to leave stale.
 */

/** Position a cell is scored at when the client does not rank in it at all. */
const NOT_FOUND_RANK = 21;

/** Visibility weight per rank band — a top-3 cell is worth far more than a 4-10. */
const RANK_BUCKETS = [
  { maxRank: 3, weight: 100 },
  { maxRank: 10, weight: 70 },
  { maxRank: 20, weight: 40 },
] as const;

export interface RollupCell {
  id: number;
  gridRow: number;
  gridCol: number;
  clientRank: number | null;
}

export interface RollupResult {
  cellId: number;
  placeId: string | null;
  name: string;
  rank: number;
  isClient: boolean;
}

interface CompetitorRollup {
  /** Place id when the provider gave one, else the lowercased name. */
  key: string;
  name: string;
  /** Cells this business appeared in at all. */
  cells: number;
  /** Cells it held a top-3 position in. */
  top3Cells: number;
  /** top3Cells as a share of the cells in the panel (0-1). */
  shareOfLocalVoice: number;
}

interface MapsGridRollups {
  cells: number;
  /** Mean rank-band weight across every cell, 0-100. */
  visibilityScore: number;
  top3Percent: number;
  top10Percent: number;
  top20Percent: number;
  /** Cells the client held a top-3 position in, as a share (0-1). */
  shareOfLocalVoice: number;
  /** Mean position over the cells where the client ranked at all. */
  avgRankWhenFound: number | null;
  /** Mean position with every miss counted as {@link NOT_FOUND_RANK}. */
  avgRankNotFoundAs21: number | null;
  /** Position in the grid's centre cell — the "classic" single-point rank. */
  centerRank: number | null;
  /** Busiest competitors first, then alphabetical. */
  competitors: CompetitorRollup[];
}

function bucketWeight(rank: number | null): number {
  if (rank === null) return 0;
  return RANK_BUCKETS.find((bucket) => rank <= bucket.maxRank)?.weight ?? 0;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Roll one panel of cells up into report numbers. Pass the cells of a single
 * keyword for a per-keyword rollup, or every cell of a run for the run-level
 * one; `centerRank` then averages the centre cell across keywords.
 */
export function computeRunRollups(input: {
  gridSize: number;
  cells: RollupCell[];
  results: RollupResult[];
}): MapsGridRollups {
  const { cells, results, gridSize } = input;
  const total = cells.length;
  if (total === 0) {
    return {
      cells: 0,
      visibilityScore: 0,
      top3Percent: 0,
      top10Percent: 0,
      top20Percent: 0,
      shareOfLocalVoice: 0,
      avgRankWhenFound: null,
      avgRankNotFoundAs21: null,
      centerRank: null,
      competitors: [],
    };
  }

  const ranks = cells.map((cell) => cell.clientRank);
  const found = ranks.filter((rank): rank is number => rank !== null);
  const countAtMost = (maxRank: number) =>
    found.filter((rank) => rank <= maxRank).length;

  // Rows and cols are 1-based, so the centre of a 7×7 grid is (4, 4).
  const centre = Math.floor(gridSize / 2) + 1;
  const centerRanks = cells
    .filter((cell) => cell.gridRow === centre && cell.gridCol === centre)
    .map((cell) => cell.clientRank)
    .filter((rank): rank is number => rank !== null);

  return {
    cells: total,
    visibilityScore:
      ranks.reduce<number>((sum, rank) => sum + bucketWeight(rank), 0) / total,
    top3Percent: (countAtMost(3) / total) * 100,
    top10Percent: (countAtMost(10) / total) * 100,
    top20Percent: (countAtMost(20) / total) * 100,
    shareOfLocalVoice: countAtMost(3) / total,
    avgRankWhenFound: mean(found),
    avgRankNotFoundAs21: mean(ranks.map((rank) => rank ?? NOT_FOUND_RANK)),
    centerRank: mean(centerRanks),
    competitors: rollUpCompetitors(results, total),
  };
}

/**
 * Who else owns this map. Keyed on place id where the provider supplied one, so
 * a business that renamed itself mid-run still counts once; the name falls back
 * to the key for the rows that have no place id.
 */
function rollUpCompetitors(
  results: RollupResult[],
  totalCells: number,
): CompetitorRollup[] {
  const byKey = new Map<
    string,
    { name: string; cells: Set<number>; top3Cells: Set<number> }
  >();

  for (const result of results) {
    if (result.isClient) continue;
    const key = result.placeId ?? result.name.trim().toLowerCase();
    if (key === "") continue;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { name: result.name, cells: new Set(), top3Cells: new Set() };
      byKey.set(key, entry);
    }
    entry.cells.add(result.cellId);
    if (result.rank <= 3) entry.top3Cells.add(result.cellId);
  }

  return sort(
    [...byKey.entries()].map(([key, entry]) => ({
      key,
      name: entry.name,
      cells: entry.cells.size,
      top3Cells: entry.top3Cells.size,
      shareOfLocalVoice: entry.top3Cells.size / totalCells,
    })),
    (a, b) =>
      b.top3Cells - a.top3Cells ||
      b.cells - a.cells ||
      a.name.localeCompare(b.name),
  );
}

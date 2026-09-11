import { describe, expect, it } from "vitest";
import {
  computeRunRollups,
  type RollupCell,
  type RollupResult,
} from "@/server/features/maps-grid/services/mapsGridRollups";

/** A 3×3 panel whose centre cell is (2, 2), one cell per supplied rank. */
function panel(ranks: Array<number | null>): RollupCell[] {
  return ranks.map((clientRank, index) => ({
    id: index + 1,
    gridRow: Math.floor(index / 3) + 1,
    gridCol: (index % 3) + 1,
    clientRank,
  }));
}

describe("computeRunRollups", () => {
  it("scores each rank band and reports the centre cell", () => {
    // Ranks by cell: a top-3, a 4-10, an 11-20, a miss, then the centre at 2.
    const rollups = computeRunRollups({
      gridSize: 3,
      cells: panel([1, 7, 15, null, 2, null, null, null, null]),
      results: [],
    });

    expect(rollups.cells).toBe(9);
    // (100 + 70 + 40 + 0 + 100 + 0·4) / 9
    expect(rollups.visibilityScore).toBeCloseTo(310 / 9, 10);
    expect(rollups.top3Percent).toBeCloseTo((2 / 9) * 100, 10);
    expect(rollups.top10Percent).toBeCloseTo((3 / 9) * 100, 10);
    expect(rollups.top20Percent).toBeCloseTo((4 / 9) * 100, 10);
    expect(rollups.shareOfLocalVoice).toBeCloseTo(2 / 9, 10);
    expect(rollups.avgRankWhenFound).toBeCloseTo((1 + 7 + 15 + 2) / 4, 10);
    // The five misses each count as 21.
    expect(rollups.avgRankNotFoundAs21).toBeCloseTo(
      (1 + 7 + 15 + 2 + 21 * 5) / 9,
      10,
    );
    expect(rollups.centerRank).toBe(2);
  });

  it("returns zeroes and no centre rank for an uncollected panel", () => {
    expect(computeRunRollups({ gridSize: 7, cells: [], results: [] })).toEqual({
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
    });
    expect(
      computeRunRollups({
        gridSize: 3,
        cells: panel(Array.from({ length: 9 }, () => null)),
        results: [],
      }),
    ).toMatchObject({
      visibilityScore: 0,
      centerRank: null,
      avgRankWhenFound: null,
    });
  });

  it("counts a competitor once per cell, keyed on place id, and excludes the client", () => {
    const results: RollupResult[] = [
      {
        cellId: 1,
        placeId: "p-rival",
        name: "Rival Dental",
        rank: 1,
        isClient: false,
      },
      // Same business, renamed between cells — the place id keeps it one row.
      {
        cellId: 2,
        placeId: "p-rival",
        name: "Rival Dental Care",
        rank: 2,
        isClient: false,
      },
      {
        cellId: 2,
        placeId: "p-rival",
        name: "Rival Dental Care",
        rank: 4,
        isClient: false,
      },
      {
        cellId: 1,
        placeId: null,
        name: "No Place Id Clinic",
        rank: 5,
        isClient: false,
      },
      { cellId: 1, placeId: "p-client", name: "Us", rank: 3, isClient: true },
    ];

    const { competitors } = computeRunRollups({
      gridSize: 3,
      cells: panel([3, 9, null, null, null, null, null, null, null]),
      results,
    });

    expect(competitors).toEqual([
      {
        key: "p-rival",
        name: "Rival Dental",
        cells: 2,
        top3Cells: 2,
        shareOfLocalVoice: 2 / 9,
      },
      {
        key: "no place id clinic",
        name: "No Place Id Clinic",
        cells: 1,
        top3Cells: 0,
        shareOfLocalVoice: 0,
      },
    ]);
  });

  it("averages the centre cell across keywords in a run-level rollup", () => {
    const cells: RollupCell[] = [
      { id: 1, gridRow: 2, gridCol: 2, clientRank: 2 },
      { id: 2, gridRow: 2, gridCol: 2, clientRank: 6 },
      // A miss in the centre is not averaged in — it has no position to average.
      { id: 3, gridRow: 2, gridCol: 2, clientRank: null },
    ];
    expect(
      computeRunRollups({ gridSize: 3, cells, results: [] }).centerRank,
    ).toBe(4);
  });
});

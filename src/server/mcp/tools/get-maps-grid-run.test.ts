import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeRunRollups } from "@/server/features/maps-grid/services/mapsGridRollups";
import { getMapsGridRunTool } from "./get-maps-grid-run";
import {
  gridCellRows,
  gridRunRow,
  monitoringIds,
  outputSchemaError,
} from "./monitoring-test-support";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getGridRun: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/maps-grid/services/MapsGridService", () => ({
  MapsGridService: { getGridRun: mocks.getGridRun },
}));

const { projectId } = monitoringIds;
const toolContext = makeToolContext();

/** The centre cell's pack: the client at 1, one competitor at 2. */
const centreResults = [
  {
    name: "Example Dental",
    rank: 1,
    isClient: true,
    placeId: "p1",
    rating: 4.8,
    reviewsCount: 120,
    url: null,
  },
  {
    name: "Rival Dental",
    rank: 2,
    isClient: false,
    placeId: "p2",
    rating: 4.5,
    reviewsCount: 80,
    url: null,
  },
];

const detailCells = gridCellRows("grid-run-1").map((cell) => ({
  ...cell,
  lat: 40.1,
  lng: -74.2,
  direction: "N",
  distanceMiles: 1.2,
  taskStatus: "retrieved",
  results: cell.gridRow === 2 && cell.gridCol === 2 ? centreResults : [],
}));

// The rollups the read model hands back are computed by the real (pure) rollup
// function, so the numbers the text renders are the production ones.
const rollups = computeRunRollups({
  gridSize: 3,
  cells: detailCells,
  results: detailCells.flatMap((cell) =>
    cell.results.map((result) => ({ ...result, cellId: cell.id })),
  ),
});

describe("get_maps_grid_run MCP tool", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      name: "Example Dental",
    });
    mocks.getGridRun.mockResolvedValue({
      run: gridRunRow(),
      gridSize: 3,
      radiusMiles: 5,
      zoom: "13z",
      device: "mobile",
      location: {
        id: "loc-1",
        name: "Downtown",
        lat: 40.1,
        lng: -74.2,
        brandName: "Example Dental",
      },
      keywords: [{ id: "kw-1", keyword: "emergency dentist" }],
      cells: detailCells,
      rollups,
      rollupsByKeyword: [{ id: "kw-1", keyword: "emergency dentist", rollups }],
      previousRun: null,
    });
  });

  it("renders the heatmap north-up and keeps each cell's top competitors", async () => {
    const result = await getMapsGridRunTool.handler(
      { projectId, runId: "grid-run-1" },
      toolContext,
    );

    const out = textContent(result);
    // Rank 1 in the centre cell, collected-but-unranked everywhere else.
    expect(out).toContain(" –  –  –\n –  1  –\n –  –  –");
    expect(out).toContain("top competitors: Rival Dental (top3 in 1 cells)");
    expect(out).toContain("share of local voice 11.1%");
    expect(result.structuredContent?.cells[4]?.topCompetitors).toEqual([
      {
        name: "Rival Dental",
        rank: 2,
        placeId: "p2",
        rating: 4.5,
        reviewsCount: 80,
      },
    ]);
    expect(
      await outputSchemaError(getMapsGridRunTool, result.structuredContent),
    ).toBe("valid");
  });
});

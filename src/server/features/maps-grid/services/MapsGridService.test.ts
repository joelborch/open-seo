import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapsGridService, startGridRun } from "./MapsGridService";

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  getLocationById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  tryCreateRun: vi.fn(),
  getActiveRunForConfig: vi.fn(),
  reserveCells: vi.fn(),
  updateRun: vi.fn(),
  getRunForProject: vi.fn(),
  getConfigForRun: vi.fn(),
  getLocationForRun: vi.fn(),
  getCellCostSummary: vi.fn(),
  staleGridRunReason: vi.fn(),
  failGridRunWithLedger: vi.fn(),
  collectGridCells: vi.fn(),
  workflowCreate: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    MAPS_GRID_WORKFLOW: {
      create: mocks.workflowCreate,
      get: () => ({ terminate: vi.fn() }),
    },
  },
}));
vi.mock("@/server/features/maps-grid/repositories/MapsGridRepository", () => ({
  MapsGridRepository: mocks,
}));
vi.mock("@/server/features/maps-grid/services/mapsGridRunGuards", () => ({
  staleGridRunReason: mocks.staleGridRunReason,
  failGridRunWithLedger: mocks.failGridRunWithLedger,
}));
vi.mock("@/server/features/maps-grid/services/mapsGridCollector", () => ({
  collectGridCells: mocks.collectGridCells,
}));
vi.mock("@/server/features/maps-grid/services/mapsGridReads", () => ({
  getGridRun: vi.fn(),
  getGridRuns: vi.fn(),
  getGridTrend: vi.fn(),
}));

const startInput = {
  configId: "config_1",
  projectId: "project_1",
  billingCustomer: {
    userId: "user_1",
    userEmail: "user@example.com",
    organizationId: "org_1",
    projectId: "project_1",
  },
  trigger: "manual" as const,
};

describe("starting a grid run", () => {
  beforeEach(() => {
    mocks.getConfigById.mockResolvedValue({
      id: "config_1",
      projectId: "project_1",
      locationId: "location_1",
      gridSize: 3,
      radiusMiles: 2,
      zoom: "13z",
      languageCode: "en",
      device: "mobile",
      depth: 20,
    });
    mocks.getLocationById.mockResolvedValue({
      id: "location_1",
      name: "Acme Dental",
      lat: 40,
      lng: -80,
    });
    mocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw_1", keyword: "dentist" },
    ]);
    mocks.tryCreateRun.mockResolvedValue(true);
    mocks.staleGridRunReason.mockResolvedValue(null);
  });

  it("refuses a run that costs more than the approved amount", async () => {
    await expect(
      startGridRun({ ...startInput, authorizedCostMicros: 1 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(mocks.tryCreateRun).not.toHaveBeenCalled();
    expect(mocks.workflowCreate).not.toHaveBeenCalled();
  });

  it("clears a blocking run whose workflow died and starts anyway", async () => {
    mocks.tryCreateRun.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.getActiveRunForConfig.mockResolvedValue({ id: "run_dead" });
    mocks.staleGridRunReason.mockResolvedValue("Grid workflow errored");

    const result = await startGridRun({
      ...startInput,
      authorizedCostMicros: 1_000_000,
    });

    expect(mocks.failGridRunWithLedger).toHaveBeenCalledWith(
      "run_dead",
      "Grid workflow errored",
    );
    expect(result).toMatchObject({ dryRun: false, ok: true });
  });

  it("still reports already_running when the blocker is alive", async () => {
    mocks.tryCreateRun.mockResolvedValue(false);
    mocks.getActiveRunForConfig.mockResolvedValue({ id: "run_live" });

    const result = await startGridRun({
      ...startInput,
      authorizedCostMicros: 1_000_000,
    });

    expect(mocks.failGridRunWithLedger).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      reason: "already_running",
      blockingRunId: "run_live",
    });
  });

  it("releases the run slot when reserving its cells fails", async () => {
    mocks.reserveCells.mockRejectedValue(new Error("D1 write failed"));

    await expect(
      startGridRun({ ...startInput, authorizedCostMicros: 1_000_000 }),
    ).rejects.toThrow("D1 write failed");

    expect(mocks.updateRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
    );
    expect(mocks.workflowCreate).not.toHaveBeenCalled();
  });
});

describe("collecting a grid run on demand", () => {
  it("refuses while the workflow still owns the run", async () => {
    mocks.getRunForProject.mockResolvedValue({
      id: "run_1",
      configId: "config_1",
      status: "running",
    });

    await expect(
      MapsGridService.retrieveGridRun({
        runId: "run_1",
        projectId: "project_1",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // A collect pass replaces each cell's rows, so racing the workflow's own
    // round can duplicate them.
    expect(mocks.collectGridCells).not.toHaveBeenCalled();
  });

  it("collects a settled run", async () => {
    mocks.getRunForProject.mockResolvedValue({
      id: "run_1",
      configId: "config_1",
      status: "failed",
    });
    mocks.getConfigForRun.mockResolvedValue({ locationId: "location_1" });
    mocks.getLocationForRun.mockResolvedValue({
      id: "location_1",
      matchTerms: [],
    });
    mocks.collectGridCells.mockResolvedValue({ collected: 2, failed: 0 });
    mocks.getCellCostSummary.mockResolvedValue({ outstanding: 1 });

    const result = await MapsGridService.retrieveGridRun({
      runId: "run_1",
      projectId: "project_1",
    });

    expect(result).toMatchObject({ collected: 2, outstanding: 1 });
  });
});

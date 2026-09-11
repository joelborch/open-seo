import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { MapsGridWorkflow } from "./MapsGridWorkflow";

const mocks = vi.hoisted(() => ({
  getConfigForRun: vi.fn(),
  getLocationForRun: vi.fn(),
  getReservedCells: vi.fn(),
  markCellsSubmitted: vi.fn(),
  markCellsOutcome: vi.fn(),
  parkReservedCells: vi.fn(),
  getCellCostSummary: vi.fn(),
  getCellsForRun: vi.fn(),
  getCellResultsForRuns: vi.fn(),
  getRunById: vi.fn(),
  updateRun: vi.fn(),
  updateConfig: vi.fn(),
  mapsGridTaskPost: vi.fn(),
  fetchMapsTasksReady: vi.fn(),
  collectGridCells: vi.fn(),
  failGridRunWithLedger: vi.fn(),
  captureServerEvent: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: vi.fn() }));
vi.mock("@/db", () => ({ withPgClient: (fn: () => unknown) => fn() }));
vi.mock("@/server/features/maps-grid/repositories/MapsGridRepository", () => ({
  MapsGridRepository: mocks,
}));
vi.mock("@/server/features/maps-grid/services/mapsGridCollector", () => ({
  collectGridCells: mocks.collectGridCells,
}));
vi.mock("@/server/features/maps-grid/services/mapsGridRollups", () => ({
  computeRunRollups: () => ({ visibilityScore: 0 }),
}));
vi.mock("@/server/features/maps-grid/services/MapsGridService", () => ({
  matchIdentityForLocation: () => ({ brandName: "Acme", matchTerms: [] }),
}));
vi.mock("@/server/features/maps-grid/services/mapsGridRunGuards", () => ({
  failGridRunWithLedger: mocks.failGridRunWithLedger,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    serp: { mapsGridTaskPost: mocks.mapsGridTaskPost },
  }),
  fetchMapsTasksReady: mocks.fetchMapsTasksReady,
  MAX_TASKS_PER_POST: 100,
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: mocks.captureServerEvent,
}));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));

// step.sleep is a no-op so the poll loop runs to completion in-process.
const step = {
  sleep: vi.fn(async () => undefined),
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only sleep is reached; pgStep is mocked to call step bodies directly
} as unknown as WorkflowStep;

const cell = {
  tag: "run_1:kw_1:r0c0",
  keyword: "dentist",
  lat: 40,
  lng: -80,
};

function costSummary(overrides: Record<string, number> = {}) {
  return {
    actualCostMicros: 0,
    reservedCostMicros: 0,
    collected: 1,
    submissionUnknown: 0,
    outstanding: 0,
    ...overrides,
  };
}

async function runWorkflow() {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mocked base class does not inspect Worker constructor context
  const workflow = new MapsGridWorkflow({} as ExecutionContext, {} as Env);
  await workflow.run(
    {
      instanceId: "run_1",
      timestamp: new Date(),
      payload: {
        runId: "run_1",
        configId: "config_1",
        projectId: "project_1",
        locationId: "location_1",
        billingCustomer: {
          userId: "user_1",
          userEmail: "user@example.com",
          organizationId: "org_1",
          projectId: "project_1",
        },
        trigger: "manual" as const,
      },
    },
    step,
  );
}

/**
 * The grid runs on the owner's own DataForSEO key, so a cell that is charged but
 * left in a state nothing collects and no rollup counts is silent spend.
 */
describe("maps grid run cell ledger", () => {
  beforeEach(() => {
    mocks.getConfigForRun.mockResolvedValue({
      zoom: "13z",
      languageCode: "en",
      device: "mobile",
      depth: 20,
      gridSize: 1,
      locationId: "location_1",
    });
    mocks.getLocationForRun.mockResolvedValue({ id: "location_1" });
    mocks.getReservedCells.mockResolvedValue([cell]);
    mocks.getRunById.mockResolvedValue({
      id: "run_1",
      status: "running",
      cellsTotal: 1,
    });
    mocks.getCellsForRun.mockResolvedValue([]);
    mocks.getCellResultsForRuns.mockResolvedValue([]);
    mocks.parkReservedCells.mockResolvedValue(0);
    mocks.getCellCostSummary.mockResolvedValue(costSummary());
    mocks.fetchMapsTasksReady.mockResolvedValue([]);
    mocks.collectGridCells.mockResolvedValue({ collected: 1, failed: 0 });
  });

  it("parks a chunk whose settlement fails after the post, and never re-posts it", async () => {
    mocks.mapsGridTaskPost.mockResolvedValue({
      posted: [{ tag: cell.tag, taskId: "task-a", costUsd: 0.0012 }],
      rejected: [],
    });
    // The charge landed; the write that records its task id is what fails.
    mocks.markCellsSubmitted.mockRejectedValue(new Error("D1 write failed"));

    await runWorkflow();

    expect(mocks.markCellsOutcome).toHaveBeenCalledWith([
      { tag: cell.tag, status: "submission_unknown" },
    ]);
    // One post: a cell DataForSEO may already hold is never bought again.
    expect(mocks.mapsGridTaskPost).toHaveBeenCalledTimes(1);
  });

  it("sweeps leftover reserved cells before rolling up the spend", async () => {
    mocks.mapsGridTaskPost.mockResolvedValue({
      posted: [{ tag: cell.tag, taskId: "task-a", costUsd: 0.0012 }],
      rejected: [],
    });
    mocks.parkReservedCells.mockResolvedValue(1);
    mocks.getCellCostSummary.mockResolvedValue(
      costSummary({ actualCostMicros: 1_200, submissionUnknown: 1 }),
    );

    await runWorkflow();

    expect(mocks.parkReservedCells).toHaveBeenCalledWith("run_1");
    // The sweep has to land before the rollup reads the ledger, or the swept
    // cells are counted as neither spent nor outstanding.
    const lastSummaryCall =
      mocks.getCellCostSummary.mock.invocationCallOrder.at(-1) ?? 0;
    expect(mocks.parkReservedCells.mock.invocationCallOrder[0]).toBeLessThan(
      lastSummaryCall,
    );
    expect(mocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "completed",
        spentCostMicros: 1_200,
        costStatus: "known_minimum",
      }),
    );
  });
});

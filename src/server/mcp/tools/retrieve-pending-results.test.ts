import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  gridRunRow,
  monitoringIds,
  outputSchemaError,
  rankRunRow,
} from "./monitoring-test-support";
import { retrievePendingResultsTool } from "./retrieve-pending-results";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getRankConfigs: vi.fn(),
  getRankRunHistory: vi.fn(),
  retrieveRankRun: vi.fn(),
  getRankRunById: vi.fn(),
  getSubmittedRankCheckTasks: vi.fn(),
  getGridConfigsForProject: vi.fn(),
  getSubmittedGridCells: vi.fn(),
  getGridRuns: vi.fn(),
  retrieveGridRun: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    getConfigs: mocks.getRankConfigs,
    getRunHistory: mocks.getRankRunHistory,
    retrieveRun: mocks.retrieveRankRun,
  },
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getRunById: mocks.getRankRunById,
      getSubmittedRankCheckTasks: mocks.getSubmittedRankCheckTasks,
    },
  }),
);
vi.mock("@/server/features/maps-grid/repositories/MapsGridRepository", () => ({
  MapsGridRepository: {
    getConfigsForProject: mocks.getGridConfigsForProject,
    getSubmittedCells: mocks.getSubmittedGridCells,
    getRunForProject: vi.fn(),
  },
}));
vi.mock("@/server/features/maps-grid/services/MapsGridService", () => ({
  MapsGridService: {
    getGridRuns: mocks.getGridRuns,
    retrieveGridRun: mocks.retrieveGridRun,
  },
}));

const { projectId, trackerId, gridConfigId } = monitoringIds;
const toolContext = makeToolContext();

describe("retrieve_pending_results MCP tool", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      name: "Example Dental",
    });
    mocks.getRankConfigs.mockResolvedValue([{ id: trackerId }]);
    mocks.getRankRunHistory.mockResolvedValue([rankRunRow()]);
    mocks.getGridConfigsForProject.mockResolvedValue([{ id: gridConfigId }]);
    mocks.getGridRuns.mockResolvedValue([gridRunRow()]);
  });

  it("collects both loops' outstanding runs and reports what it found", async () => {
    mocks.getSubmittedRankCheckTasks.mockResolvedValue([
      { trackingKeywordId: "kw-1", device: "mobile", providerTaskId: "task-1" },
    ]);
    mocks.retrieveRankRun.mockResolvedValue({
      runId: "rank-run-1",
      collected: 1,
      stillPending: 0,
      failed: 0,
      spentCostMicros: 24_000,
      costStatus: "known",
    });
    mocks.getSubmittedGridCells.mockResolvedValue([
      { id: 1, providerTaskId: "task-2" },
    ]);
    mocks.retrieveGridRun.mockResolvedValue({
      collected: 2,
      failed: 0,
      stillPending: 1,
      deferred: 0,
      outstanding: 1,
    });

    const result = await retrievePendingResultsTool.handler(
      { projectId },
      toolContext,
    );

    expect(mocks.retrieveRankRun).toHaveBeenCalledWith({
      runId: "rank-run-1",
      projectId,
    });
    expect(mocks.retrieveGridRun).toHaveBeenCalledWith({
      runId: "grid-run-1",
      projectId,
    });
    const out = textContent(result);
    expect(out).toContain("Collected 3 result(s) across 2 run(s)");
    expect(out).toContain(
      "- grid run grid-run-1: collected 2, still pending 1, failed 0, outstanding 1",
    );
    expect(
      await outputSchemaError(
        retrievePendingResultsTool,
        result.structuredContent,
      ),
    ).toBe("valid");
  });

  it("skips a run with nothing left to collect", async () => {
    mocks.getSubmittedRankCheckTasks.mockResolvedValue([]);
    mocks.getSubmittedGridCells.mockResolvedValue([]);

    const result = await retrievePendingResultsTool.handler(
      { projectId },
      toolContext,
    );

    expect(mocks.retrieveRankRun).not.toHaveBeenCalled();
    expect(mocks.retrieveGridRun).not.toHaveBeenCalled();
    expect(textContent(result)).toContain(
      "- rank run rank-run-1: skipped, no submitted tasks left to collect",
    );
  });

  it("refuses a run that is still in flight", async () => {
    mocks.getRankRunById.mockResolvedValue({
      id: "rank-run-9",
      projectId,
      status: "running",
    });

    await expect(
      retrievePendingResultsTool.handler(
        { projectId, runId: "rank-run-9" },
        toolContext,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mocks.retrieveRankRun).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  crawlRunRow,
  gridCellRows,
  gridRunRow,
  monitoringIds,
  outputSchemaError,
  rankRunRow,
} from "./monitoring-test-support";
import {
  getMonitoringStatusTool,
  listMonitoringRunsTool,
} from "./monitoring-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getScheduleHistory: vi.fn(),
  getRankConfigs: vi.fn(),
  getRankRunHistory: vi.fn(),
  getRankTaskCostSummary: vi.fn(),
  getGridConfigsForProject: vi.fn(),
  getGridCellsForRuns: vi.fn(),
  getGridRuns: vi.fn(),
  getLedgerForProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/audit-schedules/services/AuditScheduleService",
  () => ({
    AuditScheduleService: { getHistory: mocks.getScheduleHistory },
  }),
);
vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    getConfigs: mocks.getRankConfigs,
    getRunHistory: mocks.getRankRunHistory,
  },
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getRankCheckTaskCostSummary: mocks.getRankTaskCostSummary,
    },
  }),
);
vi.mock("@/server/features/maps-grid/repositories/MapsGridRepository", () => ({
  MapsGridRepository: {
    getConfigsForProject: mocks.getGridConfigsForProject,
    getCellsForRuns: mocks.getGridCellsForRuns,
  },
}));
vi.mock("@/server/features/maps-grid/services/MapsGridService", () => ({
  MapsGridService: { getGridRuns: mocks.getGridRuns },
}));
vi.mock(
  "@/server/features/bigquery-projection/repositories/BigqueryProjectionRepository",
  () => ({
    BigqueryProjectionRepository: {
      getLedgerForProject: mocks.getLedgerForProject,
    },
  }),
);

const { projectId, trackerId, gridConfigId, auditId } = monitoringIds;
const toolContext = makeToolContext();

describe("monitoring status and history MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      name: "Example Dental",
    });
    mocks.getScheduleHistory.mockResolvedValue([crawlRunRow()]);
    mocks.getRankConfigs.mockResolvedValue([
      {
        id: trackerId,
        domain: "example.com",
        locationCode: 2840,
        scheduleInterval: "weekly",
      },
    ]);
    mocks.getRankRunHistory.mockResolvedValue([rankRunRow()]);
    mocks.getRankTaskCostSummary.mockResolvedValue({
      actualCostMicros: 24_000,
      reservedCostMicros: 24_000,
      submissionUnknown: 2,
      outstanding: 1,
    });
    mocks.getGridConfigsForProject.mockResolvedValue([
      {
        id: gridConfigId,
        locationId: "loc-1",
        gridSize: 3,
        scheduleInterval: "weekly",
        isActive: true,
      },
    ]);
    mocks.getGridRuns.mockResolvedValue([gridRunRow()]);
    mocks.getGridCellsForRuns.mockResolvedValue(gridCellRows("grid-run-1"));
    mocks.getLedgerForProject.mockResolvedValue([
      {
        runKind: "rank_check_run",
        runId: "rank-run-1",
        tableName: "rank_positions",
        dataset: "client_ds",
        rows: 0,
        projectedAt: "2026-06-01T04:10:00.000Z",
        error: "permission denied",
      },
      // A row for a run this call does not report must not be included.
      {
        runKind: "maps_grid_run",
        runId: "grid-run-0",
        tableName: "maps_grid",
        dataset: "client_ds",
        rows: 9,
        projectedAt: "2026-05-25T05:10:00.000Z",
        error: null,
      },
    ]);
  });

  it("get_monitoring_status reports the latest run of every loop with its projection ledger", async () => {
    const args = z
      .object(getMonitoringStatusTool.config.inputSchema)
      .parse({ projectId });

    const result = await getMonitoringStatusTool.handler(args, toolContext);

    const out = textContent(result);
    expect(out).toContain("quick completed, 120 pages, health 82 (+3)");
    expect(out).toContain(`archive crawls/org_123/${projectId}/${auditId}`);
    expect(out).toContain(
      "completed via queued, 38/40 keywords, spend $0.0240 (floor), 2 submission_unknown, 1 outstanding",
    );
    // Rollups are recomputed from the cells: rank 1 in 1 of 9 cells.
    expect(out).toContain("9/9 cells, visibility 11.1, SoLV 11.1%");
    expect(out).toContain(
      "rank_positions (client_ds) for rank_check_run rank-run-1: error: permission denied",
    );
    expect(out).not.toContain("grid-run-0");
    expect(
      await outputSchemaError(
        getMonitoringStatusTool,
        result.structuredContent,
      ),
    ).toBe("valid");
  });

  it("list_monitoring_runs returns each loop's history oldest first", async () => {
    mocks.getScheduleHistory.mockResolvedValue([
      crawlRunRow({
        id: "crawl-run-2",
        triggeredAt: "2026-06-02T03:00:00.000Z",
      }),
      crawlRunRow(),
    ]);
    mocks.getGridRuns.mockResolvedValue([
      gridRunRow({ id: "grid-run-2", startedAt: "2026-06-08T05:00:00.000Z" }),
      gridRunRow(),
    ]);
    mocks.getGridCellsForRuns.mockResolvedValue([
      ...gridCellRows("grid-run-1"),
      ...gridCellRows("grid-run-2"),
    ]);

    const crawls = await listMonitoringRunsTool.handler(
      { projectId, kind: "crawl", limit: 5 },
      toolContext,
    );
    const grids = await listMonitoringRunsTool.handler(
      { projectId, kind: "grid", limit: 5 },
      toolContext,
    );

    const crawlText = textContent(crawls);
    expect(crawlText.indexOf("crawl-run-1")).toBeLessThan(
      crawlText.indexOf("crawl-run-2"),
    );
    const gridText = textContent(grids);
    expect(gridText.indexOf("grid-run-1")).toBeLessThan(
      gridText.indexOf("grid-run-2"),
    );
    expect(gridText).toContain("visibility 11.1");
    expect(
      await outputSchemaError(listMonitoringRunsTool, crawls.structuredContent),
    ).toBe("valid");
    expect(
      await outputSchemaError(listMonitoringRunsTool, grids.structuredContent),
    ).toBe("valid");
  });
});

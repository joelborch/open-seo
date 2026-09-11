import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BigqueryModule from "@/server/lib/bigquery";
import type { AuditRunSource } from "@/server/features/bigquery-projection/projectionRows";

const mocks = vi.hoisted(() => ({
  mergeRows: vi.fn<typeof BigqueryModule.mergeRows>(),
  getTarget: vi.fn(),
  getAuditRunSource: vi.fn(),
  getRankRunSource: vi.fn(),
  getMapsRunSource: vi.fn(),
  recordProjection: vi.fn(),
  getPendingRuns: vi.fn(),
  getLedgerForProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/bigquery", async (importOriginal) => ({
  ...(await importOriginal<typeof BigqueryModule>()),
  mergeRows: mocks.mergeRows,
}));
vi.mock(
  "@/server/features/bigquery-projection/repositories/BigqueryProjectionRepository",
  () => ({
    BigqueryProjectionRepository: {
      getTarget: mocks.getTarget,
      getAuditRunSource: mocks.getAuditRunSource,
      getRankRunSource: mocks.getRankRunSource,
      getMapsRunSource: mocks.getMapsRunSource,
      recordProjection: mocks.recordProjection,
      getPendingRuns: mocks.getPendingRuns,
      getLedgerForProject: mocks.getLedgerForProject,
    },
  }),
);

import { projectRun } from "./BigqueryProjectionService";

const auditSource: AuditRunSource = {
  run: {
    id: "run-1",
    cadence: "quick",
    triggeredAt: "2026-03-01 00:00:00",
    completedAt: "2026-03-02 00:00:00",
    pagesCrawled: 10,
    pagesWithErrors: null,
    pagesWithWarnings: null,
    pagesWithNotices: null,
    pagesBlocked: null,
    healthScore: 90,
    healthScoreDelta: null,
  },
  issueCounts: [],
};

describe("projectRun", () => {
  beforeEach(() => {
    mocks.getAuditRunSource.mockResolvedValue({
      projectId: "project-1",
      source: auditSource,
    });
    mocks.getTarget.mockResolvedValue({
      projectId: "project-1",
      clientKey: "airway",
      dataset: "airway_marketing",
      gscExportDataset: null,
    });
    mocks.mergeRows.mockResolvedValue({
      affectedRows: 2,
      sourceRows: 2,
      statements: 1,
    });
  });

  it("merges the run's table plus the internal observation and records both", async () => {
    const result = await projectRun({
      runKind: "audit_schedule_run",
      runId: "run-1",
    });

    expect(result.skipped).toBeNull();
    expect(
      mocks.mergeRows.mock.calls.map(([call]) => [
        call.dataset,
        call.spec.table,
      ]),
    ).toEqual([
      ["airway_marketing", "weekly_health_metrics"],
      ["seo_yolo_internal", "observations"],
    ]);
    expect(mocks.recordProjection).toHaveBeenCalledTimes(2);
    expect(mocks.recordProjection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runKind: "audit_schedule_run",
        runId: "run-1",
        tableName: "observations",
        error: null,
      }),
    );
  });

  it("records a failed MERGE as an error row and still writes the other tables", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.mergeRows.mockRejectedValueOnce(new Error("dataset not found"));

    const result = await projectRun({
      runKind: "audit_schedule_run",
      runId: "run-1",
    });

    expect(result.tables.map((table) => table.error)).toEqual([
      "dataset not found",
      null,
    ]);
    expect(mocks.recordProjection).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: "weekly_health_metrics",
        rows: 0,
        error: "dataset not found",
      }),
    );
    consoleError.mockRestore();
  });

  it("skips a project with no BigQuery target without touching BigQuery", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.getTarget.mockResolvedValue(null);

    const result = await projectRun({
      runKind: "audit_schedule_run",
      runId: "run-1",
    });

    expect(result.skipped).toBe("no_bigquery_target");
    expect(mocks.mergeRows).not.toHaveBeenCalled();
    expect(mocks.recordProjection).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });

  it("treats a run from another project as not found", async () => {
    const result = await projectRun({
      runKind: "audit_schedule_run",
      runId: "run-1",
      expectedProjectId: "project-2",
    });

    expect(result.skipped).toBe("run_not_found");
    expect(mocks.getTarget).not.toHaveBeenCalled();
    expect(mocks.mergeRows).not.toHaveBeenCalled();
  });
});

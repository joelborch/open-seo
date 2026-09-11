import { describe, expect, it, vi } from "vitest";
import type * as BigqueryModule from "@/server/lib/bigquery";

// The export reader exists to be optional: every miss must hand the request back
// to the Search Console API, including a miss caused by the export-target read
// itself failing, or a database blip 500s the Search Performance page.

const mocks = vi.hoisted(() => ({
  getTarget: vi.fn(),
  runQuery: vi.fn<typeof BigqueryModule.runQuery>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/bigquery", async (importOriginal) => ({
  ...(await importOriginal<typeof BigqueryModule>()),
  runQuery: mocks.runQuery,
}));
vi.mock(
  "@/server/features/bigquery-projection/repositories/BigqueryProjectionRepository",
  () => ({
    BigqueryProjectionRepository: { getTarget: mocks.getTarget },
  }),
);

import { gscExportRepository } from "./gscExportRepository";

const REQUEST = {
  projectId: "project-1",
  startDate: "2026-03-01",
  endDate: "2026-03-07",
  dimension: "query" as const,
  limit: 100,
};

describe("getSearchPerformanceFromExport", () => {
  it("falls back to the API when reading the export target throws", async () => {
    mocks.getTarget.mockRejectedValue(new Error("database unavailable"));
    // The fallback logs the cause; keep it out of the suite's output.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      gscExportRepository.getSearchPerformanceFromExport(REQUEST),
    ).resolves.toBeNull();
    expect(mocks.runQuery).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Each loop is metered, independent work: one that throws must not cost the tick
// the loops after it, and must not swallow an error an earlier loop captured.

const mocks = vi.hoisted(() => ({
  reconcileStaleAudits: vi.fn(),
  runScheduledCrawls: vi.fn(),
  runScheduledRankChecks: vi.fn(),
  runScheduledGridRuns: vi.fn(),
  runPendingProjections: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  withPgClient: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/server/features/audit/services/auditReconciler", () => ({
  reconcileStaleAudits: mocks.reconcileStaleAudits,
}));
vi.mock("@/server/features/audit-schedules/services/scheduledCrawls", () => ({
  runScheduledCrawls: mocks.runScheduledCrawls,
}));
vi.mock("@/server/features/rank-tracking/services/scheduledRankChecks", () => ({
  runScheduledRankChecks: mocks.runScheduledRankChecks,
}));
vi.mock("@/server/features/maps-grid/services/scheduledGridRuns", () => ({
  runScheduledGridRuns: mocks.runScheduledGridRuns,
}));
vi.mock(
  "@/server/features/bigquery-projection/services/BigqueryProjectionService",
  () => ({ runPendingProjections: mocks.runPendingProjections }),
);

import { runCronLoops } from "./cron-loops";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every loop is mocked, so nothing reads a binding
const env = {} as unknown as Env;

describe("runCronLoops", () => {
  beforeEach(() => {
    for (const loop of Object.values(mocks)) loop.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("finishes the later loops and rethrows the first error when the rank tick fails", async () => {
    const crawlError = new Error("crawl scheduler down");
    mocks.runScheduledCrawls.mockRejectedValue(crawlError);
    mocks.runScheduledRankChecks.mockRejectedValue(new Error("rank tick down"));

    await expect(runCronLoops(env)).rejects.toBe(crawlError);
    expect(mocks.runScheduledGridRuns).toHaveBeenCalled();
    expect(mocks.runPendingProjections).toHaveBeenCalled();
  });
});

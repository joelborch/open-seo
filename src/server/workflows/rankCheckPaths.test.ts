import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { createRankCheckTally, runQueuedCheck } from "./rankCheckPaths";

const mocks = vi.hoisted(() => ({
  reserveRankCheckTasks: vi.fn(),
  markRankCheckTasksSubmitted: vi.fn(),
  markRankCheckTasksOutcome: vi.fn(),
  markRankCheckTasksCollected: vi.fn(),
  updateRun: vi.fn(),
  persistRankCheckResults: vi.fn(),
  fetchRankCheckTaskResult: vi.fn(),
  rankCheckTaskPost: vi.fn(),
  rankCheck: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);
vi.mock("@/server/features/rank-tracking/services/rankSnapshotWriter", () => ({
  persistRankCheckResults: mocks.persistRankCheckResults,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  fetchRankCheckTaskResult: mocks.fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST: 100,
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

function makeContext() {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the serp section is exercised
    client: {
      serp: {
        rankCheckTaskPost: mocks.rankCheckTaskPost,
        rankCheck: mocks.rankCheck,
      },
    } as unknown as Parameters<typeof runQueuedCheck>[1]["client"],
    keywords: [{ id: "kw-1", keyword: "alpha" }],
    devices: "desktop" as const,
    serpDepth: 20,
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
    trackCompetitors: false,
    trackAiOverview: true,
    runId: "run_1",
  };
}

describe("queued rank check task ledger", () => {
  beforeEach(() => {
    mocks.persistRankCheckResults.mockResolvedValue(1);
  });

  it("reserves before posting, then settles submitted ids, costs and collection", async () => {
    mocks.rankCheckTaskPost.mockResolvedValue({
      posted: [
        {
          keyword: "alpha",
          keywordId: "kw-1",
          device: "desktop",
          taskId: "task-a",
          costUsd: 0.0012,
        },
      ],
      rejected: [],
    });
    mocks.fetchRankCheckTaskResult.mockResolvedValue({
      status: "completed",
      providerStatusCode: 20000,
      isEmpty: false,
      result: { keywordId: "kw-1", keyword: "alpha" },
    });

    const tally = createRankCheckTally();
    await runQueuedCheck(step, makeContext(), tally);

    // Ordering is the whole point: a row must exist before the request that
    // might charge for it.
    expect(
      mocks.reserveRankCheckTasks.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.rankCheckTaskPost.mock.invocationCallOrder[0]);
    expect(mocks.reserveRankCheckTasks).toHaveBeenCalledWith([
      expect.objectContaining({
        runId: "run_1",
        trackingKeywordId: "kw-1",
        device: "desktop",
        tag: "kw-1:desktop",
        status: "reserved",
        // Depth 20 queued = $0.00105, doubled for the AI Overview opt-in.
        reservedCostMicros: 2100,
      }),
    ]);
    expect(mocks.markRankCheckTasksSubmitted).toHaveBeenCalledWith("run_1", [
      {
        trackingKeywordId: "kw-1",
        device: "desktop",
        providerTaskId: "task-a",
        actualCostMicros: 1200,
      },
    ]);
    expect(mocks.markRankCheckTasksCollected).toHaveBeenCalledWith([
      {
        providerTaskId: "task-a",
        status: "retrieved",
        providerStatusCode: 20000,
      },
    ]);
    expect(tally).toMatchObject({
      queueTasks: 1,
      queueCollected: 1,
      fallbackTasks: 0,
      liveCostMicros: 0,
    });
  });

  it("marks a throwing post submission_unknown and never re-buys those pairs", async () => {
    mocks.rankCheckTaskPost.mockRejectedValue(new Error("socket hang up"));

    const tally = createRankCheckTally();
    await runQueuedCheck(step, makeContext(), tally);

    expect(mocks.markRankCheckTasksOutcome).toHaveBeenCalledWith("run_1", [
      expect.objectContaining({
        trackingKeywordId: "kw-1",
        device: "desktop",
        status: "submission_unknown",
      }),
    ]);
    // No live fallback: the request may have been charged already.
    expect(mocks.rankCheck).not.toHaveBeenCalled();
    expect(tally).toMatchObject({
      queueTasks: 0,
      fallbackTasks: 0,
      liveCostMicros: 0,
    });
  });

  it("records a refused entry as failed and sends it to the live endpoint", async () => {
    mocks.rankCheckTaskPost.mockResolvedValue({
      posted: [],
      rejected: [
        {
          keyword: "alpha",
          keywordId: "kw-1",
          device: "desktop",
          statusCode: 40006,
          statusMessage: "Task Limit Exceeded",
        },
      ],
    });
    mocks.rankCheck.mockResolvedValue({
      keywordId: "kw-1",
      keyword: "alpha",
      providerCostUsd: 0.0042,
    });

    const tally = createRankCheckTally();
    await runQueuedCheck(step, makeContext(), tally);

    expect(mocks.markRankCheckTasksOutcome).toHaveBeenCalledWith("run_1", [
      {
        trackingKeywordId: "kw-1",
        device: "desktop",
        status: "failed",
        providerStatusCode: 40006,
        providerStatusMessage: "Task Limit Exceeded",
      },
    ]);
    expect(tally).toMatchObject({
      fallbackTasks: 1,
      fallbackChecked: 1,
      liveCostMicros: 4200,
    });
  });
  it("parks the chunk when settling a successful post fails, and never re-posts it", async () => {
    mocks.rankCheckTaskPost.mockResolvedValue({
      posted: [
        {
          keyword: "alpha",
          keywordId: "kw-1",
          device: "desktop",
          taskId: "task-a",
          costUsd: 0.0012,
        },
      ],
      rejected: [],
    });
    // The charge landed; the write that records its task id is what fails.
    mocks.markRankCheckTasksSubmitted.mockRejectedValue(
      new Error("D1 write failed"),
    );

    const tally = createRankCheckTally();
    await runQueuedCheck(step, makeContext(), tally);

    expect(mocks.markRankCheckTasksOutcome).toHaveBeenCalledWith("run_1", [
      expect.objectContaining({
        trackingKeywordId: "kw-1",
        device: "desktop",
        status: "submission_unknown",
      }),
    ]);
    // One post, and no live re-buy of a pair DataForSEO may already hold.
    expect(mocks.rankCheckTaskPost).toHaveBeenCalledTimes(1);
    expect(mocks.rankCheck).not.toHaveBeenCalled();
    expect(tally).toMatchObject({ queueTasks: 0, fallbackTasks: 0 });
  });

  it("keeps fallback spend already incurred when a later fallback batch throws", async () => {
    // Eleven pairs all refused at post: two live-fallback batches (10 + 1).
    const keywords = Array.from({ length: 11 }, (_, index) => ({
      id: `kw-${index}`,
      keyword: `keyword ${index}`,
    }));
    mocks.rankCheckTaskPost.mockResolvedValue({
      posted: [],
      rejected: keywords.map((kw) => ({
        keyword: kw.keyword,
        keywordId: kw.id,
        device: "desktop",
        statusCode: 40006,
        statusMessage: "Task Limit Exceeded",
      })),
    });
    mocks.rankCheck.mockImplementation(
      (input: { keywordId: string; keyword: string }) =>
        Promise.resolve({ ...input, providerCostUsd: 0.0042 }),
    );
    mocks.persistRankCheckResults
      .mockResolvedValueOnce(10)
      .mockRejectedValueOnce(new Error("D1 write failed"));

    const tally = createRankCheckTally();
    await expect(
      runQueuedCheck(step, { ...makeContext(), keywords }, tally),
    ).rejects.toThrow("D1 write failed");

    // The first batch's ten live calls were charged and must survive the throw,
    // so finalize can report them instead of a confident zero.
    expect(tally.liveCostMicros).toBe(42_000);
    expect(tally.fallbackChecked).toBe(10);
  });
});

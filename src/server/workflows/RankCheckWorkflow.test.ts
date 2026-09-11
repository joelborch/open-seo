import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import {
  prepareRankCheckKeywords,
  RankCheckWorkflow,
} from "./RankCheckWorkflow";

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  getRunById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  updateRun: vi.fn(),
  autumnCheck: vi.fn(),
  createDataforseoClient: vi.fn(),
  runLiveCheck: vi.fn(),
  runQueuedCheck: vi.fn(),
  getRankCheckTaskCostSummary: vi.fn(),
  parkReservedRankCheckTasks: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  updateConfig: vi.fn(),
  failRunIfActive: vi.fn(),
  captureServerEvent: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
  resolveBrandTerms: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: vi.fn(),
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class extends Error {},
}));
vi.mock("@/db", () => ({ withPgClient: (fn: () => unknown) => fn() }));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);
vi.mock("@/server/features/rank-tracking/services/brandTerms", () => ({
  resolveBrandTerms: mocks.resolveBrandTerms,
}));
vi.mock("@/server/features/rank-tracking/services/rankCheckRunGuards", () => ({
  failRunIfActive: mocks.failRunIfActive,
}));
vi.mock("@/server/workflows/rankCheckPaths", () => ({
  createRankCheckTally: () => ({
    liveCostMicros: 0,
    queueTasks: 0,
    queueCollected: 0,
    fallbackTasks: 0,
    fallbackChecked: 0,
  }),
  runLiveCheck: mocks.runLiveCheck,
  runQueuedCheck: mocks.runQueuedCheck,
}));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: mocks.captureServerEvent,
}));
vi.mock("@/server/billing/autumn", () => ({
  autumn: { check: mocks.autumnCheck },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHostedServerAuthMode,
}));

const billingCustomer = {
  userId: "user_1",
  userEmail: "user@example.com",
  organizationId: "org_1",
  projectId: "project_1",
};

const activeRun = {
  id: "run_1",
  status: "running",
};

describe("rank check workflow credit ceiling", () => {
  beforeEach(() => {
    mocks.getRunById.mockResolvedValue(activeRun);
    mocks.updateRun.mockResolvedValue(undefined);
    mocks.isHostedServerAuthMode.mockResolvedValue(true);
    mocks.autumnCheck.mockResolvedValue({ balance: { remaining: 1_000 } });
  });

  it("rejects a keyword-list race before balance or DataForSEO calls", async () => {
    mocks.getConfigById.mockResolvedValue({ isActive: true });
    mocks.getKeywordsForConfig.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        id: `kw_${index}`,
        keyword: `keyword ${index}`,
      })),
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mocked base class does not inspect Worker constructor context
    const workflow = new RankCheckWorkflow({} as ExecutionContext, {} as Env);

    await expect(
      workflow.run(
        {
          instanceId: "run_1",
          timestamp: new Date(),
          payload: {
            runId: "run_1",
            configId: "config_1",
            billingCustomer,
            projectId: "project_1",
            domain: "example.com",
            locationCode: 2840,
            languageCode: "en",
            devices: "desktop",
            serpDepth: 10,
            trigger: "manual",
            maxCostCredits: 12,
          },
        },
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- workflow steps are executed directly by the pgStep mock
        {} as WorkflowStep,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(mocks.autumnCheck).not.toHaveBeenCalled();
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(mocks.runLiveCheck).not.toHaveBeenCalled();
  });

  it("accepts the same reloaded list at the approved ceiling", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(
      Array.from({ length: 4 }, (_, index) => ({
        id: `kw_${index}`,
        keyword: `keyword ${index}`,
      })),
    );

    const result = await prepareRankCheckKeywords({
      runId: "run_1",
      configId: "config_1",
      projectId: "project_1",
      domain: "example.com",
      billingCustomer,
      devices: "desktop",
      serpDepth: 10,
      trigger: "manual",
      maxCostCredits: 12,
    });

    expect(result.keywords).toHaveLength(4);
    expect(mocks.autumnCheck).toHaveBeenCalledTimes(2);
  });

  it("preserves callers that do not provide a ceiling", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        id: `kw_${index}`,
        keyword: `keyword ${index}`,
      })),
    );
    mocks.isHostedServerAuthMode.mockResolvedValue(false);

    const result = await prepareRankCheckKeywords({
      runId: "run_1",
      configId: "config_1",
      projectId: "project_1",
      domain: "example.com",
      billingCustomer,
      devices: "desktop",
      serpDepth: 10,
      trigger: "manual",
    });

    expect(result.keywords).toHaveLength(5);
    expect(mocks.autumnCheck).not.toHaveBeenCalled();
  });
});

/**
 * A run only ever reports "known" spend when nothing could be unaccounted. The
 * self-host deployment runs on the owner's own DataForSEO key, so this rollup is
 * the only record of what a run bought.
 */
describe("rank check run spend accounting", () => {
  const params = {
    runId: "run_1",
    configId: "config_1",
    billingCustomer,
    projectId: "project_1",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
    devices: "desktop" as const,
    serpDepth: 10,
  };

  async function runWorkflow(trigger: "manual" | "scheduled") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mocked base class does not inspect Worker constructor context
    const workflow = new RankCheckWorkflow({} as ExecutionContext, {} as Env);
    await workflow.run(
      {
        instanceId: "run_1",
        timestamp: new Date(),
        payload: { ...params, trigger },
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- workflow steps are executed directly by the pgStep mock
      {} as WorkflowStep,
    );
  }

  beforeEach(() => {
    mocks.isHostedServerAuthMode.mockResolvedValue(false);
    mocks.getConfigById.mockResolvedValue({ isActive: true });
    mocks.getRunById.mockResolvedValue({
      id: "run_1",
      status: "running",
      method: "queued",
      keywordsTotal: 2,
    });
    mocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw_1", keyword: "alpha" },
      { id: "kw_2", keyword: "beta" },
    ]);
    mocks.getSnapshotsForRun.mockResolvedValue([{ trackingKeywordId: "kw_1" }]);
    mocks.parkReservedRankCheckTasks.mockResolvedValue(0);
    mocks.getRankCheckTaskCostSummary.mockResolvedValue({
      actualCostMicros: 0,
      reservedCostMicros: 0,
      submissionUnknown: 0,
      outstanding: 0,
    });
  });

  it("reports the ledger's spend when a queued run dies after posting", async () => {
    mocks.getRankCheckTaskCostSummary.mockResolvedValue({
      actualCostMicros: 3_000,
      reservedCostMicros: 4_200,
      submissionUnknown: 1,
      outstanding: 1,
    });
    mocks.runQueuedCheck.mockRejectedValue(new Error("fallback batch failed"));

    await runWorkflow("scheduled");

    // Reserved rows are swept before the rollup so nothing sits in a state no
    // collector reads and no cost summary counts.
    expect(mocks.parkReservedRankCheckTasks).toHaveBeenCalledWith(
      "run_1",
      expect.any(String),
    );
    expect(mocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "completed",
        spentCostMicros: 3_000,
        costStatus: "known_minimum",
      }),
    );
  });

  it("keeps the live spend a partial run already incurred", async () => {
    mocks.runLiveCheck.mockImplementation(
      (_step: unknown, _ctx: unknown, tally: { liveCostMicros: number }) => {
        tally.liveCostMicros += 8_400;
        return Promise.reject(new Error("live batch failed"));
      },
    );

    await runWorkflow("manual");

    expect(mocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "completed",
        spentCostMicros: 8_400,
        costStatus: "known_minimum",
      }),
    );
  });

  it("settles as known when every task reported its charge", async () => {
    mocks.getRankCheckTaskCostSummary.mockResolvedValue({
      actualCostMicros: 2_100,
      reservedCostMicros: 2_100,
      submissionUnknown: 0,
      outstanding: 0,
    });
    mocks.runQueuedCheck.mockResolvedValue(undefined);

    await runWorkflow("scheduled");

    expect(mocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({
        status: "completed",
        spentCostMicros: 2_100,
        costStatus: "known",
      }),
    );
  });
});

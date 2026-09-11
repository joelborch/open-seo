import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistRankCheckResults } from "./rankSnapshotWriter";
import type { RankCheckResultWithDevice } from "./rankSnapshotWriter";

const mocks = vi.hoisted(() => ({
  insertSnapshots: vi.fn(),
  getSnapshotIdsForRun: vi.fn(),
  replaceSnapshotDetail: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: mocks }),
);

/** Only the fields the writer reads; the provider result type is much wider. */
function result(): RankCheckResultWithDevice {
  return {
    keywordId: "kw_1",
    keyword: "alpha",
    device: "desktop",
    serpFeatures: [],
    features: [
      { featureType: "local_pack", rankAbsolute: 2, clientPresent: true },
    ],
    aioPresent: true,
    aioClientCited: true,
    aioCitationPosition: 2,
    aioBrandMentioned: true,
    aioSnippet: "Top airway dentists in Houston include…",
    aioCitations: [
      {
        position: 1,
        domain: "rival.com",
        url: "https://rival.com/a",
        isClient: false,
      },
      { position: 2, domain: "example.com", url: null, isClient: true },
    ],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture is trimmed to the fields under test
  } as unknown as RankCheckResultWithDevice;
}

const existingRow = {
  id: 11,
  trackingKeywordId: "kw_1",
  device: "desktop" as const,
};

/**
 * Snapshots insert on-conflict-do-nothing, so a result whose row already exists
 * keeps the earlier row's position. Its detail rows have to stay with it, or a
 * live-fallback write bolts fresh SERP detail onto a queued snapshot.
 */
describe("persisting rank check results", () => {
  beforeEach(() => {
    mocks.insertSnapshots.mockResolvedValue(undefined);
  });

  it("leaves the detail rows of a snapshot that already existed", async () => {
    mocks.getSnapshotIdsForRun.mockResolvedValue([existingRow]);

    await persistRankCheckResults("run_1", [result()]);

    expect(mocks.replaceSnapshotDetail).toHaveBeenCalledWith([], {
      features: [],
      aioCitations: [],
    });
  });

  it("writes the features and AI Overview citations it inserted", async () => {
    mocks.getSnapshotIdsForRun
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([existingRow]);

    await persistRankCheckResults("run_1", [result()]);

    expect(mocks.replaceSnapshotDetail).toHaveBeenCalledWith([11], {
      features: [
        {
          snapshotId: 11,
          featureType: "local_pack",
          rankAbsolute: 2,
          clientPresent: true,
        },
      ],
      aioCitations: [
        {
          snapshotId: 11,
          position: 1,
          domain: "rival.com",
          url: "https://rival.com/a",
          isClient: false,
        },
        {
          snapshotId: 11,
          position: 2,
          domain: "example.com",
          url: null,
          isClient: true,
        },
      ],
    });
  });

  it("carries the brand mention and snippet onto the snapshot row", async () => {
    mocks.getSnapshotIdsForRun.mockResolvedValue([existingRow]);

    await persistRankCheckResults("run_1", [result()]);

    expect(mocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({
        aioBrandMentioned: true,
        aioSnippet: "Top airway dentists in Houston include…",
      }),
    ]);
  });
});

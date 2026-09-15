import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureGbpSnapshot } from "./GbpService";

// The invariants worth pinning here are the two that guard money: a second capture
// on the same day buys nothing, and a capture that fails gives its day back.

const mocks = vi.hoisted(() => ({
  getCaptureTarget: vi.fn(),
  claimSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
  updateSnapshot: vi.fn(),
  getSnapshotForDate: vi.fn(),
  replaceAttributes: vi.fn(),
  replaceReviews: vi.fn(),
  gbpProfile: vi.fn(),
  gbpReviewsTaskPost: vi.fn(),
  fetchBusinessDataTaskResult: vi.fn(),
}));

vi.mock("@/server/features/gbp/repositories/GbpRepository", () => ({
  GbpRepository: mocks,
  HISTORY_PER_LOCATION: 12,
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    business: {
      gbpProfile: mocks.gbpProfile,
      gbpReviewsTaskPost: mocks.gbpReviewsTaskPost,
    },
  }),
  fetchBusinessDataTaskResult: mocks.fetchBusinessDataTaskResult,
}));

const input = {
  locationId: "loc_1",
  projectId: "project_1",
  billingCustomer: {
    userId: "user_1",
    userEmail: "user@example.com",
    organizationId: "org_1",
    projectId: "project_1",
  },
};

const profile = {
  name: "Airway Dentists",
  primaryCategory: "Dentist",
  additionalCategories: ["Cosmetic dentist"],
  cid: "123",
  placeId: "ChIJplace",
  rating: 4.8,
  reviewsCount: 214,
  isClaimed: true,
  address: "1 Main St",
  phone: "+1 555",
  website: "https://example.com",
  photosCount: 42,
  availableAttributes: [{ key: "service_options", value: "has_online_care" }],
};

describe("captureGbpSnapshot", () => {
  beforeEach(() => {
    mocks.getCaptureTarget.mockResolvedValue({
      locationId: "loc_1",
      projectId: "project_1",
      name: "Houston",
      brandName: "Airway Dentists",
      slug: "houston",
      lat: 29.7604,
      lng: -95.3698,
      radiusMiles: 5,
      placeId: "ChIJplace",
      lastCid: "123",
    });
    mocks.claimSnapshot.mockResolvedValue(true);
    mocks.gbpProfile.mockResolvedValue({ profile, costUsd: 0.002 });
    mocks.gbpReviewsTaskPost.mockResolvedValue({
      taskId: "task-1",
      costUsd: 0.00075,
    });
  });

  it("pins the lookup to the cid a previous snapshot resolved and sums both charges", async () => {
    const result = await captureGbpSnapshot(input);

    expect(mocks.gbpProfile).toHaveBeenCalledWith({
      keyword: "cid:123",
      locationCoordinate: "29.7604,-95.3698,8047",
      languageCode: "en",
    });
    expect(result).toMatchObject({
      created: true,
      profileFound: true,
      reviewsCollected: false,
      // usdToMicros rounds each call up: 2000 + 750.
      costMicros: 2750,
    });
  });

  it("refuses an area-name lookup before any provider spend", async () => {
    mocks.getCaptureTarget.mockResolvedValue({
      locationId: "loc_1",
      projectId: "project_1",
      name: "Cypress",
      lat: 29.7,
      lng: -95.3,
      radiusMiles: 5,
      placeId: null,
      lastCid: null,
    });
    await expect(captureGbpSnapshot(input)).rejects.toThrow(
      "verified Place ID",
    );
    expect(mocks.gbpProfile).not.toHaveBeenCalled();
    expect(mocks.gbpReviewsTaskPost).not.toHaveBeenCalled();
    expect(mocks.deleteSnapshot).toHaveBeenCalledWith(expect.any(String));
  });

  it("spends nothing on a second capture the same day and collects the queued reviews", async () => {
    mocks.claimSnapshot.mockResolvedValue(false);
    mocks.getSnapshotForDate.mockResolvedValue({
      id: "snap-1",
      name: "Airway Dentists",
      providerTaskId: "task-1",
      reviewsCollectedAt: null,
    });
    mocks.fetchBusinessDataTaskResult.mockResolvedValue({
      status: "completed",
      result: { items: [{ review_id: "r1", rating: { value: 5 } }] },
    });

    const result = await captureGbpSnapshot(input);

    expect(mocks.gbpProfile).not.toHaveBeenCalled();
    expect(mocks.replaceReviews).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: "snap-1" }),
    );
    expect(result).toMatchObject({
      snapshotId: "snap-1",
      created: false,
      reviewsCollected: true,
      costMicros: 0,
    });
  });

  it("gives the day's slot back when the profile read fails", async () => {
    mocks.gbpProfile.mockRejectedValue(new Error("provider down"));

    await expect(captureGbpSnapshot(input)).rejects.toThrow("provider down");
    expect(mocks.deleteSnapshot).toHaveBeenCalledWith(expect.any(String));
  });

  it("does not buy reviews for a location Google has no profile for", async () => {
    mocks.gbpProfile.mockResolvedValue({ profile: null, costUsd: 0.002 });

    const result = await captureGbpSnapshot(input);

    expect(mocks.gbpReviewsTaskPost).not.toHaveBeenCalled();
    expect(result).toMatchObject({ profileFound: false, costMicros: 2000 });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import {
  fetchGbpProfile,
  formatGbpCoordinate,
  parseGbpReviews,
  postGbpReviewsTask,
} from "@/server/lib/dataforseo/gbpSnapshot";

// Payloads follow DataForSEO's documented my_business_info / reviews item shape —
// no recorded envelope of these endpoints exists in the repo or the seo-yolo
// runtime, so they are hand-built from the docs and trimmed to the fields a
// snapshot reads.

function stubDataforseo(payload: unknown) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof stubDataforseo>) {
  const body = fetchMock.mock.calls[0][1]?.body;
  return typeof body === "string" ? (JSON.parse(body) as unknown) : null;
}

const PROFILE_ITEM = {
  title: "Airway Dentists",
  category: "Dentist",
  additional_categories: ["Cosmetic dentist"],
  cid: "1234567890",
  place_id: "ChIJplace",
  address: "1 Main St, Houston, TX 77002",
  phone: "+1 713-555-0100",
  url: "https://example.com/houston",
  domain: "example.com",
  is_claimed: true,
  total_photos: 42,
  rating: { rating_type: "Max5", value: 4.8, votes_count: 214 },
  attributes: {
    available_attributes: {
      service_options: ["has_online_care"],
      accessibility: ["wheelchair_accessible_entrance"],
    },
    unavailable_attributes: { payments: ["accepts_cash_only"] },
  },
};

function profileResponse(taskOverrides: Record<string, unknown> = {}) {
  return {
    status_code: 20000,
    tasks: [
      {
        id: "profile-task-abc",
        status_code: 20000,
        path: ["v3", "business_data", "google", "my_business_info", "live"],
        cost: 0.002,
        result: [{ items: [PROFILE_ITEM] }],
        ...taskOverrides,
      },
    ],
  };
}

describe("fetchGbpProfile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the profile item onto the snapshot fields and flattens available attributes", async () => {
    const fetchMock = stubDataforseo(profileResponse());

    const { data, billing } = await fetchGbpProfile({
      keyword: "cid:1234567890",
      locationCoordinate: "29.7604,-95.3698,8047",
      languageCode: "en",
    });

    expect(bodyOf(fetchMock)).toEqual([
      {
        keyword: "cid:1234567890",
        location_coordinate: "29.7604,-95.3698,8047",
        language_code: "en",
      },
    ]);
    expect(billing.costUsd).toBe(0.002);
    expect(data.costUsd).toBe(0.002);
    expect(data.profile).toEqual({
      name: "Airway Dentists",
      primaryCategory: "Dentist",
      additionalCategories: ["Cosmetic dentist"],
      cid: "1234567890",
      placeId: "ChIJplace",
      rating: 4.8,
      reviewsCount: 214,
      isClaimed: true,
      address: "1 Main St, Houston, TX 77002",
      phone: "+1 713-555-0100",
      website: "https://example.com/houston",
      photosCount: 42,
      // Only the available side: an unavailable attribute is not on the profile.
      availableAttributes: [
        { key: "service_options", value: "has_online_care" },
        { key: "accessibility", value: "wheelchair_accessible_entrance" },
      ],
    });
  });

  // 40501 "No Search Results" and 40102 are charged lookups that simply matched
  // nothing — a real observation, not an error the scheduler should keep retrying.
  it.each([40501, 40102])(
    "returns an empty, still-billed profile for status %i",
    async (statusCode) => {
      stubDataforseo(
        profileResponse({ status_code: statusCode, result: null, cost: 0.002 }),
      );

      const { data } = await fetchGbpProfile({
        keyword: "cid:1234567890",
        locationCoordinate: "29.7604,-95.3698,8047",
        languageCode: "en",
      });

      expect(data).toEqual({
        profile: null,
        costUsd: 0.002,
        profileTaskId: "profile-task-abc",
        profileStatusCode: statusCode,
      });
    },
  );
});

describe("postGbpReviewsTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("queues 20 newest reviews at standard priority and returns the task id", async () => {
    const fetchMock = stubDataforseo({
      status_code: 20000,
      tasks: [
        {
          status_code: 20100,
          id: "task-abc",
          path: ["v3", "business_data", "google", "reviews", "task_post"],
          cost: 0.00075,
        },
      ],
    });

    const { data } = await postGbpReviewsTask({
      cid: "1234567890",
      locationCoordinate: "29.7604,-95.3698,8047",
      languageCode: "en",
    });

    expect(data).toEqual({ taskId: "task-abc", costUsd: 0.00075 });
    expect(bodyOf(fetchMock)).toEqual([
      {
        cid: "1234567890",
        location_coordinate: "29.7604,-95.3698,8047",
        language_code: "en",
        depth: 20,
        sort_by: "newest",
        priority: 1,
      },
    ]);
  });
});

describe("parseGbpReviews", () => {
  it("keeps the provider order, truncates long bodies and derives the owner reply flag", () => {
    const reviews = parseGbpReviews({
      items: [
        {
          review_id: "r1",
          rating: { value: 5 },
          profile_name: "Jane",
          timestamp: "2026-03-01 12:00:00 +00:00",
          review_text: "a".repeat(1200),
          owner_answer: "Thanks!",
        },
        { review_id: "r2", rating: { value: 2 }, review_text: null },
        // A row whose rating is not an object at all is dropped, not fatal: the
        // task is already paid for and a partial list beats none.
        { review_id: "r3", rating: "five" },
      ],
    });

    expect(reviews).toEqual([
      {
        reviewId: "r1",
        rating: 5,
        author: "Jane",
        publishedAt: "2026-03-01 12:00:00 +00:00",
        text: "a".repeat(1000),
        ownerReply: true,
      },
      {
        reviewId: "r2",
        rating: 2,
        author: null,
        publishedAt: null,
        text: null,
        ownerReply: false,
      },
    ]);
  });
});

describe("formatGbpCoordinate", () => {
  it("converts miles to meters and clamps to the band the endpoints accept", () => {
    expect(formatGbpCoordinate(29.7604, -95.3698, 5)).toBe(
      "29.7604,-95.3698,8047",
    );
    // 0.05 mi is 80 m, below the 200 m floor DataForSEO rejects.
    expect(formatGbpCoordinate(1, 2, 0.05)).toBe("1,2,200");
    expect(formatGbpCoordinate(1, 2, 500)).toBe("1,2,199999");
  });
});

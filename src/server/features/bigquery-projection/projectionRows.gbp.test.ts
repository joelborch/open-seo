import { describe, expect, it } from "vitest";
import {
  buildGbpProjection,
  PROJECTION_SOURCE,
  type GbpSnapshotSource,
} from "./projectionRows";

const PULLED_AT = "2026-03-04T05:06:07.000Z";

function gbpSource(
  overrides: Partial<GbpSnapshotSource> = {},
): GbpSnapshotSource {
  return {
    snapshot: {
      id: "snap-1",
      runDate: "2026-03-02",
      name: "Airway Dentists — Houston",
      placeId: "ChIJplace",
      cid: "123456",
      primaryCategory: "Dentist",
      rating: 4.8,
      reviewsCount: 214,
      isClaimed: true,
      address: "1 Main St",
      phone: "+1 555",
      website: "https://example.com",
      photosCount: 42,
      providerTaskId: "task-1",
    },
    locationSlug: "houston",
    locationName: "Houston",
    previousReviewsCount: 209,
    attributes: [
      { key: "service_options", value: "has_online_care" },
      { key: "service_options", value: "wheelchair_accessible" },
      { key: "additional_category", value: "Cosmetic dentist" },
    ],
    ...overrides,
  };
}

describe("buildGbpProjection", () => {
  it("groups attributes by key and measures review velocity against the previous snapshot", () => {
    const result = buildGbpProjection({
      source: gbpSource(),
      pulledAt: PULLED_AT,
    });

    expect(result.reportDate).toBe("2026-03-02");
    expect(result.rowsByTable.gbp_snapshots).toEqual([
      {
        report_date: "2026-03-02",
        location_slug: "houston",
        location_name: "Houston",
        profile_name: "Airway Dentists — Houston",
        place_id: "ChIJplace",
        cid: "123456",
        primary_category: "Dentist",
        rating: 4.8,
        reviews_count: 214,
        reviews_count_delta: 5,
        is_claimed: true,
        address: "1 Main St",
        phone: "+1 555",
        website: "https://example.com",
        photos_count: 42,
        attributes: {
          service_options: ["has_online_care", "wheelchair_accessible"],
          additional_category: ["Cosmetic dentist"],
        },
        source: PROJECTION_SOURCE,
        pulled_at: PULLED_AT,
        run_id: "snap-1",
        request_id: "task-1",
      },
    ]);
  });

  it("leaves the review delta null when there is nothing to compare against", () => {
    const result = buildGbpProjection({
      source: gbpSource({ previousReviewsCount: null }),
      pulledAt: PULLED_AT,
    });

    expect(
      result.rowsByTable.gbp_snapshots?.[0].reviews_count_delta,
    ).toBeNull();
  });
});

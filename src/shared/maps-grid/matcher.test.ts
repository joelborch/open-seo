import { describe, expect, it } from "vitest";
import {
  findTarget,
  isBrandMatch,
  mapsCandidateItemSchema,
  scoreCandidate,
  type CandidateItem,
  type MatchIdentity,
} from "./matcher.js";
import matcherFixture from "./fixtures/matcher-cases.json";

/** Fixture rows are provider-shaped, so they go through the real item schema. */
function candidate(row: unknown): CandidateItem {
  return mapsCandidateItemSchema.parse(row);
}

describe("maps-grid matcher", () => {
  describe("Python parity fixtures", () => {
    const identity: MatchIdentity = matcherFixture.identity;

    for (const testCase of matcherFixture.cases) {
      it(`matches the Python decision for ${testCase.id} (${testCase.description})`, () => {
        expect(scoreCandidate(candidate(testCase.candidate), identity)).toEqual(
          testCase.expected,
        );
      });
    }

    it("picks the same target and brand fallback out of the candidate pool", () => {
      const { candidates, expectedTargetTitle, expectedBrandFallbackTitle } =
        matcherFixture.findTargetTest;

      const result = findTarget(candidates.map(candidate), identity);

      expect(result.target?.title).toBe(expectedTargetTitle);
      expect(result.brandFallback?.title).toBe(expectedBrandFallbackTitle);
      expect(result.reasons).toEqual(
        matcherFixture.findTargetTest.expectedReasons,
      );
    });
  });

  describe("target selection", () => {
    const identity: MatchIdentity = {
      brandName: "Apex Dental",
      domain: "apexdental.com",
      slug: "seattle",
      matchTerms: ["seattle"],
    };

    it("prefers the higher score over the better rank", () => {
      // brand (4) + term (2) = 6, soft — never accepted however well it ranks.
      const betterRanked: CandidateItem = {
        title: "Apex Dental Office",
        address: "100 Pine St, Seattle",
        rank_group: 1,
      };
      // domain (3) + term (2) + location_url (4) = 9, hard.
      const higherScored: CandidateItem = {
        title: "Apex Dental",
        url: "https://apexdental.com/locations/seattle",
        rank_group: 5,
      };

      const result = findTarget([betterRanked, higherScored], identity);
      expect(result.target?.rank_group).toBe(5);
    });

    it("breaks a score tie on rank, whatever the array order", () => {
      const rankTwo: CandidateItem = {
        title: "Clinic A",
        url: "https://apexdental.com/locations/seattle",
        rank_group: 2,
      };
      const rankFive: CandidateItem = {
        ...rankTwo,
        title: "Clinic B",
        rank_group: 5,
      };

      expect(findTarget([rankTwo, rankFive], identity).target?.title).toBe(
        "Clinic A",
      );
      expect(findTarget([rankFive, rankTwo], identity).target?.title).toBe(
        "Clinic A",
      );
    });

    it("reports a brand fallback but no target when nothing is anchored to the location", () => {
      const result = findTarget(
        [
          {
            title: "Competitor Practice",
            phone: "206-555-9999",
            rank_group: 1,
          },
          // brand (4) + domain (3) = 7 but no address anchor, so soft.
          {
            title: "Apex Dental General Info",
            url: "https://apexdental.com",
            rank_group: 2,
          },
        ],
        identity,
      );

      expect(result.target).toBeNull();
      expect(result.brandFallback?.title).toBe("Apex Dental General Info");
      expect(result.reasons).toEqual([]);
    });
  });

  describe("identity normalization", () => {
    const identity: MatchIdentity = {
      brandName: "Downtown Sleep Therapy",
      domain: "sleeptherapy.org",
      slug: "denver-central",
      phone: "(720) 555-4321",
      street: "500 16th St",
      postalCode: "80202",
      matchTerms: ["denver", "downtown"],
    };

    it("matches a brand title with or without a leading 'The'", () => {
      const result = scoreCandidate(
        { title: "The Downtown Sleep Therapy Clinic", phone: "720-555-4321" },
        identity,
      );
      expect(result.reasons).toEqual(["brand_title", "phone", "location_term"]);
      expect(result.accepted).toBe(true);
    });

    it("matches a phone through formatting and country code", () => {
      const result = scoreCandidate(
        { title: "Sleep Center", phone: "+1 (720) 555-4321" },
        identity,
      );
      expect(result).toEqual({
        score: 7,
        reasons: ["phone"],
        hard: true,
        accepted: true,
      });
    });

    it("reads the address out of the provider's address_info block", () => {
      const result = scoreCandidate(
        candidate({
          type: "maps_search",
          title: "Downtown Sleep Therapy",
          url: "https://sleeptherapy.org/about",
          phone: "+17205554321",
          rank_group: 2,
          address_info: {
            address: "500 16th St",
            city: "Denver",
            region: "Colorado",
            zip: "80202",
          },
          rating: { value: 4.8, votes_count: 132 },
        }),
        identity,
      );
      expect(result.reasons).toEqual([
        "brand_title",
        "domain",
        "phone",
        "postal",
        "street_number",
        "location_term",
      ]);
      expect(result.accepted).toBe(true);
    });

    it("treats a domain hit as a brand match even under another name", () => {
      expect(isBrandMatch({ title: "Downtown Sleep Therapy" }, identity)).toBe(
        true,
      );
      expect(
        isBrandMatch(
          { title: "Other Name", url: "https://sleeptherapy.org" },
          identity,
        ),
      ).toBe(true);
      expect(
        isBrandMatch(
          { title: "Other Name", url: "https://competitor.com" },
          identity,
        ),
      ).toBe(false);
    });
  });
});

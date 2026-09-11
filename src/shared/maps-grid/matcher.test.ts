import { describe, expect, it } from "vitest";
import {
  findTarget,
  isBrandMatch,
  type CandidateItem,
  type MatchIdentity,
  scoreCandidate,
} from "./matcher.js";
import matcherFixture from "./fixtures/matcher-cases.json";

describe("maps-grid matcher", () => {
  describe("Python parity fixtures", () => {
    const identity: MatchIdentity = matcherFixture.identity;

    for (const testCase of matcherFixture.cases) {
      it(`matches Python decision for case: ${testCase.id} (${testCase.description})`, () => {
        const result = scoreCandidate(testCase.candidate, identity);

        expect(result.score).toBe(testCase.expected.score);
        expect(result.reasons).toEqual(testCase.expected.reasons);
        expect(result.hard).toBe(testCase.expected.hard);
        expect(result.accepted).toBe(testCase.expected.accepted);

        // Verify tuple destructuring support
        const [score, reasons, hard, accepted] = result as unknown as [
          number,
          string[],
          boolean,
          boolean,
        ];
        expect(score).toBe(testCase.expected.score);
        expect(reasons).toEqual(testCase.expected.reasons);
        expect(hard).toBe(testCase.expected.hard);
        expect(accepted).toBe(testCase.expected.accepted);
      });
    }

    it("matches Python findTarget decision across candidate pool", () => {
      const result = findTarget(
        matcherFixture.findTargetTest.candidates,
        identity,
      );

      expect(result.target?.title).toBe(
        matcherFixture.findTargetTest.expectedTargetTitle,
      );
      expect(result.brandFallback?.title).toBe(
        matcherFixture.findTargetTest.expectedBrandFallbackTitle,
      );
      expect(result.reasons).toEqual(
        matcherFixture.findTargetTest.expectedReasons,
      );

      // Verify tuple destructuring
      const [target, brandFallback, reasons] = result as unknown as [
        CandidateItem | null,
        CandidateItem | null,
        string[],
      ];
      expect(target?.title).toBe(
        matcherFixture.findTargetTest.expectedTargetTitle,
      );
      expect(brandFallback?.title).toBe(
        matcherFixture.findTargetTest.expectedBrandFallbackTitle,
      );
      expect(reasons).toEqual(matcherFixture.findTargetTest.expectedReasons);
    });
  });

  describe("rank resolution and tie-breaking", () => {
    const identity: MatchIdentity = {
      brandName: "Apex Dental",
      domain: "apexdental.com",
      slug: "seattle",
      matchTerms: ["seattle"],
    };

    it("favors candidate with higher score when ranks differ", () => {
      const lowScoreLowRank: CandidateItem = {
        title: "Apex Dental Office",
        address: "100 Pine St, Seattle",
        rankGroup: 1, // score: brand (4) + term (2) = 6 (not hard, not accepted)
      };
      const highScoreHighRank: CandidateItem = {
        title: "Apex Dental",
        url: "https://apexdental.com/locations/seattle",
        rankGroup: 5, // score: brand (4) + domain (3) + term (2) + loc_url (4) = 13 (hard, accepted)
      };

      const result = findTarget([lowScoreLowRank, highScoreHighRank], identity);
      expect(result.target?.title).toBe("Apex Dental");
      expect(result.target?.rankGroup).toBe(5);
    });

    it("favors lower rank number when accepted scores are tied", () => {
      const rankTwo: CandidateItem = {
        title: "Clinic A",
        url: "https://apexdental.com/locations/seattle",
        rankGroup: 2, // score 9 (domain + term + loc_url)
      };
      const rankFive: CandidateItem = {
        title: "Clinic B",
        url: "https://apexdental.com/locations/seattle",
        rankGroup: 5, // score 9
      };

      const resultOrder1 = findTarget([rankTwo, rankFive], identity);
      expect(resultOrder1.target?.title).toBe("Clinic A");

      const resultOrder2 = findTarget([rankFive, rankTwo], identity);
      expect(resultOrder2.target?.title).toBe("Clinic A");
    });

    it("returns null target when no candidates meet hard and score >= 7 threshold", () => {
      const candidates: CandidateItem[] = [
        {
          title: "Competitor Practice",
          phone: "206-555-9999",
          rankGroup: 1,
        },
        {
          title: "Apex Dental General Info",
          url: "https://apexdental.com",
          rankGroup: 2, // score 7 (brand 4 + domain 3), but soft (no location anchor)
        },
      ];

      const result = findTarget(candidates, identity);
      expect(result.target).toBeNull();
      expect(result.brandFallback?.title).toBe("Apex Dental General Info");
      expect(result.reasons).toEqual([]);
    });
  });

  describe("custom identity and brand normalization", () => {
    const identity: MatchIdentity = {
      brandName: "Downtown Sleep Therapy",
      domain: "sleeptherapy.org",
      slug: "denver-central",
      phone: "(720) 555-4321",
      street: "500 16th St",
      postalCode: "80202",
      matchTerms: ["denver", "downtown"],
    };

    it("matches brand title with and without leading 'The'", () => {
      const candidate: CandidateItem = {
        title: "The Downtown Sleep Therapy Clinic",
        phone: "720-555-4321",
      };
      const result = scoreCandidate(candidate, identity);
      expect(result.reasons).toContain("brand_title");
      expect(result.reasons).toContain("phone");
      expect(result.accepted).toBe(true);
    });

    it("normalizes phone formats cleanly", () => {
      const candidate: CandidateItem = {
        title: "Sleep Center",
        phone: "+1 (720) 555-4321",
      };
      const result = scoreCandidate(candidate, identity);
      expect(result.reasons).toContain("phone");
      expect(result.hard).toBe(true);
      expect(result.score).toBe(7);
      expect(result.accepted).toBe(true);
    });

    it("supports snake_case DataForSEO fields", () => {
      const candidate: CandidateItem = {
        title: "Downtown Sleep Therapy",
        url: "https://sleeptherapy.org/about",
        phone_number: "7205554321",
        postal_code: "80202",
        rank_group: 2,
        address_info: {
          address: "500 16th St",
          city: "Denver",
          zip: "80202",
        },
      };

      const result = scoreCandidate(candidate, identity);
      expect(result.reasons).toContain("brand_title");
      expect(result.reasons).toContain("domain");
      expect(result.reasons).toContain("phone");
      expect(result.reasons).toContain("postal");
      expect(result.reasons).toContain("street_number");
      expect(result.reasons).toContain("location_term");
      expect(result.hard).toBe(true);
      expect(result.accepted).toBe(true);
    });

    it("tracks brand match correctly in isBrandMatch", () => {
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

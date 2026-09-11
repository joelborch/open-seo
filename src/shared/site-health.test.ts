import { describe, expect, it } from "vitest";
import {
  computeSiteHealth,
  siteHealthDelta,
  type SiteHealth,
  type SiteHealthInput,
} from "./site-health";

describe("computeSiteHealth", () => {
  const cases: Array<{
    name: string;
    input: SiteHealthInput;
    expected: SiteHealth;
  }> = [
    {
      name: "perfect site without issues",
      input: {
        pagesConsidered: 100,
        errorPages: 0,
        warningPages: 0,
        noticePages: 0,
        truncated: false,
      },
      expected: { score: 100, penalty: 0, truncated: false },
    },
    {
      name: "typical crawl with mixed issues",
      input: {
        pagesConsidered: 100,
        errorPages: 2,
        warningPages: 10,
        noticePages: 20,
        truncated: false,
      },
      // penalty = 2 + (0.5 * 10) + (0.1 * 20) = 9
      // score = round(100 * (1 - 9 / 100)) = 91
      expected: { score: 91, penalty: 9, truncated: false },
    },
    {
      name: "truncated crawl with non-integer penalty and rounding",
      input: {
        pagesConsidered: 50,
        errorPages: 1,
        warningPages: 3,
        noticePages: 4,
        truncated: true,
      },
      // penalty = 1 + 1.5 + 0.4 = 2.9
      // score = round(100 * (1 - 2.9 / 50)) = round(94.2) = 94
      expected: { score: 94, penalty: 2.9, truncated: true },
    },
    {
      name: "boundary threshold of exactly 10 pages",
      input: {
        pagesConsidered: 10,
        errorPages: 1,
        warningPages: 2,
        noticePages: 5,
        truncated: false,
      },
      // penalty = 1 + 1 + 0.5 = 2.5
      // score = round(100 * (1 - 2.5 / 10)) = round(75) = 75
      expected: { score: 75, penalty: 2.5, truncated: false },
    },
    {
      name: "below 10 pages threshold returns null score",
      input: {
        pagesConsidered: 9,
        errorPages: 1,
        warningPages: 0,
        noticePages: 0,
        truncated: false,
      },
      expected: { score: null, penalty: 1, truncated: false },
    },
    {
      name: "zero pages considered returns null score",
      input: {
        pagesConsidered: 0,
        errorPages: 0,
        warningPages: 0,
        noticePages: 0,
        truncated: false,
      },
      expected: { score: null, penalty: 0, truncated: false },
    },
    {
      name: "clamp at 0 when penalty equals pages considered",
      input: {
        pagesConsidered: 20,
        errorPages: 20,
        warningPages: 0,
        noticePages: 0,
        truncated: false,
      },
      // penalty = 20, score = round(100 * (1 - 1)) = 0
      expected: { score: 0, penalty: 20, truncated: false },
    },
    {
      name: "clamp at 0 when penalty exceeds pages considered",
      input: {
        pagesConsidered: 15,
        errorPages: 12,
        warningPages: 8,
        noticePages: 10,
        truncated: false,
      },
      // penalty = 12 + 4 + 1 = 17 (> 15) -> clamped to 0
      expected: { score: 0, penalty: 17, truncated: false },
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(computeSiteHealth(input)).toEqual(expected);
  });
});

describe("siteHealthDelta", () => {
  const deltaCases: Array<{
    name: string;
    current: SiteHealth;
    previous: SiteHealth;
    expected: number | null;
  }> = [
    {
      name: "positive score improvement",
      current: { score: 95, penalty: 5, truncated: false },
      previous: { score: 91, penalty: 9, truncated: false },
      expected: 4,
    },
    {
      name: "negative score regression",
      current: { score: 80, penalty: 20, truncated: false },
      previous: { score: 85, penalty: 15, truncated: false },
      expected: -5,
    },
    {
      name: "identical scores give 0 delta",
      current: { score: 88, penalty: 12, truncated: false },
      previous: { score: 88, penalty: 12, truncated: false },
      expected: 0,
    },
    {
      name: "null current score returns null delta",
      current: { score: null, penalty: 2, truncated: false },
      previous: { score: 85, penalty: 15, truncated: false },
      expected: null,
    },
    {
      name: "null previous score returns null delta",
      current: { score: 85, penalty: 15, truncated: false },
      previous: { score: null, penalty: 2, truncated: false },
      expected: null,
    },
    {
      name: "both scores null returns null delta",
      current: { score: null, penalty: 2, truncated: false },
      previous: { score: null, penalty: 1, truncated: false },
      expected: null,
    },
  ];

  it.each(deltaCases)("$name", ({ current, previous, expected }) => {
    expect(siteHealthDelta(current, previous)).toBe(expected);
  });
});

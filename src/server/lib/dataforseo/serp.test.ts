/* eslint-disable max-lines -- one spec for the whole rank-check SERP surface:
   the live endpoint, task_post, task_get and the shared request params, all read
   off the same fixtures. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import {
  fetchLiveSerp,
  fetchRankCheckSerp,
  fetchRankCheckTaskResult,
  postRankCheckTasks,
} from "@/server/lib/dataforseo/serp";

function parseDataforseoRequestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected DataForSEO request body to be a string");
  }
  return JSON.parse(body) as unknown;
}

/** The posted task array, narrowed so per-key assertions need no cast. */
const requestTasksSchema = z.array(z.record(z.string(), z.unknown()));

function parseDataforseoRequestTasks(init: RequestInit | undefined) {
  return requestTasksSchema.parse(parseDataforseoRequestBody(init));
}

// Trimmed from a real `/v3/serp/google/organic/live/advanced` receipt captured
// with load_async_ai_overview (runtime/seo-yolo, advanced-dermatology
// collection checkpoint, keyword "laser treatment for acne scars"): one
// ai_overview block with element-level references/links plus block-level
// references, three local_pack rows collapsed to the matching one, and two
// organic results. Long text/markdown fields are dropped; every key name and
// nesting level is as DataForSEO returned it.
const ADVANCED_SERP_ITEMS = [
  {
    type: "ai_overview",
    rank_group: 1,
    rank_absolute: 1,
    asynchronous_ai_overview: true,
    items: [
      {
        type: "ai_overview_element",
        title: null,
        text: "Laser treatment uses focused light and heat…",
        images: null,
        links: null,
        references: [
          {
            type: "ai_overview_reference",
            domain: "www.healthline.com",
            source: "Healthline",
            title: "Laser Treatment for Acne Scars",
            url: "https://www.healthline.com/health/beauty-skin-care/laser-treatment-for-acne-scars",
          },
        ],
      },
      {
        type: "ai_overview_element",
        title: "How It Works",
        text: "Ablative lasers remove thin layers of skin…",
        images: null,
        links: [
          {
            type: "link_element",
            title: "Chicago Cosmetic Surgery & Dermatology",
            url: "https://www.chicagodermatology.co/",
            domain: "www.chicagodermatology.co",
            description: null,
          },
        ],
        references: [
          {
            type: "ai_overview_reference",
            domain: "clderm.com",
            source: "clderm.com",
            title: "Which Laser Procedures Work Best for Acne Scars?",
            url: "https://clderm.com/which-laser-procedures-work-best-for-acne-scars",
          },
        ],
      },
    ],
    references: [
      {
        type: "ai_overview_reference",
        domain: "www.asds.net",
        source: "American Society for Dermatologic Surgery",
        title: "Laser Resurfacing for Acne Scars",
        url: "https://www.asds.net/skin-experts/skin-treatments/laser-resurfacing",
      },
    ],
  },
  {
    type: "local_pack",
    rank_group: 2,
    rank_absolute: 3,
    title: "Chicago Cosmetic Surgery & Dermatology",
    domain: "www.chicagodermatology.co",
    url: "http://www.chicagodermatology.co/",
    phone: "(312) 245-9965",
  },
  {
    type: "organic",
    rank_group: 1,
    rank_absolute: 6,
    domain: "www.healthline.com",
    url: "https://www.healthline.com/health/beauty-skin-care/laser-treatment-for-acne-scars",
    links: null,
  },
  {
    type: "organic",
    rank_group: 2,
    rank_absolute: 7,
    domain: "www.chicagodermatology.co",
    url: "https://www.chicagodermatology.co/treatments/acne-scars",
    links: null,
  },
];

function stubLiveAdvancedResponse(items: unknown[]) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      status_code: 20000,
      tasks: [
        {
          id: "task-a",
          status_code: 20000,
          status_message: "Ok.",
          cost: 0.004,
          path: ["v3", "serp", "google", "organic", "live", "advanced"],
          result_count: 1,
          result: [{ items }],
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const rankCheckInput = {
  keyword: "laser treatment for acne scars",
  keywordId: "kw-1",
  locationCode: 2840,
  languageCode: "en",
  device: "desktop" as const,
  targetDomain: "chicagodermatology.co",
  depth: 20,
};

describe("live SERP", () => {
  // 40102 is the documented "No Search Results." code (40501 is "Invalid
  // Field."). isNoResultsTask matches on the status message, not the code, so
  // this stays correct whichever code DataForSEO attaches to the message.
  it("returns an empty result for DataForSEO's no-results task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          status_code: 20000,
          tasks: [
            {
              status_code: 40102,
              status_message: "No Search Results.",
              path: ["v3", "serp", "google", "organic", "live", "advanced"],
              cost: 0.002,
              result_count: 0,
              result: [],
            },
          ],
        }),
      ),
    );

    await expect(
      fetchLiveSerp({
        keyword: "obscure query",
        locationCode: 2840,
        languageCode: "en",
      }),
    ).resolves.toMatchObject({
      data: [],
      billing: { costUsd: 0.002 },
    });
  });
});

describe("rank check SERP detail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads organic rank, local pack rank, AI Overview citation and per-feature detail", async () => {
    stubLiveAdvancedResponse(ADVANCED_SERP_ITEMS);

    const { data } = await fetchRankCheckSerp({
      ...rankCheckInput,
      trackCompetitors: true,
      trackAiOverview: true,
    });

    expect(data).toEqual({
      keywordId: "kw-1",
      keyword: "laser treatment for acne scars",
      position: 2,
      rankAbsolute: 7,
      url: "https://www.chicagodermatology.co/treatments/acne-scars",
      localPackPosition: 2,
      aioPresent: true,
      aioClientCited: true,
      // Cited hosts in Google's order, de-duplicated: healthline (element 1
      // reference), clderm (element 2 reference), the client (element 2 link),
      // then the block-level asds reference.
      aioCitationPosition: 3,
      aioCitations: [
        {
          position: 1,
          domain: "healthline.com",
          url: "https://www.healthline.com/health/beauty-skin-care/laser-treatment-for-acne-scars",
          isClient: false,
        },
        {
          position: 2,
          domain: "clderm.com",
          url: "https://clderm.com/which-laser-procedures-work-best-for-acne-scars",
          isClient: false,
        },
        {
          position: 3,
          domain: "chicagodermatology.co",
          url: "https://www.chicagodermatology.co/",
          isClient: true,
        },
        {
          position: 4,
          domain: "asds.net",
          url: "https://www.asds.net/skin-experts/skin-treatments/laser-resurfacing",
          isClient: false,
        },
      ],
      // No brand terms were passed, so the mention check has nothing to run on.
      aioBrandMentioned: null,
      aioSnippet:
        "Laser treatment uses focused light and heat… Ablative lasers remove thin layers of skin…",
      serpFeatures: ["ai_overview", "local_pack", "organic"],
      features: [
        { featureType: "ai_overview", rankAbsolute: 1, clientPresent: true },
        { featureType: "local_pack", rankAbsolute: 3, clientPresent: true },
        { featureType: "organic", rankAbsolute: 6, clientPresent: true },
      ],
      providerCostUsd: 0.004,
    });
  });

  it("leaves AI Overview columns null when the config didn't pay to load the block", async () => {
    stubLiveAdvancedResponse(ADVANCED_SERP_ITEMS);

    const { data } = await fetchRankCheckSerp(rankCheckInput);

    expect(data).toMatchObject({
      aioPresent: null,
      aioClientCited: null,
      aioCitationPosition: null,
    });
    // The block is still reported as a feature that was on the page.
    expect(data.serpFeatures).toContain("ai_overview");
  });

  it("sends load_async_ai_overview and the early-stop hint only when they apply", async () => {
    const withOptIns = stubLiveAdvancedResponse(ADVANCED_SERP_ITEMS);
    await fetchRankCheckSerp({
      ...rankCheckInput,
      trackCompetitors: true,
      trackAiOverview: true,
    });
    const [optedIn] = parseDataforseoRequestTasks(
      withOptIns.mock.calls[0]?.[1],
    );
    expect(optedIn).toMatchObject({ load_async_ai_overview: true });
    // Competitor tracking needs the whole SERP, so the crawl must not stop at
    // the client's own listing.
    expect(optedIn).not.toHaveProperty("stop_crawl_on_match");

    const defaults = stubLiveAdvancedResponse(ADVANCED_SERP_ITEMS);
    await fetchRankCheckSerp(rankCheckInput);
    const [payload] = parseDataforseoRequestTasks(defaults.mock.calls[0]?.[1]);
    expect(payload).toMatchObject({
      stop_crawl_on_match: [
        { match_value: "chicagodermatology.co", match_type: "with_subdomains" },
      ],
      find_targets_in: ["organic"],
    });
    expect(payload).not.toHaveProperty("load_async_ai_overview");
  });
});

describe("rank check task queue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts queued tasks, maps ids by tag, and sums cost over all entries", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:desktop" },
          },
          {
            id: "task-b",
            status_code: 20100,
            cost: 0.0006,
            data: { tag: "kw-1:mobile" },
          },
          {
            id: "task-c",
            status_code: 40006,
            status_message: "Task Limit Exceeded",
            cost: 0.0006,
            data: { tag: "kw-2:desktop" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await postRankCheckTasks({
      tasks: [
        { keyword: "alpha", keywordId: "kw-1", device: "desktop" },
        { keyword: "alpha", keywordId: "kw-1", device: "mobile" },
        { keyword: "beta", keywordId: "kw-2", device: "desktop" },
      ],
      locationCode: 2840,
      languageCode: "en",
      depth: 20,
      targetDomain: "example.com",
    });

    expect(
      fetchMock.mock.calls.map(([url]) =>
        typeof url === "string" || url instanceof URL
          ? url.toString()
          : url.url,
      ),
    ).toEqual(["https://api.dataforseo.com/v3/serp/google/organic/task_post"]);

    // Every posted task asks DataForSEO to stop crawling at the target's
    // organic listing — that is what cuts the actual crawl cost for ranking
    // domains without false "not ranking" stops on sitelinks/PAA mentions.
    const stopCrawl = {
      stop_crawl_on_match: [
        { match_value: "example.com", match_type: "with_subdomains" },
      ],
      find_targets_in: ["organic"],
    };
    expect(
      parseDataforseoRequestBody(fetchMock.mock.calls[0]?.[1]),
    ).toMatchObject([stopCrawl, stopCrawl, stopCrawl]);
    expect(result.data.posted).toEqual([
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "desktop",
        taskId: "task-a",
        costUsd: 0.0006,
      },
      {
        keyword: "alpha",
        keywordId: "kw-1",
        device: "mobile",
        taskId: "task-b",
        costUsd: 0.0006,
      },
    ]);
    // Refused entries are reported so the task ledger can record why.
    expect(result.data.rejected).toEqual([
      {
        keyword: "beta",
        keywordId: "kw-2",
        device: "desktop",
        statusCode: 40006,
        statusMessage: "Task Limit Exceeded",
      },
    ]);
    // The rejected entry's cost is still metered: a charge is a charge.
    expect(result.billing.costUsd).toBeCloseTo(0.0018, 10);
    expect(result.billing.path).toEqual([
      "v3",
      "serp",
      "google",
      "organic",
      "task_post",
    ]);
  });

  it("reports a queued task still in progress as pending", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [{ id: "task-a", status_code: 40602 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({ status: "pending", providerStatusCode: 40602 });
  });

  it("parses a completed queued task into a rank check result", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status_code: 20000,
        tasks: [
          {
            id: "task-a",
            status_code: 20000,
            cost: 0,
            path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
            result: [
              {
                items: [
                  {
                    type: "organic",
                    rank_group: 3,
                    rank_absolute: 4,
                    domain: "www.example.com",
                    url: "https://www.example.com/page",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "alpha",
      targetDomain: "example.com",
    });

    expect(outcome).toEqual({
      status: "completed",
      providerStatusCode: 20000,
      isEmpty: false,
      result: {
        keywordId: "kw-1",
        keyword: "alpha",
        position: 3,
        rankAbsolute: 4,
        url: "https://www.example.com/page",
        localPackPosition: null,
        aioPresent: null,
        aioClientCited: null,
        aioCitationPosition: null,
        aioCitations: [],
        aioBrandMentioned: null,
        aioSnippet: null,
        serpFeatures: ["organic"],
        features: [
          { featureType: "organic", rankAbsolute: 4, clientPresent: true },
        ],
        providerCostUsd: 0,
      },
    });
  });
});

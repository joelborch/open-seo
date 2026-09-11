import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import {
  fetchLiveSerp,
  fetchRankCheckSerp,
  fetchRankCheckTaskResult,
} from "@/server/lib/dataforseo/serp";
// A real (trimmed) `serp/google/organic/live/advanced` receipt: "sleep apnea
// dentist", Houston, mobile, depth 20, load_async_ai_overview — two local pack
// rows, People also ask, three organic results, two knowledge-graph expansions
// and two `people_also_search` blocks. Long text is shortened; every key name
// and nesting level is as DataForSEO returned it.
import houstonLiveAdvanced from "@/server/lib/dataforseo/__fixtures__/organic-live-advanced-houston.json";
// A second real (trimmed) receipt from the same client, this one with an AI
// Overview: "best airway dentist houston", Houston, desktop,
// load_async_ai_overview — one `ai_overview` block whose element references,
// element links and block-level references all name the same four hosts, plus
// three organic results. Reference page snippets and the markdown renderings are
// shortened; the elements' own `text` is verbatim, because that is the overview
// body the snippet and brand-mention check are read from.
import houstonAioLiveAdvanced from "@/server/lib/dataforseo/__fixtures__/organic-live-advanced-aio-houston.json";

function stubResponse(payload: unknown) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubLiveAdvancedResponse(items: unknown[]) {
  return stubResponse({
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
  });
}

const houstonItems = houstonLiveAdvanced.tasks[0].result[0].items;

const houstonRankCheck = {
  keyword: "sleep apnea dentist",
  keywordId: "kw-1",
  locationCode: 1026481,
  languageCode: "en",
  device: "mobile" as const,
  depth: 20,
};

// The payload that used to be rejected wholesale in production: a
// `people_also_search` block carries `items: string[]`, so an item schema whose
// nested `items` had to be objects failed that item — and, through
// z.array(itemSchema), every keyword in the batch, after DataForSEO was paid.
describe("SERP item parsing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses every block type in a real SERP without dropping an item", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubResponse(houstonLiveAdvanced);

    const { data } = await fetchLiveSerp({
      keyword: "sleep apnea dentist",
      locationCode: 1026481,
      languageCode: "en",
    });

    expect(data).toHaveLength(houstonItems.length);
    expect(warn).not.toHaveBeenCalled();
    // The list DataForSEO fills with plain strings, kept as strings.
    expect(
      data.find((item) => item.type === "people_also_search")?.items,
    ).toEqual([
      "URBN Dental",
      "UT dental school Invisalign",
      "URBN Dental Montrose",
    ]);
  });

  it("reads the SERP's features for a domain that is nowhere in it", async () => {
    stubResponse(houstonLiveAdvanced);

    const { data } = await fetchRankCheckSerp({
      ...houstonRankCheck,
      // Not in this SERP at all — not organic, and not in either local pack.
      targetDomain: "theairwaydentists.com",
      trackAiOverview: true,
    });

    expect(data).toEqual({
      keywordId: "kw-1",
      keyword: "sleep apnea dentist",
      position: null,
      rankAbsolute: null,
      url: null,
      localPackPosition: null,
      // load_async_ai_overview was paid for and Google returned no block.
      aioPresent: false,
      aioClientCited: false,
      aioCitationPosition: null,
      aioCitations: [],
      // No overview block, so there is no text to check the brand against.
      aioBrandMentioned: null,
      aioSnippet: null,
      serpFeatures: [
        "local_pack",
        "people_also_ask",
        "organic",
        "knowledge_graph_expanded_item",
        "people_also_search",
      ],
      features: [
        { featureType: "local_pack", rankAbsolute: 1, clientPresent: false },
        {
          featureType: "people_also_ask",
          rankAbsolute: 3,
          clientPresent: false,
        },
        { featureType: "organic", rankAbsolute: 4, clientPresent: false },
        {
          featureType: "knowledge_graph_expanded_item",
          rankAbsolute: 5,
          clientPresent: false,
        },
        {
          featureType: "people_also_search",
          rankAbsolute: 19,
          clientPresent: false,
        },
      ],
      providerCostUsd: 0.0035,
    });
  });

  it("reads an AI Overview's citations, brand mention and snippet", async () => {
    stubResponse(houstonAioLiveAdvanced);

    const { data } = await fetchRankCheckSerp({
      ...houstonRankCheck,
      keyword: "best airway dentist houston",
      device: "desktop",
      targetDomain: "theairwaydentists.com",
      trackAiOverview: true,
      brandTerms: ["The Airway Dentists", "theairwaydentists"],
    });

    // Element references first, then element links, then the block's own
    // reference list — de-duplicated by host, which is what makes the position
    // comparable to seo-yolo's citation_position.
    expect(data.aioCitations).toEqual([
      {
        position: 1,
        domain: "theairwaydentists.com",
        url: "https://theairwaydentists.com/",
        isClient: true,
      },
      {
        position: 2,
        domain: "houstonairwayalliance.org",
        url: "https://www.houstonairwayalliance.org/dental-list",
        isClient: false,
      },
      {
        position: 3,
        domain: "adore-dentistry.com",
        url: "https://www.adore-dentistry.com/adultsairwaytherapy",
        isClient: false,
      },
      {
        position: 4,
        domain: "miaorthodontics.com",
        url: "https://miaorthodontics.com/airway-orthodontics-in-houston-tx/",
        isClient: false,
      },
    ]);
    expect(data.aioCitationPosition).toBe(1);
    expect(data.aioClientCited).toBe(true);
    // The overview names the brand in prose, not only as a citation.
    expect(data.aioBrandMentioned).toBe(true);
    // Google's line breaks collapse to single spaces, and the body is cut at 500.
    expect(data.aioSnippet).toHaveLength(500);
    expect(data.aioSnippet).toContain(
      "functional orthodontics/Invisalign for all ages. Locations:",
    );
  });

  it("leaves the brand mention unstated when no brand term was given", async () => {
    stubResponse(houstonAioLiveAdvanced);

    const { data } = await fetchRankCheckSerp({
      ...houstonRankCheck,
      targetDomain: "adore-dentistry.com",
      trackAiOverview: true,
    });

    expect(data.aioBrandMentioned).toBeNull();
    // Still a citation, just not the first one.
    expect(data.aioCitationPosition).toBe(3);
    expect(
      data.aioCitations.filter((citation) => citation.isClient),
    ).toHaveLength(1);
  });

  it("says nothing about an AI Overview the config never bought", async () => {
    stubResponse(houstonAioLiveAdvanced);

    const { data } = await fetchRankCheckSerp({
      ...houstonRankCheck,
      targetDomain: "theairwaydentists.com",
      brandTerms: ["The Airway Dentists"],
    });

    expect(data.aioCitations).toEqual([]);
    expect(data.aioBrandMentioned).toBeNull();
    expect(data.aioSnippet).toBeNull();
  });

  it("keeps a block type it doesn't model, with its type and rank", async () => {
    stubLiveAdvancedResponse([
      {
        type: "organic",
        rank_group: 1,
        rank_absolute: 2,
        domain: "www.example.com",
        url: "https://www.example.com/a",
      },
      {
        type: "commercial_units_2031",
        rank_group: 1,
        rank_absolute: 1,
        // Shapes we model as strings, arrays and numbers elsewhere, all wrong
        // here: an unmodeled block is kept for its type and rank regardless.
        title: { text: "Sponsored" },
        etv: "lots",
        items: 42,
        nested: [{ whatever: true }],
      },
    ]);

    const { data } = await fetchRankCheckSerp({
      ...houstonRankCheck,
      targetDomain: "example.com",
    });

    expect(data.serpFeatures).toEqual(["organic", "commercial_units_2031"]);
    expect(data.features).toEqual([
      { featureType: "organic", rankAbsolute: 2, clientPresent: true },
      {
        featureType: "commercial_units_2031",
        rankAbsolute: 1,
        clientPresent: false,
      },
    ]);
    expect(data.position).toBe(1);
  });

  it("skips a modeled item it cannot read instead of failing the SERP", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubLiveAdvancedResponse([
      // A malformed organic result must not be salvaged into a rank-less block:
      // that would read as "not ranking" with nothing in the logs.
      { type: "organic", rank_group: "1", domain: "www.example.com" },
      {
        type: "organic",
        rank_group: 2,
        rank_absolute: 3,
        domain: "www.example.com",
        url: "https://www.example.com/b",
      },
    ]);

    const { data } = await fetchRankCheckSerp({
      ...houstonRankCheck,
      targetDomain: "example.com",
    });

    expect(data.position).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "dataforseo.google-organic-live-advanced.skipped-item",
      expect.objectContaining({ type: "organic" }),
    );
  });

  it("applies the same tolerance on the queued collect path", async () => {
    stubResponse({
      status_code: 20000,
      tasks: [
        {
          id: "task-a",
          status_code: 20000,
          cost: 0.0011,
          path: ["v3", "serp", "google", "organic", "task_get", "advanced"],
          result: [{ items: houstonItems }],
        },
      ],
    });

    const outcome = await fetchRankCheckTaskResult({
      taskId: "task-a",
      keywordId: "kw-1",
      keyword: "sleep apnea dentist",
      targetDomain: "houstondentalsleep.com",
    });

    expect(outcome).toMatchObject({
      status: "completed",
      isEmpty: false,
      result: {
        // The first local pack row is this domain's listing.
        localPackPosition: 1,
        position: null,
        providerCostUsd: 0.0011,
      },
    });
    expect(
      outcome.status === "completed" ? outcome.result.serpFeatures : [],
    ).toContain("people_also_search");
  });
});

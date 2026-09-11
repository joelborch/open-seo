import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/server/lib/runtime-env", () => ({
  getRequiredEnvValue: vi.fn(async () => "test-api-key"),
}));

import {
  fetchMapsTaskResult,
  fetchMapsTasksReady,
  postMapsGridTasks,
} from "@/server/lib/dataforseo/mapsTasks";
// Real (trimmed) task_get envelopes: a five-row Houston pack and a coordinate
// that was charged but returned nothing.
import mapsTaskGet from "@/server/lib/dataforseo/__fixtures__/maps-task-get.json";
import mapsTaskGetEmpty from "@/server/lib/dataforseo/__fixtures__/maps-task-get-empty.json";

const requestTasksSchema = z.array(z.record(z.string(), z.unknown()));

function postedTasks(init: RequestInit | undefined) {
  if (typeof init?.body !== "string") {
    throw new Error("Expected the DataForSEO request body to be a string");
  }
  return requestTasksSchema.parse(JSON.parse(init.body));
}

function stubFetch(payload: unknown) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(payload));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const gridTask = {
  tag: "run-1:kw-1:r4c4",
  keyword: "dentist near me",
  lat: 29.7628686,
  lng: -95.4548186,
  zoom: "13z",
  languageCode: "en",
  device: "mobile" as const,
  depth: 20,
};

describe("maps grid task_post", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the map-viewport payload for every grid point", async () => {
    const fetchMock = stubFetch({
      status_code: 20000,
      tasks: [
        {
          id: "task-a",
          status_code: 20100,
          cost: 0.0006,
          data: { tag: gridTask.tag },
        },
      ],
    });

    await postMapsGridTasks({ tasks: [gridTask] });

    expect(
      fetchMock.mock.calls.map(([url]) =>
        typeof url === "string" || url instanceof URL
          ? url.toString()
          : url.url,
      ),
    ).toEqual(["https://api.dataforseo.com/v3/serp/google/maps/task_post"]);
    expect(postedTasks(fetchMock.mock.calls[0]?.[1])).toEqual([
      {
        keyword: "dentist near me",
        language_code: "en",
        // 7 decimals, zoom suffix — the viewport the pack is drawn from.
        location_coordinate: "29.7628686,-95.4548186,13z",
        priority: 1,
        tag: gridTask.tag,
        search_this_area: true,
        search_places: false,
        device: "mobile",
        os: "android",
        depth: 20,
      },
    ]);
  });

  it("maps accepted entries by tag, reports refusals, and sums every charge", async () => {
    stubFetch({
      status_code: 20000,
      tasks: [
        {
          id: "task-a",
          status_code: 20100,
          cost: 0.0006,
          data: { tag: "run-1:kw-1:r1c1" },
        },
        {
          id: "task-b",
          status_code: 40006,
          status_message: "Task Limit Exceeded",
          cost: 0.0006,
          data: { tag: "run-1:kw-1:r1c2" },
        },
      ],
    });

    const result = await postMapsGridTasks({
      tasks: [
        { ...gridTask, tag: "run-1:kw-1:r1c1" },
        { ...gridTask, tag: "run-1:kw-1:r1c2" },
      ],
    });

    expect(result.data.posted).toEqual([
      { tag: "run-1:kw-1:r1c1", taskId: "task-a", costUsd: 0.0006 },
    ]);
    expect(result.data.rejected).toEqual([
      {
        tag: "run-1:kw-1:r1c2",
        statusCode: 40006,
        statusMessage: "Task Limit Exceeded",
      },
    ]);
    // The refused entry was still charged, so it is still metered.
    expect(result.billing.costUsd).toBeCloseTo(0.0012, 10);
    expect(result.billing.path).toEqual([
      "v3",
      "serp",
      "google",
      "maps",
      "task_post",
    ]);
  });

  it("rejects a batch above the provider's per-post ceiling", async () => {
    const fetchMock = stubFetch({ status_code: 20000, tasks: [] });
    await expect(
      postMapsGridTasks({
        tasks: Array.from({ length: 101 }, (_, i) => ({
          ...gridTask,
          tag: `run-1:kw-1:t${i}`,
        })),
      }),
    ).rejects.toThrow("task_post accepts 1-100 tasks");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("maps grid collection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("lists ready task ids", async () => {
    stubFetch({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          result: [{ id: "task-a" }, { id: "task-b" }],
        },
      ],
    });
    expect(await fetchMapsTasksReady()).toEqual(["task-a", "task-b"]);
  });

  it("treats an empty queue as no ready ids", async () => {
    stubFetch({
      status_code: 20000,
      tasks: [{ status_code: 20000, result: null }],
    });
    expect(await fetchMapsTasksReady()).toEqual([]);
  });

  it("parses a completed pack out of the real task_get envelope", async () => {
    stubFetch(mapsTaskGet);

    const outcome = await fetchMapsTaskResult(
      "09071634-1337-0066-0000-234af57239ae",
    );

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.isEmpty).toBe(false);
    expect(outcome.settledCostUsd).toBe(0.0006);
    expect(outcome.items).toHaveLength(5);
    expect(outcome.items[0]).toMatchObject({
      type: "maps_search",
      rank_group: 1,
      rank_absolute: 1,
      title: "Houston Dentists at Post Oak",
      domain: "www.houstondentistsatpostoak.com",
      place_id: "ChIJwSTL_yDBQIYRYzpHj2nqo4M",
      cid: "9485682979268672099",
      rating: { value: 4.9, votes_count: 301 },
      address_info: { zip: "77056", city: "Houston" },
    });
  });

  it("treats the charged-but-empty result as a terminal empty cell", async () => {
    stubFetch(mapsTaskGetEmpty);

    const outcome = await fetchMapsTaskResult(
      "09071625-1337-0066-0000-04bc97a08438",
    );

    expect(outcome).toEqual({
      status: "completed",
      items: [],
      providerStatusCode: 40102,
      settledCostUsd: 0,
      isEmpty: true,
    });
  });

  it("reports a queued task still in the provider's queue as pending", async () => {
    stubFetch({
      status_code: 20000,
      tasks: [{ id: "task-a", status_code: 40602 }],
    });
    expect(await fetchMapsTaskResult("task-a")).toEqual({
      status: "pending",
      providerStatusCode: 40602,
    });
  });

  it("reports a genuine task failure as failed", async () => {
    stubFetch({
      status_code: 20000,
      tasks: [
        {
          id: "task-a",
          status_code: 40101,
          status_message: "Internal SE Server Error.",
        },
      ],
    });
    expect(await fetchMapsTaskResult("task-a")).toEqual({
      status: "failed",
      message: "Internal SE Server Error.",
      providerStatusCode: 40101,
    });
  });
});

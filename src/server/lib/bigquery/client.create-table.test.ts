import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { BqTableSpec } from "./specs";

const mocks = vi.hoisted(() => ({
  kvGet: vi.fn<(key: string) => Promise<string | null>>(),
  kvPut: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { KV: { get: mocks.kvGet, put: mocks.kvPut } },
}));

import { buildCreateTableSql, mergeRows } from "./client";

const TEST_SPEC: BqTableSpec = {
  table: "widgets",
  scope: "internal",
  columns: [
    { name: "widget_id", type: "STRING" },
    { name: "report_date", type: "DATE" },
    { name: "score", type: "FLOAT64" },
    { name: "details", type: "JSON" },
  ],
  mergeKeys: ["widget_id", "report_date"],
};

const ONE_ROW = [
  { widget_id: "w1", report_date: "2026-01-05", score: 1, details: null },
];

const requestBodySchema = z.object({
  query: z.string(),
  queryParameters: z.array(z.unknown()),
});

function mergedResponse(numDmlAffectedRows?: string) {
  return Response.json({
    jobComplete: true,
    jobReference: { jobId: "job-1" },
    ...(numDmlAffectedRows ? { numDmlAffectedRows } : {}),
  });
}

/** BigQuery's 404 for a query whose target table does not exist yet. */
function notFoundResponse(what: string) {
  return Response.json(
    {
      error: {
        code: 404,
        message: `Not found: ${what} was not found in location US`,
        errors: [{ reason: "notFound", domain: "global" }],
        status: "NOT_FOUND",
      },
    },
    { status: 404 },
  );
}

function sentBody(callIndex: number) {
  const body = mocks.fetch.mock.calls[callIndex]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("expected a JSON request body");
  }
  return requestBodySchema.parse(JSON.parse(body));
}

describe("mergeRows on a missing table", () => {
  beforeEach(() => {
    vi.stubEnv(
      "GCP_SA_CLIENT_EMAIL",
      "sa@example-project.iam.gserviceaccount.com",
    );
    vi.stubEnv("GCP_SA_PRIVATE_KEY", "unused — the token comes from the cache");
    vi.stubEnv("GCP_PROJECT_ID", "example-project");
    vi.stubEnv("GCP_BQ_LOCATION", "US");
    vi.stubGlobal("fetch", mocks.fetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.kvGet.mockResolvedValue("ya29.cached");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("creates the table from its spec and retries the MERGE once", async () => {
    mocks.fetch
      .mockImplementationOnce(async () =>
        notFoundResponse("Table example-project:demo_marketing.widgets"),
      )
      .mockImplementationOnce(async () => mergedResponse())
      .mockImplementationOnce(async () => mergedResponse("1"));

    const result = await mergeRows({
      dataset: "demo_marketing",
      spec: TEST_SPEC,
      rows: ONE_ROW,
    });

    expect(result).toEqual({ affectedRows: 1, sourceRows: 1, statements: 1 });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(sentBody(0).query).toMatch(/^MERGE/);
    expect(sentBody(1)).toEqual({
      query:
        "CREATE TABLE IF NOT EXISTS `example-project.demo_marketing.widgets` (widget_id STRING, report_date DATE, score FLOAT64, details JSON)",
      queryParameters: [],
    });
    expect(sentBody(2).query).toBe(sentBody(0).query);
  });

  it("leaves a missing dataset, or some other table, as the error", async () => {
    mocks.fetch
      .mockImplementationOnce(async () =>
        notFoundResponse("Dataset example-project:demo_marketing"),
      )
      .mockImplementationOnce(async () =>
        notFoundResponse("Table example-project:demo_marketing.other_table"),
      );

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        mergeRows({
          dataset: "demo_marketing",
          spec: TEST_SPEC,
          rows: ONE_ROW,
        }),
      ).rejects.toMatchObject({ code: "BIGQUERY_QUERY_FAILED" });
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up when the MERGE still fails after the table was created", async () => {
    mocks.fetch
      .mockImplementationOnce(async () =>
        notFoundResponse("Table example-project:demo_marketing.widgets"),
      )
      .mockImplementationOnce(async () => mergedResponse())
      .mockImplementationOnce(async () =>
        notFoundResponse("Table example-project:demo_marketing.widgets"),
      );

    await expect(
      mergeRows({ dataset: "demo_marketing", spec: TEST_SPEC, rows: ONE_ROW }),
    ).rejects.toMatchObject({ code: "BIGQUERY_QUERY_FAILED" });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });
});

describe("buildCreateTableSql", () => {
  it("marks REQUIRED columns NOT NULL and leaves the rest nullable", () => {
    expect(
      buildCreateTableSql("example-project", "demo_marketing", {
        table: "widgets",
        scope: "internal",
        columns: [
          { name: "widget_id", type: "STRING", mode: "REQUIRED" },
          { name: "details", type: "JSON" },
        ],
        mergeKeys: ["widget_id"],
      }),
    ).toBe(
      "CREATE TABLE IF NOT EXISTS `example-project.demo_marketing.widgets` (widget_id STRING NOT NULL, details JSON)",
    );
  });

  it("rejects identifiers it cannot quote safely", () => {
    expect(() =>
      buildCreateTableSql("example-project", "demo; DROP", {
        table: "widgets",
        scope: "internal",
        columns: [{ name: "widget_id", type: "STRING" }],
        mergeKeys: ["widget_id"],
      }),
    ).toThrow();
  });
});

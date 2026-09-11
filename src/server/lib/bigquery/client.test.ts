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

import { mergeRows, MERGE_CHUNK_SIZE, runQuery } from "./client";

const QUERIES_URL =
  "https://bigquery.googleapis.com/bigquery/v2/projects/example-project/queries";

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

const requestBodySchema = z.object({
  query: z.string(),
  useLegacySql: z.boolean(),
  parameterMode: z.string(),
  location: z.string(),
  timeoutMs: z.number(),
  queryParameters: z.array(z.unknown()),
});

type SchemaField = { name: string; type: string; mode?: string };
type RawRow = { f: { v: unknown }[] };

function queryResponse(body: {
  fields?: SchemaField[];
  rows?: RawRow[];
  jobComplete?: boolean;
  pageToken?: string;
  numDmlAffectedRows?: string;
  errors?: { message: string }[];
}) {
  return Response.json({
    jobComplete: body.jobComplete ?? true,
    jobReference: { jobId: "job-1" },
    ...(body.fields ? { schema: { fields: body.fields } } : {}),
    ...(body.rows ? { rows: body.rows } : {}),
    ...(body.pageToken ? { pageToken: body.pageToken } : {}),
    ...(body.numDmlAffectedRows
      ? { numDmlAffectedRows: body.numDmlAffectedRows }
      : {}),
    ...(body.errors ? { errors: body.errors } : {}),
  });
}

function sentBody(callIndex: number) {
  const body = mocks.fetch.mock.calls[callIndex]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("expected a JSON request body");
  }
  return requestBodySchema.parse(JSON.parse(body));
}

function sentUrl(callIndex: number): string {
  const url = mocks.fetch.mock.calls[callIndex]?.[0];
  if (typeof url !== "string") {
    throw new Error("expected a string request url");
  }
  return url;
}

describe("runQuery", () => {
  beforeEach(() => {
    vi.stubEnv(
      "GCP_SA_CLIENT_EMAIL",
      "sa@example-project.iam.gserviceaccount.com",
    );
    vi.stubEnv("GCP_SA_PRIVATE_KEY", "unused — the token comes from the cache");
    vi.stubEnv("GCP_PROJECT_ID", "example-project");
    vi.stubEnv("GCP_BQ_LOCATION", "US");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.kvGet.mockResolvedValue("ya29.cached");
    mocks.fetch.mockImplementation(async () => queryResponse({}));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts a standard-SQL named-parameter query for the configured location", async () => {
    await runQuery({
      sql: "SELECT 1 WHERE @flag",
      params: { flag: { type: "BOOL", value: true } },
    });

    expect(sentUrl(0)).toBe(QUERIES_URL);
    expect(mocks.fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer ya29.cached",
    });
    expect(sentBody(0)).toMatchObject({
      query: "SELECT 1 WHERE @flag",
      useLegacySql: false,
      parameterMode: "NAMED",
      location: "US",
      timeoutMs: 30_000,
      queryParameters: [
        {
          name: "flag",
          parameterType: { type: "BOOL" },
          parameterValue: { value: "true" },
        },
      ],
    });
  });

  it("coerces the positional f/v result format into typed row objects", async () => {
    mocks.fetch.mockImplementation(async () =>
      queryResponse({
        fields: [
          { name: "id", type: "INTEGER" },
          { name: "score", type: "FLOAT" },
          { name: "active", type: "BOOLEAN" },
          { name: "day", type: "DATE" },
          { name: "seen_at", type: "TIMESTAMP" },
          { name: "label", type: "STRING" },
          { name: "tags", type: "STRING", mode: "REPEATED" },
        ],
        rows: [
          {
            f: [
              { v: "42" },
              { v: "1.5" },
              { v: "true" },
              { v: "2026-01-05" },
              { v: "1767225600.5" },
              { v: null },
              { v: [{ v: "a" }, { v: "b" }] },
            ],
          },
        ],
      }),
    );

    const result = await runQuery({ sql: "SELECT *" });

    expect(result.rows).toEqual([
      {
        id: 42,
        score: 1.5,
        active: true,
        day: "2026-01-05",
        seen_at: new Date(1_767_225_600_500),
        label: null,
        tags: ["a", "b"],
      },
    ]);
  });

  it("polls the job until it completes", async () => {
    mocks.fetch
      .mockImplementationOnce(async () => queryResponse({ jobComplete: false }))
      .mockImplementationOnce(async () =>
        queryResponse({
          fields: [{ name: "n", type: "INT64" }],
          rows: [{ f: [{ v: "7" }] }],
        }),
      );

    const result = await runQuery({ sql: "SELECT 7 AS n" });

    expect(result.rows).toEqual([{ n: 7 }]);
    expect(sentUrl(1)).toBe(`${QUERIES_URL}/job-1?location=US&timeoutMs=30000`);
  });

  it("follows pageToken until the result set is exhausted", async () => {
    const fields = [{ name: "n", type: "INT64" }];
    mocks.fetch
      .mockImplementationOnce(async () =>
        queryResponse({ fields, rows: [{ f: [{ v: "1" }] }], pageToken: "p2" }),
      )
      .mockImplementationOnce(async () =>
        queryResponse({ fields, rows: [{ f: [{ v: "2" }] }] }),
      );

    const result = await runQuery({ sql: "SELECT n" });

    expect(result.rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(sentUrl(1)).toContain("pageToken=p2");
  });

  it("fails with BIGQUERY_QUERY_FAILED when a completed job reports errors", async () => {
    mocks.fetch.mockImplementation(async () =>
      queryResponse({ errors: [{ message: "Syntax error: unexpected end" }] }),
    );

    await expect(runQuery({ sql: "SELECT" })).rejects.toMatchObject({
      code: "BIGQUERY_QUERY_FAILED",
    });
  });
});

describe("mergeRows", () => {
  beforeEach(() => {
    vi.stubEnv(
      "GCP_SA_CLIENT_EMAIL",
      "sa@example-project.iam.gserviceaccount.com",
    );
    vi.stubEnv("GCP_SA_PRIVATE_KEY", "unused — the token comes from the cache");
    vi.stubEnv("GCP_PROJECT_ID", "example-project");
    vi.stubEnv("GCP_BQ_LOCATION", "US");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.kvGet.mockResolvedValue("ya29.cached");
    mocks.fetch.mockImplementation(async () =>
      queryResponse({ numDmlAffectedRows: "1" }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("merges on the spec's keys and parses JSON columns back from STRING", async () => {
    const result = await mergeRows({
      dataset: "demo_marketing",
      spec: TEST_SPEC,
      rows: [
        {
          widget_id: "w1",
          report_date: new Date("2026-01-05T00:00:00Z"),
          score: 1.5,
          details: { competitors: 3 },
        },
      ],
    });

    expect(result).toEqual({ affectedRows: 1, sourceRows: 1, statements: 1 });
    const body = sentBody(0);
    expect(body.query).toBe(
      [
        "MERGE `example-project.demo_marketing.widgets` T",
        "USING UNNEST(@rows) S",
        "ON T.widget_id = S.widget_id AND T.report_date = S.report_date",
        "WHEN MATCHED THEN UPDATE SET score = S.score, details = PARSE_JSON(S.details)",
        "WHEN NOT MATCHED THEN INSERT (widget_id, report_date, score, details) VALUES (S.widget_id, S.report_date, S.score, PARSE_JSON(S.details))",
      ].join("\n"),
    );
    expect(body.queryParameters).toEqual([
      {
        name: "rows",
        parameterType: {
          type: "ARRAY",
          arrayType: {
            type: "STRUCT",
            structTypes: [
              { name: "widget_id", type: { type: "STRING" } },
              { name: "report_date", type: { type: "DATE" } },
              { name: "score", type: { type: "FLOAT64" } },
              { name: "details", type: { type: "STRING" } },
            ],
          },
        },
        parameterValue: {
          arrayValues: [
            {
              structValues: {
                widget_id: { value: "w1" },
                report_date: { value: "2026-01-05" },
                score: { value: "1.5" },
                details: { value: '{"competitors":3}' },
              },
            },
          ],
        },
      },
    ]);
  });

  it("keeps the last row per merge key so MERGE never sees two matches", async () => {
    const result = await mergeRows({
      dataset: "demo_marketing",
      spec: TEST_SPEC,
      rows: [
        { widget_id: "w1", report_date: "2026-01-05", score: 1, details: null },
        { widget_id: "w1", report_date: "2026-01-05", score: 9, details: null },
        { widget_id: "w2", report_date: "2026-01-05", score: 2, details: null },
      ],
    });

    expect(result.sourceRows).toBe(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(sentBody(0).queryParameters).toMatchObject([
      {
        parameterValue: {
          arrayValues: [
            {
              structValues: {
                widget_id: { value: "w1" },
                score: { value: "9" },
              },
            },
            {
              structValues: {
                widget_id: { value: "w2" },
                score: { value: "2" },
              },
            },
          ],
        },
      },
    ]);
  });

  it("splits oversized batches into chunked statements and sums affected rows", async () => {
    const rows = Array.from({ length: MERGE_CHUNK_SIZE + 1 }, (_, index) => ({
      widget_id: `w${index}`,
      report_date: "2026-01-05",
      score: index,
      details: null,
    }));
    mocks.fetch
      .mockImplementationOnce(async () =>
        queryResponse({ numDmlAffectedRows: String(MERGE_CHUNK_SIZE) }),
      )
      .mockImplementationOnce(async () =>
        queryResponse({ numDmlAffectedRows: "1" }),
      );

    const result = await mergeRows({
      dataset: "demo_marketing",
      spec: TEST_SPEC,
      rows,
    });

    expect(result).toEqual({
      affectedRows: MERGE_CHUNK_SIZE + 1,
      sourceRows: MERGE_CHUNK_SIZE + 1,
      statements: 2,
    });
  });

  it("sends nothing when there are no rows to merge", async () => {
    const result = await mergeRows({
      dataset: "demo_marketing",
      spec: TEST_SPEC,
      rows: [],
    });

    expect(result).toEqual({ affectedRows: 0, sourceRows: 0, statements: 0 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

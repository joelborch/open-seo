import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import {
  getBigQueryAccessToken,
  getBigQueryConfig,
  type BigQueryConfig,
} from "@/server/lib/bigquery/auth";
import {
  assertIdentifier,
  assertProjectId,
  buildQueryParameters,
  columnSourceExpression,
  encodeColumnValue,
  type BqInputRow,
  type BqQueryParam,
} from "@/server/lib/bigquery/params";
import {
  coerceRows,
  type BqRow,
  type BqSchemaField,
} from "@/server/lib/bigquery/rows";
import type { BqColumn, BqTableSpec } from "@/server/lib/bigquery/specs";

const BQ_API_BASE = "https://bigquery.googleapis.com/bigquery/v2";
/** Server-side wait per request; BigQuery returns jobComplete=false past it. */
const QUERY_TIMEOUT_MS = 30_000;
/** Each poll blocks up to QUERY_TIMEOUT_MS, so this is ~5 minutes of waiting. */
const MAX_POLL_ATTEMPTS = 10;
const MAX_RESULT_PAGES = 50;
const MAX_ERROR_BODY_LENGTH = 2_000;
/**
 * Rows per MERGE statement. BigQuery caps a query at 1 MB of request payload
 * plus 10 MB of parameters, and one huge UNNEST is also the slowest shape.
 */
export const MERGE_CHUNK_SIZE = 5_000;

const bqSchemaFieldSchema: z.ZodType<BqSchemaField> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string(),
    mode: z.string().optional(),
    fields: z.array(bqSchemaFieldSchema).optional(),
  }),
);

const queryResponseSchema = z.object({
  jobComplete: z.boolean().optional(),
  jobReference: z.object({ jobId: z.string() }).optional(),
  schema: z
    .object({ fields: z.array(bqSchemaFieldSchema).optional() })
    .optional(),
  rows: z
    .array(z.object({ f: z.array(z.object({ v: z.unknown() })).optional() }))
    .optional(),
  pageToken: z.string().optional(),
  totalRows: z.string().optional(),
  numDmlAffectedRows: z.string().optional(),
  errors: z
    .array(z.object({ reason: z.string().optional(), message: z.string() }))
    .optional(),
});

type QueryResponse = z.infer<typeof queryResponseSchema>;

export type BqQueryResult = {
  rows: BqRow[];
  /** BigQuery's own count for the result set, which can exceed `rows.length`. */
  totalRows: number;
  numDmlAffectedRows: number | null;
  jobId: string | null;
};

export type BqMergeResult = {
  affectedRows: number;
  /** Rows actually sent, after deduplication on the spec's merge keys. */
  sourceRows: number;
  statements: number;
};

export async function runQuery(input: {
  sql: string;
  params?: Record<string, BqQueryParam>;
  /** Caps both the page size and the total rows returned. */
  maxResults?: number;
}): Promise<BqQueryResult> {
  const config = await getBigQueryConfig();
  const token = await getBigQueryAccessToken();

  let page = await bqFetch(token, queriesUrl(config), {
    method: "POST",
    body: JSON.stringify({
      query: input.sql,
      useLegacySql: false,
      parameterMode: "NAMED",
      queryParameters: buildQueryParameters(input.params ?? {}),
      location: config.location,
      timeoutMs: QUERY_TIMEOUT_MS,
      ...(input.maxResults === undefined
        ? {}
        : { maxResults: input.maxResults }),
    }),
  });

  const jobId = page.jobReference?.jobId ?? null;

  // A long query returns jobComplete=false; re-reading the job's results is the
  // wait (each GET blocks server-side for timeoutMs), so there is no sleep loop.
  for (let attempt = 0; !page.jobComplete; attempt++) {
    if (!jobId) {
      throw new AppError(
        "BIGQUERY_QUERY_FAILED",
        "BigQuery did not complete the query and returned no job reference to poll.",
      );
    }
    if (attempt >= MAX_POLL_ATTEMPTS) {
      throw new AppError(
        "BIGQUERY_QUERY_FAILED",
        `BigQuery job ${jobId} did not finish within ${MAX_POLL_ATTEMPTS} polls.`,
      );
    }
    page = await getQueryResults(token, config, jobId, undefined, input);
  }

  const fields = page.schema?.fields ?? [];
  const rows = coerceRows(fields, page.rows ?? []);

  let pageToken = page.pageToken;
  for (let pageCount = 1; pageToken; pageCount++) {
    if (input.maxResults !== undefined && rows.length >= input.maxResults) {
      break;
    }
    if (pageCount >= MAX_RESULT_PAGES) {
      throw new AppError(
        "BIGQUERY_QUERY_FAILED",
        `BigQuery result set exceeded ${MAX_RESULT_PAGES} pages; narrow the query or pass maxResults.`,
      );
    }
    const next = await getQueryResults(token, config, jobId, pageToken, input);
    rows.push(...coerceRows(next.schema?.fields ?? fields, next.rows ?? []));
    pageToken = next.pageToken;
  }

  return {
    rows:
      input.maxResults === undefined ? rows : rows.slice(0, input.maxResults),
    totalRows: parseCount(page.totalRows) ?? rows.length,
    numDmlAffectedRows: parseCount(page.numDmlAffectedRows),
    jobId,
  };
}

/**
 * Upserts rows into `project.dataset.table` with a single MERGE per chunk.
 * BigQuery allows 1,500 DML statements per table per day, so a run should call
 * this once per table rather than per batch of rows.
 */
export async function mergeRows(input: {
  dataset: string;
  spec: BqTableSpec;
  rows: BqInputRow[];
}): Promise<BqMergeResult> {
  const { projectId } = await getBigQueryConfig();
  const sql = buildMergeSql(projectId, input.dataset, input.spec);
  const sourceRows = dedupeOnMergeKeys(input.spec, input.rows);

  if (sourceRows.length === 0) {
    return { affectedRows: 0, sourceRows: 0, statements: 0 };
  }

  const chunks = chunk(sourceRows, MERGE_CHUNK_SIZE);
  let affectedRows = 0;

  // Sequential on purpose: concurrent MERGEs against one table serialize in
  // BigQuery anyway, and overlapping ones fail with a conflict.
  for (const rows of chunks) {
    const result = await runQuery({
      sql,
      params: { rows: { type: "ARRAY<STRUCT>", spec: input.spec, rows } },
    });
    affectedRows += result.numDmlAffectedRows ?? 0;
  }

  return {
    affectedRows,
    sourceRows: sourceRows.length,
    statements: chunks.length,
  };
}

export function buildMergeSql(
  projectId: string,
  dataset: string,
  spec: BqTableSpec,
): string {
  assertProjectId(projectId);
  assertIdentifier(dataset, "dataset");
  assertIdentifier(spec.table, "table");

  const mergeKeys = new Set(spec.mergeKeys);
  const onClause = spec.mergeKeys
    .map((key) => {
      const column = columnByName(spec, key);
      if (column.type === "JSON") {
        throw new AppError(
          "BIGQUERY_QUERY_FAILED",
          `Table ${spec.table} uses JSON column "${key}" as a merge key, which BigQuery cannot compare.`,
        );
      }
      assertIdentifier(key, "column");
      return `T.${key} = S.${key}`;
    })
    .join(" AND ");

  const updates = spec.columns
    .filter((column) => !mergeKeys.has(column.name))
    .map((column) => `${column.name} = ${columnSourceExpression(column, "S")}`);

  const lines = [
    `MERGE \`${projectId}.${dataset}.${spec.table}\` T`,
    `USING UNNEST(@rows) S`,
    `ON ${onClause}`,
  ];
  if (updates.length > 0) {
    lines.push(`WHEN MATCHED THEN UPDATE SET ${updates.join(", ")}`);
  }
  lines.push(
    `WHEN NOT MATCHED THEN INSERT (${spec.columns.map((column) => column.name).join(", ")}) VALUES (${spec.columns
      .map((column) => columnSourceExpression(column, "S"))
      .join(", ")})`,
  );

  return lines.join("\n");
}

/**
 * BigQuery aborts a MERGE when two source rows match the same target row
 * ("UPDATE/MERGE must match at most one source row"), so the last row wins per
 * merge key before anything is sent.
 */
function dedupeOnMergeKeys(
  spec: BqTableSpec,
  rows: BqInputRow[],
): BqInputRow[] {
  const byKey = new Map<string, BqInputRow>();
  for (const row of rows) {
    byKey.set(mergeKeyOf(spec, row), row);
  }
  return [...byKey.values()];
}

function mergeKeyOf(spec: BqTableSpec, row: BqInputRow): string {
  return spec.mergeKeys
    .map((key) => {
      const encoded = encodeColumnValue(columnByName(spec, key), row[key]);
      if (encoded === null) {
        // A null merge key would never match the target and would duplicate on
        // every run, so it's a bug in the caller's row building.
        throw new AppError(
          "INTERNAL_ERROR",
          `BigQuery row for ${spec.table} has no value for merge key "${key}".`,
        );
      }
      return encoded;
    })
    .join(" ");
}

function columnByName(spec: BqTableSpec, name: string): BqColumn {
  const column = spec.columns.find((candidate) => candidate.name === name);
  if (!column) {
    throw new AppError(
      "BIGQUERY_QUERY_FAILED",
      `Table ${spec.table} has no column "${name}".`,
    );
  }
  return column;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function queriesUrl(config: BigQueryConfig): string {
  return `${BQ_API_BASE}/projects/${config.projectId}/queries`;
}

async function getQueryResults(
  token: string,
  config: BigQueryConfig,
  jobId: string | null,
  pageToken: string | undefined,
  input: { maxResults?: number },
): Promise<QueryResponse> {
  if (!jobId) {
    throw new AppError(
      "BIGQUERY_QUERY_FAILED",
      "BigQuery returned paged results without a job reference.",
    );
  }
  const url = new URL(`${queriesUrl(config)}/${jobId}`);
  url.searchParams.set("location", config.location);
  url.searchParams.set("timeoutMs", String(QUERY_TIMEOUT_MS));
  if (pageToken) {
    url.searchParams.set("pageToken", pageToken);
  }
  if (input.maxResults !== undefined) {
    url.searchParams.set("maxResults", String(input.maxResults));
  }
  return bqFetch(token, url.toString());
}

async function bqFetch(
  token: string,
  url: string,
  init?: RequestInit,
): Promise<QueryResponse> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  const body = await response.text();

  if (!response.ok) {
    throw new AppError(
      "BIGQUERY_QUERY_FAILED",
      `BigQuery API error (${response.status}): ${body.slice(0, MAX_ERROR_BODY_LENGTH)}`,
    );
  }

  const parsed = queryResponseSchema.safeParse(safeJsonParse(body));
  if (!parsed.success) {
    throw new AppError(
      "BIGQUERY_QUERY_FAILED",
      `Unexpected BigQuery response shape: ${parsed.error.message.slice(0, MAX_ERROR_BODY_LENGTH)}`,
    );
  }

  // A failed job still answers 200; the error list is where it says so.
  const [firstError] = parsed.data.errors ?? [];
  if (firstError) {
    throw new AppError(
      "BIGQUERY_QUERY_FAILED",
      `BigQuery job failed: ${firstError.message}`,
    );
  }

  return parsed.data;
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

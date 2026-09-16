// Public surface of the BigQuery integration: a service-account REST client
// that works on Workers (no google-cloud SDK, no Node APIs). Internals live in
// auth.ts (JWT-bearer token minting + KV cache), client.ts (jobs.query and
// MERGE), params.ts (named parameter wire format) and rows.ts (f/v decoding).

export {
  getBigQueryAccessToken,
  getBigQueryConfig,
  type BigQueryConfig,
} from "@/server/lib/bigquery/auth";

export {
  buildCreateTableSql,
  buildMergeSql,
  mergeRows,
  runQuery,
  MERGE_CHUNK_SIZE,
  type BqMergeResult,
  type BqQueryResult,
} from "@/server/lib/bigquery/client";

export type {
  BqInputRow,
  BqParamType,
  BqQueryParam,
} from "@/server/lib/bigquery/params";

export type { BqRow, BqValue } from "@/server/lib/bigquery/rows";

export {
  BQ_TABLE_SPECS,
  CLIENT_DATASETS,
  INTERNAL_DATASET,
  type BqColumn,
  type BqTableSpec,
} from "@/server/lib/bigquery/specs";

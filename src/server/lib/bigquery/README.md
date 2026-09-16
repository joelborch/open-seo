# BigQuery client (Workers)

A service-account REST client for BigQuery that runs on Cloudflare Workers. The
Google SDKs need Node APIs the Workers runtime doesn't have, so this mints its
own OAuth token with `jose` (RS256 JWT-bearer flow) and talks to
`bigquery.googleapis.com/bigquery/v2` over `fetch`.

- `auth.ts` — signs the service-account assertion, exchanges it for an access
  token, and caches that token in KV under `bigquery:access-token:<client email>`
  for `expires_in - 300` seconds.
- `client.ts` — `runQuery` (`jobs.query` + polling + result paging) and
  `mergeRows` (upsert a batch of rows through one MERGE per chunk). When the
  first MERGE of a batch fails because the target table does not exist,
  `mergeRows` creates it from the spec (`CREATE TABLE IF NOT EXISTS`) and
  retries once; a missing dataset, a schema mismatch, or a permission error is
  still raised as-is.
- `params.ts` — named query parameters, including the `ARRAY<STRUCT<…>>` value
  that MERGE's `UNNEST(@rows)` source is built from.
- `rows.ts` — decodes BigQuery's positional `schema` + `f/v` rows into objects.
- `specs.ts` — table schemas and merge keys per projection table.

## Required secrets

| Name                  | Example                                          |
| --------------------- | ------------------------------------------------ |
| `GCP_SA_CLIENT_EMAIL` | `seo-yolo@my-project.iam.gserviceaccount.com`    |
| `GCP_SA_PRIVATE_KEY`  | the PKCS#8 PEM from the service-account key JSON |
| `GCP_PROJECT_ID`      | `my-project`                                     |
| `GCP_BQ_LOCATION`     | `US`                                             |

All four are required; a missing one fails as `BIGQUERY_AUTH_FAILED` rather than
at the first query. `GCP_SA_PRIVATE_KEY` may carry `\n`-escaped newlines (what
the service-account JSON contains, and all most secret stores accept) — the
client unescapes them before importing the key. `GCP_BQ_LOCATION` has no default
on purpose: a query sent to the wrong region simply can't see the dataset.

## Service-account IAM

Grant the minimum per scope, not project-wide `bigquery.dataEditor`:

- `roles/bigquery.jobUser` on the **project** — every query, including a MERGE,
  runs as a job billed to the project, and without this nothing runs at all.
- `roles/bigquery.dataViewer` on the `searchconsole*` export datasets — these are
  read-only sources for the monitoring pipeline.
- `roles/bigquery.dataEditor` on each client dataset in `CLIENT_DATASETS` and on
  `seo_yolo_internal` — MERGE needs to read and write the target table.

## Quotas worth designing around

- **1,500 DML statements per table per day.** A run must therefore issue one
  MERGE per table, not one per row or per API page — that's why `mergeRows`
  takes the whole batch. Chunking only kicks in above `MERGE_CHUNK_SIZE`
  (5,000 rows), so a 20k-row day still costs 4 statements.
- **A MERGE fails when two source rows match the same target row.** `mergeRows`
  deduplicates on the spec's merge keys first (last row wins), so callers can
  hand it a raw collection batch.
- **10 MB of query parameters and 1 MB of query text per request.** Wide rows
  (the JSON columns especially) are the reason the chunk size is 5,000 rather
  than the tens of thousands the DML quota alone would allow.
- **Streaming-buffer rows can't be updated for ~30 minutes.** This client never
  uses `insertAll`, so MERGE stays the only write path and the buffer problem
  doesn't arise.

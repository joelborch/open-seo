/**
 * SQL and the coverage gate for reading Search Console's native BigQuery export
 * instead of the Search Console API.
 *
 * Ported from seo-yolo's `bq_export.py`. The export stores a ZERO-BASED rank sum,
 * so the API's average position is `sum_position / impressions + 1`; site-wide
 * query totals live in `searchdata_site_impression` (with `sum_top_position`) and
 * per-URL totals in `searchdata_url_impression` (with `sum_position`), which is
 * the same split the API makes between its query and page reports.
 *
 * Pure on purpose — a leaf module with no client, no database and no Workers
 * bindings, so the generated SQL and the gate are testable without mocks.
 */
import {
  assertIdentifier,
  assertProjectId,
} from "@/server/lib/bigquery/params";

/** Grains the export can serve. Anything else stays on the API. */
export const GSC_EXPORT_DIMENSIONS = ["query", "page", "query_page"] as const;
export type GscExportDimension = (typeof GSC_EXPORT_DIMENSIONS)[number];

const SITE_TABLE = "searchdata_site_impression";
const URL_TABLE = "searchdata_url_impression";

/** Max rows one export read returns, mirroring the API path's own row cap. */
const GSC_EXPORT_MAX_ROWS = 25_000;

type ExportGrain = {
  table: string;
  /** Select list, in the order the API would return `keys`. */
  selections: string[];
  /** Output names of the selections, i.e. the `keys` order. */
  keys: string[];
  /** The rank-sum column whose mean is the reported position. */
  rankColumn: string;
  orderColumn: string;
};

const GRAINS: Record<GscExportDimension, ExportGrain> = {
  // Site-level query totals: the API's "queries" report double-counts nothing
  // across URLs, and neither does this table.
  query: {
    table: SITE_TABLE,
    selections: ["query"],
    keys: ["query"],
    rankColumn: "sum_top_position",
    orderColumn: "impressions",
  },
  page: {
    table: URL_TABLE,
    selections: ["url AS page"],
    keys: ["page"],
    rankColumn: "sum_position",
    orderColumn: "clicks",
  },
  // Keys are (query, page) — the order `dimensions: ["query","page"]` returns
  // from the API, which is what the striking-distance report reads.
  query_page: {
    table: URL_TABLE,
    selections: ["query", "url AS page"],
    keys: ["query", "page"],
    rankColumn: "sum_position",
    orderColumn: "clicks",
  },
};

export function exportGrain(dimension: GscExportDimension): ExportGrain {
  return GRAINS[dimension];
}

/**
 * The export grain a Search Console API request maps to, or null when the export
 * cannot answer it. Only the query / page / query+page combinations exist in the
 * export tables at the grain the API reports them; country, device, date and
 * searchAppearance stay on the API.
 */
export function exportDimensionFor(
  dimensions: readonly string[] | undefined,
): GscExportDimension | null {
  const requested = new Set(dimensions ?? []);
  // A repeated dimension is not something the API returns; treat it as unknown.
  if (requested.size !== (dimensions ?? []).length) return null;
  if (requested.size === 1 && requested.has("query")) return "query";
  if (requested.size === 1 && requested.has("page")) return "page";
  if (requested.size === 2 && requested.has("query") && requested.has("page")) {
    return "query_page";
  }
  return null;
}

/** Freshness and per-day completeness of one export table over a window. */
export function buildCoverageSql(input: {
  gcpProjectId: string;
  dataset: string;
  dimension: GscExportDimension;
}): string {
  assertProjectId(input.gcpProjectId);
  assertIdentifier(input.dataset, "dataset");
  return [
    "SELECT MAX(data_date) AS max_data_date, COUNT(DISTINCT data_date) AS covered_days",
    `FROM \`${input.gcpProjectId}.${input.dataset}.${exportGrain(input.dimension).table}\``,
    "WHERE data_date BETWEEN @since AND @until",
  ].join(" ");
}

export function buildExportSql(input: {
  gcpProjectId: string;
  dataset: string;
  dimension: GscExportDimension;
  limit: number;
}): string {
  assertProjectId(input.gcpProjectId);
  assertIdentifier(input.dataset, "dataset");
  const grain = exportGrain(input.dimension);
  const limit = Math.min(
    Math.max(Math.floor(input.limit), 1),
    GSC_EXPORT_MAX_ROWS,
  );
  // Anonymized queries are the export's placeholder rows for terms Google will
  // not disclose; the API omits them from query reports, so they are filtered
  // out wherever `query` is a key.
  const anonymized = grain.keys.includes("query")
    ? " AND NOT is_anonymized_query"
    : "";
  return [
    `SELECT ${grain.selections.join(", ")},`,
    "SUM(clicks) AS clicks, SUM(impressions) AS impressions,",
    "SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,",
    `SAFE_DIVIDE(SUM(${grain.rankColumn}), SUM(impressions)) + 1 AS position`,
    `FROM \`${input.gcpProjectId}.${input.dataset}.${grain.table}\``,
    `WHERE data_date BETWEEN @since AND @until AND search_type = 'WEB'${anonymized}`,
    `GROUP BY ${grain.keys.join(", ")}`,
    `ORDER BY ${grain.orderColumn} DESC, ${grain.keys[0]} ASC`,
    `LIMIT ${limit}`,
  ].join(" ");
}

/** Inclusive day count of a [startDate, endDate] window of ISO dates. */
function windowDays(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

/**
 * Whether the export can serve a window on its own. Two conditions, both from
 * `bq_export.py`: its freshest day must reach the end of the window (the export
 * lands a day or two behind, and a half-covered window would silently
 * under-report), and every reporting day in the window must be present.
 *
 * A day on which the site had literally zero impressions has no rows and so
 * reads as uncovered — the same conservative call seo-yolo makes, and it only
 * ever sends the request to the API instead.
 */
export function isWindowCovered(input: {
  maxDataDate: string | null;
  coveredDays: number;
  startDate: string;
  endDate: string;
}): boolean {
  const days = windowDays(input.startDate, input.endDate);
  if (days === 0) return false;
  if (!input.maxDataDate || input.maxDataDate < input.endDate) return false;
  return input.coveredDays >= days;
}

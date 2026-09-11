/**
 * Reads Search Console performance out of the project's native BigQuery export.
 *
 * The export reproduces the API's query and page aggregates exactly, and one
 * query replaces a paginated API crawl — but only for windows the export fully
 * covers. Everything else falls back to the API, which is why every function here
 * returns null rather than throwing on a miss.
 */
import { getBigQueryConfig, runQuery } from "@/server/lib/bigquery";
import { BigqueryProjectionRepository } from "@/server/features/bigquery-projection/repositories/BigqueryProjectionRepository";
import {
  buildCoverageSql,
  buildExportSql,
  exportGrain,
  isWindowCovered,
  type GscExportDimension,
} from "@/server/features/gsc/gscExportSql";
import type { BqRow, BqValue } from "@/server/lib/bigquery";
import type { GscSearchAnalyticsRow } from "@/server/lib/gscClient";

type GscExportRequest = {
  projectId: string;
  startDate: string;
  endDate: string;
  dimension: GscExportDimension;
  limit: number;
};

/**
 * The project's Search Console export dataset, or null when it has none. Read
 * through the BigQuery target repository so both the projection pipeline and this
 * reader resolve `project_bigquery_targets` the same way.
 */
async function getExportDataset(projectId: string): Promise<string | null> {
  const target = await BigqueryProjectionRepository.getTarget(projectId);
  return target?.gscExportDataset ?? null;
}

async function isCovered(input: {
  gcpProjectId: string;
  dataset: string;
  dimension: GscExportDimension;
  startDate: string;
  endDate: string;
}): Promise<boolean> {
  const result = await runQuery({
    sql: buildCoverageSql(input),
    params: dateWindowParams(input.startDate, input.endDate),
  });
  const [row] = result.rows;
  return isWindowCovered({
    maxDataDate: asString(row?.max_data_date),
    coveredDays: asNumber(row?.covered_days) ?? 0,
    startDate: input.startDate,
    endDate: input.endDate,
  });
}

/**
 * Search performance rows for a window, in the same shape
 * `searchAnalytics.query` returns (`keys` in the requested dimension order).
 *
 * Returns null whenever the caller should use the API instead: the project has no
 * export dataset, the export does not cover the window, or BigQuery failed. A
 * BigQuery outage must not take the Search Performance page down with it, so the
 * failure is logged and the API answers.
 */
async function getSearchPerformanceFromExport(
  input: GscExportRequest,
): Promise<GscSearchAnalyticsRow[] | null> {
  const dataset = await getExportDataset(input.projectId);
  if (!dataset) return null;

  try {
    const { projectId: gcpProjectId } = await getBigQueryConfig();
    const covered = await isCovered({
      gcpProjectId,
      dataset,
      dimension: input.dimension,
      startDate: input.startDate,
      endDate: input.endDate,
    });
    if (!covered) return null;

    const result = await runQuery({
      sql: buildExportSql({
        gcpProjectId,
        dataset,
        dimension: input.dimension,
        limit: input.limit,
      }),
      params: dateWindowParams(input.startDate, input.endDate),
    });
    const keys = exportGrain(input.dimension).keys;
    return result.rows.map((row) => toSearchAnalyticsRow(row, keys));
  } catch (error) {
    console.warn(
      `[gsc-export] Falling back to the Search Console API for project ${input.projectId}:`,
      error,
    );
    return null;
  }
}

function dateWindowParams(startDate: string, endDate: string) {
  return {
    since: { type: "DATE" as const, value: startDate },
    until: { type: "DATE" as const, value: endDate },
  };
}

/**
 * `SAFE_DIVIDE` returns null for a zero denominator, and an aggregate over no
 * rows is null too, so every measure defaults to 0 — the same normalization
 * `bq_export.py` applies before handing rows to the API's consumers.
 */
function toSearchAnalyticsRow(
  row: BqRow,
  keys: string[],
): GscSearchAnalyticsRow {
  return {
    keys: keys.map((key) => asString(row[key]) ?? ""),
    clicks: asNumber(row.clicks) ?? 0,
    impressions: asNumber(row.impressions) ?? 0,
    ctr: asNumber(row.ctr) ?? 0,
    position: asNumber(row.position) ?? 0,
  };
}

function asString(value: BqValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: BqValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

export const gscExportRepository = {
  getExportDataset,
  getSearchPerformanceFromExport,
};

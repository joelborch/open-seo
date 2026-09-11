import { describe, expect, it } from "vitest";
import {
  buildCoverageSql,
  buildExportSql,
  exportDimensionFor,
  GSC_EXPORT_DIMENSIONS,
  isWindowCovered,
} from "./gscExportSql";

const BASE = { gcpProjectId: "gmail-for-forwarding", dataset: "searchconsole" };

describe("exportDimensionFor", () => {
  it("maps the three grains the export tables can answer", () => {
    expect(exportDimensionFor(["query"])).toBe("query");
    expect(exportDimensionFor(["page"])).toBe("page");
    expect(exportDimensionFor(["query", "page"])).toBe("query_page");
    expect(exportDimensionFor(["page", "query"])).toBe("query_page");
  });

  it("rejects anything the export does not aggregate at the API's grain", () => {
    expect(exportDimensionFor(["date"])).toBeNull();
    expect(exportDimensionFor(["query", "device"])).toBeNull();
    expect(exportDimensionFor([])).toBeNull();
    expect(exportDimensionFor(undefined)).toBeNull();
  });
});

describe("buildExportSql", () => {
  it("reads site-level query totals with sum_top_position", () => {
    expect(
      buildExportSql({ ...BASE, dimension: "query", limit: 1000 }),
    ).toEqual(
      "SELECT query, SUM(clicks) AS clicks, SUM(impressions) AS impressions," +
        " SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr," +
        " SAFE_DIVIDE(SUM(sum_top_position), SUM(impressions)) + 1 AS position" +
        " FROM `gmail-for-forwarding.searchconsole.searchdata_site_impression`" +
        " WHERE data_date BETWEEN @since AND @until AND search_type = 'WEB' AND NOT is_anonymized_query" +
        " GROUP BY query ORDER BY clicks DESC, query ASC LIMIT 1000",
    );
  });

  it("reads per-URL page totals with sum_position and no query filter", () => {
    const sql = buildExportSql({ ...BASE, dimension: "page", limit: 25 });

    expect(sql).toContain("SELECT url AS page,");
    expect(sql).toContain("searchdata_url_impression");
    expect(sql).toContain(
      "SAFE_DIVIDE(SUM(sum_position), SUM(impressions)) + 1 AS position",
    );
    expect(sql).not.toContain("is_anonymized_query");
    expect(sql).toContain("GROUP BY page ORDER BY clicks DESC, page ASC");
  });

  it("keys query+page rows in the API's dimension order", () => {
    const sql = buildExportSql({ ...BASE, dimension: "query_page", limit: 10 });

    expect(sql).toContain("SELECT query, url AS page,");
    expect(sql).toContain("GROUP BY query, page");
    expect(sql).toContain("AND NOT is_anonymized_query");
  });

  // The row cap makes ordering part of the result set, not a cosmetic detail: an
  // impressions-ordered top 25,000 is a different set of rows than the API's
  // clicks-ordered one, and the two paths have to be interchangeable.
  it.each(GSC_EXPORT_DIMENSIONS)(
    "orders the %s grain by clicks, like Search Analytics",
    (dimension) => {
      expect(buildExportSql({ ...BASE, dimension, limit: 10 })).toContain(
        "ORDER BY clicks DESC",
      );
    },
  );

  it("clamps the row limit rather than interpolating it raw", () => {
    expect(
      buildExportSql({ ...BASE, dimension: "query", limit: 10_000_000 }),
    ).toContain("LIMIT 25000");
    expect(buildExportSql({ ...BASE, dimension: "query", limit: 0 })).toContain(
      "LIMIT 1",
    );
  });

  it("refuses a dataset name that is not a BigQuery identifier", () => {
    expect(() =>
      buildExportSql({
        ...BASE,
        dataset: "searchconsole`; DROP TABLE x; --",
        dimension: "query",
        limit: 10,
      }),
    ).toThrow(/Invalid BigQuery dataset name/);
  });
});

describe("buildCoverageSql", () => {
  it("asks the read's own table for freshness and per-day completeness", () => {
    expect(buildCoverageSql({ ...BASE, dimension: "query" })).toBe(
      "SELECT MAX(data_date) AS max_data_date, COUNT(DISTINCT data_date) AS covered_days" +
        " FROM `gmail-for-forwarding.searchconsole.searchdata_site_impression`" +
        " WHERE data_date BETWEEN @since AND @until",
    );
    expect(buildCoverageSql({ ...BASE, dimension: "page" })).toContain(
      "searchdata_url_impression",
    );
  });
});

describe("isWindowCovered", () => {
  const window = { startDate: "2026-03-01", endDate: "2026-03-07" };

  it("serves the window when the export is fresh and has every day", () => {
    expect(
      isWindowCovered({
        ...window,
        maxDataDate: "2026-03-07",
        coveredDays: 7,
      }),
    ).toBe(true);
  });

  it("falls back when the export has not reached the end of the window", () => {
    expect(
      isWindowCovered({
        ...window,
        maxDataDate: "2026-03-05",
        coveredDays: 5,
      }),
    ).toBe(false);
  });

  it("falls back on a gap inside the window", () => {
    expect(
      isWindowCovered({
        ...window,
        maxDataDate: "2026-03-07",
        coveredDays: 6,
      }),
    ).toBe(false);
  });

  it("falls back when the export has no rows at all for the window", () => {
    expect(
      isWindowCovered({ ...window, maxDataDate: null, coveredDays: 0 }),
    ).toBe(false);
  });

  it("falls back on an inverted or unparseable window", () => {
    expect(
      isWindowCovered({
        startDate: "2026-03-07",
        endDate: "2026-03-01",
        maxDataDate: "2026-03-07",
        coveredDays: 7,
      }),
    ).toBe(false);
  });
});

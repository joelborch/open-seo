import { describe, expect, it } from "vitest";
import { BQ_TABLE_SPECS, CLIENT_DATASETS, INTERNAL_DATASET } from "./specs";

describe("BigQuery table specs", () => {
  it("has matching table property and record key for all table specs", () => {
    for (const [key, spec] of Object.entries(BQ_TABLE_SPECS)) {
      expect(spec.table).toBe(key);
    }
  });

  it("ensures every mergeKey names an existing column in columns", () => {
    for (const [key, spec] of Object.entries(BQ_TABLE_SPECS)) {
      const columnNames = new Set(spec.columns.map((col) => col.name));
      expect(spec.mergeKeys.length).toBeGreaterThan(0);
      for (const mergeKey of spec.mergeKeys) {
        expect(
          columnNames.has(mergeKey),
          `Table "${key}" has merge key "${mergeKey}" which does not exist in columns`,
        ).toBe(true);
      }
    }
  });

  it("has no duplicate column names within any table spec", () => {
    for (const [key, spec] of Object.entries(BQ_TABLE_SPECS)) {
      const seen = new Set<string>();
      for (const column of spec.columns) {
        expect(
          seen.has(column.name),
          `Table "${key}" contains duplicate column "${column.name}"`,
        ).toBe(false);
        seen.add(column.name);
      }
    }
  });

  it("assigns expected scopes to client projections and internal observations", () => {
    expect(BQ_TABLE_SPECS.maps_rankings.scope).toBe("client");
    expect(BQ_TABLE_SPECS.keyword_rankings.scope).toBe("client");
    expect(BQ_TABLE_SPECS.aio_tracking.scope).toBe("client");
    expect(BQ_TABLE_SPECS.weekly_health_metrics.scope).toBe("client");
    expect(BQ_TABLE_SPECS.observations.scope).toBe("internal");
  });

  it("uses the cell-level grain for maps_rankings merge keys", () => {
    expect(BQ_TABLE_SPECS.maps_rankings.mergeKeys).toEqual([
      "report_date",
      "keyword",
      "grid_lat",
      "grid_lng",
      "rank_type",
      "run_id",
    ]);
  });

  it("contains registered client dataset mappings in CLIENT_DATASETS", () => {
    const keys = Object.keys(CLIENT_DATASETS);
    expect(keys.length).toBeGreaterThan(0);
    expect(CLIENT_DATASETS.theairwaydentists).toBe("airway_marketing");
    expect(CLIENT_DATASETS.reddyplasticsurgerygroup).toBe("reddy_marketing");
    expect(CLIENT_DATASETS.advanceddermchi).toBe("advderm_marketing");
  });

  it("defines INTERNAL_DATASET constant", () => {
    expect(INTERNAL_DATASET).toBe("seo_yolo_internal");
  });
});

export type BqColumn = {
  name: string;
  type: "STRING" | "INT64" | "FLOAT64" | "DATE" | "TIMESTAMP" | "BOOL" | "JSON";
  mode?: "REQUIRED" | "NULLABLE";
};

export type BqTableSpec = {
  table: string;
  scope: "client" | "internal";
  columns: BqColumn[];
  mergeKeys: string[];
};

export const INTERNAL_DATASET = "seo_yolo_internal";

export const CLIENT_DATASETS: Record<string, string> = {
  theairwaydentists: "airway_marketing",
  reddyplasticsurgerygroup: "reddy_marketing",
  advanceddermchi: "advderm_marketing",
  actchealth: "actc_marketing",
  newmouth: "newmouth_marketing",
  visioncenter: "visioncenter_marketing",
  knowyourdna: "knowyourdna_marketing",
};

export const BQ_TABLE_SPECS: Record<
  | "maps_rankings"
  | "keyword_rankings"
  | "aio_tracking"
  | "gbp_snapshots"
  | "weekly_health_metrics"
  | "observations",
  BqTableSpec
> = {
  /**
   * Cell-level grain (from seo-yolo collection_projection.py):
   * Each cell in a coordinate grid radius sweep is recorded with grid_lat, grid_lng,
   * competitors JSON, and run metadata.
   *
   * Note on office-level variant:
   * The earlier office-level variant from bq_sink.py (MAPS_RANKINGS) aggregated positions
   * per office rather than grid cell, with schema:
   *   columns: [report_date, keyword, office, rank_type, position, ranked_url, source, pulled_at]
   *   merge_keys: [report_date, keyword, office, rank_type]
   */
  maps_rankings: {
    table: "maps_rankings",
    scope: "client",
    columns: [
      { name: "report_date", type: "DATE" },
      { name: "keyword", type: "STRING" },
      { name: "office", type: "STRING" },
      { name: "rank_type", type: "STRING" },
      { name: "position", type: "INT64" },
      { name: "ranked_url", type: "STRING" },
      { name: "grid_lat", type: "FLOAT64" },
      { name: "grid_lng", type: "FLOAT64" },
      { name: "competitors", type: "JSON" },
      { name: "source", type: "STRING" },
      { name: "pulled_at", type: "TIMESTAMP" },
      { name: "run_id", type: "STRING" },
      { name: "request_id", type: "STRING" },
    ],
    mergeKeys: [
      "report_date",
      "keyword",
      "grid_lat",
      "grid_lng",
      "rank_type",
      "run_id",
    ],
  },

  keyword_rankings: {
    table: "keyword_rankings",
    scope: "client",
    columns: [
      { name: "date", type: "DATE" },
      { name: "keyword", type: "STRING" },
      { name: "location", type: "STRING" },
      { name: "surface", type: "STRING" },
      { name: "rank", type: "INT64" },
      { name: "url", type: "STRING" },
      { name: "top_domains", type: "JSON" },
      { name: "source", type: "STRING" },
      { name: "pulled_at", type: "TIMESTAMP" },
      { name: "run_id", type: "STRING" },
      { name: "request_id", type: "STRING" },
    ],
    mergeKeys: ["date", "keyword", "location", "surface", "run_id"],
  },

  aio_tracking: {
    table: "aio_tracking",
    scope: "client",
    columns: [
      { name: "report_date", type: "DATE" },
      { name: "keyword", type: "STRING" },
      { name: "tier", type: "STRING" },
      { name: "aio_present", type: "BOOL" },
      { name: "client_domain_cited", type: "BOOL" },
      { name: "citation_position", type: "INT64" },
      { name: "client_name_mentioned", type: "BOOL" },
      { name: "cited_domains", type: "STRING" },
      { name: "aio_text_snippet", type: "STRING" },
      { name: "organic_rank", type: "INT64" },
      { name: "source", type: "STRING" },
      { name: "pulled_at", type: "TIMESTAMP" },
      { name: "run_id", type: "STRING" },
      { name: "request_id", type: "STRING" },
    ],
    mergeKeys: ["report_date", "keyword", "run_id"],
  },

  /**
   * Google Business Profile state, one row per location per observation date.
   *
   * New to open-seo: seo-yolo's `gbp` source is the Business Profile *performance*
   * API (views, calls, direction requests), which it folds into
   * `weekly_health_metrics` as `gbp_<metric>` rows. That stays where it is — this
   * table is the profile itself (rating, review count, category, claimed status,
   * NAP, attributes), which seo-yolo never captured.
   *
   * The merge key carries no `run_id`, unlike the other client tables: a location
   * has at most one snapshot per date by construction (the unique
   * (location_id, run_date) in `gbp_snapshots`), so a re-capture is a correction of
   * that day's reading rather than a new observation to keep alongside it.
   */
  gbp_snapshots: {
    table: "gbp_snapshots",
    scope: "client",
    columns: [
      { name: "report_date", type: "DATE" },
      { name: "location_slug", type: "STRING" },
      { name: "location_name", type: "STRING" },
      { name: "profile_name", type: "STRING" },
      { name: "place_id", type: "STRING" },
      { name: "cid", type: "STRING" },
      { name: "primary_category", type: "STRING" },
      { name: "rating", type: "FLOAT64" },
      { name: "reviews_count", type: "INT64" },
      { name: "reviews_count_delta", type: "INT64" },
      { name: "is_claimed", type: "BOOL" },
      { name: "address", type: "STRING" },
      { name: "phone", type: "STRING" },
      { name: "website", type: "STRING" },
      { name: "photos_count", type: "INT64" },
      { name: "attributes", type: "JSON" },
      { name: "source", type: "STRING" },
      { name: "pulled_at", type: "TIMESTAMP" },
      { name: "run_id", type: "STRING" },
      { name: "request_id", type: "STRING" },
    ],
    mergeKeys: ["report_date", "location_slug"],
  },

  weekly_health_metrics: {
    table: "weekly_health_metrics",
    scope: "client",
    columns: [
      { name: "report_date", type: "DATE" },
      { name: "metric", type: "STRING" },
      { name: "value", type: "FLOAT64" },
      { name: "detail", type: "STRING" },
      { name: "source", type: "STRING" },
      { name: "pulled_at", type: "TIMESTAMP" },
      { name: "run_id", type: "STRING" },
      { name: "request_id", type: "STRING" },
    ],
    mergeKeys: ["report_date", "metric", "source", "run_id"],
  },

  observations: {
    table: "observations",
    scope: "internal",
    columns: [
      { name: "observation_id", type: "STRING" },
      { name: "run_id", type: "STRING" },
      { name: "client_key", type: "STRING" },
      { name: "occurrence_key", type: "STRING" },
      { name: "source_family", type: "STRING" },
      { name: "observed_date", type: "DATE" },
      { name: "metric_key", type: "STRING" },
      { name: "dimensions", type: "JSON" },
      { name: "value_numeric", type: "FLOAT64" },
      { name: "value_text", type: "STRING" },
      { name: "unit", type: "STRING" },
      { name: "source_record_id", type: "STRING" },
      { name: "evidence_id", type: "STRING" },
      { name: "provenance", type: "JSON" },
      { name: "observed_at", type: "TIMESTAMP" },
      { name: "ingested_at", type: "TIMESTAMP" },
    ],
    mergeKeys: ["observation_id"],
  },
};

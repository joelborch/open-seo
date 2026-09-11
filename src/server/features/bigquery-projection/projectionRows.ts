/**
 * Pure mappers from open-seo run rows to the BigQuery projection tables.
 *
 * These reproduce the column semantics of seo-yolo's `collection_projection.py`
 * compactors (`compact_crawl`, `compact_rankings`, `compact_aio`, `compact_maps`)
 * so both collectors can write the same client datasets: `report_date` is the
 * run's observation date, `source` is a constant collector tag, `pulled_at` is
 * when the projection ran, and `run_id` is part of every merge key so a re-run
 * lands as its own row rather than overwriting history.
 *
 * Where seo-yolo derives a value from the raw provider payload that open-seo
 * never stores (the full SERP item list, AI-overview text), the column is left
 * null and the reason is commented at the assignment.
 */
import { sort } from "remeda";
import type { BqInputRow } from "@/server/lib/bigquery";

/** Tag written to every `source` column, so a dataset can tell the two collectors apart. */
export const PROJECTION_SOURCE = "openseo_monitoring";
/** `provenance.projection` on internal observations; bump when a mapping changes. */
const PROJECTION_VERSION = "openseo_monitoring_v1";

/** seo-yolo's source families, reused so `observations` stays queryable across both. */
const SOURCE_FAMILY = {
  audit_schedule_run: "crawl",
  rank_check_run: "rankings",
  maps_grid_run: "maps",
  gbp_snapshot: "gbp",
} as const;

export type ProjectionRunKind = keyof typeof SOURCE_FAMILY;

/** Client-dataset tables a projection can write, keyed as in `BQ_TABLE_SPECS`. */
export type ProjectionTableName =
  | "weekly_health_metrics"
  | "keyword_rankings"
  | "aio_tracking"
  | "maps_rankings"
  | "gbp_snapshots";

/** Which client tables each run kind is expected to produce. */
export const TABLES_BY_RUN_KIND: Record<
  ProjectionRunKind,
  readonly ProjectionTableName[]
> = {
  audit_schedule_run: ["weekly_health_metrics"],
  rank_check_run: ["keyword_rankings", "aio_tracking"],
  maps_grid_run: ["maps_rankings"],
  gbp_snapshot: ["gbp_snapshots"],
};

/** Competitors kept per maps cell, matching seo-yolo's `compact_maps`. */
const MAPS_COMPETITOR_LIMIT = 3;

export type ProjectionResult = {
  /** The run's observation date, `report_date` / `date` / `observed_date`. */
  reportDate: string;
  rowsByTable: Partial<Record<ProjectionTableName, BqInputRow[]>>;
};

// ============================================================================
// audit_schedule_runs -> weekly_health_metrics
// ============================================================================

export type AuditRunSource = {
  run: {
    id: string;
    cadence: "quick" | "deep";
    triggeredAt: string;
    completedAt: string | null;
    pagesCrawled: number | null;
    pagesWithErrors: number | null;
    pagesWithWarnings: number | null;
    pagesWithNotices: number | null;
    pagesBlocked: number | null;
    healthScore: number | null;
    healthScoreDelta: number | null;
  };
  issueCounts: { issueType: string; severity: string; pages: number }[];
};

export function buildAuditProjection(input: {
  source: AuditRunSource;
  pulledAt: string;
}): ProjectionResult {
  const { run } = input.source;
  const reportDate = observationDate(run.completedAt ?? run.triggeredAt);
  const metrics: Array<[string, number | null, string | null]> = [
    ["crawl_health_score", run.healthScore, run.cadence],
    ["crawl_health_score_delta", run.healthScoreDelta, run.cadence],
    ["crawl_pages_crawled", run.pagesCrawled, run.cadence],
    ["crawl_pages_with_errors", run.pagesWithErrors, run.cadence],
    ["crawl_pages_with_warnings", run.pagesWithWarnings, run.cadence],
    ["crawl_pages_with_notices", run.pagesWithNotices, run.cadence],
    ["crawl_pages_blocked", run.pagesBlocked, run.cadence],
    // One metric per issue type, the same shape seo-yolo uses for
    // `ga4_conversions_<event>`: the metric name carries the dimension, so the
    // (report_date, metric, source, run_id) merge key stays unique per row.
    ...input.source.issueCounts.map((count): [string, number, string] => [
      `crawl_issue_${count.issueType}`,
      count.pages,
      count.severity,
    ]),
  ];

  return {
    reportDate,
    rowsByTable: {
      // A metric with no measurement is dropped rather than written as a null
      // value: a row that says "nothing was measured" is indistinguishable from
      // a zero once it is charted.
      weekly_health_metrics: metrics
        .filter(([, value]) => value !== null)
        .map(([metric, value, detail]) => ({
          report_date: reportDate,
          metric,
          value,
          detail,
          source: PROJECTION_SOURCE,
          pulled_at: input.pulledAt,
          run_id: run.id,
          // seo-yolo's request_id is its collection-receipt id. A scheduled
          // crawl is our own compute with no provider request behind it.
          request_id: null,
        })),
    },
  };
}

// ============================================================================
// rank_check_runs -> keyword_rankings + aio_tracking
// ============================================================================

export type RankRunSource = {
  run: { id: string; startedAt: string; completedAt: string | null };
  config: { locationName: string | null; locationCode: number };
  snapshots: {
    id: number;
    keyword: string;
    device: "desktop" | "mobile";
    position: number | null;
    url: string | null;
    aioPresent: boolean | null;
    aioClientCited: boolean | null;
    aioCitationPosition: number | null;
  }[];
  features: {
    snapshotId: number;
    featureType: string;
    rankAbsolute: number | null;
    clientPresent: boolean;
  }[];
};

export function buildRankProjection(input: {
  source: RankRunSource;
  pulledAt: string;
}): ProjectionResult {
  const { run, config, snapshots, features } = input.source;
  const reportDate = observationDate(run.completedAt ?? run.startedAt);
  const location = config.locationName ?? String(config.locationCode);
  // seo-yolo's schema has no device dimension: both tables key on keyword only,
  // so one snapshot per keyword is projected and desktop wins when a run checked
  // both. Mobile-only configs project their mobile snapshot.
  const chosen = preferDesktopPerKeyword(snapshots);
  const featuresBySnapshot = groupBy(features, (feature) => feature.snapshotId);

  const keywordRankings: BqInputRow[] = [];
  const aioTracking: BqInputRow[] = [];

  for (const snapshot of chosen) {
    keywordRankings.push({
      date: reportDate,
      keyword: snapshot.keyword,
      location,
      surface: "organic",
      rank: snapshot.position,
      url: snapshot.url,
      // seo-yolo reads the top ten organic domains straight off the stored SERP
      // payload; open-seo keeps only the tracked domain's own snapshot, so there
      // is nothing to list here.
      top_domains: null,
      source: PROJECTION_SOURCE,
      pulled_at: input.pulledAt,
      run_id: run.id,
      // Per-keyword provider task ids live in rank_check_tasks, but a row here
      // is per keyword+surface and a run has one task per keyword+device.
      request_id: null,
    });

    // The `surface` merge-key column carries the SERP block a rank was measured
    // in, so a feature the tracked domain appeared in becomes its own row
    // alongside the organic one. Features without the client have no rank for us
    // and are skipped.
    for (const feature of featuresBySnapshot.get(snapshot.id) ?? []) {
      if (!feature.clientPresent) continue;
      keywordRankings.push({
        date: reportDate,
        keyword: snapshot.keyword,
        location,
        surface: feature.featureType,
        rank: feature.rankAbsolute,
        url: null,
        top_domains: null,
        source: PROJECTION_SOURCE,
        pulled_at: input.pulledAt,
        run_id: run.id,
        request_id: null,
      });
    }

    // A snapshot with aio_present null was never evaluated for AI Overview
    // (the config opt-in is off), which is not the same as "absent".
    if (snapshot.aioPresent === null) continue;
    aioTracking.push({
      report_date: reportDate,
      keyword: snapshot.keyword,
      // seo-yolo reads keyword tiers from its own aio_keywords panel; open-seo
      // has no tiering concept for tracked keywords.
      tier: null,
      aio_present: snapshot.aioPresent,
      client_domain_cited: snapshot.aioClientCited ?? false,
      citation_position: snapshot.aioCitationPosition,
      // Both derived from the overview's text in seo-yolo. open-seo stores the
      // citation verdict but not the overview body, so neither the brand-mention
      // check nor the snippet can be reproduced.
      client_name_mentioned: null,
      cited_domains: null,
      aio_text_snippet: null,
      organic_rank: snapshot.position,
      source: PROJECTION_SOURCE,
      pulled_at: input.pulledAt,
      run_id: run.id,
      request_id: null,
    });
  }

  return {
    reportDate,
    rowsByTable: {
      keyword_rankings: keywordRankings,
      aio_tracking: aioTracking,
    },
  };
}

// ============================================================================
// maps_grid_runs -> maps_rankings (cell grain)
// ============================================================================

export type MapsRunSource = {
  run: { id: string; startedAt: string; completedAt: string | null };
  /** The grid config's location slug, which is seo-yolo's `office`. */
  locationSlug: string;
  cells: {
    id: number;
    keyword: string;
    lat: number;
    lng: number;
    clientRank: number | null;
    providerTaskId: string | null;
  }[];
  cellResults: {
    cellId: number;
    name: string;
    rank: number;
    rating: number | null;
    url: string | null;
    isClient: boolean;
  }[];
};

export function buildMapsProjection(input: {
  source: MapsRunSource;
  pulledAt: string;
}): ProjectionResult {
  const { run, cells, cellResults, locationSlug } = input.source;
  const reportDate = observationDate(run.completedAt ?? run.startedAt);
  const resultsByCell = groupBy(cellResults, (result) => result.cellId);

  return {
    reportDate,
    rowsByTable: {
      maps_rankings: cells.map((cell) => {
        const ranked = sort(
          resultsByCell.get(cell.id) ?? [],
          (a, b) => a.rank - b.rank,
        );
        const clientResult = ranked.find((result) => result.isClient) ?? null;
        return {
          report_date: reportDate,
          keyword: cell.keyword,
          office: locationSlug,
          rank_type: "maps",
          // `is_client` is resolved at collection time from the location's match
          // terms, so the cell's stored rank and the matched result agree.
          position: cell.clientRank ?? clientResult?.rank ?? null,
          ranked_url: clientResult?.url ?? null,
          grid_lat: cell.lat,
          grid_lng: cell.lng,
          competitors: ranked
            .filter((result) => !result.isClient)
            .slice(0, MAPS_COMPETITOR_LIMIT)
            .map((result) => ({
              name: result.name,
              position: result.rank,
              rating: result.rating,
            })),
          source: PROJECTION_SOURCE,
          pulled_at: input.pulledAt,
          run_id: run.id,
          // The closest analogue to seo-yolo's collection receipt id: this cell
          // is exactly one provider request.
          request_id: cell.providerTaskId,
        };
      }),
    },
  };
}

// ============================================================================
// gbp_snapshots -> gbp_snapshots (one row per location per day)
// ============================================================================

export type GbpSnapshotSource = {
  snapshot: {
    id: string;
    runDate: string;
    name: string | null;
    placeId: string | null;
    cid: string | null;
    primaryCategory: string | null;
    rating: number | null;
    reviewsCount: number | null;
    isClaimed: boolean | null;
    address: string | null;
    phone: string | null;
    website: string | null;
    photosCount: number | null;
    providerTaskId: string | null;
  };
  /** seo-yolo's `office`; falls back to the location id when the row is gone. */
  locationSlug: string;
  locationName: string | null;
  /** Review count at the location's previous snapshot, for the velocity delta. */
  previousReviewsCount: number | null;
  attributes: { key: string; value: string }[];
};

export function buildGbpProjection(input: {
  source: GbpSnapshotSource;
  pulledAt: string;
}): ProjectionResult {
  const { snapshot, previousReviewsCount, attributes } = input.source;
  // A snapshot's run_date IS the observation date, so unlike the run kinds there
  // is no completion timestamp to derive it from.
  const reportDate = snapshot.runDate;
  // Attribute groups as one object per snapshot ({ service_options: [...] }), so a
  // query can address a group by name instead of unnesting rows.
  const attributesByKey: Record<string, string[]> = {};
  for (const attribute of attributes) {
    (attributesByKey[attribute.key] ??= []).push(attribute.value);
  }

  return {
    reportDate,
    rowsByTable: {
      gbp_snapshots: [
        {
          report_date: reportDate,
          location_slug: input.source.locationSlug,
          location_name: input.source.locationName,
          // The name Google shows, which is not always the name we filed the
          // location under — a rename is one of the things this table catches.
          profile_name: snapshot.name,
          place_id: snapshot.placeId,
          cid: snapshot.cid,
          primary_category: snapshot.primaryCategory,
          rating: snapshot.rating,
          reviews_count: snapshot.reviewsCount,
          // Null rather than 0 when either side is unmeasured: "no previous
          // snapshot" must not chart as "gained no reviews".
          reviews_count_delta:
            snapshot.reviewsCount !== null && previousReviewsCount !== null
              ? snapshot.reviewsCount - previousReviewsCount
              : null,
          is_claimed: snapshot.isClaimed,
          address: snapshot.address,
          phone: snapshot.phone,
          website: snapshot.website,
          photos_count: snapshot.photosCount,
          attributes: attributesByKey,
          source: PROJECTION_SOURCE,
          pulled_at: input.pulledAt,
          run_id: snapshot.id,
          // The closest analogue to seo-yolo's collection receipt id we hold: the
          // profile read is a live call with no task id, so this is the queued
          // reviews task the same capture posted.
          request_id: snapshot.providerTaskId,
        },
      ],
    },
  };
}

// ============================================================================
// observations (seo_yolo_internal)
// ============================================================================

/**
 * The one internal observation every projected run writes: how many client rows
 * it produced. Same id scheme as seo-yolo (`sha256:` over canonical JSON of run
 * id, metric key and dimensions), so a replayed projection merges onto the row
 * it already wrote instead of duplicating it.
 */
export async function buildProjectionObservation(input: {
  clientKey: string;
  runKind: ProjectionRunKind;
  runId: string;
  projectId: string;
  reportDate: string;
  rowCount: number;
  pulledAt: string;
}): Promise<BqInputRow> {
  const metricKey = "projected_rows";
  const dimensions = {
    project_id: input.projectId,
    run_kind: input.runKind,
  };
  return {
    observation_id: await digest({
      run_id: input.runId,
      metric_key: metricKey,
      dimensions,
    }),
    run_id: input.runId,
    client_key: input.clientKey,
    // seo-yolo groups an observation into a wider pipeline occurrence; open-seo
    // projects one run at a time and has no enclosing occurrence.
    occurrence_key: null,
    source_family: SOURCE_FAMILY[input.runKind],
    observed_date: input.reportDate,
    metric_key: metricKey,
    dimensions,
    value_numeric: input.rowCount,
    value_text: null,
    unit: "rows",
    source_record_id: input.runId,
    evidence_id: null,
    provenance: {
      projection: PROJECTION_VERSION,
      source: SOURCE_FAMILY[input.runKind],
    },
    observed_at: `${input.reportDate}T00:00:00+00:00`,
    ingested_at: input.pulledAt,
  };
}

// ============================================================================
// helpers
// ============================================================================

/**
 * SQLite writes `current_timestamp` as "YYYY-MM-DD HH:MM:SS" and Postgres as
 * ISO-8601, so the date is the first ten characters either way.
 */
function observationDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function preferDesktopPerKeyword<
  T extends { keyword: string; device: "desktop" | "mobile" },
>(snapshots: T[]): T[] {
  const byKeyword = new Map<string, T>();
  for (const snapshot of snapshots) {
    const existing = byKeyword.get(snapshot.keyword);
    if (!existing || snapshot.device === "desktop") {
      byKeyword.set(snapshot.keyword, snapshot);
    }
  }
  return [...byKeyword.values()];
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/** seo-yolo's `digest`: sha256 over canonical (key-sorted) JSON, hex, prefixed. */
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  const hex = [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = sort(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Renders a seeding plan as a SQL file instead of executing it.
 *
 * The local seed path talks to D1 through `getPlatformProxy`, which only ever
 * reaches the local miniflare database. Production is a remote D1, so the same
 * plan is emitted as a file of statements to hand to
 * `wrangler d1 execute DB --remote --file=...`.
 *
 * Two properties make that file safe to run more than once:
 *
 * - Every statement is `INSERT INTO ... SELECT ... WHERE NOT EXISTS (...)`
 *   guarded on the natural unique key the schema already enforces, so a second
 *   run inserts nothing and never updates a row a human has since edited.
 * - Primary keys are v5 UUIDs derived from that same natural key, so re-emitting
 *   the file produces byte-identical ids and a child row always points at the
 *   parent id the previous run wrote.
 *
 * Literals stay dialect-neutral (`true`/`false` rather than `1`/`0`, ISO strings
 * for the text timestamp columns) so the file loads on both D1/SQLite and the
 * Postgres schema.
 */

import { createHash } from "node:crypto";
import type { ClientSeedPlan } from "./seed-schemas";

/**
 * Namespace for every id in the emitted SQL. It is a constant on purpose:
 * changing it re-keys every row and turns a rerun into a duplicate insert.
 */
const SEED_UUID_NAMESPACE = "fe1068dd-469f-4201-b05d-c539a3ce947e";

/** RFC 4122 v5 (SHA-1) UUID, so an id is a pure function of its natural key. */
export function seedUuid(naturalKey: string): string {
  const namespaceBytes = Buffer.from(
    SEED_UUID_NAMESPACE.replaceAll("-", ""),
    "hex",
  );
  const bytes = createHash("sha1")
    .update(namespaceBytes)
    .update(Buffer.from(naturalKey, "utf8"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

type SeedSqlValue = string | number | boolean | null;

interface SeedRow {
  table: string;
  /** Column → value, in the order the INSERT lists them. */
  values: Record<string, SeedSqlValue>;
  /**
   * The natural unique key. A NULL here emits `col IS NULL`, which is what
   * splits a national rank config (no location_name) from a local one.
   */
  match: Record<string, SeedSqlValue>;
}

export function sqlLiteral(value: SeedSqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot emit non-finite number: ${value}`);
    }
    return String(value);
  }
  if (value.includes("\0")) {
    throw new Error("Cannot emit a text value containing a NUL byte");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** One insert-if-missing statement, terminated with a semicolon. */
function renderSeedRow(row: SeedRow): string {
  const columns = Object.keys(row.values);
  const guard = Object.entries(row.match)
    .map(([column, value]) =>
      value === null ? `${column} IS NULL` : `${column} = ${sqlLiteral(value)}`,
    )
    .join(" AND ");
  return [
    `INSERT INTO ${row.table} (${columns.join(", ")})`,
    `SELECT ${columns.map((column) => sqlLiteral(row.values[column])).join(", ")}`,
    `WHERE NOT EXISTS (SELECT 1 FROM ${row.table} WHERE ${guard});`,
  ].join("\n");
}

/**
 * The plan as insert-if-missing rows, parents before children: a project's
 * BigQuery target and audit schedule, then each maps location with its match
 * terms, grid config and grid keywords, then the rank config and its keywords.
 */
export function buildSeedRows(plans: ClientSeedPlan[]): SeedRow[] {
  const rows: SeedRow[] = [];

  for (const plan of plans) {
    const { projectId } = plan;

    rows.push({
      table: "project_bigquery_targets",
      values: {
        project_id: projectId,
        client_key: plan.bigqueryTarget.clientKey,
        dataset: plan.bigqueryTarget.dataset,
        gsc_export_dataset: plan.bigqueryTarget.gscExportDataset,
      },
      match: { project_id: projectId },
    });

    const schedule = plan.auditSchedule;
    rows.push({
      table: "audit_schedules",
      values: {
        id: seedUuid(`audit_schedules:${projectId}`),
        project_id: projectId,
        start_url: schedule.startUrl,
        is_active: schedule.isActive,
        quick_enabled: schedule.quickEnabled,
        quick_max_pages: schedule.quickMaxPages,
        quick_hour_utc: schedule.quickHourUtc,
        next_quick_at: schedule.nextQuickAt,
        deep_enabled: schedule.deepEnabled,
        deep_max_pages: schedule.deepMaxPages,
        deep_dow_utc: schedule.deepDowUtc,
        deep_hour_utc: schedule.deepHourUtc,
        deep_lighthouse: schedule.deepLighthouse,
        next_deep_at: schedule.nextDeepAt,
      },
      match: { project_id: projectId },
    });

    for (const location of plan.maps?.locations ?? []) {
      const locationId = seedUuid(
        `maps_grid_locations:${projectId}:${location.slug}`,
      );
      rows.push({
        table: "maps_grid_locations",
        values: {
          id: locationId,
          project_id: projectId,
          name: location.name,
          slug: location.slug,
          lat: location.lat,
          lng: location.lng,
          radius_miles: location.radiusMiles,
          brand_name: location.brandName,
          domain: location.domain,
          phone: location.phone,
          street: location.street,
          postal_code: location.postalCode,
          place_id: location.placeId,
          location_url: location.locationUrl,
        },
        match: { project_id: projectId, slug: location.slug },
      });

      for (const term of location.matchTerms) {
        // Integer autoincrement id, so the row carries no generated key.
        rows.push({
          table: "maps_grid_location_match_terms",
          values: { location_id: locationId, term },
          match: { location_id: locationId, term },
        });
      }

      const configId = seedUuid(
        `maps_grid_configs:${projectId}:${location.slug}`,
      );
      rows.push({
        table: "maps_grid_configs",
        values: {
          id: configId,
          project_id: projectId,
          location_id: locationId,
          grid_size: location.config.gridSize,
          radius_miles: location.config.radiusMiles,
          zoom: location.config.zoom,
          language_code: location.config.languageCode,
          device: location.config.device,
          depth: location.config.depth,
          schedule_interval: location.config.scheduleInterval,
          is_active: location.config.isActive,
          next_run_at: location.config.nextRunAt,
        },
        // No unique index on (project_id, location_id) — one config per
        // location is a seeder invariant, and the guard enforces it here.
        match: { project_id: projectId, location_id: locationId },
      });

      for (const keyword of location.keywords) {
        rows.push({
          table: "maps_grid_keywords",
          values: {
            id: seedUuid(`maps_grid_keywords:${configId}:${keyword}`),
            config_id: configId,
            keyword,
          },
          match: { config_id: configId, keyword },
        });
      }
    }

    const rank = plan.rankTracking;
    // Matches the schema's partial uniques: location_name NULL is the
    // national config, a value is the local one.
    const configKey = `rank_tracking_configs:${projectId}:${rank.domain}:${rank.locationCode}:${rank.locationName ?? ""}`;
    const configId = seedUuid(configKey);
    rows.push({
      table: "rank_tracking_configs",
      values: {
        id: configId,
        project_id: projectId,
        domain: rank.domain,
        location_code: rank.locationCode,
        language_code: rank.languageCode,
        devices: rank.devices,
        serp_depth: rank.serpDepth,
        schedule_interval: rank.scheduleInterval,
        location_name: rank.locationName,
        track_competitors: rank.trackCompetitors,
        track_ai_overview: rank.trackAiOverview,
        is_active: rank.isActive,
        next_check_at: rank.nextCheckAt,
      },
      match: {
        project_id: projectId,
        domain: rank.domain,
        location_code: rank.locationCode,
        location_name: rank.locationName,
      },
    });

    for (const keyword of rank.keywords) {
      rows.push({
        table: "rank_tracking_keywords",
        values: {
          id: seedUuid(`rank_tracking_keywords:${configId}:${keyword}`),
          config_id: configId,
          keyword,
        },
        match: { config_id: configId, keyword },
      });
    }
  }

  return rows;
}

/** The whole plan as one runnable file. */
export function renderSeedSql(plans: ClientSeedPlan[]): string {
  const rows = buildSeedRows(plans);
  const header = [
    "-- Generated by scripts/seed-monitoring.ts --sql-out",
    "-- Idempotent: every statement is guarded on its natural unique key and",
    "-- every id is a v5 UUID derived from that key, so rerunning is a no-op.",
    `-- Clients: ${plans.map((plan) => plan.clientKey).join(", ") || "none"}`,
    `-- Statements: ${rows.length}`,
  ].join("\n");
  return `${[header, ...rows.map(renderSeedRow)].join("\n\n")}\n`;
}

/** Statement counts by table, for the run summary. */
export function seedRowCountsByTable(rows: SeedRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.table] = (counts[row.table] ?? 0) + 1;
  }
  return counts;
}

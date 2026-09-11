import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects, rankCheckRuns, rankSnapshots } from "./app.schema";
import { audits } from "./audit.schema";

// Lifecycle of one provider (DataForSEO) task, shared by the rank-check ledger
// and the maps-grid cells: rows start "reserved" before submission, and
// "submission_unknown" is the state a crashed submit leaves behind for the
// reconciler to resolve.
const PROVIDER_TASK_STATUS = [
  "reserved",
  "submitted",
  "submission_unknown",
  "retrieved",
  "terminal_empty",
  "failed",
] as const;

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

// Cost columns are SQLite `integer` / Postgres `bigint({ mode: "number" })`,
// matching the backlink_snapshots precedent — both resolve to Drizzle
// dataType "number", so schema parity holds.
const microsColumn = (name: string) => bigint(name, { mode: "number" });

// ============================================================================
// Scheduled crawls
// ============================================================================

// One schedule per project. Two independent cadences share the row: a cheap
// "quick" crawl that runs daily at a fixed UTC hour, and a "deep" crawl that
// runs weekly on a fixed weekday and can add Lighthouse. `next_quick_at` /
// `next_deep_at` are the claim cursors the scheduler polls, which is why each
// is indexed together with `is_active`.
export const auditSchedules = pgTable(
  "audit_schedules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    startUrl: text("start_url").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    quickEnabled: boolean("quick_enabled").notNull().default(true),
    quickMaxPages: integer("quick_max_pages").notNull().default(100),
    quickHourUtc: integer("quick_hour_utc").notNull().default(3),
    nextQuickAt: timestampColumn("next_quick_at"),
    deepEnabled: boolean("deep_enabled").notNull().default(true),
    deepMaxPages: integer("deep_max_pages").notNull().default(500),
    // 0 = Sunday, matching JS `Date#getUTCDay`.
    deepDowUtc: integer("deep_dow_utc").notNull().default(1),
    deepHourUtc: integer("deep_hour_utc").notNull().default(4),
    deepLighthouse: boolean("deep_lighthouse").notNull().default(false),
    nextDeepAt: timestampColumn("next_deep_at"),
    lastSkipReason: text("last_skip_reason"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
    updatedAt: timestampColumn("updated_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("audit_schedules_project_idx").on(table.projectId),
    index("audit_schedules_quick_due_idx").on(
      table.isActive,
      table.nextQuickAt,
    ),
    index("audit_schedules_deep_due_idx").on(table.isActive, table.nextDeepAt),
  ],
);

// One row per scheduled attempt, including the ones that never crawled
// (status "skipped" with a reason). `audit_id` is ON DELETE SET NULL so the
// monitoring history — health score, deltas, counts — survives the audit and
// its pages being pruned.
export const auditScheduleRuns = pgTable(
  "audit_schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => auditSchedules.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    auditId: text("audit_id").references(() => audits.id, {
      onDelete: "set null",
    }),
    cadence: text("cadence", { enum: ["quick", "deep"] }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed", "skipped"],
    })
      .notNull()
      .default("pending"),
    triggeredAt: timestampColumn("triggered_at").notNull().default(isoNow),
    completedAt: timestampColumn("completed_at"),
    skipReason: text("skip_reason"),
    pagesCrawled: integer("pages_crawled"),
    pagesWithErrors: integer("pages_with_errors"),
    pagesWithWarnings: integer("pages_with_warnings"),
    pagesWithNotices: integer("pages_with_notices"),
    pagesBlocked: integer("pages_blocked"),
    healthScore: integer("health_score"),
    healthScoreDelta: integer("health_score_delta"),
    truncated: boolean("truncated").notNull().default(false),
    rawR2Prefix: text("raw_r2_prefix"),
  },
  (table) => [
    index("audit_schedule_runs_schedule_idx").on(
      table.scheduleId,
      table.triggeredAt,
    ),
  ],
);

// Per-run issue rollup, normalized instead of a JSON blob on the run so the
// trend views can aggregate one issue type across runs in SQL.
export const auditRunIssueCounts = pgTable(
  "audit_run_issue_counts",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => auditScheduleRuns.id, { onDelete: "cascade" }),
    issueType: text("issue_type").notNull(),
    severity: text("severity").notNull(),
    pages: integer("pages").notNull(),
  },
  (table) => [
    // Leftmost column is runId, so this also serves per-run lookups.
    uniqueIndex("audit_run_issue_counts_run_type_idx").on(
      table.runId,
      table.issueType,
    ),
  ],
);

// ============================================================================
// Rank tracking: task ledger + SERP feature detail
// ============================================================================

// One row per (run, keyword, device) DataForSEO task. Rows are inserted in
// state "reserved" BEFORE submission so a crash between submit and response
// still leaves a record to reconcile, and the reserved vs actual cost split is
// what lets billing settle an estimate against the provider's real charge.
export const rankCheckTasks = pgTable(
  "rank_check_tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => rankCheckRuns.id, { onDelete: "cascade" }),
    // No FK to rankTrackingKeywords — same convention as rank_snapshots: the
    // task ledger outlives a keyword being removed from tracking.
    trackingKeywordId: text("tracking_keyword_id").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    providerTaskId: text("provider_task_id"),
    tag: text("tag").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status", { enum: PROVIDER_TASK_STATUS })
      .notNull()
      .default("reserved"),
    reservedCostMicros: microsColumn("reserved_cost_micros"),
    actualCostMicros: microsColumn("actual_cost_micros"),
    providerStatusCode: integer("provider_status_code"),
    providerStatusMessage: text("provider_status_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    submittedAt: timestampColumn("submitted_at"),
    retrievedAt: timestampColumn("retrieved_at"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("rank_check_tasks_run_keyword_device_idx").on(
      table.runId,
      table.trackingKeywordId,
      table.device,
    ),
    index("rank_check_tasks_status_submitted_idx").on(
      table.status,
      table.submittedAt,
    ),
    // Partial unique: a provider task id must map to exactly one ledger row,
    // but rows exist before submission with a NULL id.
    uniqueIndex("rank_check_tasks_provider_task_idx")
      .on(table.providerTaskId)
      .where(sql`${table.providerTaskId} IS NOT NULL`),
  ],
);

// SERP features observed for one snapshot, one row per feature type, replacing
// the JSON array in rank_snapshots.serp_features for anything queryable
// (which feature, where it sat, whether the tracked domain appeared in it).
export const rankSnapshotFeatures = pgTable(
  "rank_snapshot_features",
  {
    id: serial("id").primaryKey(),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => rankSnapshots.id, { onDelete: "cascade" }),
    featureType: text("feature_type").notNull(),
    rankAbsolute: integer("rank_absolute"),
    clientPresent: boolean("client_present").notNull().default(false),
  },
  (table) => [
    index("rank_snapshot_features_snapshot_idx").on(table.snapshotId),
  ],
);

// ============================================================================
// Maps grid (local pack geo-grid)
// ============================================================================

// A physical business location a grid is centred on. Held separately from
// projects because one project can track several offices, and the grid's match
// terms (below) are per-location.
export const mapsGridLocations = pgTable(
  "maps_grid_locations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    radiusMiles: real("radius_miles").notNull(),
    brandName: text("brand_name").notNull(),
    domain: text("domain").notNull(),
    phone: text("phone"),
    street: text("street"),
    postalCode: text("postal_code"),
    placeId: text("place_id"),
    locationUrl: text("location_url"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("maps_grid_locations_project_slug_idx").on(
      table.projectId,
      table.slug,
    ),
  ],
);

// Extra strings that identify the client in a maps result (DBA names,
// misspellings, legacy brands). Normalized rather than a delimited text column
// so matching can join instead of parsing.
export const mapsGridLocationMatchTerms = pgTable(
  "maps_grid_location_match_terms",
  {
    id: serial("id").primaryKey(),
    locationId: text("location_id")
      .notNull()
      .references(() => mapsGridLocations.id, { onDelete: "cascade" }),
    term: text("term").notNull(),
  },
  (table) => [
    uniqueIndex("maps_grid_location_match_terms_location_term_idx").on(
      table.locationId,
      table.term,
    ),
  ],
);

// Grid shape + cadence for one location. `next_run_at` with `is_active` is the
// scheduler's claim cursor, same shape as rank_tracking_configs.
export const mapsGridConfigs = pgTable(
  "maps_grid_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references(() => mapsGridLocations.id, { onDelete: "cascade" }),
    gridSize: integer("grid_size").notNull().default(7),
    radiusMiles: real("radius_miles").notNull().default(5),
    zoom: text("zoom").notNull().default("13z"),
    languageCode: text("language_code").notNull().default("en"),
    device: text("device", { enum: ["mobile", "desktop"] })
      .notNull()
      .default("mobile"),
    depth: integer("depth"),
    scheduleInterval: text("schedule_interval", {
      enum: ["weekly", "monthly", "manual"],
    })
      .notNull()
      .default("weekly"),
    isActive: boolean("is_active").notNull().default(true),
    lastRunAt: timestampColumn("last_run_at"),
    nextRunAt: timestampColumn("next_run_at"),
    lastSkipReason: text("last_skip_reason"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("maps_grid_configs_due_idx").on(table.isActive, table.nextRunAt),
  ],
);

// Keywords the grid is run for. One row per keyword per config; a run fans out
// to grid_size² cells per keyword.
export const mapsGridKeywords = pgTable(
  "maps_grid_keywords",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => mapsGridConfigs.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    category: text("category"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("maps_grid_keywords_config_keyword_idx").on(
      table.configId,
      table.keyword,
    ),
  ],
);

// One row per grid execution. The partial unique index on
// `config_id WHERE status IN ('pending','running')` enforces at most one
// in-flight run per config in the DB, exactly as rank_check_runs does: a
// duplicate trigger fails on the unique constraint instead of double-spending.
export const mapsGridRuns = pgTable(
  "maps_grid_runs",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => mapsGridConfigs.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    trigger: text("trigger", { enum: ["manual", "scheduled"] }).notNull(),
    cellsTotal: integer("cells_total").notNull(),
    cellsCollected: integer("cells_collected").notNull().default(0),
    authorizedCostMicros: microsColumn("authorized_cost_micros"),
    spentCostMicros: microsColumn("spent_cost_micros"),
    costStatus: text("cost_status", { enum: ["known", "known_minimum"] }),
    errorMessage: text("error_message"),
    startedAt: timestampColumn("started_at").notNull().default(isoNow),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    index("maps_grid_runs_config_idx").on(table.configId, table.startedAt),
    uniqueIndex("maps_grid_runs_one_active_per_config_idx")
      .on(table.configId)
      .where(sql`${table.status} IN ('pending', 'running')`),
  ],
);

// One cell = one (keyword, grid point) provider task. keyword_id and
// location_id carry no FK, same convention as rank_snapshots: the geo history
// stays readable after a keyword or location is deleted, and the denormalized
// keyword text keeps those rows self-describing.
export const mapsGridCells = pgTable(
  "maps_grid_cells",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => mapsGridRuns.id, { onDelete: "cascade" }),
    keywordId: text("keyword_id").notNull(),
    keyword: text("keyword").notNull(),
    locationId: text("location_id").notNull(),
    gridRow: integer("grid_row").notNull(),
    gridCol: integer("grid_col").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    direction: text("direction").notNull(),
    distanceMiles: real("distance_miles").notNull(),
    providerTaskId: text("provider_task_id"),
    tag: text("tag").notNull(),
    taskStatus: text("task_status", { enum: PROVIDER_TASK_STATUS })
      .notNull()
      .default("reserved"),
    providerStatusCode: integer("provider_status_code"),
    reservedCostMicros: microsColumn("reserved_cost_micros"),
    actualCostMicros: microsColumn("actual_cost_micros"),
    submittedAt: timestampColumn("submitted_at"),
    retrievedAt: timestampColumn("retrieved_at"),
    clientRank: integer("client_rank"),
  },
  (table) => [
    // No standalone index on runId — the unique index has it as its leftmost
    // column, so it already serves per-run lookups.
    uniqueIndex("maps_grid_cells_run_keyword_point_idx").on(
      table.runId,
      table.keywordId,
      table.gridRow,
      table.gridCol,
    ),
  ],
);

// The ranked maps results returned for one cell. `is_client` is resolved at
// write time from the location's match terms so the grid heatmap reads one
// column instead of re-matching names.
export const mapsGridCellResults = pgTable(
  "maps_grid_cell_results",
  {
    id: serial("id").primaryKey(),
    cellId: integer("cell_id")
      .notNull()
      .references(() => mapsGridCells.id, { onDelete: "cascade" }),
    placeId: text("place_id"),
    cid: text("cid"),
    name: text("name").notNull(),
    rank: integer("rank").notNull(),
    rating: real("rating"),
    reviewsCount: integer("reviews_count"),
    url: text("url"),
    isClient: boolean("is_client").notNull().default(false),
    matchScore: integer("match_score"),
  },
  (table) => [
    index("maps_grid_cell_results_cell_rank_idx").on(table.cellId, table.rank),
  ],
);

// ============================================================================
// BigQuery targets
// ============================================================================

// Where a project's exported monitoring/GSC data lands. One row per project;
// `client_key` is the stable external identifier used in dataset object names,
// so it is unique across projects.
export const projectBigqueryTargets = pgTable(
  "project_bigquery_targets",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    clientKey: text("client_key").notNull(),
    dataset: text("dataset").notNull(),
    gscExportDataset: text("gsc_export_dataset"),
    createdAt: timestampColumn("created_at").notNull().default(isoNow),
  },
  (table) => [
    uniqueIndex("project_bigquery_targets_client_key_idx").on(table.clientKey),
  ],
);

// ============================================================================
// BigQuery projection ledger
// ============================================================================

// Which run table a projection came from. `run_id` carries no FK because the
// three kinds live in three different tables; the run's own cascade from
// `projects` plus this row's cascade keep the ledger from outliving its project.
const PROJECTION_RUN_KINDS = [
  "audit_schedule_run",
  "rank_check_run",
  "maps_grid_run",
] as const;

// One row per (run, BigQuery table) projection attempt. `error` null means the
// MERGE succeeded, so the cron's "what still needs projecting" query is a join
// against the success rows rather than a status column, and a failed attempt is
// retried on the next tick by being overwritten in place.
export const bigqueryProjections = pgTable(
  "bigquery_projections",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runKind: text("run_kind", { enum: PROJECTION_RUN_KINDS }).notNull(),
    runId: text("run_id").notNull(),
    // "table" and "rows" are reserved words in Postgres; Drizzle quotes every
    // identifier it emits, so the column names still match seo-yolo's ledger.
    tableName: text("table").notNull(),
    dataset: text("dataset").notNull(),
    rows: integer("rows").notNull(),
    projectedAt: timestampColumn("projected_at").notNull().default(isoNow),
    error: text("error"),
  },
  (table) => [
    uniqueIndex("bigquery_projections_run_table_idx").on(
      table.runKind,
      table.runId,
      table.tableName,
    ),
    index("bigquery_projections_project_idx").on(
      table.projectId,
      table.projectedAt,
    ),
  ],
);

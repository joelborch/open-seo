/* eslint-disable max-lines -- one schema file per migration phase: scheduled
   crawls, the rank-check task ledger, the maps grid, and the BigQuery target +
   projection ledger all landed together and are read as one unit. */
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
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

// ============================================================================
// Scheduled crawls
// ============================================================================

// One schedule per project. Two independent cadences share the row: a cheap
// "quick" crawl that runs daily at a fixed UTC hour, and a "deep" crawl that
// runs weekly on a fixed weekday and can add Lighthouse. `next_quick_at` /
// `next_deep_at` are the claim cursors the scheduler polls, which is why each
// is indexed together with `is_active`.
export const auditSchedules = sqliteTable(
  "audit_schedules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    startUrl: text("start_url").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    quickEnabled: integer("quick_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    quickMaxPages: integer("quick_max_pages").notNull().default(100),
    quickHourUtc: integer("quick_hour_utc").notNull().default(3),
    nextQuickAt: text("next_quick_at"),
    deepEnabled: integer("deep_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    deepMaxPages: integer("deep_max_pages").notNull().default(500),
    // 0 = Sunday, matching JS `Date#getUTCDay`.
    deepDowUtc: integer("deep_dow_utc").notNull().default(1),
    deepHourUtc: integer("deep_hour_utc").notNull().default(4),
    deepLighthouse: integer("deep_lighthouse", { mode: "boolean" })
      .notNull()
      .default(false),
    nextDeepAt: text("next_deep_at"),
    lastSkipReason: text("last_skip_reason"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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
export const auditScheduleRuns = sqliteTable(
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
    triggeredAt: text("triggered_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
    skipReason: text("skip_reason"),
    pagesCrawled: integer("pages_crawled"),
    pagesWithErrors: integer("pages_with_errors"),
    pagesWithWarnings: integer("pages_with_warnings"),
    pagesWithNotices: integer("pages_with_notices"),
    pagesBlocked: integer("pages_blocked"),
    healthScore: integer("health_score"),
    healthScoreDelta: integer("health_score_delta"),
    truncated: integer("truncated", { mode: "boolean" })
      .notNull()
      .default(false),
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
export const auditRunIssueCounts = sqliteTable(
  "audit_run_issue_counts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
export const rankCheckTasks = sqliteTable(
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
    reservedCostMicros: integer("reserved_cost_micros"),
    actualCostMicros: integer("actual_cost_micros"),
    providerStatusCode: integer("provider_status_code"),
    providerStatusMessage: text("provider_status_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    submittedAt: text("submitted_at"),
    retrievedAt: text("retrieved_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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
export const rankSnapshotFeatures = sqliteTable(
  "rank_snapshot_features",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    snapshotId: integer("snapshot_id")
      .notNull()
      .references(() => rankSnapshots.id, { onDelete: "cascade" }),
    featureType: text("feature_type").notNull(),
    rankAbsolute: integer("rank_absolute"),
    clientPresent: integer("client_present", { mode: "boolean" })
      .notNull()
      .default(false),
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
export const mapsGridLocations = sqliteTable(
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
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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
export const mapsGridLocationMatchTerms = sqliteTable(
  "maps_grid_location_match_terms",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
export const mapsGridConfigs = sqliteTable(
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
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastRunAt: text("last_run_at"),
    nextRunAt: text("next_run_at"),
    lastSkipReason: text("last_skip_reason"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("maps_grid_configs_due_idx").on(table.isActive, table.nextRunAt),
  ],
);

// Keywords the grid is run for. One row per keyword per config; a run fans out
// to grid_size² cells per keyword.
export const mapsGridKeywords = sqliteTable(
  "maps_grid_keywords",
  {
    id: text("id").primaryKey(),
    configId: text("config_id")
      .notNull()
      .references(() => mapsGridConfigs.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    category: text("category"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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
export const mapsGridRuns = sqliteTable(
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
    authorizedCostMicros: integer("authorized_cost_micros"),
    spentCostMicros: integer("spent_cost_micros"),
    costStatus: text("cost_status", { enum: ["known", "known_minimum"] }),
    errorMessage: text("error_message"),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    completedAt: text("completed_at"),
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
export const mapsGridCells = sqliteTable(
  "maps_grid_cells",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    reservedCostMicros: integer("reserved_cost_micros"),
    actualCostMicros: integer("actual_cost_micros"),
    submittedAt: text("submitted_at"),
    retrievedAt: text("retrieved_at"),
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
export const mapsGridCellResults = sqliteTable(
  "maps_grid_cell_results",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    isClient: integer("is_client", { mode: "boolean" })
      .notNull()
      .default(false),
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
export const projectBigqueryTargets = sqliteTable(
  "project_bigquery_targets",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    clientKey: text("client_key").notNull(),
    dataset: text("dataset").notNull(),
    gscExportDataset: text("gsc_export_dataset"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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
export const bigqueryProjections = sqliteTable(
  "bigquery_projections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    projectedAt: text("projected_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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

CREATE TABLE "audit_run_issue_counts" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"issue_type" text NOT NULL,
	"severity" text NOT NULL,
	"pages" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"project_id" text NOT NULL,
	"audit_id" text,
	"cadence" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"triggered_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"completed_at" text,
	"skip_reason" text,
	"pages_crawled" integer,
	"pages_with_errors" integer,
	"pages_with_warnings" integer,
	"pages_with_notices" integer,
	"pages_blocked" integer,
	"health_score" integer,
	"health_score_delta" integer,
	"truncated" boolean DEFAULT false NOT NULL,
	"raw_r2_prefix" text
);
--> statement-breakpoint
CREATE TABLE "audit_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"start_url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"quick_enabled" boolean DEFAULT true NOT NULL,
	"quick_max_pages" integer DEFAULT 100 NOT NULL,
	"quick_hour_utc" integer DEFAULT 3 NOT NULL,
	"next_quick_at" text,
	"deep_enabled" boolean DEFAULT true NOT NULL,
	"deep_max_pages" integer DEFAULT 500 NOT NULL,
	"deep_dow_utc" integer DEFAULT 1 NOT NULL,
	"deep_hour_utc" integer DEFAULT 4 NOT NULL,
	"deep_lighthouse" boolean DEFAULT false NOT NULL,
	"next_deep_at" text,
	"last_skip_reason" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maps_grid_cell_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"cell_id" integer NOT NULL,
	"place_id" text,
	"cid" text,
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	"rating" real,
	"reviews_count" integer,
	"url" text,
	"is_client" boolean DEFAULT false NOT NULL,
	"match_score" integer
);
--> statement-breakpoint
CREATE TABLE "maps_grid_cells" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"keyword_id" text NOT NULL,
	"keyword" text NOT NULL,
	"location_id" text NOT NULL,
	"grid_row" integer NOT NULL,
	"grid_col" integer NOT NULL,
	"lat" real NOT NULL,
	"lng" real NOT NULL,
	"direction" text NOT NULL,
	"distance_miles" real NOT NULL,
	"provider_task_id" text,
	"tag" text NOT NULL,
	"task_status" text DEFAULT 'reserved' NOT NULL,
	"provider_status_code" integer,
	"reserved_cost_micros" bigint,
	"actual_cost_micros" bigint,
	"submitted_at" text,
	"retrieved_at" text,
	"client_rank" integer
);
--> statement-breakpoint
CREATE TABLE "maps_grid_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"location_id" text NOT NULL,
	"grid_size" integer DEFAULT 7 NOT NULL,
	"radius_miles" real DEFAULT 5 NOT NULL,
	"zoom" text DEFAULT '13z' NOT NULL,
	"language_code" text DEFAULT 'en' NOT NULL,
	"device" text DEFAULT 'mobile' NOT NULL,
	"depth" integer,
	"schedule_interval" text DEFAULT 'weekly' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" text,
	"next_run_at" text,
	"last_skip_reason" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maps_grid_keywords" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"keyword" text NOT NULL,
	"category" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maps_grid_location_match_terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"location_id" text NOT NULL,
	"term" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maps_grid_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"lat" real NOT NULL,
	"lng" real NOT NULL,
	"radius_miles" real NOT NULL,
	"brand_name" text NOT NULL,
	"domain" text NOT NULL,
	"phone" text,
	"street" text,
	"postal_code" text,
	"place_id" text,
	"location_url" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maps_grid_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger" text NOT NULL,
	"cells_total" integer NOT NULL,
	"cells_collected" integer DEFAULT 0 NOT NULL,
	"authorized_cost_micros" bigint,
	"spent_cost_micros" bigint,
	"cost_status" text,
	"error_message" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "project_bigquery_targets" (
	"project_id" text PRIMARY KEY NOT NULL,
	"client_key" text NOT NULL,
	"dataset" text NOT NULL,
	"gsc_export_dataset" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_check_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tracking_keyword_id" text NOT NULL,
	"device" text NOT NULL,
	"provider_task_id" text,
	"tag" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_cost_micros" bigint,
	"actual_cost_micros" bigint,
	"provider_status_code" integer,
	"provider_status_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"submitted_at" text,
	"retrieved_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_snapshot_features" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"feature_type" text NOT NULL,
	"rank_absolute" integer,
	"client_present" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rank_check_runs" ADD COLUMN "trigger" text;--> statement-breakpoint
ALTER TABLE "rank_check_runs" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "rank_check_runs" ADD COLUMN "authorized_cost_micros" bigint;--> statement-breakpoint
ALTER TABLE "rank_check_runs" ADD COLUMN "spent_cost_micros" bigint;--> statement-breakpoint
ALTER TABLE "rank_check_runs" ADD COLUMN "cost_status" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "rank_absolute" integer;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "local_pack_position" integer;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "aio_present" boolean;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "aio_client_cited" boolean;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "aio_citation_position" integer;--> statement-breakpoint
ALTER TABLE "rank_tracking_configs" ADD COLUMN "track_competitors" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_tracking_configs" ADD COLUMN "track_ai_overview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_run_issue_counts" ADD CONSTRAINT "audit_run_issue_counts_run_id_audit_schedule_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."audit_schedule_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_runs" ADD CONSTRAINT "audit_schedule_runs_schedule_id_audit_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."audit_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_runs" ADD CONSTRAINT "audit_schedule_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedule_runs" ADD CONSTRAINT "audit_schedule_runs_audit_id_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."audits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_schedules" ADD CONSTRAINT "audit_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_cell_results" ADD CONSTRAINT "maps_grid_cell_results_cell_id_maps_grid_cells_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."maps_grid_cells"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_cells" ADD CONSTRAINT "maps_grid_cells_run_id_maps_grid_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."maps_grid_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_configs" ADD CONSTRAINT "maps_grid_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_configs" ADD CONSTRAINT "maps_grid_configs_location_id_maps_grid_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."maps_grid_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_keywords" ADD CONSTRAINT "maps_grid_keywords_config_id_maps_grid_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."maps_grid_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_location_match_terms" ADD CONSTRAINT "maps_grid_location_match_terms_location_id_maps_grid_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."maps_grid_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_locations" ADD CONSTRAINT "maps_grid_locations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_runs" ADD CONSTRAINT "maps_grid_runs_config_id_maps_grid_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."maps_grid_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maps_grid_runs" ADD CONSTRAINT "maps_grid_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_bigquery_targets" ADD CONSTRAINT "project_bigquery_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_check_tasks" ADD CONSTRAINT "rank_check_tasks_run_id_rank_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_snapshot_features" ADD CONSTRAINT "rank_snapshot_features_snapshot_id_rank_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."rank_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_run_issue_counts_run_type_idx" ON "audit_run_issue_counts" USING btree ("run_id","issue_type");--> statement-breakpoint
CREATE INDEX "audit_schedule_runs_schedule_idx" ON "audit_schedule_runs" USING btree ("schedule_id","triggered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_schedules_project_idx" ON "audit_schedules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "audit_schedules_quick_due_idx" ON "audit_schedules" USING btree ("is_active","next_quick_at");--> statement-breakpoint
CREATE INDEX "audit_schedules_deep_due_idx" ON "audit_schedules" USING btree ("is_active","next_deep_at");--> statement-breakpoint
CREATE INDEX "maps_grid_cell_results_cell_rank_idx" ON "maps_grid_cell_results" USING btree ("cell_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "maps_grid_cells_run_keyword_point_idx" ON "maps_grid_cells" USING btree ("run_id","keyword_id","grid_row","grid_col");--> statement-breakpoint
CREATE INDEX "maps_grid_configs_due_idx" ON "maps_grid_configs" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maps_grid_keywords_config_keyword_idx" ON "maps_grid_keywords" USING btree ("config_id","keyword");--> statement-breakpoint
CREATE UNIQUE INDEX "maps_grid_location_match_terms_location_term_idx" ON "maps_grid_location_match_terms" USING btree ("location_id","term");--> statement-breakpoint
CREATE UNIQUE INDEX "maps_grid_locations_project_slug_idx" ON "maps_grid_locations" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX "maps_grid_runs_config_idx" ON "maps_grid_runs" USING btree ("config_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "maps_grid_runs_one_active_per_config_idx" ON "maps_grid_runs" USING btree ("config_id") WHERE "maps_grid_runs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "project_bigquery_targets_client_key_idx" ON "project_bigquery_targets" USING btree ("client_key");--> statement-breakpoint
CREATE UNIQUE INDEX "rank_check_tasks_run_keyword_device_idx" ON "rank_check_tasks" USING btree ("run_id","tracking_keyword_id","device");--> statement-breakpoint
CREATE INDEX "rank_check_tasks_status_submitted_idx" ON "rank_check_tasks" USING btree ("status","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rank_check_tasks_provider_task_idx" ON "rank_check_tasks" USING btree ("provider_task_id") WHERE "rank_check_tasks"."provider_task_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "rank_snapshot_features_snapshot_idx" ON "rank_snapshot_features" USING btree ("snapshot_id");
CREATE TABLE `audit_run_issue_counts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`issue_type` text NOT NULL,
	`severity` text NOT NULL,
	`pages` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `audit_schedule_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_run_issue_counts_run_type_idx` ON `audit_run_issue_counts` (`run_id`,`issue_type`);--> statement-breakpoint
CREATE TABLE `audit_schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`project_id` text NOT NULL,
	`audit_id` text,
	`cadence` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`triggered_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	`skip_reason` text,
	`pages_crawled` integer,
	`pages_with_errors` integer,
	`pages_with_warnings` integer,
	`pages_with_notices` integer,
	`pages_blocked` integer,
	`health_score` integer,
	`health_score_delta` integer,
	`truncated` integer DEFAULT false NOT NULL,
	`raw_r2_prefix` text,
	FOREIGN KEY (`schedule_id`) REFERENCES `audit_schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audit_id`) REFERENCES `audits`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_schedule_runs_schedule_idx` ON `audit_schedule_runs` (`schedule_id`,`triggered_at`);--> statement-breakpoint
CREATE TABLE `audit_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`start_url` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`quick_enabled` integer DEFAULT true NOT NULL,
	`quick_max_pages` integer DEFAULT 100 NOT NULL,
	`quick_hour_utc` integer DEFAULT 3 NOT NULL,
	`next_quick_at` text,
	`deep_enabled` integer DEFAULT true NOT NULL,
	`deep_max_pages` integer DEFAULT 500 NOT NULL,
	`deep_dow_utc` integer DEFAULT 1 NOT NULL,
	`deep_hour_utc` integer DEFAULT 4 NOT NULL,
	`deep_lighthouse` integer DEFAULT false NOT NULL,
	`next_deep_at` text,
	`last_skip_reason` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_schedules_project_idx` ON `audit_schedules` (`project_id`);--> statement-breakpoint
CREATE INDEX `audit_schedules_quick_due_idx` ON `audit_schedules` (`is_active`,`next_quick_at`);--> statement-breakpoint
CREATE INDEX `audit_schedules_deep_due_idx` ON `audit_schedules` (`is_active`,`next_deep_at`);--> statement-breakpoint
CREATE TABLE `maps_grid_cell_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cell_id` integer NOT NULL,
	`place_id` text,
	`cid` text,
	`name` text NOT NULL,
	`rank` integer NOT NULL,
	`rating` real,
	`reviews_count` integer,
	`url` text,
	`is_client` integer DEFAULT false NOT NULL,
	`match_score` integer,
	FOREIGN KEY (`cell_id`) REFERENCES `maps_grid_cells`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `maps_grid_cell_results_cell_rank_idx` ON `maps_grid_cell_results` (`cell_id`,`rank`);--> statement-breakpoint
CREATE TABLE `maps_grid_cells` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`keyword_id` text NOT NULL,
	`keyword` text NOT NULL,
	`location_id` text NOT NULL,
	`grid_row` integer NOT NULL,
	`grid_col` integer NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`direction` text NOT NULL,
	`distance_miles` real NOT NULL,
	`provider_task_id` text,
	`tag` text NOT NULL,
	`task_status` text DEFAULT 'reserved' NOT NULL,
	`provider_status_code` integer,
	`reserved_cost_micros` integer,
	`actual_cost_micros` integer,
	`submitted_at` text,
	`retrieved_at` text,
	`client_rank` integer,
	FOREIGN KEY (`run_id`) REFERENCES `maps_grid_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `maps_grid_cells_run_keyword_point_idx` ON `maps_grid_cells` (`run_id`,`keyword_id`,`grid_row`,`grid_col`);--> statement-breakpoint
CREATE TABLE `maps_grid_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`location_id` text NOT NULL,
	`grid_size` integer DEFAULT 7 NOT NULL,
	`radius_miles` real DEFAULT 5 NOT NULL,
	`zoom` text DEFAULT '13z' NOT NULL,
	`language_code` text DEFAULT 'en' NOT NULL,
	`device` text DEFAULT 'mobile' NOT NULL,
	`depth` integer,
	`schedule_interval` text DEFAULT 'weekly' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`last_skip_reason` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `maps_grid_locations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `maps_grid_configs_due_idx` ON `maps_grid_configs` (`is_active`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `maps_grid_keywords` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`keyword` text NOT NULL,
	`category` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`config_id`) REFERENCES `maps_grid_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `maps_grid_keywords_config_keyword_idx` ON `maps_grid_keywords` (`config_id`,`keyword`);--> statement-breakpoint
CREATE TABLE `maps_grid_location_match_terms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`location_id` text NOT NULL,
	`term` text NOT NULL,
	FOREIGN KEY (`location_id`) REFERENCES `maps_grid_locations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `maps_grid_location_match_terms_location_term_idx` ON `maps_grid_location_match_terms` (`location_id`,`term`);--> statement-breakpoint
CREATE TABLE `maps_grid_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`radius_miles` real NOT NULL,
	`brand_name` text NOT NULL,
	`domain` text NOT NULL,
	`phone` text,
	`street` text,
	`postal_code` text,
	`place_id` text,
	`location_url` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `maps_grid_locations_project_slug_idx` ON `maps_grid_locations` (`project_id`,`slug`);--> statement-breakpoint
CREATE TABLE `maps_grid_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`trigger` text NOT NULL,
	`cells_total` integer NOT NULL,
	`cells_collected` integer DEFAULT 0 NOT NULL,
	`authorized_cost_micros` integer,
	`spent_cost_micros` integer,
	`cost_status` text,
	`error_message` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`config_id`) REFERENCES `maps_grid_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `maps_grid_runs_config_idx` ON `maps_grid_runs` (`config_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `maps_grid_runs_one_active_per_config_idx` ON `maps_grid_runs` (`config_id`) WHERE "maps_grid_runs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE TABLE `project_bigquery_targets` (
	`project_id` text PRIMARY KEY NOT NULL,
	`client_key` text NOT NULL,
	`dataset` text NOT NULL,
	`gsc_export_dataset` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_bigquery_targets_client_key_idx` ON `project_bigquery_targets` (`client_key`);--> statement-breakpoint
CREATE TABLE `rank_check_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tracking_keyword_id` text NOT NULL,
	`device` text NOT NULL,
	`provider_task_id` text,
	`tag` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`reserved_cost_micros` integer,
	`actual_cost_micros` integer,
	`provider_status_code` integer,
	`provider_status_message` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`submitted_at` text,
	`retrieved_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `rank_check_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rank_check_tasks_run_keyword_device_idx` ON `rank_check_tasks` (`run_id`,`tracking_keyword_id`,`device`);--> statement-breakpoint
CREATE INDEX `rank_check_tasks_status_submitted_idx` ON `rank_check_tasks` (`status`,`submitted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `rank_check_tasks_provider_task_idx` ON `rank_check_tasks` (`provider_task_id`) WHERE "rank_check_tasks"."provider_task_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `rank_snapshot_features` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`feature_type` text NOT NULL,
	`rank_absolute` integer,
	`client_present` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `rank_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rank_snapshot_features_snapshot_idx` ON `rank_snapshot_features` (`snapshot_id`);--> statement-breakpoint
ALTER TABLE `rank_check_runs` ADD `trigger` text;--> statement-breakpoint
ALTER TABLE `rank_check_runs` ADD `method` text;--> statement-breakpoint
ALTER TABLE `rank_check_runs` ADD `authorized_cost_micros` integer;--> statement-breakpoint
ALTER TABLE `rank_check_runs` ADD `spent_cost_micros` integer;--> statement-breakpoint
ALTER TABLE `rank_check_runs` ADD `cost_status` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `rank_absolute` integer;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `local_pack_position` integer;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `aio_present` integer;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `aio_client_cited` integer;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `aio_citation_position` integer;--> statement-breakpoint
ALTER TABLE `rank_tracking_configs` ADD `track_competitors` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_tracking_configs` ADD `track_ai_overview` integer DEFAULT false NOT NULL;
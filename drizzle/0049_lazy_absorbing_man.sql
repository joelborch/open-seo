CREATE TABLE `gbp_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`location_id` text NOT NULL,
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
CREATE UNIQUE INDEX `gbp_schedules_location_idx` ON `gbp_schedules` (`location_id`);--> statement-breakpoint
CREATE INDEX `gbp_schedules_due_idx` ON `gbp_schedules` (`is_active`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `gbp_snapshot_attributes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `gbp_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gbp_snapshot_attributes_snapshot_value_idx` ON `gbp_snapshot_attributes` (`snapshot_id`,`key`,`value`);--> statement-breakpoint
CREATE TABLE `gbp_snapshot_reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` text NOT NULL,
	`review_id` text,
	`rating` integer,
	`author` text,
	`published_at` text,
	`text` text,
	`owner_reply` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `gbp_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gbp_snapshot_reviews_snapshot_idx` ON `gbp_snapshot_reviews` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `gbp_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`location_id` text NOT NULL,
	`run_date` text NOT NULL,
	`place_id` text,
	`cid` text,
	`name` text,
	`primary_category` text,
	`rating` real,
	`reviews_count` integer,
	`is_claimed` integer,
	`address` text,
	`phone` text,
	`website` text,
	`photos_count` integer,
	`cost_micros` integer,
	`provider_task_id` text,
	`reviews_collected_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gbp_snapshots_location_run_date_idx` ON `gbp_snapshots` (`location_id`,`run_date`);--> statement-breakpoint
CREATE INDEX `gbp_snapshots_project_idx` ON `gbp_snapshots` (`project_id`,`created_at`);
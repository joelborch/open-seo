CREATE TABLE `bigquery_projections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`run_kind` text NOT NULL,
	`run_id` text NOT NULL,
	`table` text NOT NULL,
	`dataset` text NOT NULL,
	`rows` integer NOT NULL,
	`projected_at` text DEFAULT (current_timestamp) NOT NULL,
	`error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bigquery_projections_run_table_idx` ON `bigquery_projections` (`run_kind`,`run_id`,`table`);--> statement-breakpoint
CREATE INDEX `bigquery_projections_project_idx` ON `bigquery_projections` (`project_id`,`projected_at`);
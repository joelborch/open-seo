CREATE TABLE `rank_snapshot_aio_citations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`position` integer NOT NULL,
	`domain` text NOT NULL,
	`url` text,
	`is_client` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `rank_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rank_snapshot_aio_citations_snapshot_position_idx` ON `rank_snapshot_aio_citations` (`snapshot_id`,`position`);--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `aio_brand_mentioned` integer;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `aio_snippet` text;
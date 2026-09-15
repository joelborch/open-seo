ALTER TABLE "gbp_snapshots" ADD COLUMN "query_identity" text;--> statement-breakpoint
ALTER TABLE "gbp_snapshots" ADD COLUMN "profile_task_id" text;--> statement-breakpoint
ALTER TABLE "gbp_snapshots" ADD COLUMN "profile_status_code" integer;
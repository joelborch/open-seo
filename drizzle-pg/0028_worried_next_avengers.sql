CREATE TABLE "rank_snapshot_aio_citations" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"position" integer NOT NULL,
	"domain" text NOT NULL,
	"url" text,
	"is_client" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "aio_brand_mentioned" boolean;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "aio_snippet" text;--> statement-breakpoint
ALTER TABLE "rank_snapshot_aio_citations" ADD CONSTRAINT "rank_snapshot_aio_citations_snapshot_id_rank_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."rank_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rank_snapshot_aio_citations_snapshot_position_idx" ON "rank_snapshot_aio_citations" USING btree ("snapshot_id","position");
CREATE TABLE "gbp_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"location_id" text NOT NULL,
	"schedule_interval" text DEFAULT 'weekly' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" text,
	"next_run_at" text,
	"last_skip_reason" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gbp_snapshot_attributes" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gbp_snapshot_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"review_id" text,
	"rating" integer,
	"author" text,
	"published_at" text,
	"text" text,
	"owner_reply" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gbp_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"location_id" text NOT NULL,
	"run_date" text NOT NULL,
	"place_id" text,
	"cid" text,
	"name" text,
	"primary_category" text,
	"rating" real,
	"reviews_count" integer,
	"is_claimed" boolean,
	"address" text,
	"phone" text,
	"website" text,
	"photos_count" integer,
	"cost_micros" bigint,
	"provider_task_id" text,
	"reviews_collected_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gbp_schedules" ADD CONSTRAINT "gbp_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_schedules" ADD CONSTRAINT "gbp_schedules_location_id_maps_grid_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."maps_grid_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_snapshot_attributes" ADD CONSTRAINT "gbp_snapshot_attributes_snapshot_id_gbp_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."gbp_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_snapshot_reviews" ADD CONSTRAINT "gbp_snapshot_reviews_snapshot_id_gbp_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."gbp_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_snapshots" ADD CONSTRAINT "gbp_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gbp_schedules_location_idx" ON "gbp_schedules" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "gbp_schedules_due_idx" ON "gbp_schedules" USING btree ("is_active","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gbp_snapshot_attributes_snapshot_value_idx" ON "gbp_snapshot_attributes" USING btree ("snapshot_id","key","value");--> statement-breakpoint
CREATE INDEX "gbp_snapshot_reviews_snapshot_idx" ON "gbp_snapshot_reviews" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gbp_snapshots_location_run_date_idx" ON "gbp_snapshots" USING btree ("location_id","run_date");--> statement-breakpoint
CREATE INDEX "gbp_snapshots_project_idx" ON "gbp_snapshots" USING btree ("project_id","created_at");
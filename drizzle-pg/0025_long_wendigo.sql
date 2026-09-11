CREATE TABLE "bigquery_projections" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_kind" text NOT NULL,
	"run_id" text NOT NULL,
	"table" text NOT NULL,
	"dataset" text NOT NULL,
	"rows" integer NOT NULL,
	"projected_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "bigquery_projections" ADD CONSTRAINT "bigquery_projections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bigquery_projections_run_table_idx" ON "bigquery_projections" USING btree ("run_kind","run_id","table");--> statement-breakpoint
CREATE INDEX "bigquery_projections_project_idx" ON "bigquery_projections" USING btree ("project_id","projected_at");
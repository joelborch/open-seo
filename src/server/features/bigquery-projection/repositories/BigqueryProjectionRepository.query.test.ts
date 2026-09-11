import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as BigqueryProjectionRepositoryModule from "./BigqueryProjectionRepository";

// Real in-memory SQLite: the pending-runs query is a correlated COUNT(DISTINCT)
// over the ledger, and a mocked builder chain would assert nothing about whether
// a half-projected run is actually still returned.

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let BigqueryProjectionRepository: typeof BigqueryProjectionRepositoryModule.BigqueryProjectionRepository;

const CUTOFF = "2026-03-01T00:00:00.000Z";

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  // doMock + dynamic import (not the banned per-test pattern): `@/db` exports a
  // singleton the repository captures at import time, so the test database has
  // to exist before the module is first evaluated.
  vi.doMock("@/db", () => ({ db: drizzle(client) }));

  // Only the columns these queries touch — the migration's full shape adds
  // nothing a projection-ledger test can assert on.
  await client.executeMultiple(`
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    CREATE TABLE project_bigquery_targets (
      project_id TEXT PRIMARY KEY,
      client_key TEXT NOT NULL,
      dataset TEXT NOT NULL,
      gsc_export_dataset TEXT,
      created_at TEXT NOT NULL DEFAULT (current_timestamp)
    );
    CREATE TABLE audit_schedule_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE rank_check_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      is_subset_run INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT
    );
    CREATE TABLE maps_grid_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE gbp_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      run_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE bigquery_projections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      run_kind TEXT NOT NULL,
      run_id TEXT NOT NULL,
      "table" TEXT NOT NULL,
      dataset TEXT NOT NULL,
      "rows" INTEGER NOT NULL,
      projected_at TEXT NOT NULL,
      error TEXT
    );
    CREATE UNIQUE INDEX bigquery_projections_run_table_idx
      ON bigquery_projections (run_kind, run_id, "table");
  `);

  ({ BigqueryProjectionRepository } =
    await import("./BigqueryProjectionRepository"));
});

afterAll(() => client.close());

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM bigquery_projections;
    DELETE FROM audit_schedule_runs;
    DELETE FROM rank_check_runs;
    DELETE FROM maps_grid_runs;
    DELETE FROM gbp_snapshots;
    DELETE FROM project_bigquery_targets;
    DELETE FROM projects;

    INSERT INTO projects (id) VALUES ('p1'), ('p2'), ('p-no-target');
    INSERT INTO project_bigquery_targets (project_id, client_key, dataset)
      VALUES ('p1', 'airway', 'airway_marketing'), ('p2', 'actc', 'actc_marketing');
  `);
});

async function pending(projectId?: string) {
  return BigqueryProjectionRepository.getPendingRuns({
    cutoff: CUTOFF,
    limit: 20,
    projectId,
  });
}

describe("getPendingRuns", () => {
  it("returns unprojected and half-projected runs of all kinds, oldest first", async () => {
    await client.executeMultiple(`
      INSERT INTO audit_schedule_runs (id, project_id, status, completed_at)
        VALUES ('audit-1', 'p1', 'completed', '2026-03-05T00:00:00.000Z');
      INSERT INTO rank_check_runs (id, project_id, status, completed_at)
        VALUES ('rank-1', 'p1', 'completed', '2026-03-03T00:00:00.000Z');
      INSERT INTO maps_grid_runs (id, project_id, status, completed_at)
        VALUES ('maps-1', 'p2', 'completed', '2026-03-04T00:00:00.000Z');
      -- A GBP snapshot has no status column: the row existing is what completes it.
      INSERT INTO gbp_snapshots (id, project_id, location_id, run_date, created_at)
        VALUES ('gbp-1', 'p1', 'loc-1', '2026-03-02', '2026-03-02T00:00:00.000Z');
      -- rank-1 already has keyword_rankings; aio_tracking and observations remain.
      INSERT INTO bigquery_projections
        (project_id, run_kind, run_id, "table", dataset, "rows", projected_at, error)
        VALUES ('p1', 'rank_check_run', 'rank-1', 'keyword_rankings', 'airway_marketing', 5, '2026-03-03T01:00:00.000Z', NULL);
    `);

    expect((await pending()).map((run) => run.runId)).toEqual([
      "gbp-1",
      "rank-1",
      "maps-1",
      "audit-1",
    ]);
  });

  it("drops a run once every table has a success row, but keeps one with an error", async () => {
    await client.executeMultiple(`
      INSERT INTO audit_schedule_runs (id, project_id, status, completed_at)
        VALUES ('done', 'p1', 'completed', '2026-03-05T00:00:00.000Z'),
               ('errored', 'p1', 'completed', '2026-03-06T00:00:00.000Z');
      INSERT INTO bigquery_projections
        (project_id, run_kind, run_id, "table", dataset, "rows", projected_at, error)
        VALUES
          ('p1', 'audit_schedule_run', 'done', 'weekly_health_metrics', 'airway_marketing', 3, '2026-03-05T01:00:00.000Z', NULL),
          ('p1', 'audit_schedule_run', 'done', 'observations', 'seo_yolo_internal', 1, '2026-03-05T01:00:00.000Z', NULL),
          ('p1', 'audit_schedule_run', 'errored', 'weekly_health_metrics', 'airway_marketing', 0, '2026-03-06T01:00:00.000Z', 'dataset not found'),
          ('p1', 'audit_schedule_run', 'errored', 'observations', 'seo_yolo_internal', 1, '2026-03-06T01:00:00.000Z', NULL);
    `);

    expect((await pending()).map((run) => run.runId)).toEqual(["errored"]);
  });

  it("ignores runs that are not completed, outside the cutoff, subset, or untargeted", async () => {
    await client.executeMultiple(`
      INSERT INTO audit_schedule_runs (id, project_id, status, completed_at)
        VALUES ('running', 'p1', 'running', NULL),
               ('too-old', 'p1', 'completed', '2026-02-01T00:00:00.000Z'),
               ('no-target', 'p-no-target', 'completed', '2026-03-05T00:00:00.000Z');
      INSERT INTO rank_check_runs (id, project_id, status, is_subset_run, completed_at)
        VALUES ('subset', 'p1', 'completed', 1, '2026-03-05T00:00:00.000Z');
      INSERT INTO gbp_snapshots (id, project_id, location_id, run_date, created_at)
        VALUES ('gbp-too-old', 'p1', 'loc-1', '2026-02-01', '2026-02-01T00:00:00.000Z'),
               ('gbp-no-target', 'p-no-target', 'loc-2', '2026-03-05', '2026-03-05T00:00:00.000Z');
    `);

    expect(await pending()).toEqual([]);
  });

  it("scopes the backlog to one project when asked", async () => {
    await client.executeMultiple(`
      INSERT INTO audit_schedule_runs (id, project_id, status, completed_at)
        VALUES ('mine', 'p1', 'completed', '2026-03-05T00:00:00.000Z'),
               ('theirs', 'p2', 'completed', '2026-03-04T00:00:00.000Z');
    `);

    expect((await pending("p1")).map((run) => run.runId)).toEqual(["mine"]);
  });
});

describe("recordProjection", () => {
  it("replaces an earlier attempt for the same run and table", async () => {
    const row = {
      projectId: "p1",
      runKind: "audit_schedule_run" as const,
      runId: "audit-1",
      tableName: "weekly_health_metrics" as const,
      dataset: "airway_marketing",
    };
    await BigqueryProjectionRepository.recordProjection({
      ...row,
      rows: 0,
      error: "boom",
    });
    await BigqueryProjectionRepository.recordProjection({
      ...row,
      rows: 7,
      error: null,
    });

    const ledger = await BigqueryProjectionRepository.getLedgerForProject("p1");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ rows: 7, error: null });
  });
});

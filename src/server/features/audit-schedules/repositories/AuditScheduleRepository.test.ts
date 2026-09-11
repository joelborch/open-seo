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
import type * as AuditScheduleRepositoryModule from "./AuditScheduleRepository";

// Real in-memory SQLite: retention is the one destructive query here (its
// result is fed straight to DELETE FROM audits), and it rests entirely on SQL
// the ORM generates — ordering, the OFFSET that skips the kept runs, and the
// cadence/status filters. A mocked builder chain would assert none of it.

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let AuditScheduleRepository: typeof AuditScheduleRepositoryModule.AuditScheduleRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  // testDb only exists at runtime, so the module under test must load after
  // this mock — the one sanctioned use of doMock + dynamic import.
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(`
    CREATE TABLE audit_schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      audit_id TEXT,
      cadence TEXT NOT NULL,
      status TEXT NOT NULL,
      triggered_at TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0
    );
  `);

  ({ AuditScheduleRepository } = await import("./AuditScheduleRepository"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM audit_schedule_runs");
});

async function insertRun(input: {
  id: string;
  cadence: "quick" | "deep";
  day: number;
  status?: string;
  auditId?: string | null;
}) {
  await client.execute({
    sql: `INSERT INTO audit_schedule_runs (id, schedule_id, project_id, audit_id, cadence, status, triggered_at)
          VALUES (?, 'sched-1', 'proj-1', ?, ?, ?, ?)`,
    args: [
      input.id,
      input.auditId === undefined ? `audit-${input.id}` : input.auditId,
      input.cadence,
      input.status ?? "completed",
      `2026-09-${String(input.day).padStart(2, "0")}T03:00:00.000Z`,
    ],
  });
}

describe("getPurgeableAuditIds", () => {
  it("returns only the audits older than the newest `keep` runs of that cadence", async () => {
    for (const day of [1, 2, 3, 4, 5]) {
      await insertRun({ id: `q${day}`, cadence: "quick", day });
    }
    // A deep run in the same window must not consume the quick cadence's budget.
    await insertRun({ id: "d1", cadence: "deep", day: 5 });

    expect(
      await AuditScheduleRepository.getPurgeableAuditIds({
        scheduleId: "sched-1",
        cadence: "quick",
        keep: 3,
      }),
    ).toEqual(["audit-q2", "audit-q1"]);
  });

  it("ignores runs with no audit and runs that never completed", async () => {
    // Already purged, and a skipped attempt: neither has an audit to delete.
    await insertRun({ id: "q1", cadence: "quick", day: 1, auditId: null });
    await insertRun({ id: "q2", cadence: "quick", day: 2, status: "skipped" });
    await insertRun({ id: "q3", cadence: "quick", day: 3 });

    expect(
      await AuditScheduleRepository.getPurgeableAuditIds({
        scheduleId: "sched-1",
        cadence: "quick",
        keep: 0,
      }),
    ).toEqual(["audit-q3"]);
  });
});

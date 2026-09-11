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
import type * as AuditSummaryQueries from "./auditSummaryQueries";

// Real in-memory SQLite: the health inputs are one aggregate query over a
// grouped subquery (worst severity per distinct page url), and the whole point
// of the query — a page counted once, at its worst severity — only holds if the
// generated SQL is right. A mocked builder chain would assert nothing.

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let getSiteHealthInputsForAudit: typeof AuditSummaryQueries.getSiteHealthInputsForAudit;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  // testDb only exists at runtime, so the module under test must load after
  // this mock — the one sanctioned use of doMock + dynamic import.
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(`
    CREATE TABLE audit_pages (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      url TEXT NOT NULL,
      fetch_class TEXT NOT NULL DEFAULT 'ok',
      is_indexable INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE audit_issues (
      id TEXT PRIMARY KEY,
      audit_id TEXT NOT NULL,
      page_url TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      severity TEXT NOT NULL
    );
  `);

  ({ getSiteHealthInputsForAudit } = await import("./auditSummaryQueries"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(
    `DELETE FROM audit_pages; DELETE FROM audit_issues;`,
  );
});

async function insertPage(input: {
  id: string;
  auditId?: string;
  fetchClass?: string;
  isIndexable?: number;
}) {
  await client.execute({
    sql: `INSERT INTO audit_pages (id, audit_id, url, fetch_class, is_indexable) VALUES (?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.auditId ?? "audit-1",
      `https://example.com/${input.id}`,
      input.fetchClass ?? "ok",
      input.isIndexable ?? 1,
    ],
  });
}

async function insertIssue(input: {
  id: string;
  pageUrl: string;
  severity: string;
  auditId?: string;
}) {
  await client.execute({
    sql: `INSERT INTO audit_issues (id, audit_id, page_url, issue_type, severity) VALUES (?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.auditId ?? "audit-1",
      input.pageUrl,
      "missing-title",
      input.severity,
    ],
  });
}

describe("getSiteHealthInputsForAudit", () => {
  it("counts each page once at its worst severity", async () => {
    await insertPage({ id: "p1" });
    await insertPage({ id: "p2" });
    await insertPage({ id: "p3" });
    // p1 is both critical and warning — it must count only as an error page.
    await insertIssue({
      id: "i1",
      pageUrl: "https://example.com/a",
      severity: "critical",
    });
    await insertIssue({
      id: "i2",
      pageUrl: "https://example.com/a",
      severity: "warning",
    });
    await insertIssue({
      id: "i3",
      pageUrl: "https://example.com/b",
      severity: "warning",
    });
    await insertIssue({
      id: "i4",
      pageUrl: "https://example.com/b",
      severity: "info",
    });
    await insertIssue({
      id: "i5",
      pageUrl: "https://example.com/c",
      severity: "info",
    });

    expect(await getSiteHealthInputsForAudit("audit-1")).toEqual({
      pagesConsidered: 3,
      errorPages: 1,
      warningPages: 1,
      noticePages: 1,
    });
  });

  it("excludes blocked and non-indexable pages from the denominator", async () => {
    await insertPage({ id: "p1" });
    await insertPage({ id: "p2", fetchClass: "blocked" });
    await insertPage({ id: "p3", isIndexable: 0 });
    await insertPage({ id: "p4", auditId: "audit-2" });

    expect(await getSiteHealthInputsForAudit("audit-1")).toEqual({
      pagesConsidered: 1,
      errorPages: 0,
      warningPages: 0,
      noticePages: 0,
    });
  });
});

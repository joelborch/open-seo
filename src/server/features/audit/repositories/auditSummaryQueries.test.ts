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

// Real in-memory SQLite: the health inputs are one aggregate query over a joined,
// grouped subquery (worst severity per considered page), and the whole point of
// the query — every scoreable page counted once, at its worst severity, and no
// other page counted at all — only holds if the generated SQL is right. A mocked
// builder chain would assert nothing.

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
      page_id TEXT,
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

const pageUrl = (id: string) => `https://example.com/${id}`;

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
      pageUrl(input.id),
      input.fetchClass ?? "ok",
      input.isIndexable ?? 1,
    ],
  });
}

/**
 * `page` is the audit_pages row the issue belongs to. Page-level checks stamp
 * page_id; link-graph checks only know the url, so `urlOnly` exercises the
 * other arm of the join the query has to make.
 */
async function insertIssue(input: {
  id: string;
  page: string;
  severity: string;
  urlOnly?: boolean;
  auditId?: string;
}) {
  await client.execute({
    sql: `INSERT INTO audit_issues (id, audit_id, page_id, page_url, issue_type, severity) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.auditId ?? "audit-1",
      input.urlOnly ? null : input.page,
      pageUrl(input.page),
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
    await insertIssue({ id: "i1", page: "p1", severity: "critical" });
    await insertIssue({ id: "i2", page: "p1", severity: "warning" });
    // p2's issues carry no page_id, so they only match on url.
    await insertIssue({
      id: "i3",
      page: "p2",
      severity: "warning",
      urlOnly: true,
    });
    await insertIssue({
      id: "i4",
      page: "p2",
      severity: "info",
      urlOnly: true,
    });
    await insertIssue({ id: "i5", page: "p3", severity: "info" });

    expect(await getSiteHealthInputsForAudit("audit-1")).toEqual({
      pagesConsidered: 3,
      errorPages: 1,
      warningPages: 1,
      noticePages: 1,
    });
  });

  it("scores only the pages the denominator counts", async () => {
    await insertPage({ id: "p1" });
    await insertPage({ id: "blocked", fetchClass: "blocked" });
    await insertPage({ id: "noindex", isIndexable: 0 });
    await insertPage({ id: "other-audit", auditId: "audit-2" });
    await insertIssue({ id: "i1", page: "p1", severity: "warning" });
    // A blocked page always carries a critical blocked-page issue and a noindex
    // page an info one. Neither is in the denominator, so neither may score.
    await insertIssue({ id: "i2", page: "blocked", severity: "critical" });
    await insertIssue({ id: "i3", page: "noindex", severity: "info" });
    await insertIssue({
      id: "i4",
      page: "other-audit",
      severity: "critical",
      auditId: "audit-2",
    });

    expect(await getSiteHealthInputsForAudit("audit-1")).toEqual({
      pagesConsidered: 1,
      errorPages: 0,
      warningPages: 1,
      noticePages: 0,
    });
  });
});

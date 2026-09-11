import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCrawlArchiveTool } from "./get-crawl-archive";
import { monitoringIds, outputSchemaError } from "./monitoring-test-support";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  r2Get: vi.fn(),
  getProjectForOrganization: vi.fn(),
  getAuditForProject: vi.fn(),
  getRunByAuditId: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: { R2: { get: mocks.r2Get } } }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: { getAuditForProject: mocks.getAuditForProject },
}));
vi.mock(
  "@/server/features/audit-schedules/repositories/AuditScheduleRepository",
  () => ({
    AuditScheduleRepository: { getRunByAuditId: mocks.getRunByAuditId },
  }),
);

const { projectId, auditId } = monitoringIds;
const prefix = `crawls/org_123/${projectId}/${auditId}`;
const toolContext = makeToolContext();

const manifest = {
  auditId,
  projectId,
  organizationId: "org_123",
  startUrl: "https://example.com",
  archivedAt: "2026-06-01T03:05:00.000Z",
  healthScore: 82,
  pagesConsidered: 120,
  truncated: false,
  linkGraphComplete: true,
  counts: { pages: 120, links: 4200, issues: 2 },
  parts: {
    pages: ["pages-001.ndjson.gz"],
    links: ["links-001.ndjson.gz"],
    issues: ["issues.ndjson.gz"],
  },
};

const issuesPart = gzipSync(
  Buffer.from(
    [
      JSON.stringify({
        severity: "critical",
        issue_type: "broken_link",
        page_url: "https://example.com/a",
      }),
      JSON.stringify({
        severity: "warning",
        issue_type: "missing_title",
        page_url: "https://example.com/b",
      }),
    ].join("\n") + "\n",
  ),
);

describe("get_crawl_archive MCP tool", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      name: "Example Dental",
    });
    mocks.getAuditForProject.mockResolvedValue({ id: auditId, projectId });
    mocks.getRunByAuditId.mockResolvedValue({
      id: "crawl-run-1",
      status: "completed",
      rawR2Prefix: prefix,
    });
    mocks.r2Get.mockImplementation((key: string) =>
      key.endsWith("manifest.json")
        ? { json: () => Promise.resolve(manifest) }
        : { body: new Blob([issuesPart]).stream() },
    );
  });

  it("returns the manifest plus an issue sample decoded from the gzipped part", async () => {
    const result = await getCrawlArchiveTool.handler(
      { projectId, auditId },
      toolContext,
    );

    const out = textContent(result);
    expect(out).toContain(`R2 prefix: ${prefix}`);
    expect(out).toContain("Rows: 120 pages, 4200 links, 2 issues.");
    expect(out).toContain("critical | broken_link | https://example.com/a");
    expect(result.structuredContent?.issueSample).toHaveLength(2);
    expect(
      await outputSchemaError(getCrawlArchiveTool, result.structuredContent),
    ).toBe("valid");
  });

  it("says so when the audit was started manually and has no archive", async () => {
    mocks.getRunByAuditId.mockResolvedValue(null);

    await expect(
      getCrawlArchiveTool.handler({ projectId, auditId }, toolContext),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.r2Get).not.toHaveBeenCalled();
  });
});

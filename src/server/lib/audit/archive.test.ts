import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_LINK_EXPORT_MAX_ROWS } from "@/shared/audit-limits";
import type { ScratchpadLinkRow } from "@/server/features/audit/AuditScratchpad";

// The link archive pages the scratchpad DO, which caps every page at
// AUDIT_LINK_EXPORT_MAX_ROWS. The loop reads a short page as "the edges are
// done", so it has to ask for exactly that cap — asking for more would make
// every page look short and truncate the archive after the first one.

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  exportLinks: vi.fn(),
  getPageRowsForArchive: vi.fn(),
  getIssueRowsForArchive: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: { R2: { put: mocks.put } } }));
vi.mock("@/server/features/audit/AuditScratchpad", () => ({
  getAuditScratchpad: () => ({ exportLinks: mocks.exportLinks }),
}));
vi.mock("@/server/features/audit/repositories/auditArchiveQueries", () => ({
  getPageRowsForArchive: mocks.getPageRowsForArchive,
  getIssueRowsForArchive: mocks.getIssueRowsForArchive,
}));

import { archiveCrawl } from "./archive";

// One and a quarter pages of edges, so the loop has to come back for more.
const EDGES: ScratchpadLinkRow[] = Array.from(
  { length: AUDIT_LINK_EXPORT_MAX_ROWS + 500 },
  (_, i) => ({
    sourcePageId: `page-${String(i).padStart(5, "0")}`,
    sourceUrl: `https://example.com/${i}`,
    targetUrl: "https://example.com/target",
    anchor: null,
    isNofollow: false,
  }),
);

describe("archiveCrawl", () => {
  beforeEach(() => {
    mocks.getPageRowsForArchive.mockResolvedValue([]);
    mocks.getIssueRowsForArchive.mockResolvedValue([]);
    // R2 only pulls the gzip stream when something reads the body; drain it so
    // the part's row count is the real one.
    mocks.put.mockImplementation(async (_key: string, body: unknown) => {
      if (body instanceof ReadableStream) {
        await new Response(body).arrayBuffer();
      }
    });
    // Stands in for the DO, cap included.
    mocks.exportLinks.mockImplementation(
      async (input: { afterSourcePageId: string | null; limit: number }) => {
        const limit = Math.min(input.limit, AUDIT_LINK_EXPORT_MAX_ROWS);
        const after = input.afterSourcePageId;
        const start =
          after === null
            ? 0
            : EDGES.findIndex((edge) => edge.sourcePageId === after) + 1;
        return {
          links: EDGES.slice(start, start + limit),
          linkGraphComplete: true,
        };
      },
    );
  });

  it("pages the whole link graph instead of stopping at the first full page", async () => {
    const { manifest } = await archiveCrawl({
      auditId: "audit-1",
      projectId: "project-1",
      organizationId: "org-1",
      startUrl: "https://example.com/",
      healthScore: 90,
      pagesConsidered: 10,
      truncated: false,
    });

    expect(manifest.counts.links).toBe(EDGES.length);
  });
});

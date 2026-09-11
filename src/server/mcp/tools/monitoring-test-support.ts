import { objectSchema } from "@/server/mcp/output-schemas";

/**
 * Fixtures and helpers shared by the monitoring MCP tool specs. The run rows
 * mirror the columns each loop's repository selects; overrides carry whatever a
 * test asserts on.
 */

export const monitoringIds = {
  projectId: "11111111-1111-4111-8111-111111111111",
  trackerId: "22222222-2222-4222-8222-222222222222",
  gridConfigId: "33333333-3333-4333-8333-333333333333",
  auditId: "44444444-4444-4444-8444-444444444444",
} as const;

export function crawlRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "crawl-run-1",
    cadence: "quick",
    status: "completed",
    auditId: monitoringIds.auditId,
    triggeredAt: "2026-06-01T03:00:00.000Z",
    completedAt: "2026-06-01T03:04:00.000Z",
    skipReason: null,
    pagesCrawled: 120,
    pagesWithErrors: 4,
    pagesWithWarnings: 9,
    pagesWithNotices: 2,
    pagesBlocked: 0,
    healthScore: 82,
    healthScoreDelta: 3,
    truncated: false,
    rawR2Prefix: `crawls/org_123/${monitoringIds.projectId}/${monitoringIds.auditId}`,
    issueCounts: [
      { issueType: "missing_title", severity: "warning", pages: 3 },
    ],
    ...overrides,
  };
}

export function rankRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rank-run-1",
    status: "completed",
    trigger: "scheduled",
    method: "queued",
    keywordsTotal: 40,
    keywordsChecked: 38,
    spentCostMicros: 24_000,
    costStatus: "known_minimum",
    startedAt: "2026-06-01T04:00:00.000Z",
    completedAt: "2026-06-01T04:06:00.000Z",
    ...overrides,
  };
}

export function gridRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "grid-run-1",
    configId: monitoringIds.gridConfigId,
    status: "completed",
    trigger: "scheduled",
    cellsTotal: 9,
    cellsCollected: 9,
    spentCostMicros: 18_000,
    costStatus: "known",
    errorMessage: null,
    startedAt: "2026-06-01T05:00:00.000Z",
    completedAt: "2026-06-01T05:08:00.000Z",
    ...overrides,
  };
}

/** A 3x3 panel for one keyword where the client holds rank 1 in the centre cell
 *  and nowhere else. */
export function gridCellRows(runId: string) {
  const cells = [];
  let id = 1;
  for (let gridRow = 1; gridRow <= 3; gridRow++) {
    for (let gridCol = 1; gridCol <= 3; gridCol++) {
      cells.push({
        id: id++,
        runId,
        keywordId: "kw-1",
        keyword: "emergency dentist",
        gridRow,
        gridCol,
        clientRank: gridRow === 2 && gridCol === 2 ? 1 : null,
      });
    }
  }
  return cells;
}

/**
 * "valid", or why the payload fails the tool's own output schema. The MCP SDK runs
 * this same validation after a handler returns and turns a mismatch into a
 * client-visible -32602, so every monitoring spec checks its payload against it.
 */
export async function outputSchemaError(
  tool: {
    config: { outputSchema: NonNullable<Parameters<typeof objectSchema>[0]> };
  },
  structuredContent: unknown,
): Promise<string> {
  const parsed = await objectSchema(tool.config.outputSchema).safeParseAsync(
    structuredContent,
  );
  return parsed.error?.message ?? "valid";
}

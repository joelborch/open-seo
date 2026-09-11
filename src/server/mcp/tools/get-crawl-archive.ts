import { env } from "cloudflare:workers";
import { z } from "zod";
import { AuditScheduleRepository } from "@/server/features/audit-schedules/repositories/AuditScheduleRepository";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  formatMcpTable,
  readPath,
  truncatedCell,
  type McpTableColumn,
} from "@/server/mcp/table";

/** Issue rows decoded from the archive. A sample, not a report: the archive is
 *  cold storage measured in tens of thousands of rows, and get_audit_issues is
 *  the prioritized read. */
const ISSUE_SAMPLE_ROWS = 50;

// The archive is written by src/server/lib/audit/archive.ts, whose manifest names
// every part — so this reads `manifest.json` under the run's recorded prefix and
// then whatever the manifest calls the issues part, rather than re-deriving the
// layout here.
const manifestSchema = z
  .object({
    auditId: z.string(),
    projectId: z.string(),
    organizationId: z.string(),
    startUrl: z.string(),
    archivedAt: z.string(),
    healthScore: z.number().nullable(),
    pagesConsidered: z.number(),
    truncated: z.boolean(),
    linkGraphComplete: z.boolean(),
    counts: z.object({
      pages: z.number(),
      links: z.number(),
      issues: z.number(),
    }),
    parts: z.object({
      pages: z.array(z.string()),
      links: z.array(z.string()),
      issues: z.array(z.string()),
    }),
  })
  .passthrough();

const ISSUE_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "severity", value: (row) => readPath(row, "severity") },
  { header: "issue", value: (row) => readPath(row, "issue_type") },
  {
    header: "page",
    value: (row) => readPath(row, "page_url"),
    format: truncatedCell(80),
  },
];

async function readManifest(prefix: string) {
  const object = await env.R2.get(`${prefix}/manifest.json`);
  if (!object) {
    throw new AppError(
      "NOT_FOUND",
      `No crawl archive at ${prefix} — the run recorded a prefix but its manifest is missing.`,
    );
  }
  const parsed = manifestSchema.safeParse(await object.json());
  if (!parsed.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      `Crawl archive manifest at ${prefix} is not readable: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * The first `limit` rows of a gzipped NDJSON part. Decoded through the stream and
 * abandoned as soon as the sample is full, so a 40 MB issues file costs the same
 * as a small one.
 */
async function readNdjsonSample(
  key: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const object = await env.R2.get(key);
  if (!object) return [];
  const reader = object.body
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new TextDecoderStream())
    .getReader();

  const rows: Record<string, unknown>[] = [];
  const take = (line: string) => {
    if (line.trim() === "") return;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a parsed JSON object is a plain record
      rows.push(parsed as Record<string, unknown>);
    }
  };

  let buffer = "";
  try {
    while (rows.length < limit) {
      const { value, done } = await reader.read();
      if (value !== undefined) buffer += value;
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && rows.length < limit) {
        take(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (done) {
        if (rows.length < limit) take(buffer);
        break;
      }
    }
  } finally {
    await reader.cancel();
  }
  return rows;
}

const inputSchema = {
  projectId: projectIdSchema,
  auditId: z
    .string()
    .describe(
      "Audit ID of an archived scheduled crawl (get_monitoring_status reports it as the run's auditId).",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getCrawlArchiveTool = {
  name: "get_crawl_archive",
  config: {
    title: "Get crawl archive",
    description:
      "Manifest of a scheduled crawl's cold-storage archive in R2: row counts, the parts it is sharded into, the health score, whether the crawl was truncated at its page budget and whether the link graph is complete, plus the R2 prefix and a 50-row sample of the archived issues. Read-only and free. Only scheduled crawls are archived — a manual audit has no archive; read it with get_audit_issues instead.",
    inputSchema,
    outputSchema: z
      .object({
        auditId: z.string(),
        prefix: z.string(),
        manifest: looseObjectOutputSchema,
        issueSample: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    // Authorize the audit against the project before touching R2: the prefix
    // embeds an organization id, so an unchecked auditId would read another
    // tenant's archive.
    const audit = await AuditRepository.getAuditForProject(
      args.auditId,
      args.projectId,
    );
    if (!audit) {
      throw new AppError(
        "NOT_FOUND",
        `Audit ${args.auditId} not found in this project.`,
      );
    }

    const run = await AuditScheduleRepository.getRunByAuditId(args.auditId);
    if (!run?.rawR2Prefix) {
      throw new AppError(
        "NOT_FOUND",
        run
          ? `Scheduled crawl ${run.id} has no archive yet (status ${run.status}).`
          : "This audit was started manually, and only scheduled crawls are archived. Use get_audit_issues and get_audit_pages instead.",
      );
    }

    const manifest = await readManifest(run.rawR2Prefix);
    if (manifest.projectId !== args.projectId) {
      throw new AppError(
        "NOT_FOUND",
        `The archive at ${run.rawR2Prefix} belongs to a different project.`,
      );
    }
    const issuePart = manifest.parts.issues[0];
    const issueSample = issuePart
      ? await readNdjsonSample(
          `${run.rawR2Prefix}/${issuePart}`,
          ISSUE_SAMPLE_ROWS,
        )
      : [];

    const text = [
      `Crawl archive for audit ${args.auditId} (${manifest.startUrl}), archived ${manifest.archivedAt}.`,
      `R2 prefix: ${run.rawR2Prefix}`,
      `Health score: ${manifest.healthScore ?? "—"}, pages considered ${manifest.pagesConsidered}, truncated ${manifest.truncated ? "yes" : "no"}, link graph complete ${manifest.linkGraphComplete ? "yes" : "no"}.`,
      `Rows: ${manifest.counts.pages} pages, ${manifest.counts.links} links, ${manifest.counts.issues} issues.`,
      `Parts: pages ${manifest.parts.pages.length}, links ${manifest.parts.links.length}, issues ${manifest.parts.issues.length} (gzipped NDJSON).`,
      issueSample.length === 0
        ? "No archived issue rows."
        : `Issue sample (${issueSample.length} of ${manifest.counts.issues}):\n${formatMcpTable(issueSample, ISSUE_COLUMNS)}`,
    ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/audit`,
        { auditId: args.auditId },
      ),
      structuredContent: {
        auditId: args.auditId,
        prefix: run.rawR2Prefix,
        manifest,
        issueSample,
      },
    });
  }),
};

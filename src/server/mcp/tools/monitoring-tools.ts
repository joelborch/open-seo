/**
 * Read-only monitoring tools: what the scheduled crawl, rank-check and
 * Maps-grid loops have done lately, and their run history.
 */
import { z } from "zod";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { buildProjectMeta, type ToolContext } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import {
  requireProjectAccess,
  withMcpProjectAuth,
} from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { buildDashboardUrl } from "@/server/mcp/urls";
import {
  crawlRunHistory,
  gridConfigRunsOutputSchema,
  gridRunsForProject,
  monitoringKindSchema,
  MONITORING_HISTORY_MAX,
  monitoringStatusForProject,
  projectionLedgerOutputSchema,
  rankRunsForProject,
  rankTrackerRunsOutputSchema,
  type MonitoringKind,
} from "@/server/mcp/tools/monitoring-shared";
import {
  crawlRunLine,
  gridRunLine,
  monitoringStatusLines,
  rankRunLine,
} from "@/server/mcp/tools/monitoring-text";

/**
 * Projects covered by one organization-wide sweep. Each project costs a handful
 * of small reads, so the sweep is bounded and the text says when it was cut.
 */
const SWEEP_PROJECT_LIMIT = 10;

// ─── get_monitoring_status ───────────────────────────────────────────────────

const statusInputSchema = {
  projectId: projectIdSchema
    .optional()
    .describe(
      "Project to report on. Omit to sweep every project in the organization (newest first, first 10).",
    ),
} as const;

type StatusArgs = z.infer<z.ZodObject<typeof statusInputSchema>>;

export const getMonitoringStatusTool = {
  name: "get_monitoring_status",
  config: {
    title: "Get monitoring status",
    description:
      "Latest state of every monitoring loop: the newest scheduled crawl per cadence (status, pages, health score and its delta, crawl-archive prefix), the newest rank check per tracker (status, method, keywords checked, spend and whether that spend is final), the newest Maps grid run per config (cells collected, visibility score, share of local voice, spend), and the BigQuery projection ledger rows for those runs. Uses no credits and buys nothing. Omit projectId to sweep the organization; use list_monitoring_runs for history and get_maps_grid_run for one grid run's cells.",
    inputSchema: statusInputSchema,
    outputSchema: z
      .object({
        projects: z.array(
          z
            .object({
              projectId: z.string(),
              projectName: z.string(),
              crawls: z.array(looseObjectOutputSchema),
              rank: z.array(rankTrackerRunsOutputSchema),
              grids: z.array(gridConfigRunsOutputSchema),
              gbp: z.array(looseObjectOutputSchema),
              projections: z.array(projectionLedgerOutputSchema),
            })
            .passthrough(),
        ),
        truncated: z.boolean(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: async (args: StatusArgs, toolContext: ToolContext) => {
    if (args.projectId) {
      const context = await requireProjectAccess(toolContext, args.projectId);
      const status = await monitoringStatusForProject(context.project);
      return mcpResponse({
        text: monitoringStatusLines(status).join("\n"),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
        structuredContent: { projects: [status], truncated: false },
      });
    }

    // No projectId: the organization on the credential is the boundary, exactly
    // as it is for the other tools with no project argument.
    const all = await ProjectService.listProjects(
      toolContext.auth.organizationId,
    );
    const projects = all.slice(0, SWEEP_PROJECT_LIMIT);
    const statuses = [];
    for (const project of projects) {
      statuses.push(await monitoringStatusForProject(project));
    }

    const truncated = all.length > projects.length;
    const header =
      statuses.length === 0
        ? "No projects in this organization."
        : `Monitoring status for ${statuses.length} of ${all.length} project(s)${
            truncated
              ? " — pass projectId for the rest, which this sweep skipped"
              : ""
          }:`;
    return mcpResponse({
      text: [header, ...statuses.flatMap(monitoringStatusLines)].join("\n"),
      meta: { url: buildDashboardUrl(toolContext.auth.baseUrl, "/") },
      structuredContent: { projects: statuses, truncated },
    });
  },
};

// ─── list_monitoring_runs ────────────────────────────────────────────────────

const listInputSchema = {
  projectId: projectIdSchema,
  kind: monitoringKindSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(MONITORING_HISTORY_MAX)
    .optional()
    .describe("Runs per schedule/config to return (default 10)."),
  configId: z
    .string()
    .optional()
    .describe(
      "Rank tracker or grid config to restrict to. Ignored for kind 'crawl', which has one schedule per project.",
    ),
} as const;

type ListArgs = z.infer<z.ZodObject<typeof listInputSchema>>;

export const listMonitoringRunsTool = {
  name: "list_monitoring_runs",
  config: {
    title: "List monitoring runs",
    description:
      "Run history for one project and one monitoring loop — 'crawl' (scheduled site crawls), 'rank' (scheduled rank checks) or 'grid' (Maps grid runs) — oldest first, with the same fields get_monitoring_status reports per run. Rank and grid runs are grouped per tracker/config because each is its own schedule. Uses no credits.",
    inputSchema: listInputSchema,
    outputSchema: z
      .object({
        kind: monitoringKindSchema,
        crawls: z.array(looseObjectOutputSchema).optional(),
        rank: z.array(rankTrackerRunsOutputSchema).optional(),
        grids: z.array(gridConfigRunsOutputSchema).optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ListArgs, context) => {
    const limit = args.limit ?? 10;
    const kind: MonitoringKind = args.kind;

    if (kind === "crawl") {
      const crawls = await crawlRunHistory(args.projectId, limit);
      const text =
        crawls.length === 0
          ? "No scheduled crawl runs recorded for this project."
          : [
              `Scheduled crawl runs (${crawls.length}, oldest first):`,
              ...crawls.map((run) => `- ${crawlRunLine(run)}`),
            ].join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/audit`,
        ),
        structuredContent: { kind, crawls },
      });
    }

    if (kind === "rank") {
      const rank = await rankRunsForProject({
        projectId: args.projectId,
        limit,
        configId: args.configId,
      });
      const text =
        rank.length === 0
          ? "No rank trackers in this project."
          : rank
              .flatMap((tracker) => [
                `Tracker ${tracker.domain} (${tracker.configId}) — ${tracker.runs.length} run(s), oldest first:`,
                ...(tracker.runs.length === 0
                  ? ["- no runs yet"]
                  : tracker.runs.map((run) => `- ${rankRunLine(run)}`)),
              ])
              .join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/rank-tracking`,
        ),
        structuredContent: { kind, rank },
      });
    }

    const grids = await gridRunsForProject({
      projectId: args.projectId,
      limit,
      configId: args.configId,
    });
    const text =
      grids.length === 0
        ? "No Maps grid configs in this project."
        : grids
            .flatMap((config) => [
              `Grid ${config.configId} (${config.gridSize}x${config.gridSize}) — ${config.runs.length} run(s), oldest first:`,
              ...(config.runs.length === 0
                ? ["- no runs yet"]
                : config.runs.map((run) => `- ${gridRunLine(run)}`)),
            ])
            .join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/maps-grid`,
      ),
      structuredContent: { kind, grids },
    });
  }),
};

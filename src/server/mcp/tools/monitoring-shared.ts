/**
 * Shared read model for the monitoring MCP tools.
 *
 * The three monitoring loops keep their own run tables — scheduled crawls
 * (audit_schedule_runs), scheduled rank checks (rank_check_runs) and the Maps
 * grid (maps_grid_runs) — so "what has monitoring done lately" is a read across
 * three features plus the BigQuery projection ledger. Assembling it here is what
 * makes get_monitoring_status and list_monitoring_runs report the same fields for
 * the same run, and keeps both on the existing services/repositories.
 *
 * Everything here is free: no provider call, no credits.
 */
import { reverse } from "remeda";
import { z } from "zod";
import { AuditScheduleService } from "@/server/features/audit-schedules/services/AuditScheduleService";
import { BigqueryProjectionRepository } from "@/server/features/bigquery-projection/repositories/BigqueryProjectionRepository";
import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { MapsGridService } from "@/server/features/maps-grid/services/MapsGridService";
import { computeRunRollups } from "@/server/features/maps-grid/services/mapsGridRollups";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { looseObjectOutputSchema } from "@/server/mcp/output-schemas";

/** The three monitoring loops, as `list_monitoring_runs` names them. */
export const MONITORING_KINDS = ["crawl", "rank", "grid"] as const;
export type MonitoringKind = (typeof MONITORING_KINDS)[number];

export const monitoringKindSchema = z
  .enum(MONITORING_KINDS)
  .describe(
    "Which monitoring loop to read: 'crawl' = scheduled site crawls, 'rank' = scheduled rank checks, 'grid' = Maps grid runs.",
  );

/**
 * Ceiling on `list_monitoring_runs`' limit. Each loop's own read model caps its
 * history lower than this (30 crawl runs, 24 grid runs), so a bigger limit simply
 * returns everything those keep.
 */
export const MONITORING_HISTORY_MAX = 50;

// ─── crawl runs ──────────────────────────────────────────────────────────────

type ScheduleRunRow = Awaited<
  ReturnType<typeof AuditScheduleService.getHistory>
>[number];

export type CrawlRunSummary = ReturnType<typeof summarizeCrawlRun>;

function summarizeCrawlRun(run: ScheduleRunRow) {
  return {
    runId: run.id,
    cadence: run.cadence,
    status: run.status,
    auditId: run.auditId,
    triggeredAt: run.triggeredAt,
    completedAt: run.completedAt,
    skipReason: run.skipReason,
    pagesCrawled: run.pagesCrawled,
    pagesWithErrors: run.pagesWithErrors,
    pagesWithWarnings: run.pagesWithWarnings,
    pagesWithNotices: run.pagesWithNotices,
    pagesBlocked: run.pagesBlocked,
    healthScore: run.healthScore,
    healthScoreDelta: run.healthScoreDelta,
    truncated: run.truncated,
    /** R2 prefix of the crawl archive; null for a run that wasn't archived. */
    archivePrefix: run.rawR2Prefix,
    issueCounts: run.issueCounts,
  };
}

/**
 * The newest run of each cadence. Quick and deep crawls score different samples
 * of the site, so the freshest run of each is reported rather than one "latest".
 */
async function latestCrawlRuns(projectId: string): Promise<CrawlRunSummary[]> {
  // getHistory returns newest first, so the first row seen per cadence is its
  // latest run.
  const seen = new Set<string>();
  const latest: CrawlRunSummary[] = [];
  for (const run of await AuditScheduleService.getHistory(projectId)) {
    if (seen.has(run.cadence)) continue;
    seen.add(run.cadence);
    latest.push(summarizeCrawlRun(run));
  }
  return latest;
}

/** Crawl history, oldest→newest. Capped by the service's own 30-run window. */
export async function crawlRunHistory(
  projectId: string,
  limit: number,
): Promise<CrawlRunSummary[]> {
  const runs = await AuditScheduleService.getHistory(projectId);
  return reverse(runs.slice(0, limit)).map(summarizeCrawlRun);
}

// ─── rank check runs ─────────────────────────────────────────────────────────

export type RankRunSummary = {
  runId: string;
  configId: string;
  status: string;
  trigger: string | null;
  method: string | null;
  keywordsTotal: number;
  keywordsChecked: number;
  spentCostMicros: number | null;
  costStatus: string | null;
  /** Ledger rows whose submit crashed — they make `spentCostMicros` a floor. */
  submissionUnknown: number;
  /** Ledger rows still reserved or submitted, i.e. results left to collect. */
  outstanding: number;
  startedAt: string;
  completedAt: string | null;
};

type RankRunRow = Awaited<
  ReturnType<typeof RankTrackingService.getRunHistory>
>[number];

/**
 * One run with its ledger rollup. The rollup is a separate aggregate per run, so
 * callers ask for it only on the runs they report.
 */
async function summarizeRankRun(
  configId: string,
  run: RankRunRow,
): Promise<RankRunSummary> {
  const ledger = await RankTrackingRepository.getRankCheckTaskCostSummary(
    run.id,
  );
  return {
    runId: run.id,
    configId,
    status: run.status,
    trigger: run.trigger,
    method: run.method,
    keywordsTotal: run.keywordsTotal,
    keywordsChecked: run.keywordsChecked,
    spentCostMicros: run.spentCostMicros,
    costStatus: run.costStatus,
    submissionUnknown: ledger.submissionUnknown,
    outstanding: ledger.outstanding,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

export type RankTrackerRuns = {
  configId: string;
  domain: string;
  locationCode: number;
  scheduleInterval: string;
  /** Oldest→newest. */
  runs: RankRunSummary[];
};

/**
 * Rank-check runs per tracker in the project. `limit` is per tracker, because a
 * project's trackers are independent schedules rather than one timeline.
 */
export async function rankRunsForProject(input: {
  projectId: string;
  limit: number;
  configId?: string;
}): Promise<RankTrackerRuns[]> {
  const configs = (
    await RankTrackingService.getConfigs(input.projectId)
  ).filter((config) => !input.configId || config.id === input.configId);

  return Promise.all(
    configs.map(async (config) => {
      const runs = await RankTrackingService.getRunHistory(
        config.id,
        input.projectId,
        input.limit,
      );
      return {
        configId: config.id,
        domain: config.domain,
        locationCode: config.locationCode,
        scheduleInterval: config.scheduleInterval,
        runs: await Promise.all(
          reverse(runs).map((run) => summarizeRankRun(config.id, run)),
        ),
      };
    }),
  );
}

// ─── maps grid runs ──────────────────────────────────────────────────────────

export type GridRunSummary = {
  runId: string;
  configId: string;
  status: string;
  trigger: string;
  cellsTotal: number;
  cellsCollected: number;
  spentCostMicros: number | null;
  costStatus: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  /** Mean rank-band weight across the run's cells, 0-100. */
  visibilityScore: number;
  /** Cells the client held a top-3 position in, as a share (0-1). */
  shareOfLocalVoice: number;
};

export type GridConfigRuns = {
  configId: string;
  locationId: string;
  gridSize: number;
  scheduleInterval: string;
  isActive: boolean;
  /** Oldest→newest. */
  runs: GridRunSummary[];
};

/**
 * Grid runs per config, with the two headline rollups. The rollups are
 * recomputed from the runs' cells (the same way the trend chart does) rather than
 * stored, and the ranked packs are never read — visibility and share of local
 * voice are functions of the client's rank alone.
 */
export async function gridRunsForProject(input: {
  projectId: string;
  limit: number;
  configId?: string;
}): Promise<GridConfigRuns[]> {
  const configs = (
    await MapsGridRepository.getConfigsForProject(input.projectId)
  ).filter((config) => !input.configId || config.id === input.configId);

  return Promise.all(
    configs.map(async (config) => {
      const runs = reverse(
        (
          await MapsGridService.getGridRuns({
            configId: config.id,
            projectId: input.projectId,
          })
        ).slice(0, input.limit),
      );
      const cells = await MapsGridRepository.getCellsForRuns(
        runs.map((run) => run.id),
      );
      return {
        configId: config.id,
        locationId: config.locationId,
        gridSize: config.gridSize,
        scheduleInterval: config.scheduleInterval,
        isActive: config.isActive,
        runs: runs.map((run) => {
          const rollups = computeRunRollups({
            gridSize: config.gridSize,
            cells: cells.filter((cell) => cell.runId === run.id),
            results: [],
          });
          return {
            runId: run.id,
            configId: config.id,
            status: run.status,
            trigger: run.trigger,
            cellsTotal: run.cellsTotal,
            cellsCollected: run.cellsCollected,
            spentCostMicros: run.spentCostMicros,
            costStatus: run.costStatus,
            errorMessage: run.errorMessage,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            visibilityScore: rollups.visibilityScore,
            shareOfLocalVoice: rollups.shareOfLocalVoice,
          };
        }),
      };
    }),
  );
}

// ─── BigQuery projection ledger ──────────────────────────────────────────────

export type ProjectionLedgerEntry = {
  runKind: string;
  runId: string;
  table: string;
  dataset: string;
  rows: number;
  projectedAt: string;
  error: string | null;
};

/**
 * The ledger rows belonging to the runs being reported, newest first. The whole
 * point is "did this run reach BigQuery", so a run with no rows is a run the
 * projection cron hasn't finished (or a project with no BigQuery target) — the
 * absence is the answer, and nothing is inferred here.
 */
async function projectionLedgerForRuns(input: {
  projectId: string;
  runIds: string[];
}): Promise<ProjectionLedgerEntry[]> {
  if (input.runIds.length === 0) return [];
  const wanted = new Set(input.runIds);
  const ledger = await BigqueryProjectionRepository.getLedgerForProject(
    input.projectId,
  );
  return ledger
    .filter((row) => wanted.has(row.runId))
    .map((row) => ({
      runKind: row.runKind,
      runId: row.runId,
      table: row.tableName,
      dataset: row.dataset,
      rows: row.rows,
      projectedAt: row.projectedAt,
      error: row.error,
    }));
}

// ─── one project's status ────────────────────────────────────────────────────

export type MonitoringProjectStatus = {
  projectId: string;
  projectName: string;
  crawls: CrawlRunSummary[];
  rank: RankTrackerRuns[];
  grids: GridConfigRuns[];
  projections: ProjectionLedgerEntry[];
};

/** Latest run of every monitoring loop for one project, plus its ledger rows. */
export async function monitoringStatusForProject(project: {
  id: string;
  name: string;
}): Promise<MonitoringProjectStatus> {
  const [crawls, rank, grids] = await Promise.all([
    latestCrawlRuns(project.id),
    rankRunsForProject({ projectId: project.id, limit: 1 }),
    gridRunsForProject({ projectId: project.id, limit: 1 }),
  ]);
  const runIds = [
    ...crawls.map((run) => run.runId),
    ...rank.flatMap((tracker) => tracker.runs.map((run) => run.runId)),
    ...grids.flatMap((config) => config.runs.map((run) => run.runId)),
  ];
  return {
    projectId: project.id,
    projectName: project.name,
    crawls,
    rank,
    grids,
    projections: await projectionLedgerForRuns({
      projectId: project.id,
      runIds,
    }),
  };
}

// ─── output schemas ──────────────────────────────────────────────────────────

// Rows are our own plain objects assembled above, so the shapes are declared
// rather than left loose — but every object stays passthrough so a new field on a
// run row can't turn into a client-visible -32602 output validation error.
export const rankTrackerRunsOutputSchema = z
  .object({
    configId: z.string(),
    domain: z.string(),
    runs: z.array(looseObjectOutputSchema),
  })
  .passthrough();
export const gridConfigRunsOutputSchema = z
  .object({
    configId: z.string(),
    gridSize: z.number(),
    runs: z.array(looseObjectOutputSchema),
  })
  .passthrough();
export const projectionLedgerOutputSchema = z
  .object({
    runKind: z.string(),
    runId: z.string(),
    table: z.string(),
    projectedAt: z.string(),
    error: z.string().nullable(),
  })
  .passthrough();

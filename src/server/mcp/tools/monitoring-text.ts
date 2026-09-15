/**
 * Text rendering for the monitoring MCP tools. One line per run, shared by
 * get_monitoring_status and list_monitoring_runs so a run reads the same wherever
 * it appears — the text block is what MCP clients that ignore structuredContent
 * show the user.
 */
import { formatMicrosUsd } from "@/shared/rank-tracking";
import type {
  CrawlRunSummary,
  GridRunSummary,
  MonitoringProjectStatus,
  ProjectionLedgerEntry,
  RankRunSummary,
} from "@/server/mcp/tools/monitoring-shared";

function spend(micros: number | null, costStatus: string | null): string {
  if (micros == null) return "spend —";
  const floor = costStatus === "known_minimum" ? " (floor)" : "";
  return `spend ${formatMicrosUsd(micros)}${floor}`;
}

export function crawlRunLine(run: CrawlRunSummary): string {
  const health =
    run.healthScore == null
      ? "health —"
      : `health ${run.healthScore}${
          run.healthScoreDelta == null
            ? ""
            : ` (${run.healthScoreDelta >= 0 ? "+" : ""}${run.healthScoreDelta})`
        }`;
  return [
    `${run.cadence} ${run.status}`,
    `${run.pagesCrawled ?? "—"} pages`,
    health,
    `triggered ${run.triggeredAt}`,
    `completed ${run.completedAt ?? "—"}`,
    run.skipReason ? `skipped: ${run.skipReason}` : null,
    run.archivePrefix ? `archive ${run.archivePrefix}` : "not archived",
    `run ${run.runId}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

export function rankRunLine(run: RankRunSummary): string {
  return [
    `${run.status} via ${run.method ?? "—"}`,
    `${run.keywordsChecked}/${run.keywordsTotal} keywords`,
    spend(run.spentCostMicros, run.costStatus),
    run.submissionUnknown > 0
      ? `${run.submissionUnknown} submission_unknown`
      : null,
    run.outstanding > 0 ? `${run.outstanding} outstanding` : null,
    `started ${run.startedAt}`,
    `completed ${run.completedAt ?? "—"}`,
    `run ${run.runId}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

export function gridRunLine(run: GridRunSummary): string {
  return [
    run.status,
    `${run.cellsCollected}/${run.cellsTotal} cells`,
    `visibility ${run.visibilityScore.toFixed(1)}`,
    `SoLV ${(run.shareOfLocalVoice * 100).toFixed(1)}%`,
    spend(run.spentCostMicros, run.costStatus),
    `started ${run.startedAt}`,
    run.errorMessage ? `error: ${run.errorMessage}` : null,
    `run ${run.runId}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

function projectionLines(projections: ProjectionLedgerEntry[]): string[] {
  return projections.map(
    (row) =>
      `  - ${row.table} (${row.dataset}) for ${row.runKind} ${row.runId}: ${
        row.error
          ? `error: ${row.error}`
          : `${row.rows} rows at ${row.projectedAt}`
      }`,
  );
}

/** Text block for one project's status, used for a single project and a sweep. */
export function monitoringStatusLines(
  status: MonitoringProjectStatus,
): string[] {
  const lines = [`Project ${status.projectName} (${status.projectId}):`];

  lines.push("- Scheduled crawls:");
  lines.push(
    ...(status.crawls.length === 0
      ? ["  - none recorded"]
      : status.crawls.map((run) => `  - ${crawlRunLine(run)}`)),
  );

  lines.push("- Rank checks:");
  lines.push(
    ...(status.rank.length === 0
      ? ["  - no trackers"]
      : status.rank.map((tracker) => {
          const run = tracker.runs.at(-1);
          return `  - ${tracker.domain} (${tracker.configId}, ${tracker.scheduleInterval}): ${
            run ? rankRunLine(run) : "no runs yet"
          }`;
        })),
  );

  lines.push("- Maps grids:");
  lines.push(
    ...(status.grids.length === 0
      ? ["  - no grid configs"]
      : status.grids.map((config) => {
          const run = config.runs.at(-1);
          return `  - ${config.configId} (${config.gridSize}x${config.gridSize}, ${config.scheduleInterval}${config.isActive ? "" : ", paused"}): ${
            run ? gridRunLine(run) : "no runs yet"
          }`;
        })),
  );

  lines.push("- GBP snapshots:");
  for (const location of status.gbp) {
    const snapshot = location.snapshot;
    lines.push(
      `  - ${location.name}: ${
        snapshot
          ? `${snapshot.runDate}, ${snapshot.profileFound ? "profile found" : "empty profile"}, ${spend(snapshot.costMicros, null)}, reviews ${snapshot.reviewsStatus}`
          : "no capture"
      }; next ${location.nextRunAt ?? "unset"}; skip ${location.lastSkipReason ?? "none"}`,
    );
  }
  if (status.gbp.length === 0) lines.push("  - no monitored locations");

  lines.push("- BigQuery projections:");
  lines.push(
    ...(status.projections.length === 0
      ? ["  - no projection rows for these runs"]
      : projectionLines(status.projections)),
  );

  return lines;
}

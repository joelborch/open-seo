/**
 * Stamps a finished crawl onto its schedule run row.
 *
 * Called from the site-audit workflow's finalize step, which runs in the audit
 * worker — hence a leaf module over the app DB rather than a method on the cron
 * service, so the aux worker's startup graph stays as small as it is today.
 *
 * Every write here is an overwrite of the same run row, so a finalize-step retry
 * is harmless.
 */
import { getIssueTypePageCountsForAudit } from "@/server/features/audit/repositories/auditSummaryQueries";
import { AuditScheduleRepository } from "@/server/features/audit-schedules/repositories/AuditScheduleRepository";

export async function finishScheduleRun(input: {
  auditId: string;
  pagesCrawled: number;
  pagesBlocked: number;
  healthScore: number | null;
  errorPages: number;
  warningPages: number;
  noticePages: number;
  truncated: boolean;
}): Promise<void> {
  const run = await AuditScheduleRepository.getRunByAuditId(input.auditId);
  // Manual audits have no run row — the overwhelmingly common case.
  if (!run) return;

  // Delta against the previous scored run of the SAME cadence; null when this is
  // the first one, or when either score was withheld for a too-small sample.
  const previous = await AuditScheduleRepository.getPreviousScoredRun({
    scheduleId: run.scheduleId,
    cadence: run.cadence,
    beforeTriggeredAt: run.triggeredAt,
  });
  const previousScore = previous?.healthScore ?? null;
  const healthScoreDelta =
    input.healthScore === null || previousScore === null
      ? null
      : input.healthScore - previousScore;

  await AuditScheduleRepository.updateRun(run.id, {
    status: "completed",
    completedAt: new Date().toISOString(),
    pagesCrawled: input.pagesCrawled,
    pagesBlocked: input.pagesBlocked,
    pagesWithErrors: input.errorPages,
    pagesWithWarnings: input.warningPages,
    pagesWithNotices: input.noticePages,
    healthScore: input.healthScore,
    healthScoreDelta,
    truncated: input.truncated,
  });

  const issueCounts = await getIssueTypePageCountsForAudit(input.auditId);
  await AuditScheduleRepository.replaceRunIssueCounts(run.id, issueCounts);
}

/** Records the archive prefix once the R2 shards for a run are written. */
export async function recordScheduleRunArchive(
  auditId: string,
  prefix: string,
): Promise<void> {
  const run = await AuditScheduleRepository.getRunByAuditId(auditId);
  if (!run) return;
  await AuditScheduleRepository.updateRun(run.id, { rawR2Prefix: prefix });
}

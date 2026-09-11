/**
 * The site audit's finalize phase: cross-page and link-graph checks, the optional
 * R2 crawl archive, and the completion step that scores the audit and tears the
 * crawl scratchpad down.
 *
 * Split out of siteAuditWorkflowPhases.ts (which keeps discovery and Lighthouse)
 * for the same reason siteAuditWorkflowCrawl.ts is its own file: one phase per
 * module keeps each readable.
 */
import type { WorkflowStep } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getSiteHealthInputsForAudit } from "@/server/features/audit/repositories/auditSummaryQueries";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  finishScheduleRun,
  recordScheduleRunArchive,
} from "@/server/features/audit-schedules/services/scheduleRunCompletion";
import { archiveCrawl } from "@/server/lib/audit/archive";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";
import type { DetectedIssue } from "@/server/lib/audit/issues/page-reporters";
import type { AuditConfig } from "@/server/lib/audit/types";
import { normalizeUrl } from "@/server/lib/audit/url-utils";
import { captureServerEvent } from "@/server/lib/posthog";
import { computeSiteHealth } from "@/shared/site-health";
import type { CrawlPhaseResult } from "@/server/workflows/siteAuditWorkflowCrawl";
import { pgStep } from "@/server/workflows/pgStep";
import {
  ARCHIVE_STEP,
  DB_STEP,
  MULTIPAGE_CHECKS_STEP,
} from "@/server/workflows/auditStepConfigs";

export async function finalizeAudit(args: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  crawl: CrawlPhaseResult;
  archive: boolean;
}) {
  const {
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
    archive,
  } = args;
  // The crawl stops at maxPages, so an unfinished frontier means we scored (and
  // are archiving) a sample of the site rather than all of it.
  const truncated = !crawl.completed;

  await pgStep(step, "multipage-checks", MULTIPAGE_CHECKS_STEP, async () => {
    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      currentPhase: "finalizing",
    });

    // Integrity guard: pages are persisted inside crawl-chunk steps. If the
    // crawl claims pages but the DB has none, fail loudly instead of
    // completing with an empty audit.
    if (
      crawl.pagesCrawled > 0 &&
      !(await AuditRepository.hasPagesForAudit(auditId))
    ) {
      throw new Error(
        `Audit ${auditId}: crawl reported ${crawl.pagesCrawled} pages but none were persisted`,
      );
    }

    const issues = await runMultipageChecks({ auditId });
    issues.push(...(await runScratchpadLinkChecks(auditId, startUrl, crawl)));
    await AuditRepository.insertIssues(auditId, issues);
    return { issueCount: issues.length };
  });

  // Archived before finalize so destroy() — which drops the link edges the
  // archive reads — still happens in the finalize step, and only for scheduled
  // audits. A persistent failure here is logged rather than thrown: the step has
  // its own retries, and losing cold storage must not turn a completed crawl
  // into a failed audit.
  if (archive) {
    try {
      await pgStep(step, "archive-crawl", ARCHIVE_STEP, async () => {
        const project = await ProjectRepository.getProjectById(projectId);
        if (!project) {
          throw new Error(`Audit ${auditId}: project ${projectId} is gone`);
        }
        const health = await computeAuditHealth(auditId, truncated);
        const { prefix, manifest } = await archiveCrawl({
          auditId,
          projectId,
          organizationId: project.organizationId,
          startUrl,
          healthScore: health.score,
          pagesConsidered: health.pagesConsidered,
          truncated,
        });
        await recordScheduleRunArchive(auditId, prefix);
        return { prefix, counts: manifest.counts };
      });
    } catch (error) {
      console.error(`Audit ${auditId}: crawl archive failed:`, error);
    }
  }

  await pgStep(step, "finalize", DB_STEP, async () => {
    const blockedPages = await AuditRepository.countBlockedPages(auditId);
    const health = await computeAuditHealth(auditId, truncated);
    await AuditRepository.completeAudit(auditId, workflowInstanceId, {
      pagesCrawled: crawl.pagesCrawled,
      pagesTotal: crawl.pagesCrawled,
      healthScore: health.score,
      pagesConsidered: health.pagesConsidered,
    });
    // No-op for a manual audit; stamps the score, counts and delta onto the
    // schedule run row when this crawl was started by a schedule.
    await finishScheduleRun({
      auditId,
      pagesCrawled: crawl.pagesCrawled,
      pagesBlocked: blockedPages,
      healthScore: health.score,
      errorPages: health.errorPages,
      warningPages: health.warningPages,
      noticePages: health.noticePages,
      truncated,
    });
    await captureServerEvent({
      distinctId: billingCustomer.userId,
      event: "site_audit:complete",
      organizationId: billingCustomer.organizationId,
      properties: {
        project_id: projectId,
        status: "completed",
        pages_crawled: crawl.pagesCrawled,
        pages_total: crawl.pagesCrawled,
        crawl_completed: crawl.completed,
        pages_blocked: blockedPages,
        health_score: health.score,
        pages_considered: health.pagesConsidered,
        truncated,
        run_lighthouse: config.lighthouseStrategy !== "none",
      },
    });
    await AuditProgressKV.clear(auditId);
    // Crawl scratch state (frontier, links, mirror) is no longer needed.
    await getAuditScratchpad(auditId).destroy();
  });
}

/**
 * The two finalize checks that need link edges run as SQL inside the
 * audit's scratchpad DO; map their rows onto DetectedIssue.
 */
async function runScratchpadLinkChecks(
  auditId: string,
  startUrl: string,
  crawl: CrawlPhaseResult,
): Promise<DetectedIssue[]> {
  const scratchpad = getAuditScratchpad(auditId);
  const { brokenLinks, orphanPages } = await scratchpad.runFinalizeChecks({
    // Page rows store normalized URLs; normalize the start URL the same way
    // so the orphan exclusion matches.
    startUrl: normalizeUrl(startUrl) ?? startUrl,
    // Orphan detection only makes sense when the crawl wasn't truncated.
    crawlCompleted: crawl.completed,
  });

  return [
    ...brokenLinks.map((row) => ({
      issueType: "broken-internal-link" as const,
      pageId: row.sourcePageId,
      pageUrl: row.sourceUrl,
      dedupeKey: row.targetUrl,
      details: { targetUrl: row.targetUrl, targetStatus: row.targetStatus },
    })),
    ...orphanPages.map((row) => ({
      issueType: "orphan-page" as const,
      pageId: row.pageId,
      pageUrl: row.url,
    })),
  ];
}

/**
 * Site Health for one audit: the page/issue counts from a single aggregate query
 * plus the score derived from them.
 *
 * Read (rather than passed between steps) by both the archive and finalize steps
 * so each stays self-contained on a retry — the query is one aggregate over rows
 * that are already final by this point, so it returns the same answer to both.
 */
async function computeAuditHealth(auditId: string, truncated: boolean) {
  const inputs = await getSiteHealthInputsForAudit(auditId);
  return { ...inputs, ...computeSiteHealth({ ...inputs, truncated }) };
}

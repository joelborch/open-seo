/**
 * Cron body for scheduled crawls: start a site audit for every schedule cadence
 * that is due, then trim each touched schedule's retained audits. Wrapped in
 * `withPgClient` at the entrypoint (src/server.ts), same as the rank-check loop.
 */
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { hasRunningAuditForProject } from "@/server/features/audit/repositories/auditSummaryQueries";
import { AuditService } from "@/server/features/audit/services/AuditService";
import {
  AUDIT_LIMITS,
  type AuditLimitTier,
} from "@/server/features/audit/services/audit-capacity";
import { AuditScheduleRepository } from "@/server/features/audit-schedules/repositories/AuditScheduleRepository";
import {
  computeNextDeepAt,
  computeNextQuickAt,
} from "@/shared/audit-schedules";

/**
 * Crawl work admitted per tick, in page units (a schedule's max_pages).
 * Admission control rather than a hard limit: the first start of a tick is
 * always admitted, so a schedule bigger than the whole budget (legal max: 10,000
 * pages) can never starve. Crawling is our own Workers compute, and each audit
 * is its own Workflow instance that paces itself in ~200-page chunks — the budget
 * exists to keep one tick from launching dozens of long-lived instances at once,
 * not to ration a metered provider. Unadmitted schedules stay due and the next
 * tick resumes oldest-first.
 */
const SCHEDULED_PAGE_BUDGET = 2_000;
/**
 * Wall-clock guard for the per-schedule loop: sub-hourly crons are killed at 15
 * minutes and this loop shares the tick with the rank-check loop. Stopping early
 * is safe — unclaimed schedules are still due next tick.
 */
const TICK_DEADLINE_MS = 2 * 60_000;
/** Completed audits kept per schedule, per cadence. */
const RETAINED_QUICK_AUDITS = 8;
const RETAINED_DEEP_AUDITS = 12;

/** The scheduler acts as itself, not as any member of the org. */
function systemBillingCustomer(input: {
  organizationId: string;
  projectId: string;
}): BillingCustomerContext {
  return {
    userId: "system",
    userEmail: "system@openseo.so",
    organizationId: input.organizationId,
    projectId: input.projectId,
  };
}

// Takes no Env: unlike the rank-check loop, nothing here needs a binding passed
// in — AuditService reaches SITE_AUDIT_WORKFLOW through the ambient
// `cloudflare:workers` env.
export async function runScheduledCrawls() {
  const nowIso = new Date().toISOString();
  const due = await AuditScheduleRepository.getDueSchedules(nowIso);

  // Function-local so it lives exactly one tick: at module scope this would be
  // cross-invocation global state in Workers, and a rejection would be cached
  // forever. Within a tick a rejection staying memoized is intentional — one
  // billing round trip per org, and that org's schedules simply stay due.
  const tierChecks = new Map<string, Promise<AuditLimitTier>>();
  const resolveTier = (customer: BillingCustomerContext) => {
    let check = tierChecks.get(customer.organizationId);
    if (!check) {
      check = AuditService.resolveAuditLimitTier(customer);
      tierChecks.set(customer.organizationId, check);
    }
    return check;
  };

  const deadline = Date.now() + TICK_DEADLINE_MS;
  const purgeScheduleIds = new Set<string>();
  let pagesAdmitted = 0;
  let started = 0;
  let stoppedByBudget = false;
  let stoppedByDeadline = false;
  let skippedAlreadyRunning = 0;
  let concurrentChangeSkips = 0;
  let tierErrors = 0;
  let startErrors = 0;
  let scheduleErrors = 0;
  let purgeErrors = 0;
  let purgedAudits = 0;

  for (const schedule of due) {
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    // Per-schedule containment: one bad row (a malformed cursor sorts first and
    // would head every scan) must not starve the tick or suppress the summary.
    try {
      // Projected stop: admit only what fits. The first start is exempt so an
      // oversized schedule can never starve.
      if (
        started > 0 &&
        pagesAdmitted + schedule.maxPages > SCHEDULED_PAGE_BUDGET
      ) {
        stoppedByBudget = true;
        break;
      }

      const nextDueAt =
        schedule.cadence === "quick"
          ? computeNextQuickAt(schedule.hourUtc, schedule.dueAt)
          : computeNextDeepAt(
              schedule.dowUtc,
              schedule.hourUtc,
              schedule.dueAt,
            );
      const customer = systemBillingCustomer(schedule);

      // A crawl already in flight for this project means the site is being
      // crawled anyway, so this slot is genuinely skipped (cursor advanced)
      // rather than retried: two concurrent crawls of one origin would compete
      // for the same budget and produce two half-crawls.
      if (await hasRunningAuditForProject(schedule.projectId)) {
        const claimed = await AuditScheduleRepository.claimDueSchedule({
          scheduleId: schedule.scheduleId,
          cadence: schedule.cadence,
          observedDueAt: schedule.dueAt,
          nextDueAt,
          lastSkipReason: "already_running",
        });
        if (!claimed) {
          concurrentChangeSkips++;
          continue;
        }
        await AuditScheduleRepository.insertRun({
          id: crypto.randomUUID(),
          scheduleId: schedule.scheduleId,
          projectId: schedule.projectId,
          auditId: null,
          cadence: schedule.cadence,
          status: "skipped",
          skipReason: "already_running",
        });
        skippedAlreadyRunning++;
        continue;
      }

      let limitTier: AuditLimitTier;
      try {
        limitTier = await resolveTier(customer);
      } catch (err) {
        // Never write the cursor on an error: it is the schedule anchor, so an
        // error write would permanently shift this project's slot and herd-sync
        // schedules after an outage. Leaving the row due is the retry.
        tierErrors++;
        console.error(
          `[cron] Audit plan check failed for schedule ${schedule.scheduleId} (project ${schedule.projectId}):`,
          err,
        );
        continue;
      }

      // Clamp rather than reject: a plan downgrade shouldn't silently stop a
      // schedule the user configured while on a bigger plan.
      const maxPages = Math.min(
        schedule.maxPages,
        AUDIT_LIMITS[limitTier].maxPagesPerAudit,
      );

      // Claim the slot before starting, and clear the skip badge — an unblocked
      // schedule should stop showing "already running".
      const claimed = await AuditScheduleRepository.claimDueSchedule({
        scheduleId: schedule.scheduleId,
        cadence: schedule.cadence,
        observedDueAt: schedule.dueAt,
        nextDueAt,
        lastSkipReason: null,
      });
      if (!claimed) {
        concurrentChangeSkips++;
        continue;
      }

      let result;
      try {
        result = await AuditService.startAudit({
          actorUserId: "system",
          billingCustomer: customer,
          projectId: schedule.projectId,
          startUrl: schedule.startUrl,
          maxPages,
          lighthouseStrategy: schedule.lighthouse ? "auto" : "none",
          limitTier,
          archive: true,
        });
      } catch (err) {
        // Leave the cursor advanced: a systemic Workflows outage must not make
        // every schedule due again on the next tick. The failed run row is the
        // durable trace the history table shows.
        startErrors++;
        console.error(
          `[cron] Failed to start scheduled audit for schedule ${schedule.scheduleId} (project ${schedule.projectId}):`,
          err,
        );
        await AuditScheduleRepository.insertRun({
          id: crypto.randomUUID(),
          scheduleId: schedule.scheduleId,
          projectId: schedule.projectId,
          auditId: null,
          cadence: schedule.cadence,
          status: "failed",
          skipReason: "start_failed",
        });
        continue;
      }

      await AuditScheduleRepository.insertRun({
        id: crypto.randomUUID(),
        scheduleId: schedule.scheduleId,
        projectId: schedule.projectId,
        auditId: result.auditId,
        cadence: schedule.cadence,
        status: "running",
      });
      pagesAdmitted += maxPages;
      started++;
      purgeScheduleIds.add(schedule.scheduleId);
    } catch (err) {
      scheduleErrors++;
      console.error(
        `[cron] Error processing audit schedule ${schedule.scheduleId} (project ${schedule.projectId}):`,
        err,
      );
    }
  }

  // Retention runs for the schedules touched this tick, so the sweep is bounded
  // by what we just started rather than by the whole table. The audits being
  // trimmed are the ones that completed a cadence ago, not the ones started
  // above.
  for (const scheduleId of purgeScheduleIds) {
    if (Date.now() >= deadline) break;
    try {
      purgedAudits += await purgeOldAudits(scheduleId);
    } catch (err) {
      purgeErrors++;
      console.error(
        `[cron] Audit purge failed for schedule ${scheduleId}:`,
        err,
      );
    }
  }

  const oldestDue = due[0]?.dueAt;
  // Object argument (not an interpolated string) so Workers Logs indexes the
  // fields. Error level when anything failed, so ticks that need attention
  // surface in error-filtered views.
  const logSummary =
    tierErrors + startErrors + scheduleErrors + purgeErrors > 0
      ? console.error
      : console.log;
  logSummary({
    event: "audit_scheduler_summary",
    candidates: due.length,
    started,
    pagesAdmitted,
    budget: SCHEDULED_PAGE_BUDGET,
    stoppedByBudget,
    stoppedByDeadline,
    skippedAlreadyRunning,
    concurrentChangeSkips,
    tierErrors,
    startErrors,
    scheduleErrors,
    purgedAudits,
    purgeErrors,
    oldestDueAgeMs: oldestDue
      ? Date.now() - new Date(oldestDue).getTime()
      : null,
  });
}

/**
 * Trim a schedule's completed audits to the retention window, newest kept.
 *
 * Deleting the `audits` row cascades its pages, issues and Lighthouse rows; the
 * run row survives with a null audit_id, so the health trend keeps its history
 * after the crawl detail is gone. Archived R2 shards are deliberately untouched —
 * cold storage outliving the database row is the point of the archive.
 */
async function purgeOldAudits(scheduleId: string): Promise<number> {
  const stale = [
    ...(await AuditScheduleRepository.getPurgeableAuditIds({
      scheduleId,
      cadence: "quick",
      keep: RETAINED_QUICK_AUDITS,
    })),
    ...(await AuditScheduleRepository.getPurgeableAuditIds({
      scheduleId,
      cadence: "deep",
      keep: RETAINED_DEEP_AUDITS,
    })),
  ];
  if (stale.length === 0) return 0;
  await AuditScheduleRepository.deleteAudits(stale);
  return stale.length;
}

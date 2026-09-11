/**
 * Read/write side of scheduled crawls — everything the audit page's Schedule
 * panel calls. The cron loop lives in scheduledCrawls.ts.
 */
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AuditScheduleRepository } from "@/server/features/audit-schedules/repositories/AuditScheduleRepository";
import {
  AUDIT_LIMITS,
  type AuditLimitTier,
} from "@/server/features/audit/services/audit-capacity";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { AppError } from "@/server/lib/errors";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import {
  computeNextDeepAt,
  computeNextQuickAt,
} from "@/shared/audit-schedules";

/** Runs shown in the history table. */
const HISTORY_RUNS = 30;

type AuditScheduleInput = {
  startUrl: string;
  quickEnabled: boolean;
  quickMaxPages: number;
  quickHourUtc: number;
  deepEnabled: boolean;
  deepMaxPages: number;
  deepDowUtc: number;
  deepHourUtc: number;
  deepLighthouse: boolean;
};

async function getSchedule(projectId: string) {
  return (
    (await AuditScheduleRepository.getScheduleForProject(projectId)) ?? null
  );
}

async function upsertSchedule(input: {
  projectId: string;
  billingCustomer: BillingCustomerContext;
  schedule: AuditScheduleInput;
}) {
  const { schedule } = input;
  const limitTier = await AuditService.resolveAuditLimitTier(
    input.billingCustomer,
  );
  assertWithinTier(schedule, limitTier);

  // Same SSRF/protocol gate a manual audit goes through, applied at save time so
  // a bad URL fails in the form rather than silently every night.
  const startUrl = await normalizeAndValidateStartUrl(schedule.startUrl);
  const existing = await AuditScheduleRepository.getScheduleForProject(
    input.projectId,
  );

  await AuditScheduleRepository.upsertSchedule({
    id: existing?.id ?? crypto.randomUUID(),
    projectId: input.projectId,
    startUrl,
    quickEnabled: schedule.quickEnabled,
    quickMaxPages: schedule.quickMaxPages,
    quickHourUtc: schedule.quickHourUtc,
    // Passing the existing cursor as the anchor keeps a schedule on its current
    // slot across saves that don't move the hour; computeNextQuickAt ignores an
    // anchor that no longer matches the configured hour.
    nextQuickAt: schedule.quickEnabled
      ? computeNextQuickAt(schedule.quickHourUtc, existing?.nextQuickAt)
      : null,
    deepEnabled: schedule.deepEnabled,
    deepMaxPages: schedule.deepMaxPages,
    deepDowUtc: schedule.deepDowUtc,
    deepHourUtc: schedule.deepHourUtc,
    deepLighthouse: schedule.deepLighthouse,
    nextDeepAt: schedule.deepEnabled
      ? computeNextDeepAt(
          schedule.deepDowUtc,
          schedule.deepHourUtc,
          existing?.nextDeepAt,
        )
      : null,
  });

  return getSchedule(input.projectId);
}

async function setActive(projectId: string, isActive: boolean) {
  const existing =
    await AuditScheduleRepository.getScheduleForProject(projectId);
  if (!existing)
    throw new AppError("NOT_FOUND", "No schedule for this project.");
  await AuditScheduleRepository.setScheduleActive(projectId, isActive);
  return getSchedule(projectId);
}

async function getHistory(projectId: string) {
  const schedule =
    await AuditScheduleRepository.getScheduleForProject(projectId);
  if (!schedule) return [];
  return AuditScheduleRepository.getRunHistory(schedule.id, HISTORY_RUNS);
}

/**
 * The per-audit page ceiling is a plan limit, so a schedule can't be saved
 * asking for more than the org's tier allows — otherwise the scheduler would
 * quietly clamp it every night and the configured number would be a lie.
 */
function assertWithinTier(
  schedule: AuditScheduleInput,
  limitTier: AuditLimitTier,
) {
  const { maxPagesPerAudit } = AUDIT_LIMITS[limitTier];
  if (
    schedule.quickMaxPages > maxPagesPerAudit ||
    schedule.deepMaxPages > maxPagesPerAudit
  ) {
    throw new AppError("AUDIT_PAGE_LIMIT_EXCEEDED");
  }
}

export const AuditScheduleService = {
  getSchedule,
  upsertSchedule,
  setActive,
  getHistory,
} as const;

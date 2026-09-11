import { z } from "zod";
import {
  DEFAULT_AUDIT_PAGES,
  MIN_AUDIT_PAGES,
  PAID_MAX_AUDIT_PAGES,
} from "@/shared/audit-limits";

// ─── Server function input schemas ──────────────────────────────────────────

export const startAuditSchema = z.object({
  projectId: z.string().min(1),
  startUrl: z.string().min(1, "URL is required").max(2048),
  maxPages: z
    .number()
    .int()
    .min(MIN_AUDIT_PAGES)
    .max(PAID_MAX_AUDIT_PAGES)
    .optional()
    .default(DEFAULT_AUDIT_PAGES),
  lighthouseStrategy: z.enum(["auto", "none"]).optional().default("auto"),
});

export const getAuditStatusSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

export const getAuditResultsSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

export const getAuditHistorySchema = z.object({
  projectId: z.string().min(1),
});

export const deleteAuditSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

export const getCrawlProgressSchema = z.object({
  projectId: z.string().min(1),
  auditId: z.string().min(1),
});

// ─── URL search params schema for /p/$projectId/audit ────────────────────────

const auditTabs = ["issues", "pages", "performance"] as const;

export const auditSearchSchema = z.object({
  auditId: z.string().optional().catch(undefined),
  tab: z.enum(auditTabs).catch("issues").default("issues"),
});

// ─── Scheduled crawls ───────────────────────────────────────────────────────

// Tier limits are enforced server-side (AuditScheduleService.assertWithinTier);
// this bound is the technical ceiling shared with the manual launch form.
const scheduleMaxPages = z
  .number()
  .int()
  .min(MIN_AUDIT_PAGES)
  .max(PAID_MAX_AUDIT_PAGES);
const hourUtc = z.number().int().min(0).max(23);

export const getAuditScheduleSchema = z.object({
  projectId: z.string().min(1),
});

export const upsertAuditScheduleSchema = z.object({
  projectId: z.string().min(1),
  startUrl: z.string().min(1, "URL is required").max(2048),
  quickEnabled: z.boolean(),
  quickMaxPages: scheduleMaxPages,
  quickHourUtc: hourUtc,
  deepEnabled: z.boolean(),
  deepMaxPages: scheduleMaxPages,
  // 0 = Sunday, matching JS `Date#getUTCDay`.
  deepDowUtc: z.number().int().min(0).max(6),
  deepHourUtc: hourUtc,
  deepLighthouse: z.boolean(),
});

export const setAuditScheduleActiveSchema = z.object({
  projectId: z.string().min(1),
  isActive: z.boolean(),
});

export const getAuditScheduleHistorySchema = z.object({
  projectId: z.string().min(1),
});

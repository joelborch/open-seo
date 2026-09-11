/**
 * Data access for scheduled crawls: the per-project schedule row, its run
 * history, and the per-run issue rollup. Provider-aware (D1 or Postgres) via the
 * `@/db` handle, like every other repository.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
} from "drizzle-orm";
import { sort } from "remeda";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  auditRunIssueCounts,
  auditScheduleRuns,
  auditSchedules,
  audits,
  projects,
} from "@/db/schema";
import type {
  AuditCadence,
  AuditScheduleSkipReason,
} from "@/shared/audit-schedules";

/**
 * Schedules examined per cron tick. The page-unit budget in the service is the
 * real admission control; this only bounds the query, and unclaimed schedules
 * stay due for the next tick.
 */
const DUE_SCHEDULES_PER_TICK = 50;
/** Bound on one purge pass, so a long-neglected schedule can't stall a tick. */
const PURGE_CANDIDATES_PER_PASS = 100;
/** Ids per DELETE … IN (…) — D1 caps bound parameters per statement at ~100. */
const DELETE_ID_CHUNK = 50;

type DueAuditScheduleBase = {
  scheduleId: string;
  projectId: string;
  organizationId: string;
  startUrl: string;
  /** The cursor value we read — the CAS token for claimDueSchedule. */
  dueAt: string;
  maxPages: number;
  lighthouse: boolean;
  /** The cadence's configured UTC hour, for the next-slot computation. */
  hourUtc: number;
};

/**
 * A due cadence, carrying only that cadence's settings. Split on `cadence` so
 * the caller's next-slot computation gets `dowUtc` exactly when it needs it
 * (weekly) and cannot read it when it does not exist (daily).
 */
type DueAuditSchedule = DueAuditScheduleBase &
  ({ cadence: "quick" } | { cadence: "deep"; dowUtc: number });

async function getScheduleForProject(projectId: string) {
  return db.query.auditSchedules.findFirst({
    where: eq(auditSchedules.projectId, projectId),
  });
}

/**
 * Create or replace a project's schedule. One row per project (enforced by the
 * unique index on project_id), so the conflict target is project_id rather than
 * the id the caller minted for a first insert.
 */
async function upsertSchedule(input: {
  id: string;
  projectId: string;
  startUrl: string;
  quickEnabled: boolean;
  quickMaxPages: number;
  quickHourUtc: number;
  nextQuickAt: string | null;
  deepEnabled: boolean;
  deepMaxPages: number;
  deepDowUtc: number;
  deepHourUtc: number;
  deepLighthouse: boolean;
  nextDeepAt: string | null;
}) {
  const { id: _id, projectId: _projectId, ...editable } = input;
  await db
    .insert(auditSchedules)
    .values({ ...input, isActive: true })
    .onConflictDoUpdate({
      target: auditSchedules.projectId,
      set: {
        ...editable,
        isActive: true,
        // A saved edit clears a stale badge; the scheduler re-writes a reason on
        // its next skip.
        lastSkipReason: null,
        updatedAt: new Date().toISOString(),
      },
    });
}

async function setScheduleActive(projectId: string, isActive: boolean) {
  await db
    .update(auditSchedules)
    .set({ isActive, updatedAt: new Date().toISOString() })
    .where(eq(auditSchedules.projectId, projectId));
}

/**
 * Due schedules for this tick, one entry per due cadence, oldest first.
 *
 * Two queries rather than one: the two cadences live in different columns of the
 * same row, and ordering across them in SQL would need `min`/`least`, which
 * differ between SQLite and Postgres. A project whose quick and deep slots are
 * both due yields two entries — the second is skipped as `already_running`
 * behind the first and retried on a later tick, which is the behavior we want.
 */
async function getDueSchedules(nowIso: string): Promise<DueAuditSchedule[]> {
  const [quick, deep] = await Promise.all([
    db
      .select({
        scheduleId: auditSchedules.id,
        projectId: auditSchedules.projectId,
        organizationId: projects.organizationId,
        startUrl: auditSchedules.startUrl,
        dueAt: auditSchedules.nextQuickAt,
        maxPages: auditSchedules.quickMaxPages,
        hourUtc: auditSchedules.quickHourUtc,
      })
      .from(auditSchedules)
      .innerJoin(projects, eq(auditSchedules.projectId, projects.id))
      .where(
        and(
          eq(auditSchedules.isActive, true),
          eq(auditSchedules.quickEnabled, true),
          lte(auditSchedules.nextQuickAt, nowIso),
          isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(auditSchedules.nextQuickAt), asc(auditSchedules.id))
      .limit(DUE_SCHEDULES_PER_TICK),
    db
      .select({
        scheduleId: auditSchedules.id,
        projectId: auditSchedules.projectId,
        organizationId: projects.organizationId,
        startUrl: auditSchedules.startUrl,
        dueAt: auditSchedules.nextDeepAt,
        maxPages: auditSchedules.deepMaxPages,
        lighthouse: auditSchedules.deepLighthouse,
        hourUtc: auditSchedules.deepHourUtc,
        dowUtc: auditSchedules.deepDowUtc,
      })
      .from(auditSchedules)
      .innerJoin(projects, eq(auditSchedules.projectId, projects.id))
      .where(
        and(
          eq(auditSchedules.isActive, true),
          eq(auditSchedules.deepEnabled, true),
          lte(auditSchedules.nextDeepAt, nowIso),
          isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(auditSchedules.nextDeepAt), asc(auditSchedules.id))
      .limit(DUE_SCHEDULES_PER_TICK),
  ]);

  // `lte` already excludes NULL cursors, so dueAt is non-null on both sides.
  const due: DueAuditSchedule[] = [
    ...quick.map((row) => ({
      ...row,
      dueAt: row.dueAt ?? "",
      cadence: "quick" as const,
      lighthouse: false,
    })),
    ...deep.map((row) => ({
      ...row,
      dueAt: row.dueAt ?? "",
      cadence: "deep" as const,
    })),
  ];

  return sort(
    due,
    (a, b) =>
      a.dueAt.localeCompare(b.dueAt) ||
      a.scheduleId.localeCompare(b.scheduleId),
  ).slice(0, DUE_SCHEDULES_PER_TICK);
}

/**
 * Conditionally advance one cadence's cursor, returning false when the schedule
 * changed underneath us (an edit, or a deactivation). The observed cursor value
 * is the compare-and-set token, exactly as claimDueConfig does for rank checks.
 *
 * `lastSkipReason` is written only when passed — the restore path omits it so it
 * cannot clobber a reason written in the meantime.
 */
async function claimDueSchedule(input: {
  scheduleId: string;
  cadence: AuditCadence;
  observedDueAt: string;
  nextDueAt: string;
  lastSkipReason?: AuditScheduleSkipReason | null;
}): Promise<boolean> {
  const cursor =
    input.cadence === "quick"
      ? auditSchedules.nextQuickAt
      : auditSchedules.nextDeepAt;
  const claimed = await db
    .update(auditSchedules)
    .set({
      ...(input.cadence === "quick"
        ? { nextQuickAt: input.nextDueAt }
        : { nextDeepAt: input.nextDueAt }),
      ...(input.lastSkipReason !== undefined && {
        lastSkipReason: input.lastSkipReason,
      }),
    })
    .where(
      and(
        eq(auditSchedules.id, input.scheduleId),
        eq(auditSchedules.isActive, true),
        eq(cursor, input.observedDueAt),
      ),
    )
    .returning({ id: auditSchedules.id });
  return claimed.length > 0;
}

async function insertRun(data: {
  id: string;
  scheduleId: string;
  projectId: string;
  auditId: string | null;
  cadence: AuditCadence;
  status: "running" | "skipped" | "failed";
  skipReason?: string | null;
}) {
  await db.insert(auditScheduleRuns).values(data);
}

async function updateRun(
  runId: string,
  data: {
    status?: "running" | "completed" | "failed" | "skipped";
    completedAt?: string;
    pagesCrawled?: number;
    pagesWithErrors?: number;
    pagesWithWarnings?: number;
    pagesWithNotices?: number;
    pagesBlocked?: number;
    healthScore?: number | null;
    healthScoreDelta?: number | null;
    truncated?: boolean;
    rawR2Prefix?: string;
  },
) {
  await db
    .update(auditScheduleRuns)
    .set(data)
    .where(eq(auditScheduleRuns.id, runId));
}

/** The run an audit belongs to, or null for a manually started audit. */
async function getRunByAuditId(auditId: string) {
  return db.query.auditScheduleRuns.findFirst({
    where: eq(auditScheduleRuns.auditId, auditId),
  });
}

/**
 * The most recent scored run of the same cadence before this one — the baseline
 * for health_score_delta. Cadence-matched because a 100-page quick crawl and a
 * 500-page deep crawl score different samples of the site, so comparing across
 * them would report movement that never happened.
 */
async function getPreviousScoredRun(input: {
  scheduleId: string;
  cadence: AuditCadence;
  beforeTriggeredAt: string;
}) {
  return db.query.auditScheduleRuns.findFirst({
    where: and(
      eq(auditScheduleRuns.scheduleId, input.scheduleId),
      eq(auditScheduleRuns.cadence, input.cadence),
      eq(auditScheduleRuns.status, "completed"),
      isNotNull(auditScheduleRuns.healthScore),
      lt(auditScheduleRuns.triggeredAt, input.beforeTriggeredAt),
    ),
    orderBy: desc(auditScheduleRuns.triggeredAt),
  });
}

/** Replace a run's issue rollup. Idempotent: the finalize step can retry. */
async function replaceRunIssueCounts(
  runId: string,
  rows: { issueType: string; severity: string; pages: number }[],
) {
  await db
    .delete(auditRunIssueCounts)
    .where(eq(auditRunIssueCounts.runId, runId));
  await executeInBatches(rows, (tx, row) =>
    tx.insert(auditRunIssueCounts).values({ runId, ...row }),
  );
}

async function getRunHistory(scheduleId: string, limit: number) {
  const runs = await db
    .select()
    .from(auditScheduleRuns)
    .where(eq(auditScheduleRuns.scheduleId, scheduleId))
    .orderBy(desc(auditScheduleRuns.triggeredAt))
    .limit(limit);

  if (runs.length === 0) return [];

  const counts = await db
    .select()
    .from(auditRunIssueCounts)
    .where(
      inArray(
        auditRunIssueCounts.runId,
        runs.map((run) => run.id),
      ),
    );

  return runs.map((run) => ({
    ...run,
    issueCounts: counts
      .filter((count) => count.runId === run.id)
      .map((count) => ({
        issueType: count.issueType,
        severity: count.severity,
        pages: count.pages,
      })),
  }));
}

/**
 * Audit ids past the retention window for one cadence. Deleting the `audits` row
 * cascades its pages, issues and Lighthouse results away; the run row survives
 * with audit_id NULL (ON DELETE SET NULL), so the health history stays readable
 * after the crawl detail is gone.
 */
async function getPurgeableAuditIds(input: {
  scheduleId: string;
  cadence: AuditCadence;
  keep: number;
}): Promise<string[]> {
  const rows = await db
    .select({ auditId: auditScheduleRuns.auditId })
    .from(auditScheduleRuns)
    .where(
      and(
        eq(auditScheduleRuns.scheduleId, input.scheduleId),
        eq(auditScheduleRuns.cadence, input.cadence),
        eq(auditScheduleRuns.status, "completed"),
        isNotNull(auditScheduleRuns.auditId),
      ),
    )
    .orderBy(desc(auditScheduleRuns.triggeredAt))
    .limit(PURGE_CANDIDATES_PER_PASS)
    .offset(input.keep);

  return rows.flatMap((row) => (row.auditId === null ? [] : [row.auditId]));
}

async function deleteAudits(auditIds: string[]) {
  for (let i = 0; i < auditIds.length; i += DELETE_ID_CHUNK) {
    await db
      .delete(audits)
      .where(inArray(audits.id, auditIds.slice(i, i + DELETE_ID_CHUNK)));
  }
}

export const AuditScheduleRepository = {
  getScheduleForProject,
  upsertSchedule,
  setScheduleActive,
  getDueSchedules,
  claimDueSchedule,
  insertRun,
  updateRun,
  getRunByAuditId,
  getPreviousScoredRun,
  replaceRunIssueCounts,
  getRunHistory,
  getPurgeableAuditIds,
  deleteAudits,
} as const;

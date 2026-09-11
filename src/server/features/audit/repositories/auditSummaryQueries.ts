import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  isNotNull,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { auditIssues, auditPages, audits } from "@/db/schema";

/**
 * Aggregate and single-fact audit queries that live beside AuditRepository
 * (same pattern as rank-tracking's snapshotQueries) to keep the main repository
 * under the file-size limit.
 */

/**
 * Distinct-page counts per issue type for one audit — link-level issues
 * write one row per occurrence, and consumers phrase this as "N pages".
 */
export async function getIssueTypePageCountsForAudit(auditId: string) {
  return db
    .select({
      issueType: auditIssues.issueType,
      severity: auditIssues.severity,
      pages: countDistinct(auditIssues.pageUrl),
    })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, auditId))
    .groupBy(auditIssues.issueType, auditIssues.severity);
}

/**
 * The four counts `computeSiteHealth` needs, in one round trip.
 *
 * `pagesConsidered` is the denominator: pages we actually fetched (fetch_class
 * 'ok') and that are indexable — blocked/errored fetches and noindex pages are
 * neither scoreable nor the site's fault to the same degree. The severity
 * counts partition DISTINCT page urls by their WORST issue, so a page with a
 * critical and a warning issue is one error page and not also a warning page;
 * without that a heavily-flagged page would be penalized several times over.
 */
export async function getSiteHealthInputsForAudit(auditId: string) {
  const worstPerPage = db
    .select({
      worst:
        sql<number>`min(case ${auditIssues.severity} when 'critical' then 0 when 'warning' then 1 else 2 end)`
          .mapWith(Number)
          .as("worst"),
    })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, auditId))
    .groupBy(auditIssues.pageUrl)
    .as("worst_per_page");

  const pagesConsidered = db
    .select({ pages: count() })
    .from(auditPages)
    .where(
      and(
        eq(auditPages.auditId, auditId),
        eq(auditPages.fetchClass, "ok"),
        eq(auditPages.isIndexable, true),
      ),
    );

  // Aggregates with no GROUP BY, so an audit with zero issues still returns one
  // row (all-zero severity counts) rather than none.
  const rows = await db
    .select({
      pagesConsidered: sql<number>`(${pagesConsidered})`.mapWith(Number),
      errorPages:
        sql<number>`count(case when ${worstPerPage.worst} = 0 then 1 end)`.mapWith(
          Number,
        ),
      warningPages:
        sql<number>`count(case when ${worstPerPage.worst} = 1 then 1 end)`.mapWith(
          Number,
        ),
      noticePages:
        sql<number>`count(case when ${worstPerPage.worst} = 2 then 1 end)`.mapWith(
          Number,
        ),
    })
    .from(worstPerPage);

  return (
    rows[0] ?? {
      pagesConsidered: 0,
      errorPages: 0,
      warningPages: 0,
      noticePages: 0,
    }
  );
}

/**
 * Health scores of a project's most recent scored audits, newest first — the
 * dashboard card's headline, its delta, and its sparkline.
 *
 * Read from `audits` rather than from schedule runs so a project that only ever
 * runs audits by hand still gets a trend.
 */
export async function getRecentHealthScoresForProject(
  projectId: string,
  limit: number,
) {
  const rows = await db
    .select({ healthScore: audits.healthScore })
    .from(audits)
    .where(
      and(
        eq(audits.projectId, projectId),
        eq(audits.status, "completed"),
        isNotNull(audits.healthScore),
      ),
    )
    .orderBy(desc(audits.startedAt))
    .limit(limit);

  return rows.flatMap((row) =>
    row.healthScore === null ? [] : [row.healthScore],
  );
}

/**
 * Is any audit still running for this project? The crawl scheduler checks this
 * before claiming a slot: a second concurrent crawl of the same site would
 * compete for the same origin's budget and produce two half-crawls.
 */
export async function hasRunningAuditForProject(
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: audits.id })
    .from(audits)
    .where(and(eq(audits.projectId, projectId), eq(audits.status, "running")))
    .limit(1);
  return rows.length > 0;
}

import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { auditIssues, auditPages } from "@/db/schema";

/**
 * Keyset readers for the R2 crawl archive (src/server/lib/audit/archive.ts).
 *
 * Keyset rather than OFFSET because a 10,000-page audit is paged ~10 times and
 * OFFSET re-scans from the start each time. `id` is the cursor: page and issue
 * ids are content-derived hashes (deterministicAuditRowId), so they are stable
 * across a workflow-step retry and unique within an audit — an archive part
 * rewritten on retry contains exactly the same rows.
 */

export async function getPageRowsForArchive(input: {
  auditId: string;
  afterId: string | null;
  limit: number;
}) {
  return db
    .select()
    .from(auditPages)
    .where(
      and(
        eq(auditPages.auditId, input.auditId),
        input.afterId === null ? undefined : gt(auditPages.id, input.afterId),
      ),
    )
    .orderBy(asc(auditPages.id))
    .limit(input.limit);
}

export async function getIssueRowsForArchive(input: {
  auditId: string;
  afterId: string | null;
  limit: number;
}) {
  return db
    .select()
    .from(auditIssues)
    .where(
      and(
        eq(auditIssues.auditId, input.auditId),
        input.afterId === null ? undefined : gt(auditIssues.id, input.afterId),
      ),
    )
    .orderBy(asc(auditIssues.id))
    .limit(input.limit);
}

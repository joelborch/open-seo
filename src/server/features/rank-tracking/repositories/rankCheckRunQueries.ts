import { and, desc, eq, inArray } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { rankCheckRuns } from "@/db/schema";

// Run-row CRUD for rank checks. Split out of RankTrackingRepository, which
// re-exports these; the partial unique index on
// (config_id) WHERE status IN ('pending','running') is what makes tryCreateRun
// the duplicate-trigger guard.

/**
 * Try to insert a new pending run. Returns true when inserted, or false if blocked
 * by the partial unique index on (config_id) WHERE status IN ('pending',
 * 'running') — i.e. another active run exists for this config.
 *
 * This is how duplicate-trigger protection is enforced: the DB rejects the
 * second insert rather than a separate lock table.
 */
export async function tryCreateRun(data: {
  id: string;
  configId: string;
  projectId: string;
  keywordsTotal: number;
  isSubsetRun?: boolean;
}) {
  const inserted = await db
    .insert(rankCheckRuns)
    .values({ ...data, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: rankCheckRuns.id });
  return Boolean(inserted[0]);
}

export async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof rankCheckRuns>>,
) {
  await db.update(rankCheckRuns).set(data).where(eq(rankCheckRuns.id, runId));
}

export async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(rankCheckRuns)
    .where(eq(rankCheckRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/** Recent runs for a config, newest first — the run-history read model. */
export async function getRunHistoryForConfig(configId: string, limit: number) {
  return db
    .select({
      id: rankCheckRuns.id,
      status: rankCheckRuns.status,
      trigger: rankCheckRuns.trigger,
      method: rankCheckRuns.method,
      keywordsTotal: rankCheckRuns.keywordsTotal,
      keywordsChecked: rankCheckRuns.keywordsChecked,
      spentCostMicros: rankCheckRuns.spentCostMicros,
      costStatus: rankCheckRuns.costStatus,
      startedAt: rankCheckRuns.startedAt,
      completedAt: rankCheckRuns.completedAt,
    })
    .from(rankCheckRuns)
    .where(eq(rankCheckRuns.configId, configId))
    .orderBy(desc(rankCheckRuns.startedAt))
    .limit(limit);
}

export async function getLatestRunForConfig(configId: string) {
  const rows = await db
    .select()
    .from(rankCheckRuns)
    .where(eq(rankCheckRuns.configId, configId))
    .orderBy(desc(rankCheckRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Returns the currently active (pending or running) run for a config, if any.
 * At most one such row exists, enforced by the partial unique index.
 */
export async function getActiveRunForConfig(configId: string) {
  const rows = await db
    .select()
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        inArray(rankCheckRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

import { and, eq, sql } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { rankCheckTasks } from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";

// The rank-check provider task ledger: one row per (run, keyword, device)
// DataForSEO task. Split out of RankTrackingRepository so the money-tracking
// statements sit together; they are re-exported through that repository.

/**
 * Insert ledger rows in state "reserved" — always before the provider request
 * that they account for, so a crash between submit and response still leaves a
 * record. Idempotent on (run, keyword, device) so a replayed step is a no-op.
 */
export async function reserveRankCheckTasks(
  rows: Array<InferInsertModel<typeof rankCheckTasks>>,
) {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(rankCheckTasks)
      .values(row)
      .onConflictDoNothing({
        target: [
          rankCheckTasks.runId,
          rankCheckTasks.trackingKeywordId,
          rankCheckTasks.device,
        ],
      }),
  );
}

/** Attach provider task ids and the charged cost once task_post answered. */
export async function markRankCheckTasksSubmitted(
  runId: string,
  entries: Array<{
    trackingKeywordId: string;
    device: "desktop" | "mobile";
    providerTaskId: string;
    actualCostMicros: number;
  }>,
) {
  const submittedAt = new Date().toISOString();
  await executeInBatches(entries, (tx, entry) =>
    tx
      .update(rankCheckTasks)
      .set({
        status: "submitted",
        providerTaskId: entry.providerTaskId,
        actualCostMicros: entry.actualCostMicros,
        providerStatusCode: 20100,
        submittedAt,
        attemptCount: 1,
      })
      .where(
        and(
          eq(rankCheckTasks.runId, runId),
          eq(rankCheckTasks.trackingKeywordId, entry.trackingKeywordId),
          eq(rankCheckTasks.device, entry.device),
        ),
      ),
  );
}

/**
 * Move ledger rows to a terminal (or unknown) state by keyword/device — used
 * for entries DataForSEO refused and for a post step that threw after the
 * request may already have been sent.
 */
export async function markRankCheckTasksOutcome(
  runId: string,
  entries: Array<{
    trackingKeywordId: string;
    device: "desktop" | "mobile";
    status: "submission_unknown" | "failed";
    providerStatusCode?: number | null;
    providerStatusMessage?: string | null;
  }>,
) {
  await executeInBatches(entries, (tx, entry) =>
    tx
      .update(rankCheckTasks)
      .set({
        status: entry.status,
        providerStatusCode: entry.providerStatusCode ?? null,
        providerStatusMessage: entry.providerStatusMessage ?? null,
        attemptCount: sql`${rankCheckTasks.attemptCount} + 1`,
      })
      .where(
        and(
          eq(rankCheckTasks.runId, runId),
          eq(rankCheckTasks.trackingKeywordId, entry.trackingKeywordId),
          eq(rankCheckTasks.device, entry.device),
        ),
      ),
  );
}

/** Record what a task_get said about a submitted task. */
export async function markRankCheckTasksCollected(
  entries: Array<{
    providerTaskId: string;
    status: "retrieved" | "terminal_empty" | "failed";
    providerStatusCode?: number | null;
    providerStatusMessage?: string | null;
  }>,
) {
  const retrievedAt = new Date().toISOString();
  await executeInBatches(entries, (tx, entry) =>
    tx
      .update(rankCheckTasks)
      .set({
        status: entry.status,
        providerStatusCode: entry.providerStatusCode ?? null,
        providerStatusMessage: entry.providerStatusMessage ?? null,
        retrievedAt,
        attemptCount: sql`${rankCheckTasks.attemptCount} + 1`,
      })
      .where(eq(rankCheckTasks.providerTaskId, entry.providerTaskId)),
  );
}

/** Tasks a run posted but never collected — what a retrieval pass works from. */
export async function getSubmittedRankCheckTasks(runId: string) {
  return db
    .select({
      trackingKeywordId: rankCheckTasks.trackingKeywordId,
      device: rankCheckTasks.device,
      providerTaskId: rankCheckTasks.providerTaskId,
    })
    .from(rankCheckTasks)
    .where(
      and(
        eq(rankCheckTasks.runId, runId),
        eq(rankCheckTasks.status, "submitted"),
      ),
    );
}

/**
 * Ledger rollup for one run. `submissionUnknown > 0` is what makes a run's
 * spend a floor rather than a settled figure.
 */
export async function getRankCheckTaskCostSummary(runId: string) {
  const rows = await db
    .select({
      actualCostMicros: sql<number>`coalesce(sum(${rankCheckTasks.actualCostMicros}), 0)`,
      reservedCostMicros: sql<number>`coalesce(sum(${rankCheckTasks.reservedCostMicros}), 0)`,
      submissionUnknown: sql<number>`coalesce(sum(case when ${rankCheckTasks.status} = 'submission_unknown' then 1 else 0 end), 0)`,
      outstanding: sql<number>`coalesce(sum(case when ${rankCheckTasks.status} = 'submitted' then 1 else 0 end), 0)`,
    })
    .from(rankCheckTasks)
    .where(eq(rankCheckTasks.runId, runId));
  const row = rows[0];
  // SQLite's sum() comes back as a string through some drivers.
  return {
    actualCostMicros: Number(row?.actualCostMicros ?? 0),
    reservedCostMicros: Number(row?.reservedCostMicros ?? 0),
    submissionUnknown: Number(row?.submissionUnknown ?? 0),
    outstanding: Number(row?.outstanding ?? 0),
  };
}

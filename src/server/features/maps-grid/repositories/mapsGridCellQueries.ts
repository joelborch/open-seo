import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import { mapsGridCellResults, mapsGridCells } from "@/db/schema";

// The grid's provider-task ledger: one cell per (run, keyword, grid point), with
// the ranked pack it returned. Split out of MapsGridRepository — which re-exports
// these — so the money-tracking statements sit together, exactly as the
// rank-check ledger is split out of RankTrackingRepository.
//
// Every transition here is keyed on `tag`, the string DataForSEO echoes back.
// The tag embeds the run id, so it is unique account-wide and a collected result
// never has to be matched by position.

type MapsCellTaskStatus = NonNullable<
  InferInsertModel<typeof mapsGridCells>["taskStatus"]
>;

/**
 * Insert cells in state "reserved" — always before the task_post they account
 * for, so a crash between submit and response still leaves a record of what we
 * may have bought. Idempotent on (run, keyword, row, col) so a replayed
 * workflow step is a no-op.
 */
export async function reserveMapsGridCells(
  rows: Array<InferInsertModel<typeof mapsGridCells>>,
) {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(mapsGridCells)
      .values(row)
      .onConflictDoNothing({
        target: [
          mapsGridCells.runId,
          mapsGridCells.keywordId,
          mapsGridCells.gridRow,
          mapsGridCells.gridCol,
        ],
      }),
  );
}

/** Attach provider task ids and the charged cost once task_post answered. */
export async function markMapsGridCellsSubmitted(
  entries: Array<{
    tag: string;
    providerTaskId: string;
    actualCostMicros: number;
  }>,
) {
  const submittedAt = new Date().toISOString();
  await executeInBatches(entries, (tx, entry) =>
    tx
      .update(mapsGridCells)
      .set({
        taskStatus: "submitted",
        providerTaskId: entry.providerTaskId,
        actualCostMicros: entry.actualCostMicros,
        providerStatusCode: 20100,
        submittedAt,
      })
      .where(eq(mapsGridCells.tag, entry.tag)),
  );
}

/**
 * Move cells to a terminal (or unknown) state without a provider task id — for
 * entries DataForSEO refused, and for a post step that threw after the request
 * may already have reached the provider.
 *
 * Only cells still in "reserved" are touched: a post step that fails *while
 * settling* parks its whole chunk, and a cell that already carries a provider
 * task id must keep it — it is collectable, and overwriting it would throw away
 * a pack we already paid for.
 */
export async function markMapsGridCellsOutcome(
  entries: Array<{
    tag: string;
    status: Extract<MapsCellTaskStatus, "submission_unknown" | "failed">;
    providerStatusCode?: number | null;
  }>,
) {
  await executeInBatches(entries, (tx, entry) =>
    tx
      .update(mapsGridCells)
      .set({
        taskStatus: entry.status,
        providerStatusCode: entry.providerStatusCode ?? null,
      })
      .where(
        and(
          eq(mapsGridCells.tag, entry.tag),
          eq(mapsGridCells.taskStatus, "reserved"),
        ),
      ),
  );
}

/**
 * Sweep a run's leftover "reserved" cells to submission_unknown, and report how
 * many moved.
 *
 * Once every post step of a run has had its turn, a cell still sitting at
 * reserved is one whose post step died without managing to park it, so its
 * request may well have reached DataForSEO. Parking it keeps the cell out of any
 * re-post path and makes the run's spend read as a floor rather than a settled
 * figure — left as reserved it is counted by neither, and the workflow keeps
 * polling for a task id that will never exist.
 */
export async function parkReservedMapsGridCells(
  runId: string,
): Promise<number> {
  const parked = await db
    .update(mapsGridCells)
    .set({ taskStatus: "submission_unknown" })
    .where(
      and(
        eq(mapsGridCells.runId, runId),
        eq(mapsGridCells.taskStatus, "reserved"),
      ),
    )
    .returning({ id: mapsGridCells.id });
  return parked.length;
}

/** Record what a task_get said about a submitted cell, and where we ranked. */
export async function markMapsGridCellsCollected(
  entries: Array<{
    tag: string;
    status: Extract<
      MapsCellTaskStatus,
      "retrieved" | "terminal_empty" | "failed"
    >;
    providerStatusCode?: number | null;
    clientRank?: number | null;
  }>,
) {
  const retrievedAt = new Date().toISOString();
  await executeInBatches(entries, (tx, entry) =>
    tx
      .update(mapsGridCells)
      .set({
        taskStatus: entry.status,
        providerStatusCode: entry.providerStatusCode ?? null,
        clientRank: entry.clientRank ?? null,
        retrievedAt,
      })
      .where(eq(mapsGridCells.tag, entry.tag)),
  );
}

/** Cells still waiting to be posted — what a post step works from. */
export async function getReservedMapsGridCells(runId: string) {
  return db
    .select({
      id: mapsGridCells.id,
      tag: mapsGridCells.tag,
      keywordId: mapsGridCells.keywordId,
      keyword: mapsGridCells.keyword,
      gridRow: mapsGridCells.gridRow,
      gridCol: mapsGridCells.gridCol,
      lat: mapsGridCells.lat,
      lng: mapsGridCells.lng,
    })
    .from(mapsGridCells)
    .where(
      and(
        eq(mapsGridCells.runId, runId),
        eq(mapsGridCells.taskStatus, "reserved"),
      ),
    )
    .orderBy(asc(mapsGridCells.id));
}

/** Cells posted but never collected — what a collect round works from. */
export async function getSubmittedMapsGridCells(runId: string) {
  const rows = await db
    .select({
      id: mapsGridCells.id,
      tag: mapsGridCells.tag,
      providerTaskId: mapsGridCells.providerTaskId,
      keywordId: mapsGridCells.keywordId,
      keyword: mapsGridCells.keyword,
    })
    .from(mapsGridCells)
    .where(
      and(
        eq(mapsGridCells.runId, runId),
        eq(mapsGridCells.taskStatus, "submitted"),
      ),
    )
    .orderBy(asc(mapsGridCells.id));
  // The status is only reachable through markMapsGridCellsSubmitted, which
  // always writes an id; narrow rather than assert so a schema change can't
  // hand the workflow an undefined task id.
  return rows.flatMap((row) =>
    row.providerTaskId === null
      ? []
      : [{ ...row, providerTaskId: row.providerTaskId }],
  );
}

/** Ids per DELETE … IN (…) — D1 caps bound parameters per statement at ~100. */
const DELETE_ID_CHUNK = 50;

/**
 * Replace the ranked packs of a batch of cells. Delete-then-insert per cell, so
 * a retried collect step cannot double the rows, but batched across cells: a
 * collect round settles hundreds of cells and a per-cell round trip each would
 * dominate the step.
 */
export async function replaceMapsGridCellResults(
  entries: Array<{
    cellId: number;
    rows: Array<Omit<InferInsertModel<typeof mapsGridCellResults>, "cellId">>;
  }>,
) {
  if (entries.length === 0) return;
  const cellIds = entries.map((entry) => entry.cellId);
  for (let i = 0; i < cellIds.length; i += DELETE_ID_CHUNK) {
    await db
      .delete(mapsGridCellResults)
      .where(
        inArray(
          mapsGridCellResults.cellId,
          cellIds.slice(i, i + DELETE_ID_CHUNK),
        ),
      );
  }
  const rows = entries.flatMap((entry) =>
    entry.rows.map((row) => ({ ...row, cellId: entry.cellId })),
  );
  await executeInBatches(rows, (tx, row) =>
    tx.insert(mapsGridCellResults).values(row),
  );
}

/**
 * Ledger rollup for one run. `submissionUnknown > 0` (a post whose outcome we
 * never learned) or an outstanding submission is what makes the run's spend a
 * floor rather than a settled figure.
 */
export async function getMapsGridCellCostSummary(runId: string) {
  const rows = await db
    .select({
      actualCostMicros: sql<number>`coalesce(sum(${mapsGridCells.actualCostMicros}), 0)`,
      reservedCostMicros: sql<number>`coalesce(sum(${mapsGridCells.reservedCostMicros}), 0)`,
      collected: sql<number>`coalesce(sum(case when ${mapsGridCells.taskStatus} in ('retrieved', 'terminal_empty') then 1 else 0 end), 0)`,
      submissionUnknown: sql<number>`coalesce(sum(case when ${mapsGridCells.taskStatus} = 'submission_unknown' then 1 else 0 end), 0)`,
      outstanding: sql<number>`coalesce(sum(case when ${mapsGridCells.taskStatus} in ('reserved', 'submitted') then 1 else 0 end), 0)`,
    })
    .from(mapsGridCells)
    .where(eq(mapsGridCells.runId, runId));
  const row = rows[0];
  // SQLite's sum() comes back as a string through some drivers.
  return {
    actualCostMicros: Number(row?.actualCostMicros ?? 0),
    reservedCostMicros: Number(row?.reservedCostMicros ?? 0),
    collected: Number(row?.collected ?? 0),
    submissionUnknown: Number(row?.submissionUnknown ?? 0),
    outstanding: Number(row?.outstanding ?? 0),
  };
}

/** Every cell of a run — the heatmap's rows and the rollups' input. */
export async function getMapsGridCellsForRun(runId: string) {
  return db
    .select()
    .from(mapsGridCells)
    .where(eq(mapsGridCells.runId, runId))
    .orderBy(asc(mapsGridCells.keywordId), asc(mapsGridCells.id));
}

/** Ranked results for a set of runs' cells, for the heatmap hover and rollups. */
export async function getMapsGridCellResultsForRuns(runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .select({
      cellId: mapsGridCellResults.cellId,
      runId: mapsGridCells.runId,
      keywordId: mapsGridCells.keywordId,
      placeId: mapsGridCellResults.placeId,
      cid: mapsGridCellResults.cid,
      name: mapsGridCellResults.name,
      rank: mapsGridCellResults.rank,
      rating: mapsGridCellResults.rating,
      reviewsCount: mapsGridCellResults.reviewsCount,
      url: mapsGridCellResults.url,
      isClient: mapsGridCellResults.isClient,
      matchScore: mapsGridCellResults.matchScore,
    })
    .from(mapsGridCellResults)
    .innerJoin(mapsGridCells, eq(mapsGridCellResults.cellId, mapsGridCells.id))
    .where(inArray(mapsGridCells.runId, runIds))
    .orderBy(asc(mapsGridCellResults.cellId), asc(mapsGridCellResults.rank));
}

/**
 * Cells across several runs, trimmed to what a trend needs: a rollup per run per
 * keyword is computed from ranks alone, so the ranked packs stay unread.
 */
export async function getMapsGridCellsForRuns(runIds: string[]) {
  if (runIds.length === 0) return [];
  return db
    .select({
      id: mapsGridCells.id,
      runId: mapsGridCells.runId,
      keywordId: mapsGridCells.keywordId,
      keyword: mapsGridCells.keyword,
      gridRow: mapsGridCells.gridRow,
      gridCol: mapsGridCells.gridCol,
      clientRank: mapsGridCells.clientRank,
    })
    .from(mapsGridCells)
    .where(inArray(mapsGridCells.runId, runIds))
    .orderBy(asc(mapsGridCells.runId), asc(mapsGridCells.id));
}

import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { fetchMapsTaskResult } from "@/server/lib/dataforseo";
import {
  candidateRank,
  findTarget,
  scoreCandidate,
  type CandidateItem,
  type MatchIdentity,
} from "@/shared/maps-grid";

/**
 * Collecting queued Maps cells: one free task_get per outstanding cell, matched
 * against the location's identity and written back as the cell's ranked pack.
 *
 * Shared by the grid workflow's poll loop and the manual retrieval pass, so a
 * recovered run is settled by exactly the same code that settles a live one —
 * and neither path buys anything: every task here was charged at task_post.
 */

/** Concurrent task_get requests inside one collect pass. */
const TASK_GET_CONCURRENCY = 25;

/** Ranked rows persisted per cell. Deeper than a pack ever shows. */
const RESULTS_PER_CELL = 20;

interface GridCollectOutcome {
  /** Cells settled with a pack (or a terminal empty answer) this pass. */
  collected: number;
  /** Cells DataForSEO reported as failed. */
  failed: number;
  /** Cells still in the provider's queue, or whose task_get itself failed. */
  stillPending: number;
  /** Cells eligible for this pass that the per-pass cap left for the next one. */
  deferred: number;
}

type SubmittedCell = Awaited<
  ReturnType<typeof MapsGridRepository.getSubmittedCells>
>[number];

type CollectedUpdate = Parameters<
  typeof MapsGridRepository.markCellsCollected
>[0][number];

type ResultRows = Parameters<typeof MapsGridRepository.replaceCellResults>[0];

/**
 * Turn one cell's pack into its persisted rows plus the client's position.
 *
 * `is_client` is resolved here, at write time, so the heatmap reads one column
 * instead of re-running the matcher on every render; `match_score` is kept for
 * every row because it is the only way to audit a miss after the fact.
 */
function buildCellResults(
  items: CandidateItem[],
  identity: MatchIdentity,
): { clientRank: number | null; rows: ResultRows[number]["rows"] } {
  const match = findTarget(items, identity);
  const rows = items.slice(0, RESULTS_PER_CELL).map((item, index) => ({
    placeId: item.place_id ?? null,
    cid: item.cid ?? null,
    name: item.title ?? "",
    // Fall back to list order: a pack row without a rank field still holds a
    // position, and a null rank would silently drop it out of every rollup.
    rank: candidateRank(item) ?? index + 1,
    rating: item.rating?.value ?? null,
    reviewsCount: item.rating?.votes_count ?? null,
    url: item.url ?? null,
    isClient: item === match.target,
    matchScore: scoreCandidate(item, identity).score,
  }));
  return {
    clientRank: match.target ? candidateRank(match.target) : null,
    rows,
  };
}

/**
 * Fetch and settle outstanding cells of a run.
 *
 * `readyTaskIds` narrows the pass to tasks DataForSEO has already finished (one
 * tasks_ready call covers the whole account), which is what keeps a poll round
 * from spending hundreds of task_get calls on tasks still in the queue. Omit it
 * to try every outstanding cell, as the manual retrieval pass does.
 *
 * Nothing here is charged, every write is idempotent (results are replaced per
 * cell, the ledger transition is a plain update), so the caller may retry.
 */
export async function collectGridCells(input: {
  runId: string;
  identity: MatchIdentity;
  readyTaskIds?: Set<string>;
  maxGets: number;
}): Promise<GridCollectOutcome> {
  const outstanding = await MapsGridRepository.getSubmittedCells(input.runId);
  const eligible = input.readyTaskIds
    ? outstanding.filter((cell) => input.readyTaskIds?.has(cell.providerTaskId))
    : outstanding;
  const batch = eligible.slice(0, input.maxGets);

  const outcome: GridCollectOutcome = {
    collected: 0,
    failed: 0,
    stillPending: 0,
    deferred: eligible.length - batch.length,
  };
  if (batch.length === 0) return outcome;

  const ledgerUpdates: CollectedUpdate[] = [];
  const resultUpdates: ResultRows = [];

  for (let i = 0; i < batch.length; i += TASK_GET_CONCURRENCY) {
    const chunk = batch.slice(i, i + TASK_GET_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((cell) => fetchMapsTaskResult(cell.providerTaskId)),
    );
    settled.forEach((result, index) => {
      const cell: SubmittedCell = chunk[index];
      if (result.status === "rejected") {
        // Transient task_get failure — the cell stays submitted and collectable.
        console.warn(
          `[maps-grid] ${input.runId} task_get failed for ${cell.tag}:`,
          result.reason,
        );
        outcome.stillPending++;
        return;
      }
      if (result.value.status === "pending") {
        outcome.stillPending++;
        return;
      }
      if (result.value.status === "failed") {
        console.warn(
          `[maps-grid] ${input.runId} cell ${cell.tag} failed: ${result.value.message}`,
        );
        outcome.failed++;
        ledgerUpdates.push({
          tag: cell.tag,
          status: "failed",
          providerStatusCode: result.value.providerStatusCode,
        });
        return;
      }

      const { clientRank, rows } = buildCellResults(
        result.value.items,
        input.identity,
      );
      resultUpdates.push({ cellId: cell.id, rows });
      ledgerUpdates.push({
        tag: cell.tag,
        // A charged-but-empty coordinate is a real answer ("nothing ranks
        // here"), so it is terminal rather than retried.
        status: result.value.isEmpty ? "terminal_empty" : "retrieved",
        providerStatusCode: result.value.providerStatusCode,
        clientRank,
      });
      outcome.collected++;
    });
  }

  await MapsGridRepository.replaceCellResults(resultUpdates);
  if (ledgerUpdates.length > 0) {
    await MapsGridRepository.markCellsCollected(ledgerUpdates);
  }

  // Progress for the UI; finalize recounts from the ledger anyway.
  const summary = await MapsGridRepository.getCellCostSummary(input.runId);
  await MapsGridRepository.updateRun(input.runId, {
    cellsCollected: summary.collected,
  });

  return outcome;
}

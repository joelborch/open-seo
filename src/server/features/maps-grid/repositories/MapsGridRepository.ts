import { and, asc, desc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import { executeInBatches } from "@/db/runBatch";
import {
  mapsGridCells,
  mapsGridConfigs,
  mapsGridKeywords,
  mapsGridLocationMatchTerms,
  mapsGridLocations,
  mapsGridRuns,
  projects,
} from "@/db/schema";
import {
  getMapsGridCellCostSummary,
  getMapsGridCellResultsForRuns,
  getMapsGridCellsForRun,
  getMapsGridCellsForRuns,
  getReservedMapsGridCells,
  getSubmittedMapsGridCells,
  markMapsGridCellsCollected,
  markMapsGridCellsOutcome,
  markMapsGridCellsSubmitted,
  replaceMapsGridCellResults,
  reserveMapsGridCells,
} from "@/server/features/maps-grid/repositories/mapsGridCellQueries";

/**
 * Data access for the local-pack geo grid: locations and their match terms, the
 * grid config and its keywords, and run rows. The cell ledger lives in
 * mapsGridCellQueries and is re-exported here, the same split the rank-check
 * ledger uses.
 */

/**
 * Configs examined per cron tick. The cell budget in the scheduler is the real
 * admission control; this only bounds the query, and unclaimed configs stay due.
 */
const DUE_CONFIGS_PER_TICK = 50;

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export type MapsGridLocationRow = typeof mapsGridLocations.$inferSelect;
export type MapsGridLocation = MapsGridLocationRow & { matchTerms: string[] };

async function attachMatchTerms(
  rows: MapsGridLocationRow[],
): Promise<MapsGridLocation[]> {
  if (rows.length === 0) return [];
  const terms = await db
    .select()
    .from(mapsGridLocationMatchTerms)
    .where(
      inArray(
        mapsGridLocationMatchTerms.locationId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(mapsGridLocationMatchTerms.term));
  return rows.map((row) => ({
    ...row,
    matchTerms: terms
      .filter((term) => term.locationId === row.id)
      .map((term) => term.term),
  }));
}

async function getLocationsForProject(
  projectId: string,
): Promise<MapsGridLocation[]> {
  const rows = await db
    .select()
    .from(mapsGridLocations)
    .where(eq(mapsGridLocations.projectId, projectId))
    .orderBy(asc(mapsGridLocations.name));
  return attachMatchTerms(rows);
}

async function getLocationById(input: {
  locationId: string;
  projectId: string;
}): Promise<MapsGridLocation | null> {
  const rows = await db
    .select()
    .from(mapsGridLocations)
    .where(
      and(
        eq(mapsGridLocations.id, input.locationId),
        eq(mapsGridLocations.projectId, input.projectId),
      ),
    )
    .limit(1);
  return (await attachMatchTerms(rows))[0] ?? null;
}

/** A run's matching identity, read without a project scope (the workflow). */
async function getLocationForRun(
  locationId: string,
): Promise<MapsGridLocation | null> {
  const rows = await db
    .select()
    .from(mapsGridLocations)
    .where(eq(mapsGridLocations.id, locationId))
    .limit(1);
  return (await attachMatchTerms(rows))[0] ?? null;
}

async function insertLocation(row: InferInsertModel<typeof mapsGridLocations>) {
  await db.insert(mapsGridLocations).values(row);
}

async function updateLocation(
  input: { locationId: string; projectId: string },
  data: Partial<InferInsertModel<typeof mapsGridLocations>>,
) {
  await db
    .update(mapsGridLocations)
    .set(data)
    .where(
      and(
        eq(mapsGridLocations.id, input.locationId),
        eq(mapsGridLocations.projectId, input.projectId),
      ),
    );
}

/** Cascades the location's match terms, configs, keywords and run history. */
async function deleteLocation(input: {
  locationId: string;
  projectId: string;
}) {
  await db
    .delete(mapsGridLocations)
    .where(
      and(
        eq(mapsGridLocations.id, input.locationId),
        eq(mapsGridLocations.projectId, input.projectId),
      ),
    );
}

/** Replace a location's aliases. Delete-then-insert keeps the set exact. */
async function replaceLocationMatchTerms(locationId: string, terms: string[]) {
  await db
    .delete(mapsGridLocationMatchTerms)
    .where(eq(mapsGridLocationMatchTerms.locationId, locationId));
  const unique = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  await executeInBatches(unique, (tx, term) =>
    tx.insert(mapsGridLocationMatchTerms).values({ locationId, term }),
  );
}

// ---------------------------------------------------------------------------
// Configs and keywords
// ---------------------------------------------------------------------------

async function getConfigsForProject(projectId: string) {
  return db
    .select()
    .from(mapsGridConfigs)
    .where(eq(mapsGridConfigs.projectId, projectId))
    .orderBy(asc(mapsGridConfigs.createdAt));
}

async function getConfigById(input: { configId: string; projectId: string }) {
  const rows = await db
    .select()
    .from(mapsGridConfigs)
    .where(
      and(
        eq(mapsGridConfigs.id, input.configId),
        eq(mapsGridConfigs.projectId, input.projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Config read without a project scope, for the workflow and the scheduler. */
async function getConfigForRun(configId: string) {
  const rows = await db
    .select()
    .from(mapsGridConfigs)
    .where(eq(mapsGridConfigs.id, configId))
    .limit(1);
  return rows[0] ?? null;
}

async function insertConfig(row: InferInsertModel<typeof mapsGridConfigs>) {
  await db.insert(mapsGridConfigs).values(row);
}

async function updateConfig(
  input: { configId: string; projectId: string },
  data: Partial<InferInsertModel<typeof mapsGridConfigs>>,
) {
  await db
    .update(mapsGridConfigs)
    .set(data)
    .where(
      and(
        eq(mapsGridConfigs.id, input.configId),
        eq(mapsGridConfigs.projectId, input.projectId),
      ),
    );
}

async function deleteConfig(input: { configId: string; projectId: string }) {
  await db
    .delete(mapsGridConfigs)
    .where(
      and(
        eq(mapsGridConfigs.id, input.configId),
        eq(mapsGridConfigs.projectId, input.projectId),
      ),
    );
}

async function getKeywordsForConfig(configId: string) {
  return db
    .select()
    .from(mapsGridKeywords)
    .where(eq(mapsGridKeywords.configId, configId))
    .orderBy(asc(mapsGridKeywords.createdAt), asc(mapsGridKeywords.id));
}

/** Returns the ids that actually won the unique(config_id, keyword) race. */
async function addKeywordsToConfig(
  rows: Array<InferInsertModel<typeof mapsGridKeywords>>,
) {
  const insertedIds: string[] = [];
  const insertBatchSize = 25;
  for (let i = 0; i < rows.length; i += insertBatchSize) {
    const inserted = await db
      .insert(mapsGridKeywords)
      .values(rows.slice(i, i + insertBatchSize))
      .onConflictDoNothing()
      .returning({ id: mapsGridKeywords.id });
    insertedIds.push(...inserted.map((row) => row.id));
  }
  return insertedIds;
}

async function removeKeywordsFromConfig(
  configId: string,
  keywordIds: string[],
) {
  if (keywordIds.length === 0) return;
  await db
    .delete(mapsGridKeywords)
    .where(
      and(
        eq(mapsGridKeywords.configId, configId),
        inArray(mapsGridKeywords.id, keywordIds),
      ),
    );
}

/**
 * Due configs joined to their project's organization — the scheduler needs the
 * org id to act as a system billing customer, and archived projects are excluded
 * so a paused account stops spending.
 */
async function getDueConfigsWithOrganization(nowIso: string) {
  return (
    db
      .select({
        id: mapsGridConfigs.id,
        projectId: mapsGridConfigs.projectId,
        locationId: mapsGridConfigs.locationId,
        gridSize: mapsGridConfigs.gridSize,
        depth: mapsGridConfigs.depth,
        scheduleInterval: mapsGridConfigs.scheduleInterval,
        nextRunAt: mapsGridConfigs.nextRunAt,
        organizationId: projects.organizationId,
      })
      .from(mapsGridConfigs)
      .innerJoin(projects, eq(mapsGridConfigs.projectId, projects.id))
      .where(
        and(
          eq(mapsGridConfigs.isActive, true),
          // A manual config can keep a stale non-null next_run_at; without this it
          // would be selected every tick and never advanced.
          ne(mapsGridConfigs.scheduleInterval, "manual"),
          lte(mapsGridConfigs.nextRunAt, nowIso),
          isNull(projects.archivedAt),
        ),
      )
      // Oldest first so a backlog drains in order. `lte` already excludes NULL, so
      // both ordering columns are non-null and SQLite/Postgres agree.
      .orderBy(asc(mapsGridConfigs.nextRunAt), asc(mapsGridConfigs.id))
      .limit(DUE_CONFIGS_PER_TICK)
  );
}

/**
 * Conditionally advance a due config's cursor, returning false when the config
 * changed underneath us (an edit, or a deactivation). The observed `next_run_at`
 * is the compare-and-set token, exactly as claimDueConfig does for rank checks.
 *
 * `lastSkipReason` is written only when passed — the restore path omits it so it
 * cannot clobber a reason written in the meantime.
 */
async function claimDueConfig(input: {
  configId: string;
  observedNextRunAt: string;
  nextRunAt: string;
  lastSkipReason?: string | null;
}): Promise<boolean> {
  const claimed = await db
    .update(mapsGridConfigs)
    .set({
      nextRunAt: input.nextRunAt,
      ...(input.lastSkipReason !== undefined && {
        lastSkipReason: input.lastSkipReason,
      }),
    })
    .where(
      and(
        eq(mapsGridConfigs.id, input.configId),
        eq(mapsGridConfigs.isActive, true),
        eq(mapsGridConfigs.nextRunAt, input.observedNextRunAt),
      ),
    )
    .returning({ id: mapsGridConfigs.id });
  return claimed.length > 0;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Try to insert a pending run. Returns false when the partial unique index on
 * (config_id) WHERE status IN ('pending','running') rejects it — that rejection
 * *is* the "already running" signal, so a duplicate trigger fails on a
 * constraint instead of double-spending at the provider.
 */
async function tryCreateRun(
  row: InferInsertModel<typeof mapsGridRuns>,
): Promise<boolean> {
  const inserted = await db
    .insert(mapsGridRuns)
    .values({ ...row, status: "pending" })
    .onConflictDoNothing()
    .returning({ id: mapsGridRuns.id });
  return inserted.length > 0;
}

async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof mapsGridRuns>>,
) {
  await db.update(mapsGridRuns).set(data).where(eq(mapsGridRuns.id, runId));
}

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(mapsGridRuns)
    .where(eq(mapsGridRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getRunForProject(input: { runId: string; projectId: string }) {
  const rows = await db
    .select()
    .from(mapsGridRuns)
    .where(
      and(
        eq(mapsGridRuns.id, input.runId),
        eq(mapsGridRuns.projectId, input.projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getActiveRunForConfig(configId: string) {
  const rows = await db
    .select()
    .from(mapsGridRuns)
    .where(
      and(
        eq(mapsGridRuns.configId, configId),
        inArray(mapsGridRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Recent runs for a config, newest first — the run picker's read model. */
async function getRunsForConfig(configId: string, limit: number) {
  return db
    .select()
    .from(mapsGridRuns)
    .where(eq(mapsGridRuns.configId, configId))
    .orderBy(desc(mapsGridRuns.startedAt))
    .limit(limit);
}

/**
 * Keywords a run actually covered, read off its cells rather than the config —
 * the config's keyword list drifts, and a week-over-week comparison is only
 * valid between runs whose cell panel matches.
 */
async function getRunKeywords(runId: string) {
  const rows = await db
    .selectDistinct({
      keywordId: mapsGridCells.keywordId,
      keyword: mapsGridCells.keyword,
    })
    .from(mapsGridCells)
    .where(eq(mapsGridCells.runId, runId))
    .orderBy(asc(mapsGridCells.keyword));
  return rows;
}

export const MapsGridRepository = {
  getLocationsForProject,
  getLocationById,
  getLocationForRun,
  insertLocation,
  updateLocation,
  deleteLocation,
  replaceLocationMatchTerms,
  getConfigsForProject,
  getConfigById,
  getConfigForRun,
  insertConfig,
  updateConfig,
  deleteConfig,
  getKeywordsForConfig,
  addKeywordsToConfig,
  removeKeywordsFromConfig,
  getDueConfigsWithOrganization,
  claimDueConfig,
  tryCreateRun,
  updateRun,
  getRunById,
  getRunForProject,
  getActiveRunForConfig,
  getRunsForConfig,
  getRunKeywords,
  reserveCells: reserveMapsGridCells,
  markCellsSubmitted: markMapsGridCellsSubmitted,
  markCellsOutcome: markMapsGridCellsOutcome,
  markCellsCollected: markMapsGridCellsCollected,
  getReservedCells: getReservedMapsGridCells,
  getSubmittedCells: getSubmittedMapsGridCells,
  replaceCellResults: replaceMapsGridCellResults,
  getCellCostSummary: getMapsGridCellCostSummary,
  getCellsForRun: getMapsGridCellsForRun,
  getCellsForRuns: getMapsGridCellsForRuns,
  getCellResultsForRuns: getMapsGridCellResultsForRuns,
} as const;

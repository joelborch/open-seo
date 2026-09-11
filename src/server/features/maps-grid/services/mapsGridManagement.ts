import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { AppError } from "@/server/lib/errors";
import { computeNextCheckAt } from "@/shared/rank-tracking";
import type {
  GridConfigFields,
  GridLocationFields,
} from "@/types/schemas/maps-grid";
import { MAX_GRID_KEYWORDS } from "@/types/schemas/maps-grid";

/**
 * CRUD for the grid's configuration: the physical locations a grid is centred on
 * (with their match terms) and the per-location grid config and keyword set.
 * Kept apart from MapsGridService, which is about running and reading runs.
 */

export async function getLocations(projectId: string) {
  return MapsGridRepository.getLocationsForProject(projectId);
}

export async function createLocation(input: {
  projectId: string;
  fields: GridLocationFields;
}) {
  const { matchTerms, ...columns } = input.fields;
  const id = crypto.randomUUID();
  await MapsGridRepository.insertLocation({
    id,
    projectId: input.projectId,
    ...columns,
  });
  await MapsGridRepository.replaceLocationMatchTerms(id, matchTerms);
  return { locationId: id };
}

export async function updateLocation(input: {
  projectId: string;
  locationId: string;
  fields: GridLocationFields;
}) {
  const existing = await MapsGridRepository.getLocationById(input);
  if (!existing) throw new AppError("NOT_FOUND", "Grid location not found");

  const { matchTerms, ...columns } = input.fields;
  await MapsGridRepository.updateLocation(input, columns);
  await MapsGridRepository.replaceLocationMatchTerms(
    input.locationId,
    matchTerms,
  );
  return { locationId: input.locationId };
}

/** Cascades the location's configs, keywords and run history. */
export async function deleteLocation(input: {
  projectId: string;
  locationId: string;
}) {
  const existing = await MapsGridRepository.getLocationById(input);
  if (!existing) throw new AppError("NOT_FOUND", "Grid location not found");
  await MapsGridRepository.deleteLocation(input);
  return { success: true };
}

export async function getConfigs(projectId: string) {
  return MapsGridRepository.getConfigsForProject(projectId);
}

/**
 * The scheduler's claim cursor. A "manual" config has none — a null cursor is
 * what keeps it out of the due query entirely.
 */
function nextRunAtFor(
  scheduleInterval: GridConfigFields["scheduleInterval"],
  previous?: string | null,
): string | null {
  if (scheduleInterval === "manual") return null;
  return computeNextCheckAt(scheduleInterval, previous);
}

export async function createConfig(input: {
  projectId: string;
  locationId: string;
  fields: GridConfigFields;
}) {
  const location = await MapsGridRepository.getLocationById(input);
  if (!location) throw new AppError("NOT_FOUND", "Grid location not found");

  const id = crypto.randomUUID();
  await MapsGridRepository.insertConfig({
    id,
    projectId: input.projectId,
    locationId: input.locationId,
    ...input.fields,
    depth: input.fields.depth ?? null,
    nextRunAt: nextRunAtFor(input.fields.scheduleInterval),
  });
  return { configId: id };
}

export async function updateConfig(input: {
  projectId: string;
  configId: string;
  fields: GridConfigFields;
}) {
  const existing = await MapsGridRepository.getConfigById(input);
  if (!existing) throw new AppError("NOT_FOUND", "Grid config not found");

  // Recompute the cursor from the saved one so an unchanged cadence keeps its
  // slot instead of drifting to "a week from this edit".
  await MapsGridRepository.updateConfig(input, {
    ...input.fields,
    depth: input.fields.depth ?? null,
    nextRunAt: nextRunAtFor(
      input.fields.scheduleInterval,
      existing.scheduleInterval === input.fields.scheduleInterval
        ? existing.nextRunAt
        : null,
    ),
    // A saved edit clears a stale badge; the scheduler writes a new reason on
    // its next skip.
    lastSkipReason: null,
  });
  return { configId: input.configId };
}

export async function deleteConfig(input: {
  projectId: string;
  configId: string;
}) {
  const existing = await MapsGridRepository.getConfigById(input);
  if (!existing) throw new AppError("NOT_FOUND", "Grid config not found");
  await MapsGridRepository.deleteConfig(input);
  return { success: true };
}

export async function getKeywords(input: {
  projectId: string;
  configId: string;
}) {
  const config = await MapsGridRepository.getConfigById(input);
  if (!config) throw new AppError("NOT_FOUND", "Grid config not found");
  return MapsGridRepository.getKeywordsForConfig(config.id);
}

export async function addKeywords(input: {
  projectId: string;
  configId: string;
  keywords: string[];
  category?: string | null;
}) {
  const config = await MapsGridRepository.getConfigById(input);
  if (!config) throw new AppError("NOT_FOUND", "Grid config not found");

  const existing = await MapsGridRepository.getKeywordsForConfig(config.id);
  const incoming = [
    ...new Set(input.keywords.map((word) => word.trim()).filter(Boolean)),
  ].filter((word) => !existing.some((row) => row.keyword === word));

  if (existing.length + incoming.length > MAX_GRID_KEYWORDS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `A grid config holds at most ${MAX_GRID_KEYWORDS} keywords — each one costs grid_size² provider requests per run.`,
    );
  }

  const insertedIds = await MapsGridRepository.addKeywordsToConfig(
    incoming.map((word) => ({
      id: crypto.randomUUID(),
      configId: config.id,
      keyword: word,
      category: input.category ?? null,
    })),
  );
  return { added: insertedIds.length };
}

export async function removeKeywords(input: {
  projectId: string;
  configId: string;
  keywordIds: string[];
}) {
  const config = await MapsGridRepository.getConfigById(input);
  if (!config) throw new AppError("NOT_FOUND", "Grid config not found");
  await MapsGridRepository.removeKeywordsFromConfig(
    config.id,
    input.keywordIds,
  );
  return { success: true };
}

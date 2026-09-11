import { z } from "zod";

/**
 * Boundary schemas for the local-pack geo grid. Everything a client can send
 * lands here first: a grid run buys one charged provider request per cell, so the
 * shape and the bounds of grid size, radius and keyword count are validated
 * before anything reaches the planner.
 */

/** Odd sizes only — an even grid has no centre cell to anchor the run on. */
export const GRID_SIZES = [3, 5, 7] as const;

export type GridSize = (typeof GRID_SIZES)[number];

/** Narrow a stored grid size back to the offered set, defaulting to 7×7. */
export function asGridSize(value: number): GridSize {
  return GRID_SIZES.find((size) => size === value) ?? 7;
}

/** Keywords per config. Each one multiplies the run by grid_size² cells. */
export const MAX_GRID_KEYWORDS = 50;

const projectId = z.string().min(1);
const locationId = z.string().min(1);
const configId = z.string().min(1);

const slug = z
  .string()
  .min(1)
  .max(80)
  // Used verbatim in the `/locations/<slug>` URL check the matcher runs.
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase letters, digits and dashes",
  );

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);
const radiusMiles = z.number().min(0.25).max(50);

/** Google map zoom, e.g. "13z". Lower is wider; the grid default is 13z. */
const zoom = z
  .string()
  .regex(/^(?:[0-9]|1[0-9]|2[01])z$/, "Zoom looks like “13z”");

const keyword = z.string().min(1).max(200);

export const locationFieldsSchema = z.object({
  name: z.string().min(1).max(160),
  slug,
  lat: latitude,
  lng: longitude,
  radiusMiles,
  brandName: z.string().min(1).max(160),
  domain: z.string().min(1).max(253),
  phone: z.string().max(40).nullable().optional(),
  street: z.string().max(200).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  placeId: z.string().max(256).nullable().optional(),
  locationUrl: z.string().max(2048).nullable().optional(),
  /** Extra strings that identify the client in a pack (DBAs, legacy brands). */
  matchTerms: z.array(z.string().min(1).max(120)).max(40).default([]),
});

export const getGridLocationsSchema = z.object({ projectId });

export const createGridLocationSchema = locationFieldsSchema.extend({
  projectId,
});

export const updateGridLocationSchema = locationFieldsSchema.extend({
  projectId,
  locationId,
});

export const deleteGridLocationSchema = z.object({ projectId, locationId });

export const configFieldsSchema = z.object({
  gridSize: z.union([z.literal(3), z.literal(5), z.literal(7)]),
  radiusMiles,
  zoom,
  languageCode: z.string().min(2).max(10),
  device: z.enum(["mobile", "desktop"]),
  /** Pack depth per cell; null uses the planner's default. */
  depth: z.number().int().min(10).max(100).nullable().optional(),
  scheduleInterval: z.enum(["weekly", "monthly", "manual"]),
  isActive: z.boolean(),
});

export const getGridConfigsSchema = z.object({ projectId });

export const createGridConfigSchema = configFieldsSchema.extend({
  projectId,
  locationId,
});

export const updateGridConfigSchema = configFieldsSchema.extend({
  projectId,
  configId,
});

export const deleteGridConfigSchema = z.object({ projectId, configId });

export const getGridKeywordsSchema = z.object({ projectId, configId });

export const addGridKeywordsSchema = z.object({
  projectId,
  configId,
  keywords: z.array(keyword).min(1).max(MAX_GRID_KEYWORDS),
  category: z.string().max(80).nullable().optional(),
});

export const removeGridKeywordsSchema = z.object({
  projectId,
  configId,
  keywordIds: z.array(z.string().min(1)).min(1).max(MAX_GRID_KEYWORDS),
});

export const previewGridRunSchema = z.object({ projectId, configId });

export const startGridRunSchema = z.object({
  projectId,
  configId,
  /**
   * Price the user approved from the preview, in provider micro-dollars. The run
   * is refused when the plan grew past it — a keyword added between preview and
   * confirm must not be bought silently.
   */
  authorizedCostMicros: z.number().int().min(0).optional(),
});

export const retrieveGridRunSchema = z.object({
  projectId,
  runId: z.string().min(1),
});

export const getGridRunsSchema = z.object({ projectId, configId });

export const getGridRunSchema = z.object({
  projectId,
  runId: z.string().min(1),
});

export const getGridTrendSchema = z.object({ projectId, configId });

export type GridLocationFields = z.infer<typeof locationFieldsSchema>;
export type GridConfigFields = z.infer<typeof configFieldsSchema>;

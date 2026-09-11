import { z } from "zod";
import {
  MAX_KEYWORDS_PER_CONFIG,
  MAX_TRACKED_KEYWORD_LENGTH,
} from "@/shared/rank-tracking";

export const DEFAULT_PATHS = {
  seoYoloRoot: "/Volumes/Development/Joel/seo-yolo",
  ahrefsClientsConfig:
    "/Volumes/Development/Joel/workspaces/ahrefs-replacement/config/clients.json",
  // seo-yolo's rankings panel reads location_name from here
  // (`clients[slug].default_location`), not from the client profile — see
  // seo-yolo's query_panels.py `paid_panel`.
  aioKeywordsConfig:
    "/Volumes/Development/Joel/workspaces/ahrefs-replacement/config/aio_keywords.json",
  seoHistoryPy:
    "/Volumes/Development/Joel/tools/studio-tools/apps/analytics/shared/seo_history.py",
} as const;

/**
 * Scheduled-crawl settings every seeded project gets. Heavier than the schema
 * defaults (100/500 pages at 03/04 UTC) because these are real client sites
 * crawled overnight US time.
 */
export const AUDIT_SCHEDULE_SEED_DEFAULTS = {
  quickEnabled: true,
  quickMaxPages: 300,
  quickHourUtc: 9,
  deepEnabled: true,
  deepMaxPages: 5000,
  // 1 = Monday, matching `Date#getUTCDay`.
  deepDowUtc: 1,
  deepHourUtc: 10,
  deepLighthouse: true,
  isActive: true,
} as const;

/**
 * Rank-tracking settings every seeded project gets. The local/publisher split —
 * a `location_name` plus mobile for locals, US location_code plus desktop for
 * publishers — mirrors the payloads seo-yolo's rankings panel posts.
 */
export const RANK_TRACKING_SEED_DEFAULTS = {
  locationCode: 2840,
  languageCode: "en",
  serpDepth: 20,
  scheduleInterval: "weekly",
  trackCompetitors: true,
  trackAiOverview: true,
  isActive: true,
} as const;

export const DEFAULT_CLIENT_ORDER = [
  "airway",
  "reddy",
  "advanced-dermatology",
  "actc",
  "newmouth",
  "visioncenter",
  "knowyourdna",
] as const;

export const DEFAULT_GSC_EXPORT_DATASETS: Record<string, string> = {
  theairwaydentists: "searchconsole",
  actchealth: "searchconsole_actchealth",
  advanceddermchi: "searchconsole_advanceddermchi",
  knowyourdna: "searchconsole_knowyourdna",
  newmouth: "searchconsole_newmouth",
  reddyplasticsurgerygroup: "searchconsole_reddyplasticsurgerygroup",
  visioncenter: "searchconsole_visioncenter",
};

export const ProjectMappingSchema = z.record(
  z.string().min(1, "Client key must not be empty"),
  z.string().min(1, "Project ID must not be empty"),
);
export type ProjectMapping = z.infer<typeof ProjectMappingSchema>;

export const SeoYoloProfileSchema = z
  .object({
    key: z.string().min(1),
    display_name: z.string().min(1),
    profile_slug: z.string().min(1),
    domain: z.string().min(1),
    dataset: z.string().optional(),
    client_type: z.string().optional(),
    cadence: z.record(z.string(), z.unknown()).optional(),
    monitoring_cadence: z.record(z.string(), z.unknown()).optional(),
    topics: z.array(z.string()).optional(),
    weekly_rank_keywords: z.array(z.string()).optional(),
    locations: z.array(z.unknown()).optional(),
  })
  .passthrough();
export type SeoYoloProfile = z.infer<typeof SeoYoloProfileSchema>;

const AhrefsClientEntrySchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().optional(),
    domain: z.string().optional(),
    maps_config: z.string().optional(),
    weekly_rank_keywords: z.array(z.string()).optional(),
    weekly_maps_keywords: z.array(z.string()).optional(),
    monthly_maps_keywords: z.array(z.string()).optional(),
  })
  .passthrough();

export const AhrefsClientsConfigSchema = z
  .object({
    clients: z.array(AhrefsClientEntrySchema),
  })
  .passthrough();
export type AhrefsClientsConfig = z.infer<typeof AhrefsClientsConfigSchema>;

/**
 * Only the part of seo-yolo's aio_keywords.json the seeder needs:
 * `default_location` is the canonical DataForSEO location_name its rankings
 * panel posts for a local client ("Houston,Texas,United States").
 */
export const AioKeywordsConfigSchema = z
  .object({
    clients: z.record(
      z.string().min(1),
      z
        .object({
          domain: z.string().optional(),
          default_location: z.string().min(1).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type AioKeywordsConfig = z.infer<typeof AioKeywordsConfigSchema>;

/**
 * `--publisher-keywords` file: client key (or profile slug) → the keywords to
 * track. Publishers have no local rank panel in seo-yolo, so their list is
 * supplied by hand rather than discovered.
 */
export const PublisherKeywordsFileSchema = z.record(
  z.string().min(1, "Client key must not be empty"),
  z
    .array(z.string().trim().min(1).max(MAX_TRACKED_KEYWORD_LENGTH))
    .max(MAX_KEYWORDS_PER_CONFIG),
);
export type PublisherKeywordsFile = z.infer<typeof PublisherKeywordsFileSchema>;

const MapsLocationSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1),
    url: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    street: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    state: z.string().optional().nullable(),
    postal_code: z.string().optional().nullable(),
    lat: z.number(),
    lng: z.number(),
    radius_miles: z.number().positive().optional().nullable(),
    place_id: z.string().optional().nullable(),
    match_terms: z.array(z.string()).default([]),
  })
  .passthrough();

export const MapsConfigSchema = z
  .object({
    client: z.string().optional(),
    domain: z.string().optional(),
    grid_size: z.number().int().positive().default(7),
    radius_miles: z.number().positive().default(5),
    zoom: z.string().default("13z"),
    language_code: z.string().default("en"),
    device: z.enum(["mobile", "desktop"]).default("mobile"),
    depth: z.number().int().optional().nullable(),
    keywords: z.array(z.string()).default([]),
    locations: z.array(MapsLocationSchema).default([]),
  })
  .passthrough();
export type MapsConfig = z.infer<typeof MapsConfigSchema>;

export interface DiscoveredClient {
  key: string;
  slug: string;
  displayName: string;
  domain: string;
  profile: SeoYoloProfile;
  mapsConfigPath: string | null;
  mapsConfig: MapsConfig | null;
  bigqueryDataset: string;
  gscExportDataset: string;
  /** `local_visibility` in the profile topics, or a maps config to run grids for. */
  isLocal: boolean;
  /** `weekly_rank_keywords` from seo-yolo's clients.json; empty for publishers. */
  weeklyRankKeywords: string[];
  /** `default_location` from aio_keywords.json; null for publishers. */
  rankLocationName: string | null;
}

export interface LocationSeedPlan {
  name: string;
  slug: string;
  lat: number;
  lng: number;
  radiusMiles: number;
  brandName: string;
  domain: string;
  phone: string | null;
  street: string | null;
  postalCode: string | null;
  placeId: string | null;
  locationUrl: string | null;
  matchTerms: string[];
  config: {
    gridSize: number;
    radiusMiles: number;
    zoom: string;
    languageCode: string;
    device: "mobile" | "desktop";
    depth: number | null;
    scheduleInterval: "weekly";
    isActive: boolean;
    nextRunAt: null;
  };
  /**
   * Business Profile snapshot cadence for this location. `next_run_at` is null for
   * the same reason the grid config's is: the scheduler's due query excludes a null
   * cursor, so seeding records the intent without arming any provider spend until
   * someone saves the schedule in the app.
   */
  gbpSchedule: {
    scheduleInterval: "weekly";
    isActive: boolean;
    nextRunAt: null;
  };
  keywords: string[];
}

export interface BigqueryTargetPlan {
  projectId: string;
  clientKey: string;
  dataset: string;
  gscExportDataset: string | null;
}

export interface AuditSchedulePlan {
  startUrl: string;
  isActive: boolean;
  quickEnabled: boolean;
  quickMaxPages: number;
  quickHourUtc: number;
  nextQuickAt: string;
  deepEnabled: boolean;
  deepMaxPages: number;
  deepDowUtc: number;
  deepHourUtc: number;
  deepLighthouse: boolean;
  nextDeepAt: string;
}

export interface RankTrackingSeedPlan {
  domain: string;
  locationCode: number;
  languageCode: string;
  /** Non-null for locals only; NULL is what the schema treats as a national config. */
  locationName: string | null;
  devices: "mobile" | "desktop" | "both";
  serpDepth: number;
  scheduleInterval: "weekly";
  trackCompetitors: boolean;
  trackAiOverview: boolean;
  isActive: boolean;
  nextCheckAt: string;
  keywords: string[];
}

export interface ClientSeedPlan {
  clientKey: string;
  clientSlug: string;
  displayName: string;
  projectId: string;
  profile: SeoYoloProfile;
  bigqueryTarget: BigqueryTargetPlan;
  auditSchedule: AuditSchedulePlan;
  rankTracking: RankTrackingSeedPlan;
  maps?: {
    configSource?: string;
    locations: LocationSeedPlan[];
  };
}

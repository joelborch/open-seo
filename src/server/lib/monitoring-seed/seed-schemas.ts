import { z } from "zod";

export const DEFAULT_PATHS = {
  seoYoloRoot: "/Volumes/Development/Joel/seo-yolo",
  ahrefsClientsConfig:
    "/Volumes/Development/Joel/workspaces/ahrefs-replacement/config/clients.json",
  seoHistoryPy:
    "/Volumes/Development/Joel/tools/studio-tools/apps/analytics/shared/seo_history.py",
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

export const AhrefsClientEntrySchema = z
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
export type AhrefsClientEntry = z.infer<typeof AhrefsClientEntrySchema>;

export const AhrefsClientsConfigSchema = z
  .object({
    clients: z.array(AhrefsClientEntrySchema),
  })
  .passthrough();
export type AhrefsClientsConfig = z.infer<typeof AhrefsClientsConfigSchema>;

export const MapsLocationSchema = z
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
export type MapsLocation = z.infer<typeof MapsLocationSchema>;

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
  keywords: string[];
}

export interface BigqueryTargetPlan {
  projectId: string;
  clientKey: string;
  dataset: string;
  gscExportDataset: string | null;
}

export interface ClientSeedPlan {
  clientKey: string;
  clientSlug: string;
  displayName: string;
  projectId: string;
  profile: SeoYoloProfile;
  bigqueryTarget: BigqueryTargetPlan;
  maps?: {
    configSource?: string;
    locations: LocationSeedPlan[];
  };
}

export interface SeedingPlan {
  clients: ClientSeedPlan[];
  unmappedClientKeys: string[];
}

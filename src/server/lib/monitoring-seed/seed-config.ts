import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sortBy } from "remeda";
import {
  computeNextQuickAt,
  computeNextDeepAt,
} from "@/shared/audit-schedules";
import { computeNextCheckAt } from "@/shared/rank-tracking";
import { CLIENT_DATASETS } from "../bigquery/specs";
import {
  normalizeTrackedKeywords,
  parseAhrefsClientsConfig,
  parseAioKeywordsConfig,
  parseClientOrder,
  parseClientProfile,
  parseMapsConfig,
} from "./seed-parsers";
import {
  AUDIT_SCHEDULE_SEED_DEFAULTS,
  DEFAULT_CLIENT_ORDER,
  DEFAULT_GSC_EXPORT_DATASETS,
  DEFAULT_PATHS,
  RANK_TRACKING_SEED_DEFAULTS,
  type AuditSchedulePlan,
  type BigqueryTargetPlan,
  type ClientSeedPlan,
  type DiscoveredClient,
  type LocationSeedPlan,
  type MapsConfig,
  type ProjectMapping,
  type PublisherKeywordsFile,
  type RankTrackingSeedPlan,
  type SeoYoloProfile,
} from "./seed-schemas";

export * from "./seed-parsers";
export * from "./seed-schemas";

/**
 * A local client runs a geo panel: seo-yolo gates that on `local_visibility` in
 * the profile topics, and a maps config is the same signal from the other side.
 */
function isLocalClient(
  profile: SeoYoloProfile,
  mapsConfig: MapsConfig | null,
): boolean {
  return (
    (profile.topics ?? []).includes("local_visibility") || Boolean(mapsConfig)
  );
}

type DiscoverClientsOptions = {
  seoYoloRoot?: string;
  ahrefsClientsConfigPath?: string;
  aioKeywordsConfigPath?: string;
  readFileFn?: (path: string) => string;
  fileExistsFn?: (path: string) => boolean;
};

export function discoverClients(
  options: DiscoverClientsOptions = {},
): DiscoveredClient[] {
  const seoYoloRoot = options.seoYoloRoot ?? DEFAULT_PATHS.seoYoloRoot;
  const ahrefsClientsConfigPath =
    options.ahrefsClientsConfigPath ?? DEFAULT_PATHS.ahrefsClientsConfig;
  const readFn = options.readFileFn ?? ((p: string) => readFileSync(p, "utf8"));
  const existsFn = options.fileExistsFn ?? existsSync;

  let clientOrder: string[] = [...DEFAULT_CLIENT_ORDER];
  const configPyPath = join(seoYoloRoot, "src", "seo_yolo", "config.py");
  if (existsFn(configPyPath)) {
    try {
      const content = readFn(configPyPath);
      clientOrder = parseClientOrder(content);
    } catch {
      clientOrder = [...DEFAULT_CLIENT_ORDER];
    }
  }

  const mapsConfigBySlug = new Map<string, string>();
  const rankKeywordsBySlug = new Map<string, string[]>();
  if (existsFn(ahrefsClientsConfigPath)) {
    try {
      const raw = readFn(ahrefsClientsConfigPath);
      const parsed = parseAhrefsClientsConfig(raw);
      for (const client of parsed.clients) {
        if (client.maps_config) {
          mapsConfigBySlug.set(client.slug, client.maps_config);
        }
        if (client.weekly_rank_keywords) {
          rankKeywordsBySlug.set(client.slug, client.weekly_rank_keywords);
        }
      }
    } catch {
      // Continue without ahrefs maps configs if absent
    }
  }

  // seo-yolo's rankings panel posts `clients[slug].default_location` from
  // aio_keywords.json as location_name, so the seeded local configs reuse that
  // exact string rather than rebuilding it from an office address.
  const rankLocationBySlug = new Map<string, string>();
  const aioKeywordsConfigPath =
    options.aioKeywordsConfigPath ?? DEFAULT_PATHS.aioKeywordsConfig;
  if (existsFn(aioKeywordsConfigPath)) {
    try {
      const parsed = parseAioKeywordsConfig(readFn(aioKeywordsConfigPath));
      for (const [slug, panel] of Object.entries(parsed.clients)) {
        if (panel.default_location) {
          rankLocationBySlug.set(slug, panel.default_location);
        }
      }
    } catch {
      // Continue without rankings locations if the config is absent
    }
  }

  const discovered: DiscoveredClient[] = [];
  for (const clientKey of clientOrder) {
    const profilePath = join(seoYoloRoot, "clients", clientKey, "profile.json");
    if (!existsFn(profilePath)) {
      continue;
    }

    const rawProfile = readFn(profilePath);
    const profile = parseClientProfile(rawProfile);
    const slug = profile.profile_slug;

    let mapsConfigPath =
      mapsConfigBySlug.get(slug) ?? mapsConfigBySlug.get(clientKey);

    let mapsConfig: MapsConfig | null = null;
    if (mapsConfigPath && existsFn(mapsConfigPath)) {
      try {
        const rawMaps = readFn(mapsConfigPath);
        mapsConfig = parseMapsConfig(rawMaps);
      } catch {
        mapsConfig = null;
      }
    }

    const bigqueryDataset =
      CLIENT_DATASETS[slug] ?? profile.dataset ?? `${slug}_marketing`;
    const gscExportDataset = DEFAULT_GSC_EXPORT_DATASETS[slug] ?? "";

    discovered.push({
      key: profile.key,
      slug,
      displayName: profile.display_name,
      domain: profile.domain,
      profile,
      mapsConfigPath: mapsConfigPath ?? null,
      mapsConfig,
      bigqueryDataset,
      gscExportDataset,
      isLocal: isLocalClient(profile, mapsConfig),
      weeklyRankKeywords: rankKeywordsBySlug.get(slug) ?? [],
      rankLocationName: rankLocationBySlug.get(slug) ?? null,
    });
  }

  return discovered;
}

type AuditSchedulePageOverrides = {
  quickMaxPages?: number;
  deepMaxPages?: number;
};

type BuildSeedingPlanOptions = {
  discoveredClients?: DiscoveredClient[];
  clientDatasets?: Record<string, string>;
  gscExportDatasets?: Record<string, string>;
  /** `--publisher-keywords`: rank keywords for clients with no local panel. */
  publisherKeywords?: PublisherKeywordsFile;
  /** `--quick-pages` / `--deep-pages`, applied to every client. */
  auditPageLimits?: AuditSchedulePageOverrides;
  /** Per-client crawl-size overrides, keyed by client key or profile slug. */
  auditPageLimitsByClient?: Record<string, AuditSchedulePageOverrides>;
};

function buildAuditSchedulePlan(
  client: DiscoveredClient,
  options: BuildSeedingPlanOptions,
): AuditSchedulePlan {
  const perClient =
    options.auditPageLimitsByClient?.[client.key] ??
    options.auditPageLimitsByClient?.[client.slug] ??
    {};
  const defaults = AUDIT_SCHEDULE_SEED_DEFAULTS;
  return {
    startUrl: `https://${client.domain}/`,
    isActive: defaults.isActive,
    quickEnabled: defaults.quickEnabled,
    quickMaxPages:
      perClient.quickMaxPages ??
      options.auditPageLimits?.quickMaxPages ??
      defaults.quickMaxPages,
    quickHourUtc: defaults.quickHourUtc,
    nextQuickAt: computeNextQuickAt(defaults.quickHourUtc),
    deepEnabled: defaults.deepEnabled,
    deepMaxPages:
      perClient.deepMaxPages ??
      options.auditPageLimits?.deepMaxPages ??
      defaults.deepMaxPages,
    deepDowUtc: defaults.deepDowUtc,
    deepHourUtc: defaults.deepHourUtc,
    deepLighthouse: defaults.deepLighthouse,
    nextDeepAt: computeNextDeepAt(defaults.deepDowUtc, defaults.deepHourUtc),
  };
}

/**
 * Locals track their seo-yolo rankings panel on mobile in the panel's own
 * location; publishers track a national US desktop SERP with a hand-supplied
 * keyword list. A local with no rankings location would otherwise be seeded as
 * a national config, which is a different row under the schema's partial
 * uniques, so it fails loudly instead.
 */
function buildRankTrackingPlan(
  client: DiscoveredClient,
  options: BuildSeedingPlanOptions,
): RankTrackingSeedPlan {
  const defaults = RANK_TRACKING_SEED_DEFAULTS;
  const keywords = client.isLocal
    ? client.weeklyRankKeywords
    : (options.publisherKeywords?.[client.key] ??
      options.publisherKeywords?.[client.slug] ??
      []);

  if (client.isLocal && !client.rankLocationName) {
    throw new Error(
      `Local client "${client.key}" has no rankings location_name (clients.${client.slug}.default_location in ${DEFAULT_PATHS.aioKeywordsConfig}).`,
    );
  }

  return {
    domain: client.domain,
    locationCode: defaults.locationCode,
    languageCode: defaults.languageCode,
    locationName: client.isLocal ? client.rankLocationName : null,
    devices: client.isLocal ? "mobile" : "desktop",
    serpDepth: defaults.serpDepth,
    scheduleInterval: defaults.scheduleInterval,
    trackCompetitors: defaults.trackCompetitors,
    trackAiOverview: defaults.trackAiOverview,
    isActive: defaults.isActive,
    nextCheckAt: computeNextCheckAt(defaults.scheduleInterval),
    keywords: normalizeTrackedKeywords(keywords),
  };
}

export function buildSeedingPlan(
  mapping: ProjectMapping,
  options: BuildSeedingPlanOptions = {},
): ClientSeedPlan[] {
  const discovered = options.discoveredClients ?? discoverClients();
  const clientDatasets = options.clientDatasets ?? CLIENT_DATASETS;
  const gscExportDatasets =
    options.gscExportDatasets ?? DEFAULT_GSC_EXPORT_DATASETS;

  const byKey = new Map<string, DiscoveredClient>();
  const bySlug = new Map<string, DiscoveredClient>();
  for (const client of discovered) {
    byKey.set(client.key, client);
    bySlug.set(client.slug, client);
  }

  const plans: ClientSeedPlan[] = [];

  for (const [requestedKey, projectId] of Object.entries(mapping)) {
    const client = byKey.get(requestedKey) ?? bySlug.get(requestedKey);
    if (!client) {
      const known = sortBy(
        Array.from(new Set([...byKey.keys(), ...bySlug.keys()])),
        (k) => k,
      );
      throw new Error(
        `Unknown client "${requestedKey}" in mapping. Known clients: ${known.join(", ")}`,
      );
    }

    const canonicalSlug = client.slug;
    const dataset =
      clientDatasets[canonicalSlug] ??
      client.profile.dataset ??
      `${canonicalSlug}_marketing`;
    const gscExportDataset = gscExportDatasets[canonicalSlug] ?? null;

    const bigqueryTarget: BigqueryTargetPlan = {
      projectId,
      clientKey: canonicalSlug,
      dataset,
      gscExportDataset,
    };

    let maps: ClientSeedPlan["maps"] = undefined;
    if (client.mapsConfig && client.mapsConfig.locations.length > 0) {
      const sharedKeywords = client.mapsConfig.keywords ?? [];
      const defaultRadius = client.mapsConfig.radius_miles ?? 5;
      const gridSize = client.mapsConfig.grid_size ?? 7;
      const zoom = client.mapsConfig.zoom ?? "13z";
      const device = client.mapsConfig.device ?? "mobile";
      const languageCode = client.mapsConfig.language_code ?? "en";
      const depth = client.mapsConfig.depth ?? null;

      const locations: LocationSeedPlan[] = [];
      for (const loc of client.mapsConfig.locations) {
        const radiusMiles = loc.radius_miles ?? defaultRadius;
        locations.push({
          name: loc.name,
          slug: loc.slug,
          lat: loc.lat,
          lng: loc.lng,
          radiusMiles,
          brandName: client.profile.display_name,
          domain: client.profile.domain,
          phone: loc.phone ?? null,
          street: loc.street ?? loc.address ?? null,
          postalCode: loc.postal_code ?? null,
          placeId: loc.place_id ?? null,
          locationUrl: loc.url ?? null,
          matchTerms: loc.match_terms ?? [],
          config: {
            gridSize,
            radiusMiles,
            zoom,
            languageCode,
            device,
            depth,
            scheduleInterval: "weekly",
            isActive: true,
            nextRunAt: null,
          },
          keywords: [...sharedKeywords],
        });
      }

      maps = {
        configSource: client.mapsConfigPath ?? undefined,
        locations,
      };
    }

    plans.push({
      clientKey: client.key,
      clientSlug: canonicalSlug,
      displayName: client.displayName,
      projectId,
      profile: client.profile,
      bigqueryTarget,
      auditSchedule: buildAuditSchedulePlan(client, options),
      rankTracking: buildRankTrackingPlan(client, options),
      maps,
    });
  }

  return plans;
}

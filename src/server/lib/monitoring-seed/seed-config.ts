import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sortBy } from "remeda";
import { CLIENT_DATASETS } from "../bigquery/specs";
import {
  DEFAULT_CLIENT_ORDER,
  DEFAULT_GSC_EXPORT_DATASETS,
  DEFAULT_PATHS,
  type AhrefsClientsConfig,
  AhrefsClientsConfigSchema,
  type BigqueryTargetPlan,
  type ClientSeedPlan,
  type DiscoveredClient,
  type LocationSeedPlan,
  type MapsConfig,
  MapsConfigSchema,
  type ProjectMapping,
  ProjectMappingSchema,
  type SeoYoloProfile,
  SeoYoloProfileSchema,
} from "./seed-schemas";

export * from "./seed-schemas";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "Unknown error";
}

export function parseProjectMapping(input: unknown): ProjectMapping {
  let parsed = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new Error(
          `Invalid JSON in project mapping string: ${getErrorMessage(err)}`,
          { cause: err },
        );
      }
    } else {
      if (!existsSync(trimmed)) {
        throw new Error(`Mapping file does not exist: ${trimmed}`);
      }
      try {
        const fileContent = readFileSync(trimmed, "utf8");
        parsed = JSON.parse(fileContent);
      } catch (err) {
        throw new Error(
          `Failed to read or parse mapping file "${trimmed}": ${getErrorMessage(err)}`,
          { cause: err },
        );
      }
    }
  }

  const result = ProjectMappingSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Project mapping validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function parseClientProfile(input: unknown): SeoYoloProfile {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      throw new Error(
        `Failed to parse profile JSON string: ${getErrorMessage(err)}`,
        { cause: err },
      );
    }
  }
  const result = SeoYoloProfileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Client profile validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function parseAhrefsClientsConfig(input: unknown): AhrefsClientsConfig {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      throw new Error(
        `Failed to parse ahrefs clients JSON string: ${getErrorMessage(err)}`,
        { cause: err },
      );
    }
  }
  const result = AhrefsClientsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Ahrefs clients config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function parseMapsConfig(input: unknown): MapsConfig {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      throw new Error(
        `Failed to parse maps config JSON string: ${getErrorMessage(err)}`,
        { cause: err },
      );
    }
  }
  const result = MapsConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Maps config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function parseClientOrder(pythonSource: string): string[] {
  const match = pythonSource.match(/CLIENT_ORDER\s*=\s*\(([^)]+)\)/s);
  if (!match) return [...DEFAULT_CLIENT_ORDER];
  const body = match[1];
  const items: string[] = [];
  const regex = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null = null;
  while ((m = regex.exec(body)) !== null) {
    items.push(m[1]);
  }
  return items.length > 0 ? items : [...DEFAULT_CLIENT_ORDER];
}

export function parseGscExportDatasets(
  pythonSource: string,
): Record<string, string> {
  const match = pythonSource.match(
    /GSC_EXPORT_DATASETS\s*:\s*(?:dict\[[^\]]+\]\s*)?=\s*\{([^}]+)\}/s,
  );
  if (!match) return { ...DEFAULT_GSC_EXPORT_DATASETS };
  const body = match[1];
  const result: Record<string, string> = {};
  const lineRegex = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null = null;
  while ((m = lineRegex.exec(body)) !== null) {
    result[m[1]] = m[2];
  }
  return Object.keys(result).length > 0
    ? result
    : { ...DEFAULT_GSC_EXPORT_DATASETS };
}

type DiscoverClientsOptions = {
  seoYoloRoot?: string;
  ahrefsClientsConfigPath?: string;
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
  if (existsFn(ahrefsClientsConfigPath)) {
    try {
      const raw = readFn(ahrefsClientsConfigPath);
      const parsed = parseAhrefsClientsConfig(raw);
      for (const client of parsed.clients) {
        if (client.maps_config) {
          mapsConfigBySlug.set(client.slug, client.maps_config);
        }
      }
    } catch {
      // Continue without ahrefs maps configs if absent
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
    });
  }

  return discovered;
}

type BuildSeedingPlanOptions = {
  discoveredClients?: DiscoveredClient[];
  clientDatasets?: Record<string, string>;
  gscExportDatasets?: Record<string, string>;
};

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
      maps,
    });
  }

  return plans;
}

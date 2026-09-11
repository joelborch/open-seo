/**
 * Parsing and validation for every external input the monitoring seeder reads:
 * the project mapping and publisher-keyword files passed on the CLI, seo-yolo's
 * client profiles and maps configs, and the two Python constants the client list
 * is derived from. Everything here is pure — no filesystem walking, no plan
 * construction — so it is the trust boundary the rest of the seeder sits behind.
 */
import { existsSync, readFileSync } from "node:fs";
import { unique } from "remeda";
import { MAX_KEYWORDS_PER_CONFIG } from "@/shared/rank-tracking";
import {
  DEFAULT_CLIENT_ORDER,
  DEFAULT_GSC_EXPORT_DATASETS,
  type AhrefsClientsConfig,
  AhrefsClientsConfigSchema,
  type AioKeywordsConfig,
  AioKeywordsConfigSchema,
  type MapsConfig,
  MapsConfigSchema,
  type ProjectMapping,
  ProjectMappingSchema,
  type PublisherKeywordsFile,
  PublisherKeywordsFileSchema,
  type SeoYoloProfile,
  SeoYoloProfileSchema,
} from "./seed-schemas";

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "Unknown error";
}

/** A CLI argument that is either inline JSON or a path to a JSON file. */
function readJsonInput(input: unknown, label: string): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `Invalid JSON in ${label} string: ${getErrorMessage(err)}`,
        { cause: err },
      );
    }
  }
  if (!existsSync(trimmed)) {
    throw new Error(`${label} file does not exist: ${trimmed}`);
  }
  try {
    return JSON.parse(readFileSync(trimmed, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to read or parse ${label} file "${trimmed}": ${getErrorMessage(err)}`,
      { cause: err },
    );
  }
}

export function parseProjectMapping(input: unknown): ProjectMapping {
  const parsed = readJsonInput(input, "project mapping");
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

export function parseAioKeywordsConfig(input: unknown): AioKeywordsConfig {
  const result = AioKeywordsConfigSchema.safeParse(
    readJsonInput(input, "aio keywords config"),
  );
  if (!result.success) {
    throw new Error(
      `Aio keywords config validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

/**
 * `--publisher-keywords`: `{ "<client_key>": ["kw", ...] }`, inline or a path.
 * Keywords are trimmed, de-duplicated, and capped at the app's per-config limit
 * so the emitted rows cannot exceed what the product itself allows.
 */
export function parsePublisherKeywords(input: unknown): PublisherKeywordsFile {
  const result = PublisherKeywordsFileSchema.safeParse(
    readJsonInput(input, "publisher keywords"),
  );
  if (!result.success) {
    throw new Error(
      `Publisher keywords validation failed: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const normalized: PublisherKeywordsFile = {};
  for (const [clientKey, keywords] of Object.entries(result.data)) {
    normalized[clientKey] = normalizeTrackedKeywords(keywords);
  }
  return normalized;
}

/** Trim, drop blanks and duplicates, then cap at `MAX_KEYWORDS_PER_CONFIG`. */
export function normalizeTrackedKeywords(keywords: string[]): string[] {
  return unique(keywords.map((keyword) => keyword.trim()))
    .filter((keyword) => keyword.length > 0)
    .slice(0, MAX_KEYWORDS_PER_CONFIG);
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

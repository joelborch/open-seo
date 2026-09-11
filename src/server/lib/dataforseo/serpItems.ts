import { z } from "zod";

// Parsing layer for Google organic SERP items: the hand-written item schema and
// everything derived from a parsed item list. Kept out of serp.ts so the
// endpoint callers there stay readable, and so the live and task_get paths share
// one interpretation of a SERP.

const serpReferenceSchema = z
  .object({
    domain: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

// Nested element of a feature block (`ai_overview_element`, PAA answers, …).
// Its references/links are where an AI Overview's citations live.
const serpNestedItemSchema = z
  .object({
    type: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    references: z.array(serpReferenceSchema).nullable().optional(),
    links: z.array(serpReferenceSchema).nullable().optional(),
  })
  .passthrough();

// Kept as a hand-written schema: the SDK's BaseSerpApiElementItem type omits
// etv / estimated_paid_traffic_cost / backlinks_info / rank_changes, which we
// rely on. The fields survive deserialization (the SDK copies unknown keys), so
// validating here is both our type-safety guard and how we read those fields.
export const serpSnapshotItemSchema = z
  .object({
    type: z.string(),
    items: z.array(serpNestedItemSchema).nullable().optional(),
    references: z.array(serpReferenceSchema).nullable().optional(),
    links: z.array(serpReferenceSchema).nullable().optional(),
    rank_group: z.number().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    domain: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    breadcrumb: z.string().nullable().optional(),
    etv: z.number().nullable().optional(),
    estimated_paid_traffic_cost: z.number().nullable().optional(),
    backlinks_info: z
      .object({
        referring_domains: z.number().nullable().optional(),
        backlinks: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    rank_changes: z
      .object({
        previous_rank_absolute: z.number().nullable().optional(),
        is_new: z.boolean().nullable().optional(),
        is_up: z.boolean().nullable().optional(),
        is_down: z.boolean().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type SerpLiveItem = z.infer<typeof serpSnapshotItemSchema>;

export interface RankSnapshotFeature {
  featureType: string;
  /** Where the block sat in the whole SERP (features included). */
  rankAbsolute: number | null;
  /** Whether the tracked domain appeared inside the block — as the listing
   *  itself (local pack) or as a cited source (AI Overview). */
  clientPresent: boolean;
}

export interface RankCheckResult {
  keywordId: string;
  keyword: string;
  /** Position among organic results only. */
  position: number | null;
  /** Position across the whole SERP, feature blocks included. */
  rankAbsolute: number | null;
  url: string | null;
  /** Rank of the target's listing inside the local pack, if it is in one. */
  localPackPosition: number | null;
  /** null on all three when the config didn't opt into AI Overview tracking —
   *  we didn't pay to load the block, so absence proves nothing. */
  aioPresent: boolean | null;
  aioClientCited: boolean | null;
  aioCitationPosition: number | null;
  serpFeatures: string[];
  features: RankSnapshotFeature[];
  /** Cost DataForSEO reported on the response that produced this result. On
   *  the live path that is the amount just charged; on task_get it is the
   *  settled task cost, already paid at task_post. */
  providerCostUsd: number | null;
}

/**
 * Host of a `domain` or `url` field: lowercased, scheme/path/port stripped, and
 * `www.` dropped so "www.example.com", "https://example.com/x" and
 * "example.com" all compare equal.
 */
function toHost(value: string | null | undefined): string | null {
  if (!value) return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
  return host || null;
}

function hostMatchesTarget(
  value: string | null | undefined,
  target: string,
): boolean {
  const host = toHost(value);
  if (!host) return false;
  return host === target || host.endsWith(`.${target}`);
}

/**
 * Hosts cited inside one feature block, in the order Google shows them and
 * de-duplicated — the ordering that makes an AI Overview citation position
 * meaningful, since reference entries carry no rank of their own. Element-level
 * references and links come first (mirroring seo-yolo's projection), then the
 * block's own reference list.
 */
function citedHosts(item: SerpLiveItem): string[] {
  const hosts: string[] = [];
  const add = (
    refs: z.infer<typeof serpReferenceSchema>[] | null | undefined,
  ) => {
    for (const ref of refs ?? []) {
      const host = toHost(ref.domain ?? ref.url);
      if (host && !hosts.includes(host)) hosts.push(host);
    }
  };
  for (const element of item.items ?? []) {
    add(element.references);
    add(element.links);
  }
  add(item.references);
  add(item.links);
  return hosts;
}

/** Whether the tracked domain appears in a block, as its subject or a source. */
function itemMentionsTarget(item: SerpLiveItem, target: string): boolean {
  if (
    hostMatchesTarget(item.domain, target) ||
    hostMatchesTarget(item.url, target)
  ) {
    return true;
  }
  return citedHosts(item).some((host) => hostMatchesTarget(host, target));
}

function buildFeatureList(
  items: SerpLiveItem[],
  target: string,
): RankSnapshotFeature[] {
  const byType = new Map<string, RankSnapshotFeature>();
  for (const item of items) {
    if (!item.type) continue;
    const mentions = itemMentionsTarget(item, target);
    const existing = byType.get(item.type);
    if (!existing) {
      byType.set(item.type, {
        featureType: item.type,
        rankAbsolute: item.rank_absolute ?? null,
        clientPresent: mentions,
      });
      continue;
    }
    // Several blocks of one type can appear (three local_pack rows, say): keep
    // the topmost rank and OR the presence flags into one row per type.
    existing.clientPresent = existing.clientPresent || mentions;
    if (
      item.rank_absolute != null &&
      (existing.rankAbsolute == null ||
        item.rank_absolute < existing.rankAbsolute)
    ) {
      existing.rankAbsolute = item.rank_absolute;
    }
  }
  return [...byType.values()];
}

export function buildRankCheckResult(
  input: {
    keywordId: string;
    keyword: string;
    targetDomain: string;
  } & { trackAiOverview?: boolean },
  items: SerpLiveItem[],
  providerCostUsd: number | null = null,
): RankCheckResult {
  const target = toHost(input.targetDomain) ?? input.targetDomain.toLowerCase();
  const organicMatch = items.find(
    (item) => item.type === "organic" && hostMatchesTarget(item.domain, target),
  );
  const localPackMatch = items.find(
    (item) =>
      item.type === "local_pack" &&
      (hostMatchesTarget(item.domain, target) ||
        hostMatchesTarget(item.url, target)),
  );
  const aiOverview = items.find((item) => item.type === "ai_overview");
  const citationIndex = aiOverview
    ? citedHosts(aiOverview).findIndex((host) =>
        hostMatchesTarget(host, target),
      )
    : -1;

  return {
    keywordId: input.keywordId,
    keyword: input.keyword,
    // rank_group = position among organic results only (what users count as
    // "my ranking"). rank_absolute would also count SERP features (local
    // pack, PAA, AI overviews) and reads as worse than what users see.
    position: organicMatch
      ? (organicMatch.rank_group ?? organicMatch.rank_absolute ?? null)
      : null,
    rankAbsolute: organicMatch?.rank_absolute ?? null,
    url: organicMatch?.url ?? null,
    localPackPosition: localPackMatch
      ? (localPackMatch.rank_group ?? localPackMatch.rank_absolute ?? null)
      : null,
    // Without the opt-in the block was never requested, so "absent" would be
    // an unfounded claim — leave all three null.
    aioPresent: input.trackAiOverview ? aiOverview !== undefined : null,
    aioClientCited: input.trackAiOverview
      ? aiOverview !== undefined && citationIndex >= 0
      : null,
    aioCitationPosition:
      input.trackAiOverview && citationIndex >= 0 ? citationIndex + 1 : null,
    serpFeatures: [...new Set(items.map((item) => item.type).filter(Boolean))],
    features: buildFeatureList(items, target),
    providerCostUsd,
  };
}

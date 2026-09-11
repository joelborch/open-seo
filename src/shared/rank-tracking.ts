import {
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  SEO_DATA_COST_MARKUP,
  roundUsdForBilling,
} from "./billing";
import type {
  RankTrackingConfig,
  RankTrackingDeviceResult,
} from "@/types/schemas/rank-tracking";

// ---------------------------------------------------------------------------
// Cost constants
// ---------------------------------------------------------------------------

/** DataForSEO Live API: cost of first page (10 results) */
const LIVE_BASE_PAGE_COST_USD = 0.002;

/** DataForSEO Live API: cost of each additional page (75% of base) */
const LIVE_EXTRA_PAGE_COST_USD = 0.0015;

/** DataForSEO task queue (standard priority): cost of first page (10 results) */
const QUEUED_BASE_PAGE_COST_USD = 0.0006;

/** DataForSEO task queue (standard priority): cost of each additional page (75% of base) */
const QUEUED_EXTRA_PAGE_COST_USD = 0.00045;

/**
 * How a rank check reaches DataForSEO: "live" is the instant endpoint used for
 * manual checks; "queued" is the cheaper task queue used for scheduled checks.
 */
type RankCheckMethod = "live" | "queued";

/** How many keywords are checked per batch */
export const KEYWORDS_PER_BATCH = 10;

/** Approximate seconds per batch */
export const SECONDS_PER_BATCH = 6;

/** Soft application limit for keywords per rank tracking config */
export const MAX_KEYWORDS_PER_CONFIG = 1000;

/** Maximum length of a single tracked keyword */
export const MAX_TRACKED_KEYWORD_LENGTH = 200;

/** Maximum configs (domain+location combos) per project */
export const MAX_CONFIGS_PER_PROJECT = 500;

/** Maximum queued rank-check tasks DataForSEO accepts in one task_post. */
export const MAX_TASKS_PER_POST = 100;

export const rankCheckCostApprovalError = (
  costCredits: number,
  maxCostCredits: number,
) => {
  return `The current rank check costs ${costCredits} credits, above the approved maximum of ${maxCostCredits}. Call estimate_rank_tracker_cost again and ask the user to approve the updated amount.`;
};

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * Asking DataForSEO to load the AI Overview block (`load_async_ai_overview`)
 * doubles what the SERP task costs, so the config opt-in has to be visible in
 * every estimate and reservation.
 */
export const AI_OVERVIEW_COST_MULTIPLIER = 2;

/**
 * DataForSEO's own price for a single SERP request at the given depth — no
 * markup. This is the unit the rank-check ledger reserves and settles in
 * (`rank_check_tasks.reserved_cost_micros`), which is why it is exported.
 */
export function costPerSerpAtDepth(
  depth: number,
  method: RankCheckMethod,
  aiOverview = false,
): number {
  const pages = depth / 10;
  const base =
    method === "queued"
      ? QUEUED_BASE_PAGE_COST_USD + (pages - 1) * QUEUED_EXTRA_PAGE_COST_USD
      : LIVE_BASE_PAGE_COST_USD + (pages - 1) * LIVE_EXTRA_PAGE_COST_USD;
  return aiOverview ? base * AI_OVERVIEW_COST_MULTIPLIER : base;
}

// ---------------------------------------------------------------------------
// Money in micros
// ---------------------------------------------------------------------------

/**
 * USD to integer micro-dollars, rounded up. Every provider-cost column
 * (`*_cost_micros`) stores integers so a run's spend can be summed in SQL
 * without float drift; rounding up means a rollup is never an understatement.
 */
export function usdToMicros(usd: number): number {
  return Math.ceil(usd * 1_000_000);
}

/** Display helper: micro-dollars as a dollar string (4 decimals, so sub-cent
 *  rank-check spend is still readable). */
export function formatMicrosUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

export function depthToPages(depth: number): number {
  return depth / 10;
}

export function pagesToDepth(pages: number): number {
  return pages * 10;
}

export function estimateRankCheckCredits(
  keywordCount: number,
  devices: RankTrackingConfig["devices"],
  depth: number,
  method: RankCheckMethod,
) {
  const totalChecks = keywordCount * devicesCount(devices);
  const checksPerMeteredCall = method === "queued" ? MAX_TASKS_PER_POST : 1;
  let costUsd = 0;
  let costCredits = 0;

  // Metering rounds and ceilings each provider call independently. Live rank
  // checks make one call per keyword/device pair, while queued checks post up
  // to MAX_TASKS_PER_POST pairs per call. Summing one aggregate and rounding
  // once can therefore understate the credits that will actually be charged.
  for (let offset = 0; offset < totalChecks; offset += checksPerMeteredCall) {
    const checksInCall = Math.min(checksPerMeteredCall, totalChecks - offset);
    const callCostUsd = roundUsdForBilling(
      checksInCall * costPerSerpAtDepth(depth, method) * SEO_DATA_COST_MARKUP,
    );
    costUsd += callCostUsd;
    costCredits += Math.ceil(callCostUsd * AUTUMN_SEO_DATA_CREDITS_PER_USD);
  }

  // This is the nominal queued task_post estimate. Rejected, failed, or
  // timed-out tasks can later incur additional live-fallback spend.
  costUsd = roundUsdForBilling(costUsd);
  return { costUsd, costCredits };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

type ScheduledRankTrackingInterval = Exclude<
  RankTrackingConfig["scheduleInterval"],
  "manual"
>;

// Values written to rank_tracking_configs.last_skip_reason (free-form text in
// the schema; this union keeps writers and UI comparisons in sync).
export type RankTrackingSkipReason =
  | "plan_required"
  | "no_keywords"
  | "insufficient_credits";

export function estimateScheduledRankCheckCredits(
  keywordCount: number,
  devices: RankTrackingConfig["devices"],
  depth: number,
  scheduleInterval: ScheduledRankTrackingInterval,
) {
  const { costUsd, costCredits } = estimateRankCheckCredits(
    keywordCount,
    devices,
    depth,
    "queued",
  );
  const checksPerMonth =
    scheduleInterval === "daily" ? 30 : scheduleInterval === "weekly" ? 4 : 1;
  return {
    scheduleInterval,
    costUsd,
    costCredits,
    checksPerMonth,
    monthlyCostUsd: costUsd * checksPerMonth,
    monthlyCostCredits: costCredits * checksPerMonth,
  };
}

export function isScheduledRankTrackingInterval(
  interval: RankTrackingConfig["scheduleInterval"],
): interval is ScheduledRankTrackingInterval {
  return interval !== "manual";
}

function endOfMonthWithTime(source: Date, monthOffset = 0): Date {
  const endOfMonth = new Date(
    Date.UTC(
      source.getUTCFullYear(),
      source.getUTCMonth() + monthOffset + 1,
      0,
    ),
  );
  endOfMonth.setUTCHours(
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
  return endOfMonth;
}

/**
 * Compute the next check time for a scheduled config.
 *
 * If `previousNextCheckAt` is provided, advances from that anchor by the
 * interval until the result is in the future. This prevents schedule drift
 * when runs are delayed (e.g., a weekly config due Monday that fires on
 * Wednesday will still schedule the next check for the following Monday).
 *
 * Otherwise a random hour (04–09 UTC) and minute are chosen.
 */
export function computeNextCheckAt(
  interval: ScheduledRankTrackingInterval,
  previousNextCheckAt?: string | null,
): string {
  const now = Date.now();

  if (interval === "monthly") {
    if (previousNextCheckAt) {
      const anchor = new Date(previousNextCheckAt);
      let monthOffset = 1;
      let nextDate = endOfMonthWithTime(anchor, monthOffset);
      while (nextDate.getTime() <= now) {
        monthOffset += 1;
        nextDate = endOfMonthWithTime(anchor, monthOffset);
      }
      return nextDate.toISOString();
    }

    const hour = 4 + Math.floor(Math.random() * 6);
    const minute = Math.floor(Math.random() * 60);
    const nextDate = endOfMonthWithTime(new Date());
    nextDate.setUTCHours(hour, minute, 0, 0);
    if (nextDate.getTime() <= now) {
      const followingMonth = endOfMonthWithTime(nextDate, 1);
      followingMonth.setUTCHours(hour, minute, 0, 0);
      return followingMonth.toISOString();
    }
    return nextDate.toISOString();
  }

  const daysAhead = interval === "daily" ? 1 : 7;

  if (previousNextCheckAt) {
    const anchor = new Date(previousNextCheckAt).getTime();
    const intervalMs = daysAhead * 86_400_000;
    const steps = Math.floor(Math.max(0, now - anchor) / intervalMs) + 1;
    return new Date(anchor + steps * intervalMs).toISOString();
  }

  const nextDate = new Date();
  nextDate.setUTCDate(nextDate.getUTCDate() + daysAhead);
  const hour = 4 + Math.floor(Math.random() * 6);
  const minute = Math.floor(Math.random() * 60);
  nextDate.setUTCHours(hour, minute, 0, 0);
  return nextDate.toISOString();
}

// ---------------------------------------------------------------------------
// Display labels
// ---------------------------------------------------------------------------

export function devicesLabel(devices: RankTrackingConfig["devices"]): string {
  if (devices === "both") return "Desktop + Mobile";
  return devices === "desktop" ? "Desktop" : "Mobile";
}

export function scheduleLabel(
  interval: RankTrackingConfig["scheduleInterval"],
): string {
  if (interval === "daily") return "Daily";
  if (interval === "weekly") return "Weekly";
  if (interval === "monthly") return "Monthly";
  return "Manual";
}

export function devicesCount(devices: RankTrackingConfig["devices"]): number {
  return devices === "both" ? 2 : 1;
}

/**
 * A device row with nothing observed. Both the read model (keywords that have
 * never been checked) and the sparse trend/history views need one, so the shape
 * lives in one place — a new SERP-detail column then has a single default.
 */
export function emptyRankTrackingDeviceResult(
  previousPosition: number | null = null,
): RankTrackingDeviceResult {
  return {
    position: null,
    previousPosition,
    rankingUrl: null,
    serpFeatures: [],
    localPackPosition: null,
    aioPresent: null,
    aioClientCited: null,
    aioCitationPosition: null,
    aioCitations: [],
    aioSnippet: null,
  };
}

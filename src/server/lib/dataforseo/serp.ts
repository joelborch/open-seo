import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import { MAX_TASKS_PER_POST } from "@/server/lib/dataforseo/shared";
import {
  assertOk,
  buildTaskBilling,
  isNoResultsTask,
  isTaskInProgress,
  parseTaskItems,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import {
  buildRankCheckResult,
  serpSnapshotItemSchema,
  type RankCheckResult,
  type SerpLiveItem,
} from "@/server/lib/dataforseo/serpItems";
import { AppError } from "@/server/lib/errors";

// Default depth for keyword SERP analysis. DataForSEO crawls (and bills) one
// Google page of 10 results at a time, and the crawls are sequential, so depth
// is the single lever on both latency and cost here: every 10 results is
// another page fetch against the shared 60s request budget. Keep this low —
// callers that need to see deeper ranks pass an explicit depth. There is no
// offset/cursor: a deeper request re-crawls pages 1..N/10 from the top, so it
// replaces the shallow snapshot rather than extending it.
export const SERP_ANALYSIS_DEPTH = 20;

/** DataForSEO bills SERPs in pages of 10; depth outside 10-100 is rejected. */
function clampSerpDepth(depth: number): number {
  return Math.min(100, Math.max(10, depth));
}

/**
 * Stop crawling SERP pages once the target domain is found — DataForSEO only
 * bills the pages crawled, so a page-1 ranking at depth 20 costs one page
 * instead of two. Matching is restricted to organic results and uses
 * with_subdomains, mirroring buildRankCheckResult exactly: without
 * find_targets_in, a sitelink or PAA mention could stop the crawl before the
 * domain's organic listing and record a false "not ranking".
 */
function stopCrawlOnTarget(targetDomain: string) {
  return {
    stop_crawl_on_match: [
      { match_value: targetDomain, match_type: "with_subdomains" },
    ],
    find_targets_in: ["organic"],
  };
}

/** Config opt-ins that change what a rank-check request buys. */
interface RankCheckCollectionOptions {
  /** Keep crawling past the target's listing so competitor ranks are captured
   *  too. Costs every page of `depth` instead of stopping early. */
  trackCompetitors?: boolean;
  /** Ask Google to load the AI Overview block. Doubles the task's cost, so it
   *  is only sent when the config opted in. */
  trackAiOverview?: boolean;
}

/**
 * Per-request params derived from the collection opt-ins. Shared by the live
 * and task_post payloads so the two paths can never drift on what they bought.
 */
function collectionParams(
  input: RankCheckCollectionOptions & { targetDomain: string },
) {
  return {
    // Competitor tracking needs the whole SERP, so the early-stop optimization
    // is off in that mode — the run pays for every page of `depth`.
    ...(input.trackCompetitors ? {} : stopCrawlOnTarget(input.targetDomain)),
    ...(input.trackAiOverview ? { load_async_ai_overview: true } : {}),
  };
}

// A cited source inside a SERP feature block. `ai_overview_reference` entries
// carry domain + url (and no rank of their own), `link_element` entries the
// same two fields — so one shape reads both.

export async function fetchLiveSerp(input: {
  keyword: string;
  locationCode: number;
  languageCode: string;
  depth?: number;
}): Promise<DataforseoApiResponse<SerpLiveItem[]>> {
  const response = await dataforseoPost(
    "/v3/serp/google/organic/live/advanced",
    [
      {
        keyword: input.keyword,
        location_code: input.locationCode,
        language_code: input.languageCode,
        device: "desktop",
        os: "windows",
        depth: clampSerpDepth(input.depth ?? SERP_ANALYSIS_DEPTH),
      },
    ],
  );
  // DataForSEO uses a task error for a valid empty SERP. Keep the charged
  // response in the normal billing path and return an empty item list.
  const task = assertOk(response, { treatNoResultsAsEmpty: true });
  return {
    data: parseTaskItems(
      "google-organic-live-advanced",
      task,
      serpSnapshotItemSchema,
    ),
    billing: buildTaskBilling(task),
  };
}

/** One SERP feature block observed in a check, persisted per snapshot. */
export async function fetchRankCheckSerp(
  input: {
    keyword: string;
    keywordId: string;
    locationCode: number;
    languageCode: string;
    locationName?: string;
    device: "desktop" | "mobile";
    targetDomain: string;
    depth: number;
  } & RankCheckCollectionOptions,
): Promise<DataforseoApiResponse<RankCheckResult>> {
  const depth = clampSerpDepth(input.depth);
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  const response = await dataforseoPost(
    "/v3/serp/google/organic/live/advanced",
    [
      {
        keyword: input.keyword,
        ...locationParams,
        language_code: input.languageCode,
        device: input.device,
        os: input.device === "desktop" ? "windows" : "android",
        depth,
        ...collectionParams(input),
      },
    ],
  );

  // "No Search Results" (40501) is valid for obscure/new keywords — treat as an
  // empty result set rather than failing the whole rank-tracking run.
  const task = assertOk(response, { treatNoResultsAsEmpty: true });
  const items = parseTaskItems(
    "google-organic-live-advanced",
    task,
    serpSnapshotItemSchema,
  );
  const billing = buildTaskBilling(task);

  return {
    data: buildRankCheckResult(input, items, billing.costUsd),
    billing,
  };
}

// ---------------------------------------------------------------------------
// Task-queue rank checks (scheduled runs). DataForSEO's standard queue costs
// ~30% of the live endpoint; tasks complete in ~5 minutes on average. The flow
// is task_post (charged) -> poll task_get (free) -> live fallback for
// stragglers, orchestrated by the rank check workflow.
// ---------------------------------------------------------------------------

export interface RankCheckTaskInput {
  keyword: string;
  keywordId: string;
  device: "desktop" | "mobile";
}

export interface PostedRankCheckTask extends RankCheckTaskInput {
  taskId: string;
  /** Cost DataForSEO charged for this task at post time, in USD. */
  costUsd: number;
}

/** An entry DataForSEO refused, kept so the ledger can record why. */
interface RejectedRankCheckTask extends RankCheckTaskInput {
  statusCode: number | null;
  statusMessage: string | null;
}

interface RankCheckTaskPostResult {
  posted: PostedRankCheckTask[];
  rejected: RejectedRankCheckTask[];
}

export async function postRankCheckTasks(
  input: {
    tasks: RankCheckTaskInput[];
    locationCode: number;
    languageCode: string;
    locationName?: string;
    depth: number;
    targetDomain: string;
  } & RankCheckCollectionOptions,
): Promise<DataforseoApiResponse<RankCheckTaskPostResult>> {
  if (input.tasks.length === 0 || input.tasks.length > MAX_TASKS_PER_POST) {
    throw new AppError(
      "INTERNAL_ERROR",
      `task_post accepts 1-${MAX_TASKS_PER_POST} tasks, got ${input.tasks.length}`,
    );
  }
  const depth = clampSerpDepth(input.depth);
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  const response = await dataforseoPost<
    DataforseoTaskLike & { id?: string; data?: Record<string, unknown> }
  >(
    "/v3/serp/google/organic/task_post",
    input.tasks.map((task) => ({
      keyword: task.keyword,
      ...locationParams,
      language_code: input.languageCode,
      device: task.device,
      os: task.device === "desktop" ? "windows" : "android",
      depth,
      // Queued tasks are billed provisionally at full depth at post time;
      // task_get later reports the reduced actual cost when the crawl
      // stopped early. We meter customers on the post-time amount —
      // collection-time metering is a possible future optimization.
      ...collectionParams(input),
      // Echoed back on the response entry and task_get; used to map a
      // DataForSEO task id back to our keyword without relying on order.
      tag: `${task.keywordId}:${task.device}`,
    })),
  );

  if (!response || response.status_code !== 20000) {
    throw new AppError(
      "INTERNAL_ERROR",
      response?.status_message || "DataForSEO task_post failed",
    );
  }

  // One response entry per submitted task; accepted entries have status 20100
  // "Task Created" and their own cost (charged at post time). Cost is summed
  // over every entry — accepted or not — so anything DataForSEO charged is
  // metered. Rejected entries get no posted task; the workflow falls back to
  // the live endpoint for any keyword/device pair missing from the result.
  const byTag = new Map(
    input.tasks.map((task) => [`${task.keywordId}:${task.device}`, task]),
  );
  const posted: PostedRankCheckTask[] = [];
  const rejected: RejectedRankCheckTask[] = [];
  let costUsd = 0;
  for (const entry of response.tasks ?? []) {
    const entryCost = entry.cost ?? 0;
    costUsd += entryCost;
    const tag: unknown = entry.data?.tag;
    const task = typeof tag === "string" ? byTag.get(tag) : undefined;
    if (entry.status_code !== 20100 || !entry.id || !task) {
      console.warn(
        `dataforseo.task_post.rejected-entry (${entry.status_code}): ${entry.status_message}`,
      );
      if (task) {
        rejected.push({
          ...task,
          statusCode: entry.status_code ?? null,
          statusMessage: entry.status_message ?? null,
        });
      }
      continue;
    }
    posted.push({ ...task, taskId: entry.id, costUsd: entryCost });
  }

  return {
    data: { posted, rejected },
    billing: {
      path: ["v3", "serp", "google", "organic", "task_post"],
      costUsd,
    },
  };
}

type RankCheckTaskOutcome =
  | { status: "pending"; providerStatusCode: number | null }
  | {
      status: "failed";
      message: string;
      providerStatusCode: number | null;
    }
  | {
      status: "completed";
      result: RankCheckResult;
      providerStatusCode: number | null;
      /** DataForSEO returned the task but no SERP items — a terminal empty
       *  result, not a failure and not worth retrying. */
      isEmpty: boolean;
    };

/**
 * Collect one queued task's result. Deliberately not metered and not wrapped
 * in the billing envelope: collection is free (the task was charged at
 * task_post), and the task_get response carries the task's settled cost
 * (reduced when stop_crawl_on_match ended the crawl early) — running it
 * through the metering seam would charge the customer twice.
 */
export async function fetchRankCheckTaskResult(
  input: {
    taskId: string;
    keywordId: string;
    keyword: string;
    targetDomain: string;
  } & RankCheckCollectionOptions,
): Promise<RankCheckTaskOutcome> {
  const response = await dataforseoGet(
    `/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(input.taskId)}`,
  );
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    throw new AppError(
      "INTERNAL_ERROR",
      response?.status_message || "DataForSEO task_get failed",
    );
  }

  const providerStatusCode = task.status_code ?? null;
  // Settled cost the queue reports back. Already paid at task_post, so it is
  // carried for the record, not re-metered.
  const settledCostUsd = typeof task.cost === "number" ? task.cost : null;

  if (isTaskInProgress(task)) {
    return { status: "pending", providerStatusCode };
  }

  if (task.status_code !== 20000) {
    // "No Search Results" is valid for obscure/new keywords — same treatment
    // as the live path's treatNoResultsAsEmpty.
    if (!isNoResultsTask(task)) {
      return {
        status: "failed",
        message:
          task.status_message || `DataForSEO task failed (${task.status_code})`,
        providerStatusCode,
      };
    }
    return {
      status: "completed",
      result: buildRankCheckResult(input, [], settledCostUsd),
      providerStatusCode,
      isEmpty: true,
    };
  }

  const items = parseTaskItems(
    "google-organic-task-get-advanced",
    task,
    serpSnapshotItemSchema,
  );
  return {
    status: "completed",
    result: buildRankCheckResult(input, items, settledCostUsd),
    providerStatusCode,
    isEmpty: items.length === 0,
  };
}

export async function fetchLocalSerp(input: {
  keyword: string;
  locationCoordinate?: string;
  languageCode: string;
  searchType: "maps" | "local_finder";
  device: "desktop" | "mobile";
  depth: number;
  searchPlaces?: boolean;
}): Promise<DataforseoApiResponse<Record<string, unknown>[]>> {
  const os = input.device === "desktop" ? "windows" : "android";

  if (input.searchType === "maps") {
    const response = await dataforseoPost<
      DataforseoItemsTask<Record<string, unknown>>
    >("/v3/serp/google/maps/live/advanced", [
      {
        keyword: input.keyword,
        location_coordinate: input.locationCoordinate,
        language_code: input.languageCode,
        device: input.device,
        os,
        depth: input.depth,
        search_places: input.searchPlaces,
      },
    ]);
    // 40501 = billed empty SERP; DataForSEO returns it for some coordinate-only
    // Maps and Local Finder queries (both paths below opt in).
    const task = assertOk(response, { treatNoResultsAsEmpty: true });
    return {
      data: task.result?.[0]?.items ?? [],
      billing: buildTaskBilling(task),
    };
  }

  const response = await dataforseoPost<
    DataforseoItemsTask<Record<string, unknown>>
  >("/v3/serp/google/local_finder/live/advanced", [
    {
      keyword: input.keyword,
      location_coordinate: input.locationCoordinate,
      language_code: input.languageCode,
      device: input.device,
      os,
      depth: input.depth,
    },
  ]);
  const task = assertOk(response, { treatNoResultsAsEmpty: true });
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}

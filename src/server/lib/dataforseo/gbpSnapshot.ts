/**
 * Provider surface for the scheduled Google Business Profile snapshot: read one
 * profile's current state, and queue its newest reviews.
 *
 * Two calls per location per run, both on the `business_data` endpoints upstream
 * already uses:
 *
 *  - `google/my_business_info/live` is the profile itself (rating, review count,
 *    category, claimed status, NAP, photo count, attributes). It is live because
 *    there is no queued variant, and it is the cheap half of a snapshot.
 *  - `google/reviews/task_post` is queued at standard priority. A weekly snapshot
 *    has no latency requirement, and high priority costs double for nothing here
 *    — the cron collects the result through `fetchBusinessDataTaskResult`, which
 *    is free and deliberately unmetered.
 *
 * Both fetchers echo what DataForSEO charged back on their `data`, on top of the
 * billing envelope the metered client consumes, because the snapshot row keeps
 * its own `cost_micros` ledger of what the capture actually spent.
 */
import { z } from "zod";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  assertOk,
  buildTaskBilling,
  isRecord,
  type DataforseoApiResponse,
  type DataforseoItemsTask,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

/** Reviews kept per snapshot. One `depth` unit is one review at the provider. */
const GBP_REVIEWS_DEPTH = 20;

/** Review text is stored for display, not archival; longer bodies are truncated. */
const GBP_REVIEW_TEXT_LIMIT = 1000;

/** "Task Created" — the success status on a task_post entry. */
const TASK_CREATED_STATUS_CODE = 20100;

/**
 * Codes DataForSEO returns for a profile lookup that ran, was charged, and found
 * nothing: 40501 "No Search Results" and 40102, the same billed-empty pair the
 * Maps grid treats as a terminal "not found". A location whose profile Google has
 * dropped is a real observation, so these produce an empty snapshot rather than
 * an error the scheduler has to keep retrying.
 */
const BILLED_EMPTY_STATUS_CODES = new Set([40102, 40501]);

// task_post creates a billed task. A 5xx does not prove the provider skipped the
// charge, so those posts must never be replayed.
const NO_RETRY = { maxServerErrorRetries: 0 } as const;

/**
 * Location + language, the same pair the other business_data fetchers take: the
 * endpoints accept a coordinate ("lat,lng,radius" in meters) or a location code,
 * never both, so the coordinate wins when present.
 */
type GbpLocationInput = {
  locationCoordinate?: string;
  locationCode?: number;
  languageCode: string;
};

function locationParams(input: GbpLocationInput) {
  return input.locationCoordinate
    ? { location_coordinate: input.locationCoordinate }
    : { location_code: input.locationCode };
}

// The Google business_data endpoints take the coordinate radius in meters and
// reject anything outside this band.
const MIN_RADIUS_M = 200;
const MAX_RADIUS_M = 199_999;
const METERS_PER_MILE = 1609.344;

/** "lat,lng,radius" with the radius in meters, as these endpoints want it. */
export function formatGbpCoordinate(
  lat: number,
  lng: number,
  radiusMiles: number,
): string {
  const radius = Math.min(
    MAX_RADIUS_M,
    Math.max(MIN_RADIUS_M, Math.round(radiusMiles * METERS_PER_MILE)),
  );
  return `${Number(lat.toFixed(7))},${Number(lng.toFixed(7))},${radius}`;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/**
 * The fields of a `my_business_info` item a snapshot stores. Everything else on
 * the item (images, popular times, place topics, the people-also-search list) is
 * dropped here rather than downstream, so the row shape is the contract.
 *
 * `.loose()` on every object: DataForSEO adds fields to these items without
 * notice, and a snapshot must not start failing because of one.
 */
const profileItemSchema = z.looseObject({
  title: z.string().nullish(),
  category: z.string().nullish(),
  additional_categories: z.array(z.string()).nullish(),
  cid: z.string().nullish(),
  place_id: z.string().nullish(),
  address: z.string().nullish(),
  phone: z.string().nullish(),
  url: z.string().nullish(),
  is_claimed: z.boolean().nullish(),
  total_photos: z.number().nullish(),
  rating: z
    .looseObject({
      value: z.number().nullish(),
      votes_count: z.number().nullish(),
    })
    .nullish(),
  // { available_attributes: { service_options: ["has_delivery"] }, ... }
  attributes: z
    .looseObject({
      available_attributes: z
        .record(z.string(), z.array(z.string()).nullish())
        .nullish(),
    })
    .nullish(),
});

type GbpProfile = {
  name: string | null;
  primaryCategory: string | null;
  additionalCategories: string[];
  cid: string | null;
  placeId: string | null;
  rating: number | null;
  reviewsCount: number | null;
  isClaimed: boolean | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  photosCount: number | null;
  /** Attribute group -> the values Google shows as present on the profile. */
  availableAttributes: Array<{ key: string; value: string }>;
};

type GbpProfileResult = {
  /** Null when DataForSEO charged for a lookup that matched no profile. */
  profile: GbpProfile | null;
  /** What this call cost, in USD, for the snapshot's own cost ledger. */
  costUsd: number;
};

function toProfile(item: Record<string, unknown>): GbpProfile {
  const parsed = profileItemSchema.safeParse(item);
  if (!parsed.success) {
    console.error(
      "dataforseo.gbp-profile.invalid-payload",
      parsed.error.issues.slice(0, 5),
    );
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO my_business_info returned an invalid response shape",
    );
  }
  const data = parsed.data;
  const groups = data.attributes?.available_attributes ?? {};
  return {
    name: data.title ?? null,
    primaryCategory: data.category ?? null,
    additionalCategories: data.additional_categories ?? [],
    cid: data.cid ?? null,
    placeId: data.place_id ?? null,
    rating: data.rating?.value ?? null,
    reviewsCount: data.rating?.votes_count ?? null,
    isClaimed: data.is_claimed ?? null,
    address: data.address ?? null,
    phone: data.phone ?? null,
    website: data.url ?? null,
    photosCount: data.total_photos ?? null,
    availableAttributes: Object.entries(groups).flatMap(([key, values]) =>
      (values ?? []).map((value) => ({ key, value })),
    ),
  };
}

/**
 * Read one Google Business Profile. `keyword` carries the identity through
 * DataForSEO's documented `cid:` / `place_id:` prefixes (the endpoint takes no
 * separate identifier field), so the caller decides how precisely the location
 * is pinned.
 */
export async function fetchGbpProfile(
  input: { keyword: string } & GbpLocationInput,
): Promise<DataforseoApiResponse<GbpProfileResult>> {
  const response = await dataforseoPost<DataforseoItemsTask<unknown>>(
    "/v3/business_data/google/my_business_info/live",
    [
      {
        keyword: input.keyword,
        ...locationParams(input),
        language_code: input.languageCode,
      },
    ],
  );

  const billedEmpty = response?.tasks?.[0];
  if (
    response?.status_code === 20000 &&
    billedEmpty &&
    BILLED_EMPTY_STATUS_CODES.has(billedEmpty.status_code ?? 0)
  ) {
    const billing = buildTaskBilling(billedEmpty);
    return {
      data: { profile: null, costUsd: billing.costUsd },
      billing,
    };
  }

  const task = assertOk(response);
  const billing = buildTaskBilling(task);
  const item = task.result?.[0]?.items?.[0];
  return {
    data: {
      profile: isRecord(item) ? toProfile(item) : null,
      costUsd: billing.costUsd,
    },
    billing,
  };
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

type PostedGbpReviewsTask = {
  taskId: string;
  costUsd: number;
};

/**
 * Queue the newest {@link GBP_REVIEWS_DEPTH} reviews for one location. Unlike the
 * profile lookup this endpoint takes `cid` / `place_id` as their own fields, so
 * the identity is passed structurally rather than through the keyword.
 */
export async function postGbpReviewsTask(
  input: {
    keyword?: string;
    cid?: string;
    placeId?: string;
  } & GbpLocationInput,
): Promise<DataforseoApiResponse<PostedGbpReviewsTask>> {
  const response = await dataforseoPost<DataforseoTaskLike & { id?: string }>(
    "/v3/business_data/google/reviews/task_post",
    [
      {
        keyword: input.keyword,
        cid: input.cid,
        place_id: input.placeId,
        ...locationParams(input),
        language_code: input.languageCode,
        depth: GBP_REVIEWS_DEPTH,
        sort_by: "newest",
        // Standard priority: a weekly snapshot tolerates the queue's latency, and
        // high priority costs double. The cron collects the result for free.
        priority: 1,
      },
    ],
    NO_RETRY,
  );

  const task = assertOk(response, {
    okTaskStatusCode: TASK_CREATED_STATUS_CODE,
  });
  if (!task.id) {
    throw new AppError("INTERNAL_ERROR", "DataForSEO did not return a task id");
  }
  const billing = buildTaskBilling(task);
  return {
    data: { taskId: task.id, costUsd: billing.costUsd },
    billing,
  };
}

const reviewItemSchema = z.looseObject({
  review_id: z.string().nullish(),
  timestamp: z.string().nullish(),
  review_text: z.string().nullish(),
  profile_name: z.string().nullish(),
  owner_answer: z.string().nullish(),
  rating: z.looseObject({ value: z.number().nullish() }).nullish(),
});

type GbpReview = {
  reviewId: string | null;
  rating: number | null;
  author: string | null;
  publishedAt: string | null;
  text: string | null;
  ownerReply: boolean;
};

/**
 * Reviews out of one collected `reviews/task_get` result, newest first (the order
 * `sort_by: newest` returned them in). Rows that don't parse are dropped rather
 * than failing the collection: the task is already paid for, and a partial list
 * beats none.
 */
export function parseGbpReviews(
  result: Record<string, unknown> | null,
): GbpReview[] {
  const items = Array.isArray(result?.items) ? result.items : [];
  return items.flatMap((item) => {
    const parsed = reviewItemSchema.safeParse(item);
    if (!parsed.success) return [];
    const data = parsed.data;
    return [
      {
        reviewId: data.review_id ?? null,
        rating: data.rating?.value ?? null,
        author: data.profile_name ?? null,
        publishedAt: data.timestamp ?? null,
        text: data.review_text?.slice(0, GBP_REVIEW_TEXT_LIMIT) ?? null,
        ownerReply: data.owner_answer != null,
      },
    ];
  });
}

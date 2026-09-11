import { z } from "zod";
import { dataforseoGet, dataforseoPost } from "@/server/lib/dataforseo/core";
import {
  isNoResultsTask,
  isTaskInProgress,
  parseTaskItems,
  type DataforseoApiResponse,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";
import { MAX_TASKS_PER_POST } from "@/server/lib/dataforseo/shared";
import { AppError } from "@/server/lib/errors";
import {
  formatLocationCoordinate,
  mapsCandidateItemSchema,
  type CandidateItem,
} from "@/shared/maps-grid";

// ---------------------------------------------------------------------------
// Queued Google Maps tasks — the geo-grid's only provider surface.
//
// A 7×7 grid is 49 charged requests per keyword, so the grid never touches the
// live Maps endpoint: task_post at ~30% of live cost, then free polling. The
// flow mirrors the rank-check queue (post -> tasks_ready -> task_get), and the
// same rule holds — task_post is where DataForSEO charges, so it is the only
// call routed through the metered client.
// ---------------------------------------------------------------------------

const TASK_POST_PATH = "/v3/serp/google/maps/task_post";
const TASKS_READY_PATH = "/v3/serp/google/maps/tasks_ready";
const TASK_GET_PATH = "/v3/serp/google/maps/task_get/advanced";

/** Task-created status on a task_post entry ("Task Created"). */
const TASK_CREATED_STATUS_CODE = 20100;

/**
 * Codes DataForSEO returns for a Maps query that ran, was charged, and simply
 * found nothing at that coordinate — common on rural grid edges. Terminal and
 * not a failure: the cell records "not found" rather than an error.
 */
const BILLED_EMPTY_STATUS_CODES = new Set([40102, 40501]);

interface MapsGridTaskInput {
  /** Echoed back by DataForSEO; how a provider task id maps back to a cell. */
  tag: string;
  keyword: string;
  lat: number;
  lng: number;
  /** Map zoom for the viewport, e.g. "13z". */
  zoom: string;
  languageCode: string;
  device: "desktop" | "mobile";
  depth?: number;
}

interface PostedMapsGridTask {
  tag: string;
  taskId: string;
  /** What DataForSEO charged for this task at post time, in USD. */
  costUsd: number;
}

/** An entry DataForSEO refused, kept so the cell can record why. */
interface RejectedMapsGridTask {
  tag: string;
  statusCode: number | null;
  statusMessage: string | null;
}

interface MapsGridTaskPostResult {
  posted: PostedMapsGridTask[];
  rejected: RejectedMapsGridTask[];
}

/**
 * Queue up to {@link MAX_TASKS_PER_POST} Maps searches, one per grid point.
 *
 * `search_this_area: true` is what makes a coordinate-only query behave like a
 * user panning the map to that spot, and `search_places: false` keeps the
 * response to the ranked pack instead of the place-detail payload. Cost is summed
 * over every response entry, refused ones included — a charge is a charge.
 */
export async function postMapsGridTasks(input: {
  tasks: MapsGridTaskInput[];
}): Promise<DataforseoApiResponse<MapsGridTaskPostResult>> {
  if (input.tasks.length === 0 || input.tasks.length > MAX_TASKS_PER_POST) {
    throw new AppError(
      "INTERNAL_ERROR",
      `task_post accepts 1-${MAX_TASKS_PER_POST} tasks, got ${input.tasks.length}`,
    );
  }

  const response = await dataforseoPost<
    DataforseoTaskLike & { id?: string; data?: Record<string, unknown> }
  >(
    TASK_POST_PATH,
    input.tasks.map((task) => ({
      keyword: task.keyword,
      language_code: task.languageCode,
      location_coordinate: formatLocationCoordinate(
        task.lat,
        task.lng,
        task.zoom,
      ),
      // Standard priority. A grid tolerates the queue's ~5 minute latency, and
      // high priority costs double for no benefit here.
      priority: 1,
      tag: task.tag,
      search_this_area: true,
      search_places: false,
      device: task.device,
      os: task.device === "mobile" ? "android" : undefined,
      depth: task.depth,
    })),
    // A 5xx does not prove DataForSEO skipped the charge, so a charged,
    // non-idempotent post is never replayed.
    { maxServerErrorRetries: 0 },
  );

  if (!response || response.status_code !== 20000) {
    throw new AppError(
      "INTERNAL_ERROR",
      response?.status_message || "DataForSEO maps task_post failed",
    );
  }

  const tags = new Set(input.tasks.map((task) => task.tag));
  const posted: PostedMapsGridTask[] = [];
  const rejected: RejectedMapsGridTask[] = [];
  let costUsd = 0;

  for (const entry of response.tasks ?? []) {
    costUsd += entry.cost ?? 0;
    const tag: unknown = entry.data?.tag;
    const matchedTag =
      typeof tag === "string" && tags.has(tag) ? tag : undefined;
    if (
      entry.status_code !== TASK_CREATED_STATUS_CODE ||
      !entry.id ||
      !matchedTag
    ) {
      console.warn(
        `dataforseo.maps.task_post.rejected-entry (${entry.status_code}): ${entry.status_message}`,
      );
      if (matchedTag) {
        rejected.push({
          tag: matchedTag,
          statusCode: entry.status_code ?? null,
          statusMessage: entry.status_message ?? null,
        });
      }
      continue;
    }
    posted.push({
      tag: matchedTag,
      taskId: entry.id,
      costUsd: entry.cost ?? 0,
    });
  }

  return {
    data: { posted, rejected },
    billing: { path: ["v3", "serp", "google", "maps", "task_post"], costUsd },
  };
}

const tasksReadyEntrySchema = z.object({ id: z.string() }).passthrough();

/**
 * Ids of finished Maps tasks waiting for collection, across the whole account.
 * Free, so it is not metered and not wrapped in the billing envelope: polling
 * this once per round is far cheaper than a task_get per outstanding cell.
 */
export async function fetchMapsTasksReady(): Promise<string[]> {
  const response = await dataforseoGet(TASKS_READY_PATH);
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    throw new AppError(
      "INTERNAL_ERROR",
      response?.status_message || "DataForSEO maps tasks_ready failed",
    );
  }
  // An empty queue answers with a null result rather than an empty array.
  const parsed = z.array(tasksReadyEntrySchema).safeParse(task.result ?? []);
  if (!parsed.success) {
    console.error(
      "dataforseo.maps.tasks_ready.invalid-payload",
      parsed.error.issues.slice(0, 5),
    );
    throw new AppError(
      "INTERNAL_ERROR",
      "DataForSEO maps tasks_ready returned an invalid response shape",
    );
  }
  return parsed.data.map((entry) => entry.id);
}

type MapsTaskOutcome =
  | { status: "pending"; providerStatusCode: number | null }
  | { status: "failed"; message: string; providerStatusCode: number | null }
  | {
      status: "completed";
      items: CandidateItem[];
      providerStatusCode: number | null;
      /** Cost the queue settled on, carried for the record — already charged. */
      settledCostUsd: number | null;
      /** Charged but empty: a real answer of "nothing ranks here". */
      isEmpty: boolean;
    };

/**
 * Collect one queued Maps task. Deliberately unmetered: the task was charged at
 * task_post, and running collection through the metering seam would bill the
 * customer a second time for the same request.
 */
export async function fetchMapsTaskResult(
  taskId: string,
): Promise<MapsTaskOutcome> {
  const response = await dataforseoGet(
    `${TASK_GET_PATH}/${encodeURIComponent(taskId)}`,
  );
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    throw new AppError(
      "INTERNAL_ERROR",
      response?.status_message || "DataForSEO maps task_get failed",
    );
  }

  const providerStatusCode = task.status_code ?? null;
  const settledCostUsd = typeof task.cost === "number" ? task.cost : null;

  if (isTaskInProgress(task)) {
    return { status: "pending", providerStatusCode };
  }

  if (task.status_code !== 20000) {
    const isBilledEmpty =
      (task.status_code !== undefined &&
        BILLED_EMPTY_STATUS_CODES.has(task.status_code)) ||
      isNoResultsTask(task);
    if (!isBilledEmpty) {
      return {
        status: "failed",
        message:
          task.status_message ||
          `DataForSEO maps task failed (${task.status_code})`,
        providerStatusCode,
      };
    }
    return {
      status: "completed",
      items: [],
      providerStatusCode,
      settledCostUsd,
      isEmpty: true,
    };
  }

  const items = parseTaskItems(
    "google-maps-task-get-advanced",
    task,
    mapsCandidateItemSchema,
  );
  return {
    status: "completed",
    items,
    providerStatusCode,
    settledCostUsd,
    isEmpty: items.length === 0,
  };
}

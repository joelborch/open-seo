import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, Loader2, MessageSquare, Star } from "lucide-react";
import { toast } from "sonner";
import {
  gbpQueryKeys,
  useGbpSnapshots,
  type GbpSnapshot,
} from "@/client/features/gbp/useGbpQueries";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  captureGbpSnapshotNow,
  upsertGbpSchedule,
} from "@/serverFunctions/gbp";

/**
 * What Google currently says about one location, and how that moved since the last
 * reading: rating, review count, category and claimed status, plus the newest
 * reviews. A capture is two charged provider requests and idempotent for the day,
 * so "Capture now" is safe to press twice — the second press spends nothing and
 * collects the reviews the first one queued.
 */

const GBP_INTERVALS = ["weekly", "monthly", "manual"] as const;

type GbpInterval = (typeof GBP_INTERVALS)[number];

const INTERVAL_LABELS: Record<GbpInterval, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  manual: "Manual only",
};

/** Narrows a `<select>` value back to the cadence set, ignoring anything else. */
function asInterval(value: string): GbpInterval | null {
  return GBP_INTERVALS.find((interval) => interval === value) ?? null;
}

const SKIP_REASON_LABELS: Record<string, string> = {
  already_captured: "last run skipped — already captured that day",
  capture_failed: "last run failed — retrying on the next schedule",
};

function formatDelta(delta: number | null, digits = 0): string | null {
  if (delta === null || delta === 0) return null;
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(digits)}`;
}

/** Difference between consecutive snapshots, null unless both measured it. */
function metricDelta(
  latest: GbpSnapshot | undefined,
  previous: GbpSnapshot | undefined,
  field: "rating" | "reviewsCount",
): number | null {
  const now = latest?.[field];
  const before = previous?.[field];
  if (now == null || before == null) return null;
  return now - before;
}

export function GbpProfileSection({
  projectId,
  locationId,
}: {
  projectId: string;
  locationId: string;
}) {
  const queryClient = useQueryClient();
  const snapshotsQuery = useGbpSnapshots(projectId);
  const entry = snapshotsQuery.data?.find(
    (row) => row.location.locationId === locationId,
  );

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: gbpQueryKeys.snapshots(projectId),
    });

  const captureMutation = useMutation({
    mutationFn: () =>
      captureGbpSnapshotNow({ data: { projectId, locationId } }),
    onSuccess: async (result) => {
      await invalidate();
      if (!result.created) {
        toast.success(
          result.reviewsCollected
            ? "Today's snapshot was already taken — reviews collected"
            : "Today's snapshot was already taken; its reviews are still queued",
        );
        return;
      }
      toast.success(
        result.profileFound
          ? "Profile captured — reviews arrive in the background"
          : "Google returned no profile for this location",
      );
    },
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Couldn't capture the profile"),
      ),
  });

  const scheduleMutation = useMutation({
    mutationFn: (fields: {
      scheduleInterval: GbpInterval;
      isActive: boolean;
    }) => upsertGbpSchedule({ data: { projectId, locationId, ...fields } }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Snapshot schedule saved");
    },
    onError: (error) =>
      toast.error(getStandardErrorMessage(error, "Couldn't save the schedule")),
  });

  if (snapshotsQuery.isPending) {
    return <div className="skeleton h-40 w-full" />;
  }

  const schedule = entry?.location;
  const interval = schedule?.scheduleInterval ?? "weekly";
  const isActive = schedule?.isActive ?? false;
  const latest = entry?.snapshots[0];
  const previous = entry?.snapshots[1];
  const ratingDelta = formatDelta(metricDelta(latest, previous, "rating"), 1);
  const reviewsDelta = formatDelta(
    metricDelta(latest, previous, "reviewsCount"),
  );
  const skipNote = schedule?.lastSkipReason
    ? SKIP_REASON_LABELS[schedule.lastSkipReason]
    : null;

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="card-title text-base">Business Profile</h2>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="select select-sm select-bordered"
              value={interval}
              disabled={scheduleMutation.isPending}
              onChange={(event) => {
                const scheduleInterval = asInterval(event.target.value);
                if (scheduleInterval) {
                  scheduleMutation.mutate({ scheduleInterval, isActive });
                }
              }}
            >
              {Object.entries(INTERVAL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <label className="label cursor-pointer gap-2 text-sm">
              <input
                type="checkbox"
                className="toggle toggle-sm"
                checked={isActive}
                disabled={scheduleMutation.isPending}
                onChange={(event) =>
                  scheduleMutation.mutate({
                    scheduleInterval: interval,
                    isActive: event.target.checked,
                  })
                }
              />
              Scheduled
            </label>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={captureMutation.isPending}
              onClick={() => captureMutation.mutate()}
            >
              {captureMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Camera className="size-4" />
              )}
              Capture now
            </button>
          </div>
        </div>

        {latest ? (
          <>
            <div className="flex flex-wrap gap-6">
              <Metric
                icon={<Star className="size-4" />}
                label="Rating"
                value={latest.rating?.toFixed(1) ?? "—"}
                delta={ratingDelta}
                positive={(metricDelta(latest, previous, "rating") ?? 0) > 0}
              />
              <Metric
                icon={<MessageSquare className="size-4" />}
                label="Reviews"
                value={latest.reviewsCount?.toLocaleString() ?? "—"}
                delta={reviewsDelta}
                positive={
                  (metricDelta(latest, previous, "reviewsCount") ?? 0) > 0
                }
              />
              <Metric
                label="Category"
                value={latest.primaryCategory ?? "—"}
                delta={null}
                positive={false}
              />
              <Metric
                label="Claimed"
                value={
                  latest.isClaimed === null
                    ? "—"
                    : latest.isClaimed
                      ? "Yes"
                      : "No"
                }
                delta={null}
                positive={false}
              />
              <Metric
                label="Photos"
                value={latest.photosCount?.toLocaleString() ?? "—"}
                delta={null}
                positive={false}
              />
            </div>

            <p className="text-sm text-base-content/60">
              Read {latest.runDate}
              {previous ? ` · previous ${previous.runDate}` : ""}
              {skipNote ? ` · ${skipNote}` : ""}
            </p>

            {entry.reviews.length > 0 ? (
              <ul className="divide-y divide-base-300 border-t border-base-300">
                {entry.reviews.map((review, index) => (
                  <li
                    key={review.reviewId ?? index}
                    className="flex flex-col gap-1 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">
                        {review.rating ?? "—"}★
                      </span>
                      <span className="text-base-content/70">
                        {review.author ?? "Anonymous"}
                      </span>
                      {review.publishedAt ? (
                        <span className="text-xs text-base-content/50">
                          {review.publishedAt.slice(0, 10)}
                        </span>
                      ) : null}
                      {review.ownerReply ? (
                        <span className="badge badge-ghost badge-sm">
                          Owner replied
                        </span>
                      ) : (
                        <span className="badge badge-warning badge-sm">
                          No reply
                        </span>
                      )}
                    </div>
                    {review.text ? (
                      <p className="text-sm text-base-content/70">
                        {review.text}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-base-content/60">
                {latest.providerTaskId && latest.reviewsCollectedAt === null
                  ? "Reviews are still in the provider's queue — they land on the next scheduled tick, or press Capture now again to pull them in for free."
                  : "Google returned no reviews for this profile."}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-base-content/60">
            No profile reading yet. A capture buys one profile lookup plus the
            newest 20 reviews; turn the schedule on to take one every week, or
            capture once now.
          </p>
        )}
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  delta,
  positive,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  delta: string | null;
  positive: boolean;
}) {
  return (
    <div>
      <p className="flex items-center gap-1 text-xs text-base-content/60">
        {icon}
        {label}
      </p>
      <p className="flex items-baseline gap-2">
        <span className="text-xl font-semibold">{value}</span>
        {delta ? (
          <span
            className={`text-sm ${positive ? "text-success" : "text-error"}`}
          >
            {delta}
          </span>
        ) : null}
      </p>
    </div>
  );
}

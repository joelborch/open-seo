import {
  AI_OVERVIEW_COST_MULTIPLIER,
  estimateRankCheckCredits,
} from "@/shared/rank-tracking";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

/**
 * The two opt-ins that widen what each check collects — and what it costs. Both
 * change the provider request rather than just the display, so the price line
 * below them has to move with the toggles.
 */
export function CollectionOptionsField({
  trackCompetitors,
  onTrackCompetitorsChange,
  trackAiOverview,
  onTrackAiOverviewChange,
}: {
  trackCompetitors: boolean;
  onTrackCompetitorsChange: (value: boolean) => void;
  trackAiOverview: boolean;
  onTrackAiOverviewChange: (value: boolean) => void;
}) {
  return (
    <fieldset className="form-control">
      <legend className="label">
        <span className="label-text font-medium">What to collect</span>
      </legend>
      <label className="flex cursor-pointer items-start gap-2.5 py-1">
        <input
          type="checkbox"
          className="checkbox checkbox-sm mt-0.5"
          checked={trackCompetitors}
          onChange={(e) => onTrackCompetitorsChange(e.target.checked)}
        />
        <span className="text-sm">
          Track competitors (full SERP)
          <span className="block text-xs text-base-content/50">
            Keeps crawling past your own listing so every result on the page is
            captured. Costs the full search depth on every check instead of
            stopping early.
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-2.5 py-1">
        <input
          type="checkbox"
          className="checkbox checkbox-sm mt-0.5"
          checked={trackAiOverview}
          onChange={(e) => onTrackAiOverviewChange(e.target.checked)}
        />
        <span className="text-sm">
          Track AI Overviews (2× cost)
          <span className="block text-xs text-base-content/50">
            Loads Google's AI Overview block and records whether your domain is
            cited in it. DataForSEO charges double for the block.
          </span>
        </span>
      </label>
    </fieldset>
  );
}

/** Per-keyword and monthly price for the settings currently in the form. */
export function ConfigCostPreview({
  devices,
  serpDepth,
  schedule,
  trackAiOverview,
}: {
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  schedule: RankTrackingConfig["scheduleInterval"];
  trackAiOverview: boolean;
}) {
  // Scheduled checks run through the cheaper task queue; manual configs only
  // ever pay the live price.
  const { costUsd: baseCostPerKeyword } = estimateRankCheckCredits(
    1,
    devices,
    serpDepth,
    schedule === "manual" ? "live" : "queued",
  );
  const costPerKeyword = trackAiOverview
    ? baseCostPerKeyword * AI_OVERVIEW_COST_MULTIPLIER
    : baseCostPerKeyword;
  const checksPerMonth =
    schedule === "daily" ? 30 : schedule === "weekly" ? 4 : 1;

  return (
    <div className="rounded-lg bg-base-200/50 px-3 py-2.5 text-xs text-base-content/70 space-y-0.5">
      <div>
        <span className="font-mono font-semibold text-base-content">
          ~${costPerKeyword.toFixed(4)}
        </span>{" "}
        per keyword per check
      </div>
      {schedule !== "manual" && (
        <div>
          50 keywords would cost{" "}
          <span className="font-mono font-semibold text-base-content">
            ~${(costPerKeyword * 50 * checksPerMonth).toFixed(2)}
          </span>
          /month
        </div>
      )}
    </div>
  );
}

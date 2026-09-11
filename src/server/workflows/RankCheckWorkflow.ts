import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { withPgClient } from "@/db";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { failRunIfActive } from "@/server/features/rank-tracking/services/rankCheckRunGuards";
import {
  createRankCheckTally,
  runLiveCheck,
  runQueuedCheck,
  type RankCheckTally,
} from "@/server/workflows/rankCheckPaths";
import { pgStep } from "@/server/workflows/pgStep";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { captureServerEvent } from "@/server/lib/posthog";
import { AppError } from "@/server/lib/errors";
import { autumn } from "@/server/billing/autumn";
import {
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
} from "@/shared/billing";
import {
  costPerSerpAtDepth,
  devicesCount,
  estimateRankCheckCredits,
  rankCheckCostApprovalError,
  usdToMicros,
} from "@/shared/rank-tracking";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

interface RankCheckParams {
  runId: string;
  configId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  domain: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  devices: "both" | "desktop" | "mobile";
  serpDepth: number;
  trackCompetitors?: boolean;
  trackAiOverview?: boolean;
  trigger: "manual" | "scheduled";
  keywordIds?: string[];
  maxCostCredits?: number;
}

/** Manual checks want instant answers; scheduled ones take the cheap queue. */
function methodForTrigger(
  trigger: RankCheckParams["trigger"],
): "live" | "queued" {
  return trigger === "scheduled" ? "queued" : "live";
}

export async function prepareRankCheckKeywords(input: {
  runId: string;
  configId: string;
  billingCustomer: BillingCustomerContext;
  devices: RankCheckParams["devices"];
  serpDepth: number;
  trackAiOverview?: boolean;
  trigger: RankCheckParams["trigger"];
  keywordIds?: string[];
  maxCostCredits?: number;
}) {
  // If stale-cleanup marked our run failed before we got here, bail out
  // rather than resurrecting a superseded run.
  const run = await RankTrackingRepository.getRunById(input.runId);
  if (!run || run.status === "failed" || run.status === "completed") {
    throw new NonRetryableError(
      `Run ${input.runId} is no longer active (status=${run?.status ?? "missing"})`,
    );
  }

  const method = methodForTrigger(input.trigger);
  await RankTrackingRepository.updateRun(input.runId, {
    status: "running",
    trigger: input.trigger,
    method,
  });

  let trackingKeywords = await RankTrackingRepository.getKeywordsForConfig(
    input.configId,
  );

  if (input.keywordIds && input.keywordIds.length > 0) {
    const idSet = new Set(input.keywordIds);
    trackingKeywords = trackingKeywords.filter((kw) => idSet.has(kw.id));
  }

  if (trackingKeywords.length === 0) {
    throw new AppError("INTERNAL_ERROR", "No keywords to track");
  }

  const { costCredits } = estimateRankCheckCredits(
    trackingKeywords.length,
    input.devices,
    input.serpDepth,
    method,
  );
  if (input.maxCostCredits != null && costCredits > input.maxCostCredits) {
    throw new AppError(
      "VALIDATION_ERROR",
      rankCheckCostApprovalError(costCredits, input.maxCostCredits),
    );
  }

  // Verify the user has enough credits for the full check before starting.
  // Scheduled checks go through the cheaper task queue, so estimate at queued
  // pricing — a live-price estimate would skip checks the user can afford.
  if (await isHostedServerAuthMode()) {
    const [monthlyCheck, topupCheck] = await Promise.all([
      autumn.check({
        customerId: input.billingCustomer.organizationId,
        featureId: AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
      }),
      autumn.check({
        customerId: input.billingCustomer.organizationId,
        featureId: AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
      }),
    ]);
    const available =
      (monthlyCheck.balance?.remaining ?? 0) +
      (topupCheck.balance?.remaining ?? 0);
    if (available < costCredits) {
      throw new AppError(
        "INSUFFICIENT_CREDITS",
        "Insufficient credits for rank check",
      );
    }
  }

  // Budget authorized up front, in the same provider-cost micros the ledger
  // settles in — so `spent` and `authorized` on the run are comparable.
  const authorizedCostMicros = usdToMicros(
    trackingKeywords.length *
      devicesCount(input.devices) *
      costPerSerpAtDepth(input.serpDepth, method, input.trackAiOverview),
  );
  await RankTrackingRepository.updateRun(input.runId, {
    keywordsTotal: trackingKeywords.length,
    authorizedCostMicros,
  });

  return {
    keywords: trackingKeywords.map((kw) => ({
      id: kw.id,
      keyword: kw.keyword,
    })),
  };
}

/**
 * What the run actually spent at DataForSEO, in micro-dollars, and whether that
 * figure is final.
 *
 * The task ledger is read no matter how the run ended — a queued run that died
 * mid-post still has rows recording what DataForSEO charged, and a live run
 * simply has none, so there is no path where a failure reports a confident
 * zero. Live-endpoint calls (the live path and the queued path's fallback) are
 * added from the tally, which the caller accumulated per step.
 *
 * The total is a floor rather than a settled amount whenever spend could be
 * unaccounted: a submission whose outcome we never learned, a task still
 * outstanding, or a step that threw after it may already have bought something.
 */
async function summarizeRunSpend(
  runId: string,
  input: { tally: RankCheckTally; batchError: string | null },
): Promise<{
  spentCostMicros: number;
  costStatus: "known" | "known_minimum";
  submissionUnknown: number;
  outstanding: number;
}> {
  const ledger =
    await RankTrackingRepository.getRankCheckTaskCostSummary(runId);
  const unaccounted =
    ledger.submissionUnknown > 0 ||
    ledger.outstanding > 0 ||
    input.batchError !== null;
  return {
    spentCostMicros: ledger.actualCostMicros + input.tally.liveCostMicros,
    costStatus: unaccounted ? "known_minimum" : "known",
    submissionUnknown: ledger.submissionUnknown,
    outstanding: ledger.outstanding,
  };
}

async function finalizeRankCheckRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  trigger: RankCheckParams["trigger"];
  batchError: string | null;
  /** Spend and progress the check path accumulated step by step. */
  tally: RankCheckTally;
}) {
  // If stale-cleanup already marked our run failed, don't overwrite that
  // decision with a completed status — a replacement run may already be
  // underway.
  const run = await RankTrackingRepository.getRunById(input.runId);
  if (!run || run.status === "failed" || run.status === "completed") {
    console.warn(
      `[rank-check] ${input.runId} no longer active (status=${run?.status ?? "missing"}), skipping finalization`,
    );
    return;
  }

  const nowIso = new Date().toISOString();

  // Snapshots were written incrementally by each batch step.
  // Count from DB to get the authoritative keyword count.
  const snapshots = await RankTrackingRepository.getSnapshotsForRun(
    input.runId,
  );
  const keywordsChecked = new Set(snapshots.map((s) => s.trackingKeywordId))
    .size;

  const keywordsTotal = run.keywordsTotal || keywordsChecked;
  const incompleteCount = keywordsTotal - keywordsChecked;

  let errorMessage: string | undefined;
  if (input.batchError) {
    errorMessage = `Completed ${keywordsChecked} of ${keywordsTotal} keyword(s). Error: ${input.batchError}`;
  } else if (incompleteCount > 0) {
    errorMessage = `${incompleteCount} keyword(s) could not be checked`;
  }

  // Any ledger row still at "reserved" belongs to a post step that died without
  // parking it, so its request may have reached DataForSEO. Sweeping it to
  // submission_unknown before reading the spend is what keeps the pair out of
  // every re-post path and the run's total honest. A live run has no ledger
  // rows, so this is a no-op there.
  const parked = await RankTrackingRepository.parkReservedRankCheckTasks(
    input.runId,
    "Post step ended without settling this task",
  );
  if (parked > 0) {
    console.warn(
      `[rank-check] ${input.runId} parked ${parked} unsettled task(s) as submission_unknown`,
    );
  }

  const spend = await summarizeRunSpend(input.runId, {
    tally: input.tally,
    batchError: input.batchError,
  });

  // Flipping status away from 'pending'/'running' is what releases the
  // partial-index slot for the next run.
  await RankTrackingRepository.updateRun(input.runId, {
    status: "completed",
    keywordsChecked,
    completedAt: nowIso,
    spentCostMicros: spend.spentCostMicros,
    costStatus: spend.costStatus,
    ...(errorMessage ? { errorMessage } : {}),
  });

  // Clear any previous skip reason on success.
  // Note: nextCheckAt is NOT set here — the cron handler advances it eagerly
  // before starting the workflow to prevent retry storms.
  await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
    lastCheckedAt: nowIso,
    lastSkipReason: null,
  });

  // One-line summary per run so fallback rates are visible in Workers Logs.
  // Keys match the PostHog event properties for log/event correlation.
  const queueSummary =
    run.method === "queued"
      ? ` queue_tasks=${input.tally.queueTasks} queue_collected=${input.tally.queueCollected} fallback_tasks=${input.tally.fallbackTasks} fallback_checked=${input.tally.fallbackChecked} submission_unknown=${spend.submissionUnknown} outstanding=${spend.outstanding}`
      : "";
  // Error text can echo vendor/user content — keep it one line and bounded.
  const errorSummary = errorMessage
    ? ` error="${errorMessage.replace(/\s+/g, " ").slice(0, 200)}"`
    : "";
  console.log(
    `[rank-check] ${input.runId} completed org=${input.billingCustomer.organizationId} project=${input.projectId} trigger=${input.trigger} keywords=${keywordsChecked}/${keywordsTotal} spent_micros=${spend.spentCostMicros} cost_status=${spend.costStatus}${queueSummary}${errorSummary}`,
  );

  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "rank_tracking:check_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status: "completed",
      trigger: input.trigger,
      keywords_checked: keywordsChecked,
      spent_cost_micros: spend.spentCostMicros,
      cost_status: spend.costStatus,
      ...(run.method === "queued"
        ? {
            queue_tasks: input.tally.queueTasks,
            queue_collected: input.tally.queueCollected,
            fallback_tasks: input.tally.fallbackTasks,
            fallback_checked: input.tally.fallbackChecked,
            submission_unknown: spend.submissionUnknown,
            outstanding: spend.outstanding,
          }
        : {}),
    },
  });
}

async function markRankCheckRunFailed(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  error: unknown;
}) {
  const errorMessage =
    input.error instanceof Error ? input.error.message : "Unknown error";
  await failRunIfActive(input.runId, errorMessage);

  // Flag the config so the UI can show why the scheduled check was skipped
  const isInsufficientCredits =
    input.error instanceof AppError &&
    input.error.code === "INSUFFICIENT_CREDITS";
  if (isInsufficientCredits) {
    await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
      lastSkipReason: "insufficient_credits",
    });
  }

  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "rank_tracking:check_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status: "failed",
      error: errorMessage,
    },
  });
}

export class RankCheckWorkflow extends WorkflowEntrypoint<
  Env,
  RankCheckParams
> {
  async run(event: WorkflowEvent<RankCheckParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this workflow invocation (no-op in
    // D1 mode). The socket is reclaimed when the invocation ends, so there is
    // nothing to tear down here.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<RankCheckParams>,
    step: WorkflowStep,
  ) {
    const {
      runId,
      configId,
      billingCustomer,
      projectId,
      domain,
      locationCode,
      languageCode,
      locationName,
      devices,
      serpDepth,
      trackCompetitors,
      trackAiOverview,
      trigger,
      keywordIds,
      maxCostCredits,
    } = event.payload;

    // Guard: skip if config was archived after the workflow was triggered
    const configCheck = await pgStep(
      step,
      "check-active",
      { retries: { limit: 0, delay: "1 second" } },
      async () => {
        const cfg = await RankTrackingRepository.getConfigById({
          configId,
          projectId,
        });
        return { isActive: cfg?.isActive ?? false };
      },
    );
    if (!configCheck.isActive) {
      await failRunIfActive(runId, "Config has been archived");
      return;
    }

    try {
      console.log(
        `[rank-check] ${runId} starting (trigger=${trigger}, devices=${devices})`,
      );

      const prepareResult = await pgStep(
        step,
        "prepare",
        { retries: { limit: 0, delay: "1 second" } },
        async () =>
          prepareRankCheckKeywords({
            runId,
            configId,
            billingCustomer,
            devices,
            serpDepth,
            trackAiOverview,
            trigger,
            keywordIds,
            maxCostCredits,
          }),
      );

      const keywords = prepareResult.keywords;
      const client = createDataforseoClient(billingCustomer);

      console.log(`[rank-check] ${runId} loaded ${keywords.length} keywords`);

      let batchError: string | null = null;
      // Owned here, not returned by the check path: a batch or post step that
      // throws must not take the spend already accumulated with it.
      const tally = createRankCheckTally();

      try {
        const checkContext = {
          client,
          keywords,
          devices,
          serpDepth,
          domain,
          locationCode,
          languageCode,
          locationName,
          trackCompetitors: trackCompetitors ?? false,
          trackAiOverview: trackAiOverview ?? false,
          runId,
        };
        // Scheduled checks use DataForSEO's task queue (~30% of live cost);
        // manual checks stay on the live endpoint for instant results.
        if (trigger === "scheduled") {
          await runQueuedCheck(step, checkContext, tally);
        } else {
          await runLiveCheck(step, checkContext, tally);
        }
      } catch (error) {
        // Batch failure — snapshots for completed batches are already
        // persisted incrementally. Continue to finalization.
        batchError = error instanceof Error ? error.message : String(error);
        console.warn(`[rank-check] ${runId} partial failure: ${batchError}`);
      }

      await pgStep(step, "finalize", SINGLE_ATTEMPT_STEP_CONFIG, async () =>
        finalizeRankCheckRun({
          runId,
          configId,
          projectId,
          billingCustomer,
          trigger,
          batchError,
          tally,
        }),
      );
    } catch (error) {
      console.error(`Rank check ${runId} failed:`, error);
      await pgStep(step, "mark-failed", SINGLE_ATTEMPT_STEP_CONFIG, async () =>
        markRankCheckRunFailed({
          runId,
          configId,
          projectId,
          billingCustomer,
          error,
        }),
      );
      throw error;
    }
  }
}

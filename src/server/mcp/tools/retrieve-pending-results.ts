/**
 * retrieve_pending_results — the free recovery pass over both provider-backed
 * monitoring loops.
 */
import { z } from "zod";
import { MapsGridRepository } from "@/server/features/maps-grid/repositories/MapsGridRepository";
import { MapsGridService } from "@/server/features/maps-grid/services/MapsGridService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const retrieveInputSchema = {
  projectId: projectIdSchema,
  runId: z
    .string()
    .optional()
    .describe(
      "One rank-check or Maps-grid run to collect. Omit to sweep the latest run of every tracker and grid config in the project.",
    ),
} as const;

type RetrieveArgs = z.infer<z.ZodObject<typeof retrieveInputSchema>>;

type RetrievalOutcome = {
  kind: "rank" | "grid";
  runId: string;
  collected: number;
  stillPending: number;
  failed: number;
  outstanding: number | null;
};

type RetrievalSkip = { kind: "rank" | "grid"; runId: string; reason: string };

/** Mirrors MapsGridService.retrieveGridRun's guard for both loops: a collect pass
 *  replaces each cell's/keyword's rows, so racing the run's own workflow can
 *  duplicate what it writes. An active run settles itself. */
function assertRunSettled(status: string, kind: "rank" | "grid") {
  if (status === "pending" || status === "running") {
    throw new AppError(
      "CONFLICT",
      `This ${kind === "rank" ? "rank check" : "grid run"} is still collecting its results. Wait for it to finish, then collect whatever is left over.`,
    );
  }
}

async function retrieveRank(
  projectId: string,
  runId: string,
): Promise<RetrievalOutcome> {
  const result = await RankTrackingService.retrieveRun({ runId, projectId });
  return {
    kind: "rank",
    runId,
    collected: result.collected,
    stillPending: result.stillPending,
    failed: result.failed,
    outstanding: null,
  };
}

async function retrieveGrid(
  projectId: string,
  runId: string,
): Promise<RetrievalOutcome> {
  const result = await MapsGridService.retrieveGridRun({ runId, projectId });
  return {
    kind: "grid",
    runId,
    collected: result.collected,
    stillPending: result.stillPending + result.deferred,
    failed: result.failed,
    outstanding: result.outstanding,
  };
}

/** The latest run of every tracker and grid config, with the ones that have
 *  nothing outstanding (or are still in flight) reported instead of collected. */
async function sweepProject(projectId: string) {
  const collected: RetrievalOutcome[] = [];
  const skipped: RetrievalSkip[] = [];

  for (const config of await RankTrackingService.getConfigs(projectId)) {
    const [run] = await RankTrackingService.getRunHistory(
      config.id,
      projectId,
      1,
    );
    if (!run) continue;
    if (run.status === "pending" || run.status === "running") {
      skipped.push({ kind: "rank", runId: run.id, reason: "still running" });
      continue;
    }
    const outstanding = await RankTrackingRepository.getSubmittedRankCheckTasks(
      run.id,
    );
    if (outstanding.length === 0) {
      skipped.push({
        kind: "rank",
        runId: run.id,
        reason: "no submitted tasks left to collect",
      });
      continue;
    }
    collected.push(await retrieveRank(projectId, run.id));
  }

  for (const config of await MapsGridRepository.getConfigsForProject(
    projectId,
  )) {
    const [run] = await MapsGridService.getGridRuns({
      configId: config.id,
      projectId,
    });
    if (!run) continue;
    if (run.status === "pending" || run.status === "running") {
      skipped.push({ kind: "grid", runId: run.id, reason: "still running" });
      continue;
    }
    const outstanding = await MapsGridRepository.getSubmittedCells(run.id);
    if (outstanding.length === 0) {
      skipped.push({
        kind: "grid",
        runId: run.id,
        reason: "no submitted cells left to collect",
      });
      continue;
    }
    collected.push(await retrieveGrid(projectId, run.id));
  }

  return { collected, skipped };
}

export const retrievePendingResultsTool = {
  name: "retrieve_pending_results",
  config: {
    title: "Retrieve pending monitoring results",
    description:
      "Collect results a monitoring run already paid for but never stored — the recovery path for a rank check or Maps grid run whose workflow died mid-poll. Buys nothing and uses no credits: it reads DataForSEO's stored task ids (task_get is free, the charge landed at submit time) and never posts a new task, which is why this is the answer instead of re-running the check. Omit runId to sweep the latest run of every tracker and grid config. Refuses a run that is still in flight — that run finishes, or is reaped, on its own.",
    inputSchema: retrieveInputSchema,
    outputSchema: z
      .object({
        collected: z.array(looseObjectOutputSchema),
        skipped: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      // Writes the snapshots/cell results it collects, so not read-only — but it
      // spends nothing and destroys nothing.
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: RetrieveArgs, context) => {
    let collected: RetrievalOutcome[];
    let skipped: RetrievalSkip[];

    if (args.runId) {
      // A run id names either loop, so the rank ledger is checked first and the
      // grid only when that misses.
      const rankRun = await RankTrackingRepository.getRunById(args.runId);
      if (rankRun && rankRun.projectId === args.projectId) {
        assertRunSettled(rankRun.status, "rank");
        collected = [await retrieveRank(args.projectId, args.runId)];
      } else {
        const gridRun = await MapsGridRepository.getRunForProject({
          runId: args.runId,
          projectId: args.projectId,
        });
        if (!gridRun) {
          throw new AppError(
            "NOT_FOUND",
            `No rank check or Maps grid run ${args.runId} in this project.`,
          );
        }
        assertRunSettled(gridRun.status, "grid");
        collected = [await retrieveGrid(args.projectId, args.runId)];
      }
      skipped = [];
    } else {
      ({ collected, skipped } = await sweepProject(args.projectId));
    }

    const lines = [
      ...collected.map(
        (outcome) =>
          `- ${outcome.kind} run ${outcome.runId}: collected ${outcome.collected}, still pending ${outcome.stillPending}, failed ${outcome.failed}${
            outcome.outstanding == null
              ? ""
              : `, outstanding ${outcome.outstanding}`
          }`,
      ),
      ...skipped.map(
        (skip) => `- ${skip.kind} run ${skip.runId}: skipped, ${skip.reason}`,
      ),
    ];
    const total = collected.reduce(
      (sum, outcome) => sum + outcome.collected,
      0,
    );
    const header =
      lines.length === 0
        ? "Nothing to collect: no rank check or Maps grid runs in this project."
        : `Collected ${total} result(s) across ${collected.length} run(s). Nothing was purchased.`;

    return mcpResponse({
      text: [header, ...lines].join("\n"),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking`,
      ),
      structuredContent: { collected, skipped },
    });
  }),
};

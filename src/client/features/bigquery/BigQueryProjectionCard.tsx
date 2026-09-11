import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { IntegrationConnectionCard } from "@/client/features/integrations/IntegrationConnectionCard";
import {
  getBigQueryStatus,
  projectRunNow,
} from "@/serverFunctions/bigqueryProjection";

const RUN_KIND_LABELS = {
  audit_schedule_run: "Scheduled crawl",
  rank_check_run: "Rank check",
  maps_grid_run: "Maps grid",
  gbp_snapshot: "Business Profile",
} as const;

/**
 * Read-only view of where this project's monitoring runs land in BigQuery, plus a
 * manual trigger for the backlog. The target row itself is seeded by the
 * monitoring importer rather than edited here — the dataset name is part of the
 * warehouse's naming convention, not a per-project preference.
 */
export function BigQueryProjectionCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const statusKey = ["bigqueryStatus", projectId];
  const statusQuery = useQuery({
    queryKey: statusKey,
    queryFn: () => getBigQueryStatus({ data: { projectId } }),
  });
  const status = statusQuery.data;
  const nextPending = status?.pendingRuns[0];

  const projectNow = useMutation({
    mutationFn: async () => {
      if (!nextPending) return null;
      return projectRunNow({
        data: {
          projectId,
          runKind: nextPending.runKind,
          runId: nextPending.runId,
        },
      });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: statusKey });
      const failed = result?.tables.filter((table) => table.error) ?? [];
      if (failed.length > 0) {
        toast.error(`BigQuery rejected ${failed.length} table(s)`);
        return;
      }
      const rows =
        result?.tables.reduce((total, table) => total + table.rows, 0) ?? 0;
      toast.success(`Projected ${rows} row${rows === 1 ? "" : "s"}`);
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  return (
    <IntegrationConnectionCard
      title="BigQuery"
      status={
        statusQuery.isSuccess
          ? status?.target
            ? "connected"
            : "disconnected"
          : undefined
      }
    >
      {statusQuery.isPending ? (
        <div className="skeleton h-16 w-full" />
      ) : !status?.target ? (
        <p className="text-sm text-base-content/60">
          This project has no BigQuery dataset. Monitoring runs are kept in
          OpenSEO only until one is configured.
        </p>
      ) : (
        <div className="space-y-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Detail label="Dataset" value={status.target.dataset} />
            <Detail label="Client key" value={status.target.clientKey} />
            <Detail
              label="Search Console export"
              value={status.target.gscExportDataset ?? "Not linked"}
            />
          </dl>

          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-base-content/50">
              Last projection per table
            </h3>
            {status.lastProjections.length === 0 ? (
              <p className="text-sm text-base-content/60">
                Nothing projected yet.
              </p>
            ) : (
              <ul className="divide-y divide-base-300 rounded-lg border border-base-300">
                {status.lastProjections.map((projection) => (
                  <li
                    key={projection.table}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-xs">
                      {projection.table}
                    </span>
                    <span className="text-base-content/60">
                      {projection.error ? (
                        <span className="text-error">{projection.error}</span>
                      ) : (
                        `${projection.rows} rows · ${formatStamp(projection.projectedAt)}`
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!nextPending || projectNow.isPending}
              onClick={() => projectNow.mutate()}
            >
              {projectNow.isPending ? "Projecting…" : "Project now"}
            </button>
            <span className="text-sm text-base-content/60">
              {nextPending
                ? `${status.pendingRuns.length} run(s) waiting — next: ${RUN_KIND_LABELS[nextPending.runKind]} from ${formatStamp(nextPending.completedAt)}`
                : "Everything in the last 30 days is projected."}
            </span>
          </div>
        </div>
      )}
    </IntegrationConnectionCard>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-base-content/50">{label}</dt>
      <dd className="truncate font-mono text-xs">{value}</dd>
    </div>
  );
}

function formatStamp(timestamp: string): string {
  const parsed = new Date(timestamp.replace(" ", "T"));
  return Number.isNaN(parsed.getTime())
    ? timestamp
    : parsed.toLocaleDateString();
}

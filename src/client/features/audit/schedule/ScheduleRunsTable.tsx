import { Link } from "@tanstack/react-router";
import { formatDate } from "@/client/features/audit/shared";
import { HealthDelta, HealthScore } from "@/client/features/audit/siteHealth";
import type { AuditScheduleRun } from "@/client/features/audit/schedule/useScheduleController";

export function ScheduleRunsTable({
  projectId,
  runs,
}: {
  projectId: string;
  runs: AuditScheduleRun[];
}) {
  if (runs.length === 0) return null;

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body gap-3">
        <h2 className="card-title text-base">Scheduled Crawl History</h2>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Date</th>
                <th>Cadence</th>
                <th>Health</th>
                <th>Change</th>
                <th>Pages</th>
                <th>Errors</th>
                <th>Warnings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="hover">
                  <td className="text-xs text-base-content/70">
                    {formatDate(run.triggeredAt)}
                  </td>
                  <td>
                    <span className="badge badge-ghost badge-sm">
                      {run.cadence}
                    </span>
                  </td>
                  <td>
                    {run.status === "completed" ? (
                      <HealthScore
                        score={run.healthScore}
                        className="text-sm"
                      />
                    ) : (
                      <RunStatus run={run} />
                    )}
                  </td>
                  <td>
                    <HealthDelta delta={run.healthScoreDelta} />
                  </td>
                  <td className="tabular-nums">{run.pagesCrawled ?? "—"}</td>
                  <td className="tabular-nums">{run.pagesWithErrors ?? "—"}</td>
                  <td className="tabular-nums">
                    {run.pagesWithWarnings ?? "—"}
                  </td>
                  <td className="text-right">
                    {/* Null once the audit ages out of retention; the run row
                        and its numbers outlive the crawl detail. */}
                    {run.auditId ? (
                      <Link
                        to="/p/$projectId/audit"
                        params={{ projectId }}
                        search={{ auditId: run.auditId, tab: "issues" }}
                        className="btn btn-ghost btn-xs"
                      >
                        View
                      </Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function RunStatus({ run }: { run: AuditScheduleRun }) {
  if (run.status === "skipped") {
    return (
      <span
        className="badge badge-ghost badge-sm"
        title={run.skipReason ?? undefined}
      >
        Skipped
      </span>
    );
  }
  if (run.status === "failed") {
    return <span className="badge badge-error badge-sm">Failed</span>;
  }
  return <span className="badge badge-info badge-sm">Running</span>;
}

import { ScheduleCard } from "@/client/features/audit/schedule/ScheduleCard";
import { ScheduleRunsTable } from "@/client/features/audit/schedule/ScheduleRunsTable";
import { useScheduleQueries } from "@/client/features/audit/schedule/useScheduleController";

export function ScheduleSection({
  projectId,
  fallbackStartUrl,
  maxPagesLimit,
}: {
  projectId: string;
  fallbackStartUrl: string;
  maxPagesLimit: number;
}) {
  const { scheduleQuery, historyQuery } = useScheduleQueries(projectId);

  if (scheduleQuery.isPending) {
    return <div className="skeleton h-48 w-full" />;
  }
  if (scheduleQuery.isError) {
    return (
      <div className="alert alert-error py-2">
        <span className="text-sm">Couldn&rsquo;t load the crawl schedule.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Keyed on the row's updatedAt so the form's defaultValues are re-read
          after a save or a pause, without a reset effect. Deliberately not
          `dataUpdatedAt`: that changes on every background refetch (window
          focus included) and would throw away edits in progress. */}
      <ScheduleCard
        key={scheduleQuery.data?.updatedAt ?? "new"}
        projectId={projectId}
        schedule={scheduleQuery.data}
        fallbackStartUrl={fallbackStartUrl}
        maxPagesLimit={maxPagesLimit}
        onSaved={() => {
          void scheduleQuery.refetch();
          void historyQuery.refetch();
        }}
      />
      <ScheduleRunsTable projectId={projectId} runs={historyQuery.data ?? []} />
    </div>
  );
}

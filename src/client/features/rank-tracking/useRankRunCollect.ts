import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { retrieveRankCheckRun } from "@/serverFunctions/rank-tracking";

/**
 * Rescue an interrupted run's already-charged queued tasks. Buys nothing: the
 * server reads the stored provider task ids and writes whatever has finished,
 * which is why this is offered instead of re-running a check the customer has
 * already paid for.
 */
export function useRankRunCollect(projectId: string, configId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      retrieveRankCheckRun({ data: { projectId, runId } }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ["rankTrackingResults", projectId, configId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankTrackingLatestRun", projectId, configId],
      });
      if (result.collected > 0) {
        toast.success(
          `Collected ${result.collected} result${result.collected === 1 ? "" : "s"}`,
        );
      } else if (result.stillPending > 0) {
        toast.info(`${result.stillPending} task(s) are still running`);
      } else {
        toast.info("Nothing left to collect for this run");
      }
    },
    onError: () => toast.error("Could not collect results for this run"),
  });
}

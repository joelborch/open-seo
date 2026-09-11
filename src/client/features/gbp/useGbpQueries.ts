import { useQuery } from "@tanstack/react-query";
import { getGbpSnapshots } from "@/serverFunctions/gbp";

/**
 * Server state for the Business Profile section. One read per project rather than
 * per location: the whole section is a handful of snapshot rows, and the Map Grid
 * page switches locations often enough that a per-location query would refetch on
 * every click.
 */

export type GbpLocationHistory = Awaited<
  ReturnType<typeof getGbpSnapshots>
>[number];
export type GbpSnapshot = GbpLocationHistory["snapshots"][number];

export const gbpQueryKeys = {
  snapshots: (projectId: string) => ["gbp-snapshots", projectId] as const,
};

export function useGbpSnapshots(projectId: string) {
  return useQuery({
    queryKey: gbpQueryKeys.snapshots(projectId),
    queryFn: () => getGbpSnapshots({ data: { projectId } }),
  });
}

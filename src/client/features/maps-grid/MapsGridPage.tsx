import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { MapsGridConfigPanel } from "@/client/features/maps-grid/MapsGridConfigPanel";
import { MapsGridLocationForm } from "@/client/features/maps-grid/MapsGridLocationForm";
import { MapsGridResults } from "@/client/features/maps-grid/MapsGridResults";
import {
  gridQueryKeys,
  useGridConfigs,
  useGridLocations,
} from "@/client/features/maps-grid/useMapsGridQueries";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { deleteGridLocation } from "@/serverFunctions/mapsGrid";

/**
 * The local-pack grid page: pick a location, shape and run its grid, read the
 * heatmap. One config per location, so selecting a location selects its grid.
 */

/** Sentinel `editing` value for the "add a location" form. */
const NEW_LOCATION = "new";

export function MapsGridPage({ projectId }: { projectId: string }) {
  const locationsQuery = useGridLocations(projectId);
  const configsQuery = useGridConfigs(projectId);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(
    null,
  );
  // `NEW_LOCATION` or a location id; null closes the form.
  const [editing, setEditing] = useState<string | null>(null);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);

  const locations = useMemo(
    () => locationsQuery.data ?? [],
    [locationsQuery.data],
  );
  useEffect(() => {
    if (selectedLocationId === null && locations.length > 0) {
      setSelectedLocationId(locations[0].id);
    }
  }, [locations, selectedLocationId]);

  const selectedLocation =
    locations.find((location) => location.id === selectedLocationId) ?? null;
  const config =
    configsQuery.data?.find(
      (entry) => entry.locationId === selectedLocation?.id,
    ) ?? null;

  if (locationsQuery.isPending) {
    return <div className="skeleton h-64 w-full" />;
  }

  return (
    <div className="space-y-4">
      <div className="card bg-base-100 border border-base-300">
        <div className="card-body gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="card-title text-base">Locations</h2>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                setEditing(editing === NEW_LOCATION ? null : NEW_LOCATION)
              }
            >
              <Plus className="size-4" /> Add location
            </button>
          </div>

          {locations.length === 0 && editing !== NEW_LOCATION ? (
            <p className="text-sm text-base-content/60">
              Add the business this grid is centred on — its coordinates set the
              grid, and its brand, domain, phone and address are how we tell
              your listing apart from every other office on the map.
            </p>
          ) : null}

          <ul className="flex flex-wrap gap-2">
            {locations.map((location) => (
              <li key={location.id}>
                <button
                  type="button"
                  className={`btn btn-sm ${
                    location.id === selectedLocationId
                      ? "btn-primary"
                      : "btn-ghost"
                  }`}
                  onClick={() => {
                    setSelectedLocationId(location.id);
                    setStartedRunId(null);
                  }}
                >
                  <MapPin className="size-4" />
                  {location.name}
                </button>
              </li>
            ))}
          </ul>

          {editing !== null ? (
            <MapsGridLocationForm
              projectId={projectId}
              location={
                editing === NEW_LOCATION
                  ? null
                  : (locations.find((entry) => entry.id === editing) ?? null)
              }
              onDone={() => setEditing(null)}
            />
          ) : selectedLocation ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-base-300 pt-3">
              <p className="flex-1 text-sm text-base-content/60">
                {selectedLocation.brandName} &middot; {selectedLocation.domain}{" "}
                &middot;{" "}
                <span className="font-mono text-xs">
                  {selectedLocation.lat.toFixed(5)},{" "}
                  {selectedLocation.lng.toFixed(5)}
                </span>
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setEditing(selectedLocation.id)}
              >
                <Pencil className="size-4" /> Edit
              </button>
              <DeleteLocationButton
                projectId={projectId}
                locationId={selectedLocation.id}
                onDeleted={() => setSelectedLocationId(null)}
              />
            </div>
          ) : null}
        </div>
      </div>

      {selectedLocation ? (
        <>
          <MapsGridConfigPanel
            key={selectedLocation.id}
            projectId={projectId}
            location={selectedLocation}
            config={config}
            onRunStarted={setStartedRunId}
          />
          {config ? (
            <MapsGridResults
              key={config.id}
              projectId={projectId}
              configId={config.id}
              selectedRunId={startedRunId}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function DeleteLocationButton({
  projectId,
  locationId,
  onDeleted,
}: {
  projectId: string;
  locationId: string;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => deleteGridLocation({ data: { projectId, locationId } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: gridQueryKeys.locations(projectId),
        }),
        queryClient.invalidateQueries({
          queryKey: gridQueryKeys.configs(projectId),
        }),
      ]);
      onDeleted();
      toast.success("Location deleted");
    },
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Couldn't delete the location"),
      ),
  });

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm text-error"
      disabled={mutation.isPending}
      onClick={() => {
        // Deleting takes the grid, its keywords and every run's history with it.
        if (!confirm("Delete this location and all of its grid history?"))
          return;
        mutation.mutate();
      }}
    >
      <Trash2 className="size-4" /> Delete
    </button>
  );
}

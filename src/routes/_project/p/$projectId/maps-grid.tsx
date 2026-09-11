import { createFileRoute } from "@tanstack/react-router";
import { MapsGridPage } from "@/client/features/maps-grid/MapsGridPage";

export const Route = createFileRoute("/_project/p/$projectId/maps-grid")({
  component: MapsGridRoute,
});

function MapsGridRoute() {
  const { projectId } = Route.useParams();

  return (
    <div className="px-4 py-4 pb-24 overflow-auto md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <h1 className="text-2xl font-semibold">Map Grid</h1>
          <p className="text-sm text-base-content/70">
            Where you actually rank in the local pack, point by point across the
            map
          </p>
        </div>

        <MapsGridPage projectId={projectId} />
      </div>
    </div>
  );
}

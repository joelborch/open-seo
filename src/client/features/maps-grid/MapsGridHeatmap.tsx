import { useState } from "react";
import type { GridRunCell } from "@/client/features/maps-grid/useMapsGridQueries";

/**
 * The 7×7 (or 5×5, or 3×3) rank heatmap for one keyword.
 *
 * The whole point of a grid is that a single "we rank #2" hides where that is
 * true, so the colour bands are coarse on purpose — top-3 wins the pack, 4-10
 * needs a scroll, 11-20 is invisible, and a miss is a hole in the map. The
 * centre cell is outlined because it is the position a non-grid rank tracker
 * would have reported on its own.
 */

/** A cell the client didn't rank in at all is scored at this position. */
const NOT_FOUND_LABEL = "—";

interface CellDelta {
  gridRow: number;
  gridCol: number;
  clientRank: number | null;
}

function bandClasses(rank: number | null): string {
  if (rank === null) return "bg-red-500/85 text-white";
  if (rank <= 3) return "bg-emerald-500/90 text-white";
  if (rank <= 10) return "bg-amber-400/90 text-black";
  if (rank <= 20) return "bg-orange-500/90 text-white";
  return "bg-red-500/85 text-white";
}

export function MapsGridHeatmap({
  cells,
  gridSize,
  previousCells,
}: {
  cells: GridRunCell[];
  gridSize: number;
  /** Prior run's ranks for the same panel; null when the panels don't match. */
  previousCells: CellDelta[] | null;
}) {
  const [hovered, setHovered] = useState<GridRunCell | null>(null);

  const byPoint = new Map(
    cells.map((cell) => [`${cell.gridRow}:${cell.gridCol}`, cell]),
  );
  const previousByPoint = new Map(
    (previousCells ?? []).map((cell) => [
      `${cell.gridRow}:${cell.gridCol}`,
      cell.clientRank,
    ]),
  );
  const centre = Math.floor(gridSize / 2) + 1;
  const rows = Array.from({ length: gridSize }, (_, i) => i + 1);

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div
        className="grid min-w-0 flex-1 gap-1"
        style={{ gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))` }}
        onMouseLeave={() => setHovered(null)}
      >
        {rows.flatMap((row) =>
          rows.map((col) => {
            const cell = byPoint.get(`${row}:${col}`);
            const isCentre = row === centre && col === centre;
            if (!cell) {
              return (
                <div
                  key={`${row}:${col}`}
                  className="aspect-square rounded bg-base-200"
                />
              );
            }
            const previousRank = previousByPoint.get(`${row}:${col}`);
            return (
              <button
                key={cell.id}
                type="button"
                className={`aspect-square rounded text-xs font-semibold leading-none transition-opacity hover:opacity-80 ${bandClasses(
                  cell.clientRank,
                )} ${isCentre ? "ring-2 ring-base-content ring-offset-1 ring-offset-base-100" : ""}`}
                title={cellSummary(cell)}
                onMouseEnter={() => setHovered(cell)}
                onFocus={() => setHovered(cell)}
              >
                <span className="block">
                  {cell.clientRank ?? NOT_FOUND_LABEL}
                </span>
                {previousCells ? (
                  <DeltaBadge
                    current={cell.clientRank}
                    previous={previousRank}
                  />
                ) : null}
              </button>
            );
          }),
        )}
      </div>

      <CellDetail cell={hovered} />
    </div>
  );
}

/**
 * Week-over-week movement for one cell, rendered only when the caller supplied a
 * comparable prior run — a delta against a different keyword set or grid size
 * would be reporting movement that never happened.
 */
function DeltaBadge({
  current,
  previous,
}: {
  current: number | null;
  previous: number | null | undefined;
}) {
  if (previous === undefined) return null;
  if (current === null && previous === null) return null;
  if (current === null)
    return <span className="block text-[0.6rem] font-normal">lost</span>;
  if (previous === null)
    return <span className="block text-[0.6rem] font-normal">new</span>;
  const delta = previous - current;
  if (delta === 0) return null;
  return (
    <span className="block text-[0.6rem] font-normal">
      {delta > 0 ? `▲${delta}` : `▼${Math.abs(delta)}`}
    </span>
  );
}

function CellDetail({ cell }: { cell: GridRunCell | null }) {
  if (!cell) {
    return (
      <div className="w-full shrink-0 rounded-lg border border-dashed border-base-300 p-4 text-sm text-base-content/50 lg:w-64">
        Hover a cell to see who ranks there.
      </div>
    );
  }
  const topThree = cell.results.slice(0, 3);
  return (
    <div className="w-full shrink-0 space-y-2 rounded-lg border border-base-300 bg-base-200/30 p-4 lg:w-64">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">
          {cell.clientRank === null
            ? "Not in the pack"
            : `Rank #${cell.clientRank}`}
        </p>
        <p className="text-xs text-base-content/60">
          {cell.distanceMiles.toFixed(2)} mi {cell.direction} of centre
        </p>
        <p className="font-mono text-[0.65rem] text-base-content/50">
          {cell.lat.toFixed(5)}, {cell.lng.toFixed(5)}
        </p>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-base-content/60">
          Top 3 here
        </p>
        {topThree.length === 0 ? (
          <p className="text-xs text-base-content/50">No results collected.</p>
        ) : (
          <ol className="space-y-0.5 text-xs">
            {topThree.map((result) => (
              <li
                key={`${result.rank}-${result.name}`}
                className={result.isClient ? "font-semibold text-success" : ""}
              >
                {result.rank}. {result.name || "Unnamed listing"}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function cellSummary(cell: GridRunCell): string {
  const rank =
    cell.clientRank === null ? "not found" : `rank ${cell.clientRank}`;
  return `${rank} — ${cell.distanceMiles.toFixed(2)} mi ${cell.direction} (${cell.lat.toFixed(5)}, ${cell.lng.toFixed(5)})`;
}

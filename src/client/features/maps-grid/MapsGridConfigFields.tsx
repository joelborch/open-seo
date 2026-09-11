import { useState } from "react";
import { Plus, X } from "lucide-react";
import {
  asGridSize,
  GRID_SIZES,
  type GridSize,
} from "@/types/schemas/maps-grid";

/**
 * Field groups for the grid config panel: the shape/cadence controls and the
 * keyword chips. Split out so the panel itself stays about the mutations.
 */

const ZOOM_OPTIONS = ["11z", "12z", "13z", "14z"] as const;

export interface GridSettings {
  gridSize: GridSize;
  radiusMiles: string;
  zoom: string;
  device: "mobile" | "desktop";
  scheduleInterval: "weekly" | "monthly" | "manual";
}

/** Narrow a config row's stored settings into the panel's form state. */
export function gridSettingsFrom(input: {
  gridSize: number;
  radiusMiles: number;
  zoom: string;
  device: "mobile" | "desktop";
  scheduleInterval: "weekly" | "monthly" | "manual";
}): GridSettings {
  return {
    gridSize: asGridSize(input.gridSize),
    radiusMiles: String(input.radiusMiles),
    zoom: input.zoom,
    device: input.device,
    scheduleInterval: input.scheduleInterval,
  };
}

export /** The config's keyword chips and the add field. Comma splits a pasted list. */
function GridKeywordList({
  keywords,
  isLoading,
  isAdding,
  onAdd,
  onRemove,
}: {
  keywords: Array<{ id: string; keyword: string }>;
  isLoading: boolean;
  isAdding: boolean;
  onAdd: (keywords: string[]) => void;
  onRemove: (keywordId: string) => void;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const words = draft
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean);
    if (words.length === 0) return;
    onAdd(words);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
        Keywords
      </span>
      <div className="flex flex-wrap gap-2">
        {keywords.map((keyword) => (
          <span key={keyword.id} className="badge badge-outline gap-1 py-3">
            {keyword.keyword}
            <button
              type="button"
              aria-label={`Remove ${keyword.keyword}`}
              className="opacity-60 hover:opacity-100"
              onClick={() => onRemove(keyword.id)}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {keywords.length === 0 && !isLoading ? (
          <span className="text-sm text-base-content/50">
            No keywords yet — a grid run needs at least one.
          </span>
        ) : null}
      </div>
      <div className="flex gap-2">
        <input
          className="input input-bordered input-sm flex-1"
          placeholder="dentist near me"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
        />
        <button
          type="button"
          className="btn btn-sm"
          disabled={isAdding}
          onClick={submit}
        >
          <Plus className="size-4" /> Add
        </button>
      </div>
    </div>
  );
}

/** Grid shape and cadence. Extracted so the panel above stays readable. */
export function GridSettingsFields({
  settings,
  onChange,
}: {
  settings: GridSettings;
  onChange: (update: (previous: GridSettings) => GridSettings) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
          Grid size
        </span>
        <div className="join">
          {GRID_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={`btn btn-sm join-item ${settings.gridSize === size ? "btn-active" : ""}`}
              onClick={() => onChange((prev) => ({ ...prev, gridSize: size }))}
            >
              {size}&times;{size}
            </button>
          ))}
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
          Radius (miles)
        </span>
        <input
          className="input input-bordered input-sm w-full"
          value={settings.radiusMiles}
          onChange={(event) =>
            onChange((prev) => ({
              ...prev,
              radiusMiles: event.target.value,
            }))
          }
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
          Zoom
        </span>
        <select
          className="select select-bordered select-sm w-full"
          value={settings.zoom}
          onChange={(event) =>
            onChange((prev) => ({ ...prev, zoom: event.target.value }))
          }
        >
          {ZOOM_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
          Device
        </span>
        <select
          className="select select-bordered select-sm w-full"
          value={settings.device}
          onChange={(event) =>
            onChange((prev) => ({
              ...prev,
              device: event.target.value === "desktop" ? "desktop" : "mobile",
            }))
          }
        >
          <option value="mobile">Mobile</option>
          <option value="desktop">Desktop</option>
        </select>
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium uppercase tracking-wide text-base-content/60">
          Schedule
        </span>
        <select
          className="select select-bordered select-sm w-full"
          value={settings.scheduleInterval}
          onChange={(event) =>
            onChange((prev) => ({
              ...prev,
              scheduleInterval: asInterval(event.target.value),
            }))
          }
        >
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="manual">Manual only</option>
        </select>
      </label>
    </div>
  );
}

function asInterval(value: string): "weekly" | "monthly" | "manual" {
  return value === "monthly" || value === "manual" ? value : "weekly";
}

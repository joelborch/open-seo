import { describe, expect, it, vi } from "vitest";
import {
  GRID_RUN_STALE_AFTER_MS,
  gridRunStaleReason,
} from "./mapsGridRunGuards";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/maps-grid/repositories/MapsGridRepository", () => ({
  MapsGridRepository: {},
}));

const stale = GRID_RUN_STALE_AFTER_MS + 60_000;

/**
 * The active run row is the config's lock, so this decision is the only thing
 * standing between a workflow that died and a grid that never runs again.
 */
describe("deciding a grid run is stale", () => {
  it("leaves a young run alone even with no live instance", () => {
    expect(
      gridRunStaleReason({
        runStatus: "running",
        workflowStatus: null,
        ageMs: 5 * 60_000,
      }),
    ).toBeNull();
  });

  it("leaves a run whose instance is still working", () => {
    expect(
      gridRunStaleReason({
        runStatus: "running",
        workflowStatus: { status: "waiting" },
        ageMs: stale,
      }),
    ).toBeNull();
  });

  it("reports an errored instance with its own message", () => {
    expect(
      gridRunStaleReason({
        runStatus: "running",
        workflowStatus: {
          status: "errored",
          error: { message: "exceeded memory" },
        },
        ageMs: stale,
      }),
    ).toBe("exceeded memory");
  });

  it("reports an instance that finished without finalizing the run", () => {
    expect(
      gridRunStaleReason({
        runStatus: "pending",
        workflowStatus: { status: "complete" },
        ageMs: stale,
      }),
    ).toBe("Grid workflow completed without finalizing the run");
  });

  it("reports a missing instance past the window", () => {
    expect(
      gridRunStaleReason({
        runStatus: "pending",
        workflowStatus: null,
        ageMs: stale,
      }),
    ).toBe("Grid workflow instance was not found");
  });

  it("says nothing about a run that already settled", () => {
    expect(
      gridRunStaleReason({
        runStatus: "completed",
        workflowStatus: null,
        ageMs: stale,
      }),
    ).toBeNull();
  });
});

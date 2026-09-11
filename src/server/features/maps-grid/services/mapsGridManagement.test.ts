import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfig } from "./mapsGridManagement";
import type { GridConfigFields } from "@/types/schemas/maps-grid";

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("@/server/features/maps-grid/repositories/MapsGridRepository", () => ({
  MapsGridRepository: mocks,
}));

const fields: GridConfigFields = {
  gridSize: 7,
  radiusMiles: 3,
  zoom: "13z",
  languageCode: "en",
  device: "mobile",
  depth: null,
  scheduleInterval: "weekly",
  isActive: true,
};

const inFourDays = new Date(Date.now() + 4 * 86_400_000).toISOString();

/**
 * The cursor is what the scheduler claims a run from, so an edit that moves it
 * forward silently skips a run the user is paying for.
 */
describe("saving a grid config's schedule cursor", () => {
  let savedNextRunAt: string | null | undefined;

  beforeEach(() => {
    savedNextRunAt = undefined;
    mocks.updateConfig.mockImplementation(
      (_input: unknown, data: { nextRunAt?: string | null }) => {
        savedNextRunAt = data.nextRunAt;
        return Promise.resolve();
      },
    );
  });

  it("keeps a pending slot when the cadence is unchanged", async () => {
    mocks.getConfigById.mockResolvedValue({
      scheduleInterval: "weekly",
      nextRunAt: inFourDays,
    });

    await updateConfig({ projectId: "p1", configId: "c1", fields });

    expect(savedNextRunAt).toBe(inFourDays);
  });

  it("recomputes the slot when the cadence changes", async () => {
    mocks.getConfigById.mockResolvedValue({
      scheduleInterval: "weekly",
      nextRunAt: inFourDays,
    });

    await updateConfig({
      projectId: "p1",
      configId: "c1",
      fields: { ...fields, scheduleInterval: "monthly" },
    });

    expect(savedNextRunAt).not.toBe(inFourDays);
    expect(new Date(savedNextRunAt ?? "").getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it("recomputes a cursor that is already due", async () => {
    const overdue = new Date(Date.now() - 3 * 86_400_000).toISOString();
    mocks.getConfigById.mockResolvedValue({
      scheduleInterval: "weekly",
      nextRunAt: overdue,
    });

    await updateConfig({ projectId: "p1", configId: "c1", fields });

    expect(new Date(savedNextRunAt ?? "").getTime()).toBeGreaterThan(
      Date.now(),
    );
  });
});

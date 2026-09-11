import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeNextDeepAt, computeNextQuickAt } from "./audit-schedules";

// 2026-09-11 is a Friday (getUTCDay() === 5).
const NOW = "2026-09-11T09:30:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeNextQuickAt", () => {
  it("advances a missed anchor by whole days to the next future slot", () => {
    // Three days stale: the result must be the next slot, not three overdue ones.
    expect(computeNextQuickAt(3, "2026-09-08T03:00:00.000Z")).toBe(
      "2026-09-12T03:00:00.000Z",
    );
  });

  it("ignores an anchor whose hour no longer matches the config", () => {
    // The user moved the daily crawl from 03:00 to 07:00 — stepping the old
    // anchor would keep firing at 03:00 forever. Today's 07:00 is already past,
    // so the next slot is tomorrow's.
    expect(computeNextQuickAt(7, "2026-09-12T03:00:00.000Z")).toBe(
      "2026-09-12T07:00:00.000Z",
    );
  });
});

describe("computeNextDeepAt", () => {
  it("lands on the configured weekday and hour", () => {
    // Monday (1) at 04:00, from a Friday.
    expect(computeNextDeepAt(1, 4)).toBe("2026-09-14T04:00:00.000Z");
  });

  it("advances an on-grid anchor a week at a time", () => {
    expect(computeNextDeepAt(1, 4, "2026-09-07T04:00:00.000Z")).toBe(
      "2026-09-14T04:00:00.000Z",
    );
  });

  it("skips today when its slot has already passed", () => {
    // Friday (5) at 04:00 and it is already 09:30 — next week, not today.
    expect(computeNextDeepAt(5, 4)).toBe("2026-09-18T04:00:00.000Z");
  });
});

// Saving a schedule re-derives its cursor from the cursor it already holds, so a
// pending slot has to survive the round trip — otherwise every save (even one
// that changes nothing) pushes the next run out by a full interval.
describe("a still-future anchor", () => {
  it.each([
    {
      cadence: "quick",
      slot: "2026-09-12T03:00:00.000Z",
      compute: () => computeNextQuickAt(3, "2026-09-12T03:00:00.000Z"),
    },
    {
      cadence: "deep",
      slot: "2026-09-14T04:00:00.000Z",
      compute: () => computeNextDeepAt(1, 4, "2026-09-14T04:00:00.000Z"),
    },
  ])("is returned unchanged for the $cadence cadence", ({ slot, compute }) => {
    expect(compute()).toBe(slot);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildGridPoints,
  formatLocationCoordinate,
  getDirection,
  haversineMiles,
} from "./geometry.js";
import anchorageFixture from "./fixtures/grid-anchorage.json";
import chicagoFixture from "./fixtures/grid-chicago.json";
import phoenixFixture from "./fixtures/grid-phoenix.json";

describe("maps-grid geometry", () => {
  describe("haversineMiles", () => {
    it("returns 0 for identical coordinates", () => {
      expect(haversineMiles(33.4484, -112.074, 33.4484, -112.074)).toBe(0);
    });

    it("matches known distances accurately", () => {
      // Phoenix to Chicago ~ 1440 miles
      const distance = haversineMiles(33.4484, -112.074, 41.8781, -87.6298);
      expect(distance).toBeGreaterThan(1430);
      expect(distance).toBeLessThan(1460);
    });
  });

  describe("getDirection", () => {
    it("identifies center cell", () => {
      expect(getDirection(2, 2, 5)).toBe("Center");
      expect(getDirection(3, 3, 7)).toBe("Center");
    });

    it("identifies 8 cardinal and intercardinal directions", () => {
      // 3x3 grid: center is (1, 1)
      expect(getDirection(0, 0, 3)).toBe("NW");
      expect(getDirection(0, 1, 3)).toBe("N");
      expect(getDirection(0, 2, 3)).toBe("NE");
      expect(getDirection(1, 0, 3)).toBe("W");
      expect(getDirection(1, 1, 3)).toBe("Center");
      expect(getDirection(1, 2, 3)).toBe("E");
      expect(getDirection(2, 0, 3)).toBe("SW");
      expect(getDirection(2, 1, 3)).toBe("S");
      expect(getDirection(2, 2, 3)).toBe("SE");
    });
  });

  describe("formatLocationCoordinate", () => {
    it("formats coordinates with 7 decimal places and zoom string", () => {
      expect(formatLocationCoordinate(33.4484, -112.074, "13z")).toBe(
        "33.4484000,-112.0740000,13z",
      );
    });

    it("appends z when numeric zoom is supplied", () => {
      expect(formatLocationCoordinate(41.8781, -87.6298, 14)).toBe(
        "41.8781000,-87.6298000,14z",
      );
    });

    it("defaults to 13z zoom", () => {
      expect(formatLocationCoordinate(61.2181, -149.9003)).toBe(
        "61.2181000,-149.9003000,13z",
      );
    });
  });

  describe("buildGridPoints - Python parity fixtures", () => {
    const fixtureSuites = [
      { name: "Phoenix 7x7 @ 5mi", fixture: phoenixFixture },
      { name: "Chicago 5x5 @ 3mi", fixture: chicagoFixture },
      {
        name: "Anchorage 3x3 @ 10mi (high latitude)",
        fixture: anchorageFixture,
      },
    ];

    for (const { name, fixture } of fixtureSuites) {
      it(`matches Python fixture for ${name} within 1e-9 precision`, () => {
        const points = buildGridPoints({
          centerLat: fixture.centerLat,
          centerLng: fixture.centerLng,
          gridSize: fixture.gridSize,
          radiusMiles: fixture.radiusMiles,
        });

        expect(points.length).toBe(fixture.points.length);
        expect(points.length).toBe(fixture.gridSize * fixture.gridSize);

        for (let i = 0; i < points.length; i++) {
          const actual = points[i];
          const expected = fixture.points[i];

          expect(actual.row).toBe(expected.row);
          expect(actual.col).toBe(expected.col);
          expect(actual.direction).toBe(expected.direction);

          // Assert coordinates and distances match Python within 1e-9
          expect(Math.abs(actual.lat - expected.lat)).toBeLessThan(1e-9);
          expect(Math.abs(actual.lng - expected.lng)).toBeLessThan(1e-9);
          expect(
            Math.abs(actual.distanceMiles - expected.distanceMiles),
          ).toBeLessThan(1e-9);
        }
      });
    }
  });

  describe("buildGridPoints - structural invariants", () => {
    it("handles 1x1 grid gracefully", () => {
      const points = buildGridPoints({
        centerLat: 33.4484,
        centerLng: -112.074,
        gridSize: 1,
        radiusMiles: 5,
      });
      expect(points.length).toBe(1);
      expect(points[0]).toEqual({
        row: 1,
        col: 1,
        lat: 33.4484,
        lng: -112.074,
        direction: "Center",
        distanceMiles: 0,
      });
    });

    it("clamps cosine at high latitude to 0.2", () => {
      // At latitude 85, cos(85 deg) ~ 0.087, which is < 0.2
      const points = buildGridPoints({
        centerLat: 85.0,
        centerLng: 0.0,
        gridSize: 3,
        radiusMiles: 10,
      });
      const centerPoint = points[4]; // row 2, col 2
      const eastPoint = points[5]; // row 2, col 3 (offset +1 col)

      const expectedLonRadius = 10 / (69.172 * 0.2);
      expect(
        Math.abs(eastPoint.lng - centerPoint.lng - expectedLonRadius),
      ).toBeLessThan(1e-9);
    });

    it("orients row 1 North and col 1 West", () => {
      const points = buildGridPoints({
        centerLat: 40.0,
        centerLng: -80.0,
        gridSize: 3,
        radiusMiles: 5,
      });
      const northWest = points[0]; // row 1, col 1
      const center = points[4]; // row 2, col 2
      const southEast = points[8]; // row 3, col 3

      expect(northWest.lat).toBeGreaterThan(center.lat);
      expect(northWest.lng).toBeLessThan(center.lng);
      expect(southEast.lat).toBeLessThan(center.lat);
      expect(southEast.lng).toBeGreaterThan(center.lng);
    });
  });
});

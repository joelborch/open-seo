/**
 * Maps-grid geometry: the N×N point lattice a grid run fans out over, plus the
 * distance / direction / coordinate-string helpers that describe each point.
 *
 * The arithmetic is a direct port of
 * `tools/studio-tools/apps/analytics/scripts/local_intent/google_maps_radius_grid.py`,
 * and the fixtures under `fixtures/` are that script's output — the equality
 * tests are what keep a grid rendered here comparable to the historical ones.
 */

/** Earth radius used by the Python original, in miles. */
const EARTH_RADIUS_MILES = 3958.7613;
/** Degrees of latitude are effectively constant in length. */
const MILES_PER_DEGREE_LAT = 69.0;
/** Degrees of longitude at the equator; scaled by cos(lat) away from it. */
const MILES_PER_DEGREE_LON_EQUATOR = 69.172;
/**
 * Floor on cos(lat) when converting miles to degrees of longitude. Without it a
 * near-polar grid would divide by ~0 and span half the globe.
 */
const MIN_COS_CLAMP = 0.2;

type GridDirection =
  | "Center"
  | "N"
  | "S"
  | "E"
  | "W"
  | "NW"
  | "NE"
  | "SW"
  | "SE";

interface GridPoint {
  /** 1-based; row 1 is the northern edge. */
  row: number;
  /** 1-based; col 1 is the western edge. */
  col: number;
  lat: number;
  lng: number;
  direction: GridDirection;
  /** Great-circle distance from the grid centre. */
  distanceMiles: number;
}

const DEGREES_TO_RADIANS = Math.PI / 180;

/** Great-circle distance between two coordinates, in miles (haversine). */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const phi1 = lat1 * DEGREES_TO_RADIANS;
  const phi2 = lat2 * DEGREES_TO_RADIANS;
  const deltaPhi = (lat2 - lat1) * DEGREES_TO_RADIANS;
  const deltaLambda = (lon2 - lon1) * DEGREES_TO_RADIANS;

  const a =
    Math.sin(deltaPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;

  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compass label for a 0-indexed (row, col) cell relative to the grid centre.
 * Row 0 is north, col 0 is west — so the label reads top-left as "NW".
 */
export function getDirection(
  row: number,
  col: number,
  size: number,
): GridDirection {
  const centre = Math.floor(size / 2);
  if (row === centre && col === centre) return "Center";
  if (row === centre) return col < centre ? "W" : "E";
  if (col === centre) return row < centre ? "N" : "S";
  if (row < centre) return col < centre ? "NW" : "NE";
  return col < centre ? "SW" : "SE";
}

/**
 * The N×N lattice of search points around a centre, ordered row-major from the
 * north-west corner. Offsets are linear in degrees rather than a true geodesic
 * projection: the grid is a viewport sampler, so cells only need to be evenly
 * spread and reproducible, and `distanceMiles` reports the real distance.
 */
export function buildGridPoints(options: {
  centerLat: number;
  centerLng: number;
  gridSize: number;
  radiusMiles: number;
}): GridPoint[] {
  const { centerLat, centerLng, gridSize, radiusMiles } = options;
  const centre = Math.floor(gridSize / 2);

  const latRadius = radiusMiles / MILES_PER_DEGREE_LAT;
  const lonRadius =
    radiusMiles /
    (MILES_PER_DEGREE_LON_EQUATOR *
      Math.max(MIN_COS_CLAMP, Math.cos(centerLat * DEGREES_TO_RADIANS)));

  const points: GridPoint[] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      // A 1×1 grid has no offset to scale, so it collapses onto the centre.
      const lat =
        centre === 0
          ? centerLat
          : centerLat + ((centre - row) / centre) * latRadius;
      const lng =
        centre === 0
          ? centerLng
          : centerLng + ((col - centre) / centre) * lonRadius;

      points.push({
        row: row + 1,
        col: col + 1,
        lat,
        lng,
        direction: getDirection(row, col, gridSize),
        distanceMiles: haversineMiles(centerLat, centerLng, lat, lng),
      });
    }
  }
  return points;
}

/**
 * DataForSEO's Maps `location_coordinate`: "lat,lng,<zoom>z" with 7 decimals.
 * The zoom suffix is load-bearing — it sets the viewport the pack is drawn
 * from, and a too-tight viewport reads as "not ranked" for a business a couple
 * of grid steps away.
 */
export function formatLocationCoordinate(
  lat: number,
  lng: number,
  zoom: string | number = "13z",
): string {
  const trimmed = String(zoom).trim();
  const zoomSuffix = trimmed === "" ? "13z" : trimmed;
  return `${lat.toFixed(7)},${lng.toFixed(7)},${
    zoomSuffix.endsWith("z") ? zoomSuffix : `${zoomSuffix}z`
  }`;
}

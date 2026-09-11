/**
 * Maps grid geometry: grid points generation, haversine distance calculation,
 * cardinal direction determination, and DataForSEO location coordinate formatting.
 *
 * Ported from `tools/studio-tools/apps/analytics/scripts/local_intent/google_maps_radius_grid.py`.
 */

export const EARTH_RADIUS_MILES = 3958.7613;
export const MILES_PER_DEGREE_LAT = 69.0;
export const MILES_PER_DEGREE_LON_EQUATOR = 69.172;
export const MIN_COS_CLAMP = 0.2;

export type GridDirection =
  | "Center"
  | "N"
  | "S"
  | "E"
  | "W"
  | "NW"
  | "NE"
  | "SW"
  | "SE";

export interface BuildGridPointsOptions {
  centerLat: number;
  centerLng: number;
  gridSize: number;
  radiusMiles: number;
}

export interface GridPoint {
  row: number;
  col: number;
  lat: number;
  lng: number;
  direction: string;
  distanceMiles: number;
}

/**
 * Calculates great-circle distance between two coordinates in miles
 * using the Haversine formula and an earth radius of 3958.7613 miles.
 */
export function haversineMiles(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dPhi = (lat2 - lat1) * toRad;
  const dLam = (lon2 - lon1) * toRad;

  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;

  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Determines cardinal direction for a 0-indexed (row, col) grid cell relative to center.
 * Row 0 is North (top), col 0 is West (left).
 */
export function getDirection(
  row: number,
  col: number,
  size: number,
): GridDirection {
  const center = Math.floor(size / 2);
  if (row === center && col === center) {
    return "Center";
  }
  const ns = row < center ? "N" : row > center ? "S" : "";
  const ew = col < center ? "W" : col > center ? "E" : "";
  return `${ns}${ew}` as GridDirection;
}

/**
 * Builds an N x N matrix of grid points around a central latitude/longitude.
 *
 * Rows and cols are 1-based:
 * - Row 1 is North, Row N is South.
 * - Col 1 is West, Col N is East.
 */
export function buildGridPoints(options: BuildGridPointsOptions): GridPoint[] {
  const { centerLat, centerLng, gridSize, radiusMiles } = options;
  const center = Math.floor(gridSize / 2);
  const toRad = Math.PI / 180;

  const latRadius = radiusMiles / MILES_PER_DEGREE_LAT;
  const lonRadius =
    radiusMiles /
    (MILES_PER_DEGREE_LON_EQUATOR *
      Math.max(MIN_COS_CLAMP, Math.cos(centerLat * toRad)));

  const points: GridPoint[] = [];

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const rowOffset = center - row;
      const colOffset = col - center;

      const lat =
        center !== 0 ? centerLat + (rowOffset / center) * latRadius : centerLat;
      const lng =
        center !== 0 ? centerLng + (colOffset / center) * lonRadius : centerLng;

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
 * Formats coordinates for DataForSEO Maps tasks as "lat,lng,13z" with 7 decimals.
 */
export function formatLocationCoordinate(
  lat: number,
  lng: number,
  zoom: string | number = "13z",
): string {
  const normalizedZoom = zoom ? String(zoom).trim() : "13z";
  const zoomStr = normalizedZoom.endsWith("z")
    ? normalizedZoom
    : `${normalizedZoom}z`;
  return `${lat.toFixed(7)},${lng.toFixed(7)},${zoomStr}`;
}

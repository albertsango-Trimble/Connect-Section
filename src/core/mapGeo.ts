import { fromProject, looksLikeProjectCoordinates, modelOrigin, toProject } from './geo';
import type { XY } from './section';

/** Metres per degree used to draw a model with no coordinate system on a blank grid around 0°, 0°. */
const M_PER_DEG = 111320;

let local = true;
const listeners = new Set<() => void>();

/**
 * Chooses how model coordinates are placed on the map: through the project's coordinate system when it is known
 * and the model's coordinates look like it, otherwise on a blank local grid (metres from the model origin).
 * `sampleX` is any model x coordinate, used to check the model really is in project coordinates.
 */
export function updatePlacement(sampleX: number | undefined): void {
  const georeferenced = toProject(0, 0) !== null && sampleX !== undefined && looksLikeProjectCoordinates(sampleX);
  const next = !georeferenced;
  if (next !== local) {
    local = next;
    listeners.forEach((l) => l());
  }
}

/** True when the map is a blank grid rather than the earth. */
export const isLocalGrid = () => local;

export function onPlacementChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Model coordinates (metres) to map longitude/latitude, or null if they can't be placed. */
export function modelToMap(x: number, y: number): XY | null {
  if (local) return [x / M_PER_DEG, y / M_PER_DEG];
  try {
    const ll = fromProject(x + modelOrigin.x, y + modelOrigin.y);
    if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1]) || Math.abs(ll[1]) > 90) return null;
    return ll;
  } catch {
    return null;
  }
}

/** Map longitude/latitude to model coordinates (metres), or null if they can't be placed. */
export function mapToModel(lon: number, lat: number): XY | null {
  if (local) return [lon * M_PER_DEG, lat * M_PER_DEG];
  try {
    const en = toProject(lon, lat);
    if (!en || !Number.isFinite(en[0]) || !Number.isFinite(en[1])) return null;
    return [en[0] - modelOrigin.x, en[1] - modelOrigin.y];
  } catch {
    return null;
  }
}

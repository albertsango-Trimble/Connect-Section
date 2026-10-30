/**
 * The geometry of a cross section, worked out in model coordinates (metres, x east, y north, z up).
 * Nothing here talks to Connect, so it can be tested on its own.
 */

export type XY = [number, number];

/** One object in a loaded model, with its axis-aligned bounding box. */
export interface Element {
  modelId: string;
  id: number;
  min: [number, number, number];
  max: [number, number, number];
}

/** A vertical clipping plane: a point on it and the normal pointing into the part that is kept. */
export interface Plane {
  point: [number, number, number];
  inward: [number, number, number];
}

export interface SectionOptions {
  /** 1 keeps (and looks at) the left-hand side of the line as drawn from its start, -1 the right-hand side */
  side: 1 | -1;
  /** Fixed depth behind the cut in metres. Leave undefined to take it from the elements the line crosses. */
  depth?: number;
  /** Most depth taken from the elements, so a long wall along the line can't push the back plane kilometres away */
  maxDepth?: number;
  /** Keep only this far past the ends of the crossed elements, in metres */
  margin?: number;
}

export interface Section {
  a: XY;
  b: XY;
  /** Unit vector along the line */
  along: XY;
  /** Unit vector from the cut into the kept part (the way the camera looks) */
  into: XY;
  /** The elements the line crosses */
  crossed: Element[];
  /** Kept range along the line, measured from `a` (metres) */
  from: number;
  to: number;
  /** Depth kept behind the cut (metres) */
  depth: number;
  /** Lowest and highest points of the crossed elements, or of every element when nothing is crossed */
  zMin: number;
  zMax: number;
  /** True when the depth came from the crossed elements rather than being typed in */
  depthFromElements: boolean;
  /** The four vertical planes bounding the kept slab: the cut, the back, and the two ends */
  planes: Plane[];
  /** The kept slab seen from above, as a closed ring in model coordinates */
  footprint: XY[];
}

const DEFAULT_MAX_DEPTH = 100;
const MIN_DEPTH = 0.5;

/**
 * True when the segment a→b passes through (or touches) the rectangle min..max.
 * Liang–Barsky clipping of the segment against the rectangle.
 */
export function segmentHitsBox(a: XY, b: XY, min: XY, max: XY): boolean {
  let t0 = 0;
  let t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (let axis = 0; axis < 2; axis++) {
    if (Math.abs(d[axis]) < 1e-12) {
      if (a[axis] < min[axis] || a[axis] > max[axis]) return false;
      continue;
    }
    let lo = (min[axis] - a[axis]) / d[axis];
    let hi = (max[axis] - a[axis]) / d[axis];
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
    if (t0 > t1) return false;
  }
  return true;
}

const corners = (e: Element): XY[] => [
  [e.min[0], e.min[1]],
  [e.max[0], e.min[1]],
  [e.max[0], e.max[1]],
  [e.min[0], e.max[1]],
];

/**
 * Works out the section for a line drawn on the map. The cut runs vertically through the line. The kept slab
 * reaches back from the cut as deep as the crossed elements go (or `options.depth`), and along the line as far
 * as the crossed elements reach, so the clipping fits the geometry the line actually cuts through.
 * Returns null for a line too short to have a direction.
 */
export function computeSection(a: XY, b: XY, elements: Element[], options: SectionOptions): Section | null {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < 0.01) return null;
  const along: XY = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const left: XY = [-along[1], along[0]];
  const into: XY = [left[0] * options.side, left[1] * options.side];
  const margin = options.margin ?? 0.5;

  const crossed = elements.filter((e) => segmentHitsBox(a, b, [e.min[0], e.min[1]], [e.max[0], e.max[1]]));

  const t = (p: XY) => (p[0] - a[0]) * along[0] + (p[1] - a[1]) * along[1];
  const d = (p: XY) => (p[0] - a[0]) * into[0] + (p[1] - a[1]) * into[1];

  let from = 0;
  let to = length;
  let depthFound = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  // Site-sized objects such as terrain surfaces are still cut, but don't set the extent: they would stretch it far
  // past everything else the line crosses.
  const sized = crossed.filter((e) => Math.hypot(e.max[0] - e.min[0], e.max[1] - e.min[1]) <= Math.max(50, 3 * length));
  const shaping = sized;
  if (shaping.length > 0) {
    from = Infinity;
    to = -Infinity;
    for (const e of shaping) {
      for (const c of corners(e)) {
        from = Math.min(from, t(c));
        to = Math.max(to, t(c));
        depthFound = Math.max(depthFound, d(c));
      }
      zMin = Math.min(zMin, e.min[2]);
      zMax = Math.max(zMax, e.max[2]);
    }
    // The line itself is always inside the kept range, even where it runs past the last crossed element.
    from = Math.min(from, 0) - margin;
    to = Math.max(to, length) + margin;
  }
  if (!Number.isFinite(zMin)) {
    for (const e of crossed.length > 0 ? crossed : elements) {
      zMin = Math.min(zMin, e.min[2]);
      zMax = Math.max(zMax, e.max[2]);
    }
  }
  if (!Number.isFinite(zMin)) {
    zMin = 0;
    zMax = 10;
  }

  const depthFromElements = options.depth === undefined;
  const depth = depthFromElements
    ? Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, Math.max(MIN_DEPTH, depthFound + margin))
    : Math.max(0.01, options.depth as number);

  const at = (s: number, r: number): XY => [a[0] + along[0] * s + into[0] * r, a[1] + along[1] * s + into[1] * r];
  const zMid = (zMin + zMax) / 2;
  const p3 = (p: XY): [number, number, number] => [p[0], p[1], zMid];
  const v3 = (v: XY, sign = 1): [number, number, number] => [v[0] * sign, v[1] * sign, 0];

  const planes: Plane[] = [
    { point: p3(at(0, 0)), inward: v3(into) }, // the cut
    { point: p3(at(0, depth)), inward: v3(into, -1) }, // the back
    { point: p3(at(from, 0)), inward: v3(along) }, // the start end
    { point: p3(at(to, 0)), inward: v3(along, -1) }, // the far end
  ];
  const footprint: XY[] = [at(from, 0), at(to, 0), at(to, depth), at(from, depth), at(from, 0)];

  return { a, b, along, into, crossed, from, to, depth, zMin, zMax, depthFromElements, planes, footprint };
}

export interface SectionCamera {
  position: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
  fieldOfView: number;
  /** Height of view for an orthographic camera (metres) */
  orthoSize: number;
}

/**
 * A camera square-on to the cut, standing in front of it and looking into the kept slab, placed far enough
 * back that the whole cut fits the pane. `aspect` is the 3D pane's width over its height.
 */
export function sectionCamera(s: Section, aspect: number, fieldOfView = 45): SectionCamera {
  const width = Math.max(1, s.to - s.from);
  const height = Math.max(1, s.zMax - s.zMin);
  const mid = (s.from + s.to) / 2;
  const centre: XY = [s.a[0] + s.along[0] * mid, s.a[1] + s.along[1] * mid];
  const z = (s.zMin + s.zMax) / 2;
  const half = ((fieldOfView / 2) * Math.PI) / 180;
  const fit = 1.15;
  const distance = Math.max((height / 2 / Math.tan(half)) * fit, (width / 2 / (Math.tan(half) * Math.max(0.2, aspect))) * fit, 2);
  return {
    position: { x: centre[0] - s.into[0] * distance, y: centre[1] - s.into[1] * distance, z },
    lookAt: { x: centre[0], y: centre[1], z },
    fieldOfView,
    orthoSize: Math.max(height, width / Math.max(0.2, aspect)) * fit,
  };
}

/** The element whose footprint is smallest among those containing the point, for picking the most specific one. */
export function elementAt(p: XY, elements: Element[]): Element | null {
  let best: Element | null = null;
  let bestArea = Infinity;
  for (const e of elements) {
    if (p[0] < e.min[0] || p[0] > e.max[0] || p[1] < e.min[1] || p[1] > e.max[1]) continue;
    const area = (e.max[0] - e.min[0]) * (e.max[1] - e.min[1]);
    if (area < bestArea) {
      best = e;
      bestArea = area;
    }
  }
  return best;
}

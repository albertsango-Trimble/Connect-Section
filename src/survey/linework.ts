import { DEFAULT_CONTROLS, type ControlAction, type FeatureDefinition, type FeatureLibrary } from './fxl';
import type { JobLine, SurveyPoint } from './jobxml';

export type V3 = [number, number, number | null];

/** A run of linework: points joined in the order they were measured, with arcs and smooth curves densified. */
export interface SurveyString {
  /** The feature code */
  code: string;
  /** The code plus its string number, e.g. "EB2" */
  key: string;
  color: string;
  closed: boolean;
  kind: 'line' | 'polygon';
  /** Names of the measured points, in order */
  points: string[];
  /** The drawn shape, including the extra vertices of arcs and curves */
  coords: V3[];
}

export interface StyledPoint extends SurveyPoint {
  /** The first feature code recognised for the point (or the first code word) */
  feature?: string;
  color: string;
  /** True when the library says this code is drawn as a point (or nothing says otherwise) */
  isPointFeature: boolean;
}

export interface Linework {
  points: StyledPoint[];
  strings: SurveyString[];
  /** Codes used that the library doesn't define */
  unknownCodes: string[];
}

const PALETTE = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#6d4c41', '#3949ab', '#c0ca33', '#d81b60', '#00acc1', '#5e35b1'];

/** A steady colour for a code that the library gives none. */
export function colorFor(code: string): string {
  let h = 0;
  for (const ch of code.toUpperCase()) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Finds a code in the library: as written, or without a trailing string number ("EB2" → "EB"). */
export function lookup(token: string, library: FeatureLibrary | null): { def: FeatureDefinition; key: string } | null {
  if (!library) return null;
  const up = token.toUpperCase();
  const exact = library.features.get(up);
  if (exact) return { def: exact, key: up };
  const m = up.match(/^(.*?)(\d+)$/);
  if (m && m[1]) {
    const base = library.features.get(m[1]);
    if (base) return { def: base, key: up };
  }
  return null;
}

/** Points on a circle through three points, from a to c passing b. Null when the three are in a line. */
function arcThrough(a: V3, b: V3, c: V3, steps = 16): V3[] | null {
  const [ax, ay] = a;
  const [bx, by] = b;
  const [cx, cy] = c;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const r = Math.hypot(ax - ux, ay - uy);
  const ang = (p: V3) => Math.atan2(p[1] - uy, p[0] - ux);
  const a0 = ang(a);
  let a1 = ang(b);
  let a2 = ang(c);
  // Go the way that passes through b.
  const ccw = ((a1 - a0 + 4 * Math.PI) % (2 * Math.PI)) < ((a2 - a0 + 4 * Math.PI) % (2 * Math.PI));
  const sweep = ccw ? (a2 - a0 + 4 * Math.PI) % (2 * Math.PI) : -((a0 - a2 + 4 * Math.PI) % (2 * Math.PI));
  a1 = a0;
  a2 = a0 + sweep;
  const za = a[2];
  const zc = c[2];
  const out: V3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const th = a1 + (a2 - a1) * t;
    out.push([ux + r * Math.cos(th), uy + r * Math.sin(th), za !== null && zc !== null ? za + (zc - za) * t : za ?? zc]);
  }
  return out;
}

/** Arc from a to c with a radius and turning direction. */
function arcByRadius(a: V3, c: V3, radius: number, clockwise: boolean, steps = 16): V3[] | null {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  const chord = Math.hypot(dx, dy);
  if (!(radius > chord / 2) || chord === 0) return null;
  const h = Math.sqrt(radius * radius - (chord / 2) ** 2);
  const mx = (a[0] + c[0]) / 2;
  const my = (a[1] + c[1]) / 2;
  // The centre is to the right of the chord for a clockwise (minor) arc.
  const side = clockwise ? -1 : 1;
  const ux = mx + (side * -dy * h) / chord;
  const uy = my + (side * dx * h) / chord;
  const midAngle = Math.atan2(my - uy, mx - ux);
  const b: V3 = [ux + radius * Math.cos(midAngle), uy + radius * Math.sin(midAngle), null];
  return arcThrough(a, b, c, steps);
}

/** A Catmull-Rom curve through the points. */
function smooth(pts: V3[], steps = 6): V3[] {
  if (pts.length < 3) return pts;
  const out: V3[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (k: 0 | 1) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      const z = p1[2] !== null && p2[2] !== null ? p1[2] + (p2[2] - p1[2]) * t : p1[2] ?? p2[2];
      out.push([f(0), f(1), z]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

interface Open {
  code: string;
  key: string;
  color: string;
  kind: 'line' | 'polygon';
  points: SurveyPoint[];
  /** Which segment each vertex starts: straight, part of an arc, or part of a smooth curve */
  modes: ('line' | 'arc' | 'smooth')[];
  mode: 'line' | 'arc' | 'smooth';
}

/**
 * Turns an open string into its drawn shape. Each run of points that were measured inside an arc (from the point
 * with the start code to the one with the end code) becomes a circular arc through its first, middle and last
 * points; a smooth-curve run becomes a curve through all of them; everything else is joined straight.
 */
function shape(s: Open, closed: boolean): V3[] {
  const v = s.points.map((p) => [p.x, p.y, p.z] as V3);
  const out: V3[] = [];
  let i = 0;
  while (i < v.length) {
    const mode = s.modes[i];
    if (mode === 'line') {
      out.push(v[i]);
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < v.length && s.modes[j + 1] === mode) j++;
    const run = v.slice(i, j + 1);
    const part = mode === 'arc' ? (run.length >= 3 ? arcThrough(run[0], run[Math.floor(run.length / 2)], run[run.length - 1]) : null) ?? run : smooth(run);
    out.push(...part);
    i = j + 1;
  }
  if (closed && v.length > 2) out.push(v[0]);
  return out;
}

/**
 * Builds linework from the codes recorded with each point, the way Trimble Access draws it: points with the same
 * line code are joined in the order they were measured; a control code after the feature code starts, ends or
 * closes the line, or begins and ends an arc or smooth curve. A trailing number on a code ("EB2") keeps separate
 * strings of the same feature apart. Lines and arcs recorded in the job itself are added as their own strings.
 */
export function buildLinework(points: SurveyPoint[], library: FeatureLibrary | null, jobLines: JobLine[] = []): Linework {
  const controls = library?.controls.size ? library.controls : DEFAULT_CONTROLS;
  const open = new Map<string, Open>();
  const strings: SurveyString[] = [];
  const unknown = new Set<string>();
  const styled: StyledPoint[] = [];

  const finish = (key: string, closed = false) => {
    const s = open.get(key);
    open.delete(key);
    if (!s || s.points.length < 2) return;
    strings.push({ code: s.code, key: s.key, color: s.color, closed: closed || s.kind === 'polygon', kind: s.kind, points: s.points.map((p) => p.name), coords: shape(s, closed || s.kind === 'polygon') });
  };

  // Codes the library doesn't define (or every code, with no library) are taken as lines when the job ever puts
  // a control code after them, and as points otherwise.
  const implicitLines = new Set<string>();
  for (const p of points) {
    const tokens = p.code.split(/\s+/).filter(Boolean);
    tokens.forEach((token, i) => {
      if (!controls.has(token.toUpperCase()) && !lookup(token, library) && i + 1 < tokens.length && controls.has(tokens[i + 1].toUpperCase())) {
        implicitLines.add(token.toUpperCase().replace(/\d+$/, ''));
      }
    });
  }
  const find = (token: string): { def: FeatureDefinition; key: string } | null => {
    const found = lookup(token, library);
    if (found) return found;
    const up = token.toUpperCase();
    const base = up.replace(/\d+$/, '') || up;
    return implicitLines.has(base) ? { def: { code: base, kind: 'line' }, key: up } : null;
  };

  for (const p of [...points].sort((a, b) => a.order - b.order)) {
    const tokens = p.code.split(/\s+/).filter(Boolean);
    let feature: string | undefined;
    let color: string | undefined;
    let isPoint = true;
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      if (controls.has(token.toUpperCase())) continue;
      const found = find(token);
      if (found && !lookup(token, library) && library) unknown.add(token);
      if (!found) {
        if (library) unknown.add(token);
        if (!feature) {
          feature = token;
          color = colorFor(token.replace(/\d+$/, ''));
        }
        continue;
      }
      const def = found.def;
      if (!feature || isPoint) {
        feature = def.code;
        color = def.color ?? colorFor(def.code);
      }
      if (def.kind === 'point') continue;
      isPoint = false;
      // Control codes that follow this feature code, up to the next feature code.
      const actions: ControlAction[] = [];
      for (let u = t + 1; u < tokens.length; u++) {
        const c = controls.get(tokens[u].toUpperCase());
        if (!c) break;
        actions.push(c.action);
      }
      const key = found.key;
      if (actions.includes('start')) finish(key);
      let s = open.get(key);
      if (!s) {
        s = { code: def.code, key, color: def.color ?? colorFor(def.code), kind: def.kind === 'polygon' ? 'polygon' : 'line', points: [], modes: [], mode: 'line' };
        open.set(key, s);
      }
      if (actions.includes('arcStart')) s.mode = 'arc';
      if (actions.includes('smoothStart')) s.mode = 'smooth';
      s.points.push(p);
      s.modes.push(s.mode);
      if (actions.includes('arcEnd') || actions.includes('smoothEnd')) s.mode = 'line';
      if (actions.includes('close')) finish(key, true);
      else if (actions.includes('end')) finish(key);
    }
    styled.push({ ...p, feature, color: color ?? '#5b6875', isPointFeature: isPoint });
  }
  for (const key of [...open.keys()]) finish(key);

  // Lines and arcs keyed in or computed in the job.
  const byName = new Map(points.map((p) => [p.name, p]));
  for (const l of jobLines) {
    const a = byName.get(l.start);
    const b = l.end ? byName.get(l.end) : undefined;
    if (!a || !b) continue;
    const va: V3 = [a.x, a.y, a.z];
    const vb: V3 = [b.x, b.y, b.z];
    let coords: V3[] = [va, vb];
    if (l.kind === 'arc') {
      const via = l.through ? byName.get(l.through) : undefined;
      const centre = l.center ? byName.get(l.center) : undefined;
      if (via) coords = arcThrough(va, [via.x, via.y, via.z], vb) ?? coords;
      else if (centre) coords = arcByRadius(va, vb, Math.hypot(a.x - centre.x, a.y - centre.y), l.clockwise ?? true) ?? coords;
      else if (l.radius) coords = arcByRadius(va, vb, l.radius, l.clockwise ?? true) ?? coords;
    }
    const code = l.code.split(/\s+/)[0] || l.name || 'Line';
    const found = lookup(code, library);
    strings.push({ code, key: `job:${l.name}`, color: found?.def.color ?? colorFor(code), closed: false, kind: 'line', points: [l.start, l.end as string], coords });
  }

  return { points: styled, strings, unknownCodes: [...unknown].sort() };
}

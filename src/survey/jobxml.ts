import { child, children, elements, localName, num, parseXml, text } from './xml';

/** One attribute recorded against a feature code on a point. */
export interface SurveyAttribute {
  name: string;
  value: string;
}

/** A surveyed point, at its best position (model/project coordinates in metres). */
export interface SurveyPoint {
  name: string;
  /** The code field exactly as recorded, which can hold several codes and control codes */
  code: string;
  description?: string;
  /** Attributes by feature code */
  features: { code: string; attributes: SurveyAttribute[] }[];
  x: number;
  y: number;
  /** Null when the point has no elevation (a 2D point) */
  z: number | null;
  /** Position in the order the points were measured, used to join linework */
  order: number;
  classification?: string;
  method?: string;
  timestamp?: string;
}

/** A line or arc recorded in the job itself (from Cogo or keyed in), between named points. */
export interface JobLine {
  name: string;
  code: string;
  kind: 'line' | 'arc';
  start: string;
  end?: string;
  /** For arcs */
  radius?: number;
  clockwise?: boolean;
  center?: string;
  through?: string;
}

export interface JobXml {
  jobName: string;
  points: SurveyPoint[];
  lines: JobLine[];
  /** The feature library file the job was coded with, e.g. "UM.fxl" */
  libraryFile?: string;
  libraryName?: string;
  /** The job's coordinate system, as named in the file */
  coordinateSystem?: string;
  /** Points left out: deleted, or without a usable position */
  skipped: number;
}

interface Position {
  x: number;
  y: number;
  z: number | null;
}

/** North/East/Elevation of a grid position element, or null when it has no horizontal position. */
function gridOf(el: Element | undefined): Position | null {
  if (!el) return null;
  const n = num(el, 'North');
  const e = num(el, 'East');
  if (n === undefined || e === undefined) return null;
  return { x: e, y: n, z: num(el, 'Elevation') ?? null };
}

const isTrue = (v: string | undefined) => v?.toLowerCase() === 'true';

function featuresOf(el: Element | undefined): SurveyPoint['features'] {
  return children(child(el, 'Features'), 'Feature').map((f) => ({
    code: f.getAttribute('Name') ?? '',
    attributes: children(f, 'Attribute').flatMap((a) => {
      const name = text(a, 'Name');
      return name ? [{ name, value: text(a, 'Value') ?? '' }] : [];
    }),
  }));
}

/**
 * Reads a Trimble JobXML file (.jxl). Each point takes its best position from the Reductions section (the
 * position the controller would use), falling back to the grid position recorded with the point. Deleted points
 * are left out. `toGrid` turns WGS84 latitude/longitude into project easting/northing, for points that only
 * have a WGS84 position.
 */
export function parseJobXml(source: string, toGrid?: (lon: number, lat: number) => [number, number] | null): JobXml {
  const doc = parseXml(source);
  const root = doc.documentElement;
  if (localName(root) !== 'jobfile') throw new Error(`not a JobXML file (it starts with <${root.nodeName}>)`);
  const fieldBook = child(root, 'FieldBook');
  const reductions = child(root, 'Reductions');

  const fromWgs = (el: Element | undefined): Position | null => {
    const w = child(el, 'WGS84');
    const lat = num(w, 'Latitude');
    const lon = num(w, 'Longitude');
    if (!toGrid || lat === undefined || lon === undefined) return null;
    const g = toGrid(lon, lat);
    return g ? { x: g[0], y: g[1], z: num(w, 'Height') ?? null } : null;
  };

  // The last non-deleted record of each point name: its code, attributes and when it was measured.
  const records = new Map<string, { el: Element; order: number }>();
  const deleted = new Set<string>();
  let order = 0;
  let libraryFile: string | undefined;
  let libraryName: string | undefined;
  let coordinateSystem: string | undefined;
  const lines: JobLine[] = [];
  for (const el of fieldBook ? elements(fieldBook) : []) {
    const kind = localName(el);
    if (kind === 'pointrecord') {
      const name = text(el, 'Name');
      if (!name) continue;
      if (isTrue(text(el, 'Deleted'))) {
        deleted.add(name);
        continue;
      }
      deleted.delete(name);
      records.set(name, { el, order: order++ });
    } else if (kind === 'featurecodingrecord') {
      libraryFile = text(el, 'SourceFilename') ?? libraryFile;
      libraryName = text(el, 'LibraryName') ?? libraryName;
    } else if (kind === 'coordinatesystemrecord') {
      coordinateSystem = [text(el, 'SystemName'), text(el, 'ZoneName')].filter(Boolean).join(' / ') || coordinateSystem;
    } else if ((kind === 'linerecord' || kind === 'arcrecord') && !isTrue(text(el, 'Deleted'))) {
      const start = text(el, 'StartPoint');
      if (!start) continue;
      lines.push({
        name: text(el, 'Name') ?? '',
        code: text(el, 'Code') ?? '',
        kind: kind === 'arcrecord' ? 'arc' : 'line',
        start,
        end: text(el, 'EndPoint'),
        radius: num(el, 'Radius'),
        clockwise: /^clock/i.test(text(el, 'Direction') ?? '') ? true : /anti|counter/i.test(text(el, 'Direction') ?? '') ? false : undefined,
        center: text(el, 'CenterPoint'),
        through: text(el, 'OtherPointOnArc'),
      });
    }
  }

  const points = new Map<string, SurveyPoint>();
  let skipped = deleted.size;
  const add = (name: string, best: Element | undefined, record: { el: Element; order: number } | undefined) => {
    const pos = gridOf(child(best, 'Grid')) ?? gridOf(child(record?.el, 'Grid')) ?? gridOf(child(record?.el, 'ComputedGrid')) ?? fromWgs(best) ?? fromWgs(record?.el);
    if (!pos) {
      skipped++;
      return;
    }
    const src = record?.el ?? best;
    const features = featuresOf(record?.el);
    points.set(name, {
      name,
      code: text(src, 'Code') ?? text(best, 'Code') ?? '',
      description: [text(src, 'Description1') ?? text(best, 'Description1'), text(src, 'Description2') ?? text(best, 'Description2')].filter(Boolean).join(' · ') || undefined,
      features: features.length ? features : featuresOf(best),
      ...pos,
      order: record?.order ?? order++,
      classification: text(src, 'Classification'),
      method: text(src, 'SurveyMethod') ?? text(src, 'Method'),
      timestamp: record?.el.getAttribute('TimeStamp') ?? undefined,
    });
  };

  for (const p of reductions ? children(reductions, 'Point') : []) {
    const name = text(p, 'Name');
    if (!name || deleted.has(name) || points.has(name)) continue;
    add(name, p, records.get(name));
  }
  // Points recorded in the field book that the Reductions section left out (or files without one).
  for (const [name, record] of records) if (!points.has(name)) add(name, undefined, record);

  return {
    jobName: root.getAttribute('jobName') ?? 'Job',
    points: [...points.values()].sort((a, b) => a.order - b.order),
    lines,
    libraryFile,
    libraryName,
    coordinateSystem,
    skipped,
  };
}

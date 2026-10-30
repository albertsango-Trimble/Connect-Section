import { field, localName, parseXml, walk } from './xml';

export type FeatureKind = 'point' | 'line' | 'polygon';

/** What a control code does to the line of the feature code it follows. */
export type ControlAction =
  | 'start'
  | 'end'
  | 'close'
  | 'arcStart'
  | 'arcEnd'
  | 'smoothStart'
  | 'smoothEnd'
  | 'unknown';

export interface FeatureDefinition {
  code: string;
  kind: FeatureKind;
  description?: string;
  layer?: string;
  /** CSS colour */
  color?: string;
  lineStyle?: string;
}

export interface FeatureLibrary {
  name: string;
  features: Map<string, FeatureDefinition>;
  controls: Map<string, { code: string; action: ControlAction; description?: string }>;
  /** Layer colours, for features coloured "by layer" */
  layers: Map<string, string>;
  /** Element names that looked like definitions but weren't understood, for checking against real files */
  unread: string[];
}

const NAMED: Record<string, string> = {
  red: '#e53935', green: '#2e7d32', blue: '#1e63c6', yellow: '#f9c80e', cyan: '#00acc1', magenta: '#c2185b',
  white: '#ffffff', black: '#000000', orange: '#ef6c00', brown: '#795548', grey: '#757575', gray: '#757575',
};

/** The AutoCAD colour index palette's first entries, which libraries made from CAD standards often use. */
const ACI = ['#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ffffff', '#808080', '#c0c0c0'];

/**
 * Reads a colour written in any of the ways libraries use: "#RRGGBB", "RRGGBB", "#AARRGGBB", "r,g,b", a colour
 * name, a small AutoCAD colour index, or a Windows colour number (0x00BBGGRR). "ByLayer" and the like give null.
 */
export function parseColor(raw: string | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^by\s*(layer|block)$/i.test(v)) return null;
  if (NAMED[v.toLowerCase()]) return NAMED[v.toLowerCase()];
  let m = v.match(/^#?([0-9a-f]{6})$/i);
  if (m) return `#${m[1].toLowerCase()}`;
  m = v.match(/^#?[0-9a-f]{2}([0-9a-f]{6})$/i);
  if (m) return `#${m[1].toLowerCase()}`;
  m = v.match(/^(\d{1,3})\s*[,; ]\s*(\d{1,3})\s*[,; ]\s*(\d{1,3})/);
  if (m) return `#${[m[1], m[2], m[3]].map((c) => Math.min(255, Number(c)).toString(16).padStart(2, '0')).join('')}`;
  if (/^-?\d+$/.test(v)) {
    const n = Number(v);
    if (n >= 0 && n < ACI.length) return ACI[n];
    // Windows COLORREF (0x00BBGGRR); a negative number is a signed ARGB value
    const u = n < 0 ? n >>> 0 : n;
    const r = n < 0 ? (u >> 16) & 255 : u & 255;
    const g = (u >> 8) & 255;
    const b = n < 0 ? u & 255 : (u >> 16) & 255;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

/** Works out a control code's action from however the library words it. */
export function controlAction(words: string): ControlAction {
  const w = words.toLowerCase().replace(/[_-]/g, ' ');
  const isStart = /start|begin/.test(w);
  const isEnd = /\bend\b|stop|finish|endjoin|end join/.test(w) || /end(join|line|arc|curve|smooth|sequence)/.test(w.replace(/\s/g, ''));
  if (/close/.test(w)) return 'close';
  if (/arc|curve/.test(w) && !/smooth/.test(w)) return isEnd ? 'arcEnd' : isStart ? 'arcStart' : 'unknown';
  if (/smooth|spline/.test(w)) return isEnd ? 'smoothEnd' : isStart ? 'smoothStart' : 'unknown';
  if (isEnd) return 'end';
  if (isStart || /new line|new string/.test(w)) return 'start';
  return 'unknown';
}

const kindOf = (tag: string, type: string | undefined): FeatureKind | 'control' | null => {
  const t = `${tag} ${type ?? ''}`.toLowerCase();
  if (/control/.test(t)) return 'control';
  if (/polygon|area/.test(t)) return 'polygon';
  if (/line|string|polyline/.test(t)) return 'line';
  if (/point|symbol/.test(t)) return 'point';
  return null;
};

/**
 * Reads a Trimble feature library (.fxl, made in Trimble Business Center's Feature Definition Manager). The
 * format isn't published, so this looks through every element for anything with a code: its element name or
 * type says whether it is a point, line or polygon feature or a control code, and its colour and layer are read
 * from attributes or child elements, whichever the file uses.
 */
export function parseFxl(source: string, fileName = 'Feature library'): FeatureLibrary {
  const doc = parseXml(source);
  const lib: FeatureLibrary = { name: fileName.replace(/\.fxl$/i, ''), features: new Map(), controls: new Map(), layers: new Map(), unread: [] };
  const all = [...walk(doc.documentElement)];

  for (const el of all) {
    const tag = localName(el);
    if (!/layer/.test(tag)) continue;
    const name = field(el, 'Name', 'LayerName');
    const color = parseColor(field(el, 'Color', 'Colour', 'LineColor'));
    if (name && color) lib.layers.set(name, color);
  }

  for (const el of all) {
    const tag = localName(el);
    if (/layer|attribute/.test(tag) || (/library$|definitions$|list$|collection$/.test(tag) && !/definition$/.test(tag))) continue;
    const code = field(el, 'Code', 'FeatureCode', 'Name');
    if (!code || /\s/.test(code) || !/definition|feature|code/.test(tag)) continue;
    // A Name-only element is only taken as a feature when the element name says it is one.
    if (!field(el, 'Code', 'FeatureCode') && !/definition/.test(tag)) continue;
    const type = field(el, 'Type', 'FeatureType', 'Geometry', 'GeometryType', 'ControlCodeType', 'Action', 'Function');
    const kind = kindOf(tag, type);
    const description = field(el, 'Description', 'Desc');
    if (kind === 'control') {
      lib.controls.set(code.toUpperCase(), { code, action: controlAction(`${type ?? ''} ${field(el, 'Action', 'Function', 'ControlCodeType') ?? ''} ${description ?? ''}`), description });
      continue;
    }
    if (!kind) {
      if (!lib.unread.includes(tag)) lib.unread.push(tag);
      continue;
    }
    const layer = field(el, 'Layer', 'LayerName');
    const color = parseColor(field(el, 'Color', 'Colour', 'LineColor', 'SymbolColor')) ?? (layer ? lib.layers.get(layer) : undefined);
    lib.features.set(code.toUpperCase(), { code, kind, description, layer, color: color ?? undefined, lineStyle: field(el, 'LineStyle', 'LineType') });
  }
  if (lib.unread.length) console.info('[section viewer] feature library elements not understood', lib.name, lib.unread);
  return lib;
}

/** Control codes Trimble Access libraries commonly use, for jobs with no library. */
export const DEFAULT_CONTROLS: FeatureLibrary['controls'] = new Map(
  (
    [
      ['ST', 'start'], ['SL', 'start'], ['BL', 'start'], ['B', 'start'], ['S', 'start'],
      ['END', 'end'], ['EL', 'end'], ['E', 'end'],
      ['CL', 'close'], ['CLO', 'close'], ['CLS', 'close'], ['C', 'close'],
      ['BA', 'arcStart'], ['SA', 'arcStart'], ['STA', 'arcStart'], ['EA', 'arcEnd'], ['ENA', 'arcEnd'],
      ['SS', 'smoothStart'], ['ES', 'smoothEnd'],
    ] as [string, ControlAction][]
  ).map(([code, action]) => [code, { code, action }]),
);

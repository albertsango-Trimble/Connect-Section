import { computeSection, type Element, type Section, type XY } from '../core/section';

type Listener = () => void;

/** A reference to one object in one model. */
export interface ObjectRef {
  modelId: string;
  id: number;
}

export const sameRef = (a: ObjectRef | null | undefined, b: ObjectRef | null | undefined) => !!a && !!b && a.modelId === b.modelId && a.id === b.id;
export const refKey = (r: ObjectRef) => `${r.modelId}:${r.id}`;

const SIDE_KEY = 'connectsection.side';
const ISOLATE_KEY = 'connectsection.isolate';
const ORTHO_KEY = 'connectsection.ortho';

const read = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
};

/** Everything the map and 3D panes share. */
class Store {
  /** Every object in the loaded models with its bounding box */
  elements: Element[] = [];
  /** Incremented whenever `elements` is replaced */
  elementsVersion = 0;
  /** Names of objects, filled in as they are looked up */
  names = new Map<string, string>();

  /** The section line as drawn, in model coordinates */
  line: [XY, XY] | null = null;
  side: 1 | -1 = read(SIDE_KEY, '1') === '-1' ? -1 : 1;
  /** A depth typed in by the person; null takes it from the crossed elements */
  depth: number | null = null;
  /** Hide everything the line doesn't cross */
  isolate = read(ISOLATE_KEY, '0') === '1';
  /** Look at the cut with an orthographic camera */
  ortho = read(ORTHO_KEY, '0') === '1';
  section: Section | null = null;
  /** Incremented whenever the section changes */
  sectionVersion = 0;

  /** The object under the mouse in the map */
  mapHover: ObjectRef | null = null;
  /** Objects selected or picked in the 3D view */
  modelSelection: ObjectRef[] = [];
  /** The last point picked in the 3D view (model coordinates) */
  modelPick: { x: number; y: number; z: number } | null = null;
  /** Where the 3D camera is and which way it looks (model coordinates) */
  camera: { x: number; y: number; z: number; heading: number } | null = null;

  status = '';
  busy = false;

  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  setElements(elements: Element[]): void {
    this.elements = elements;
    this.elementsVersion++;
    this.recompute();
  }

  setLine(line: [XY, XY] | null): void {
    this.line = line;
    this.recompute();
  }

  /** Puts back a whole section at once: its line, the side it is seen from and its depth (null for automatic). */
  restoreSection(line: [XY, XY], side: 1 | -1, depth: number | null): void {
    this.side = side;
    write(SIDE_KEY, String(side));
    this.depth = depth !== null && Number.isFinite(depth) && depth > 0 ? depth : null;
    this.line = line;
    this.recompute();
  }

  flipSide(): void {
    this.side = this.side === 1 ? -1 : 1;
    write(SIDE_KEY, String(this.side));
    this.recompute();
  }

  setDepth(depth: number | null): void {
    this.depth = depth !== null && Number.isFinite(depth) && depth > 0 ? depth : null;
    this.recompute();
  }

  setIsolate(on: boolean): void {
    this.isolate = on;
    write(ISOLATE_KEY, on ? '1' : '0');
    this.sectionVersion++;
    this.emit();
  }

  setOrtho(on: boolean): void {
    this.ortho = on;
    write(ORTHO_KEY, on ? '1' : '0');
    this.sectionVersion++;
    this.emit();
  }

  private recompute(): void {
    this.section = this.line ? computeSection(this.line[0], this.line[1], this.elements, { side: this.side, depth: this.depth ?? undefined }) : null;
    this.sectionVersion++;
    this.emit();
  }

  setMapHover(ref: ObjectRef | null): void {
    if (sameRef(ref, this.mapHover) || (!ref && !this.mapHover)) return;
    this.mapHover = ref;
    this.emit();
  }

  setModelSelection(refs: ObjectRef[]): void {
    this.modelSelection = refs;
    this.emit();
  }

  setModelPick(p: { x: number; y: number; z: number } | null): void {
    this.modelPick = p;
    this.emit();
  }

  setCamera(c: Store['camera']): void {
    this.camera = c;
    this.emit();
  }

  setName(ref: ObjectRef, name: string): void {
    this.names.set(refKey(ref), name);
    this.emit();
  }

  setStatus(text: string, busy = false): void {
    this.status = text;
    this.busy = busy;
    this.emit();
  }
}

export const store = new Store();

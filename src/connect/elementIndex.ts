import type { Element } from '../core/section';
import type { WorkspaceApi } from './workspace';

/** Most objects read across all models. Past this, the rest of the objects aren't used for crossing or hovering. */
const MAX_OBJECTS = 200000;
/** Objects per bounding box request */
const CHUNK = 1000;

/** A model loaded in the 3D viewer. */
export interface IndexedModel {
  /** The id its objects are known by in the viewer (the file id or the version id) */
  id: string;
  /** The Connect file id and version id */
  fileId: string;
  versionId?: string;
  name: string;
  objects: number;
}

export interface IndexResult {
  elements: Element[];
  models: IndexedModel[];
  /** True when there were more objects than MAX_OBJECTS */
  partial: boolean;
}

/**
 * Pulls object runtime ids out of whatever `getObjects` returned. The published types say each entry has an
 * `objects` list of `{ id }`, but be lenient: also accept `objectRuntimeIds`, and plain numbers.
 */
export function runtimeIds(groups: unknown, modelId?: string): { modelId: string; id: number }[] {
  if (!Array.isArray(groups)) return [];
  const out: { modelId: string; id: number }[] = [];
  for (const group of groups) {
    const g = (group ?? {}) as { modelId?: string; objects?: unknown; objectRuntimeIds?: unknown };
    if (modelId !== undefined && g.modelId !== undefined && g.modelId !== modelId) continue;
    const owner = g.modelId ?? modelId;
    if (!owner) continue;
    const list = Array.isArray(g.objects) ? g.objects : Array.isArray(g.objectRuntimeIds) ? g.objectRuntimeIds : [];
    for (const item of list) {
      const id = typeof item === 'number' ? item : (item as { id?: unknown } | null)?.id;
      if (typeof id === 'number' && Number.isFinite(id)) out.push({ modelId: owner, id });
    }
  }
  return out;
}

const isPointCloud = (type: string | undefined, name: string) => /point|cloud|e57|\blas\b|\blaz\b|potree|tileset|reality/i.test(type ?? '') || /\.(las|laz|e57|ptx)$/i.test(name);

/**
 * Reads every object of every model loaded in the 3D viewer with its bounding box. These boxes are what the
 * section line is tested against, and what is drawn on the map for hovering.
 */
export async function readElements(api: WorkspaceApi, progress: (text: string) => void): Promise<IndexResult> {
  const loaded = await api.viewer.getModels('loaded');
  const elements: Element[] = [];
  const models: IndexResult['models'] = [];
  let partial = false;

  for (const model of loaded) {
    if (isPointCloud(model.type, model.name)) continue;
    if (elements.length >= MAX_OBJECTS) {
      partial = true;
      break;
    }
    progress(`Reading ${model.name}…`);
    let ids: number[] = [];
    let modelId = model.id;
    // The viewer identifies a model by id or version id depending on how it was loaded, so try both.
    for (const candidate of [model.id, model.versionId].filter(Boolean)) {
      for (const selector of [{ modelObjectIds: [{ modelId: candidate }] }, { modelObjectIds: [{ modelId: candidate, recursive: true }] }]) {
        try {
          ids = runtimeIds(await api.viewer.getObjects(selector), candidate).map((r) => r.id);
        } catch {
          ids = [];
        }
        if (ids.length) break;
      }
      if (ids.length) {
        modelId = candidate;
        break;
      }
    }
    ids = [...new Set(ids)];
    const room = MAX_OBJECTS - elements.length;
    if (ids.length > room) {
      partial = true;
      ids = ids.slice(0, room);
    }
    let count = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (ids.length > CHUNK) progress(`Reading ${model.name}… ${Math.round((i / ids.length) * 100)}%`);
      let boxes: unknown;
      try {
        boxes = await api.viewer.getObjectBoundingBoxes(modelId, ids.slice(i, i + CHUNK));
      } catch (err) {
        console.warn('[section viewer] could not read bounding boxes', model.name, err);
        continue;
      }
      if (!Array.isArray(boxes)) continue;
      for (const entry of boxes) {
        const e = entry as { id?: number; boundingBox?: { min?: { x: number; y: number; z?: number }; max?: { x: number; y: number; z?: number } } } | null;
        const b = e?.boundingBox;
        if (typeof e?.id !== 'number' || !b?.min || !b.max) continue;
        const v = [b.min.x, b.min.y, b.max.x, b.max.y];
        if (!v.every(Number.isFinite)) continue;
        const z0 = Number.isFinite(b.min.z) ? (b.min.z as number) : 0;
        const z1 = Number.isFinite(b.max.z) ? (b.max.z as number) : z0;
        elements.push({ modelId, id: e.id, min: [b.min.x, b.min.y, z0], max: [b.max.x, b.max.y, z1] });
        count++;
      }
    }
    models.push({ id: modelId, fileId: model.id, versionId: model.versionId, name: model.name, objects: count });
  }
  return { elements, models, partial };
}

/** The name of an object for tooltips: its product name, class or id. */
export async function objectName(api: WorkspaceApi, modelId: string, id: number): Promise<string> {
  try {
    const [props] = await api.viewer.getObjectProperties(modelId, [id]);
    const product = props?.product as { name?: string; objectType?: string } | undefined;
    const fromSets = props?.properties
      ?.flatMap((set) => set.properties ?? [])
      .find((p) => /^name$/i.test(p.name) && typeof p.value === 'string' && p.value)?.value as string | undefined;
    return product?.name || fromSets || props?.class || `Object ${id}`;
  } catch {
    return `Object ${id}`;
  }
}

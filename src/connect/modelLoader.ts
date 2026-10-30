import type { ProjectFiles, ProjectItem } from './projectFiles';
import type { WorkspaceApi } from './workspace';

/** File types the Connect 3D viewer opens as models with objects (point clouds and drawings are left out). */
const MODEL_FILE = /\.(ifc|ifczip|ifcxml|trb|rvt|dwg|dxf|skp|dgn|nwd|nwc|tekla|obj|fbx|stl|3ds|dae|glb|gltf)$/i;
/** Folders looked through at most, so a huge project doesn't stall the start. */
const MAX_FOLDERS = 400;

export interface ProjectModel {
  id: string;
  versionId?: string;
  name: string;
  /** Folder path, e.g. "Models / Structural" */
  folder: string;
}

const EXCLUDED_KEY = 'connectsection.excludedModels';

/** Models the person has unticked in this project, so they aren't loaded again next time. */
export function excludedModels(projectId: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? '{}') as Record<string, string[]>;
    return new Set(all[projectId] ?? []);
  } catch {
    return new Set();
  }
}

export function saveExcluded(projectId: string, ids: Set<string>): void {
  try {
    const all = JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? '{}') as Record<string, string[]>;
    all[projectId] = [...ids];
    localStorage.setItem(EXCLUDED_KEY, JSON.stringify(all));
  } catch {
    // Not critical.
  }
}

/** Every model file in the project, found by walking its folders. */
export async function findProjectModels(files: ProjectFiles, progress?: (text: string) => void): Promise<ProjectModel[]> {
  const root = await files.root();
  const queue: { id: string; path: string }[] = [{ id: root.id, path: '' }];
  const found: ProjectModel[] = [];
  let visited = 0;
  while (queue.length && visited < MAX_FOLDERS) {
    const folder = queue.shift() as { id: string; path: string };
    visited++;
    progress?.(`Looking for models… (${visited} folders)`);
    let items: ProjectItem[];
    try {
      items = await files.list(folder.id);
    } catch (err) {
      console.warn('[section viewer] could not list a folder', folder.path, err);
      continue;
    }
    for (const item of items) {
      if (item.isFolder) queue.push({ id: item.id, path: folder.path ? `${folder.path} / ${item.name}` : item.name });
      else if (MODEL_FILE.test(item.name)) found.push({ id: item.id, versionId: item.versionId, name: item.name, folder: folder.path || 'Project' });
    }
  }
  return found.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Loads models into the 3D viewer, skipping any that are already loaded. */
export async function loadModels(api: WorkspaceApi, models: ProjectModel[]): Promise<void> {
  if (!models.length) return;
  const loaded = await api.viewer.getModels('loaded').catch(() => []);
  const have = new Set(loaded.flatMap((m) => [m.id, m.versionId]));
  const wanted = models.filter((m) => !have.has(m.id) && !(m.versionId && have.has(m.versionId)));
  if (!wanted.length) return;
  try {
    await api.viewer.toggleModelVersion(
      wanted.map((m) => ({ id: m.id, versionId: m.versionId })),
      true,
      false,
    );
  } catch (err) {
    // Older viewers only take model ids.
    console.warn('[section viewer] toggleModelVersion failed, trying toggleModel', err);
    await api.viewer.toggleModel(
      wanted.map((m) => m.id),
      true,
      false,
    );
  }
}

/** Takes models out of the 3D viewer. */
export async function unloadModels(api: WorkspaceApi, models: ProjectModel[]): Promise<void> {
  if (!models.length) return;
  const loaded = await api.viewer.getModels('loaded').catch(() => []);
  const ids = new Set(models.flatMap((m) => [m.id, m.versionId]));
  const hit = loaded.filter((m) => ids.has(m.id) || ids.has(m.versionId));
  if (hit.length) await api.viewer.toggleModel(hit.map((m) => m.id), false, false);
}

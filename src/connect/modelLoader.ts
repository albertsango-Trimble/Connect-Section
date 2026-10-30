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

/** A file found in the project, with the folder it is in. */
export interface ProjectFile extends ProjectItem {
  folder: string;
}

export interface ProjectScan {
  models: ProjectModel[];
  /** Trimble JobXML files (.jxl) */
  jobs: ProjectFile[];
  /** Trimble feature libraries (.fxl) */
  libraries: ProjectFile[];
}

const JOBXML_FILE = /\.jxl$/i;
const FXL_FILE = /\.fxl$/i;

/** Walks the project's folders once and collects its models, JobXML files and feature libraries. */
export async function scanProject(files: ProjectFiles, progress?: (text: string) => void): Promise<ProjectScan> {
  const root = await files.root();
  const queue: { id: string; path: string }[] = [{ id: root.id, path: '' }];
  const scan: ProjectScan = { models: [], jobs: [], libraries: [] };
  let visited = 0;
  while (queue.length && visited < MAX_FOLDERS) {
    const folder = queue.shift() as { id: string; path: string };
    visited++;
    progress?.(`Looking through the project… (${visited} folders)`);
    let items: ProjectItem[];
    try {
      items = await files.list(folder.id);
    } catch (err) {
      console.warn('[section viewer] could not list a folder', folder.path, err);
      continue;
    }
    const where = folder.path || 'Project';
    for (const item of items) {
      if (item.isFolder) queue.push({ id: item.id, path: folder.path ? `${folder.path} / ${item.name}` : item.name });
      else if (MODEL_FILE.test(item.name)) scan.models.push({ id: item.id, versionId: item.versionId, name: item.name, folder: where });
      else if (JOBXML_FILE.test(item.name)) scan.jobs.push({ ...item, folder: where });
      else if (FXL_FILE.test(item.name)) scan.libraries.push({ ...item, folder: where });
    }
  }
  const byPlace = (a: { folder: string; name: string }, b: { folder: string; name: string }) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name, undefined, { numeric: true });
  scan.models.sort(byPlace);
  scan.jobs.sort(byPlace);
  scan.libraries.sort(byPlace);
  return scan;
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

import type { ProjectFile } from '../connect/modelLoader';
import type { ProjectFiles } from '../connect/projectFiles';
import { toProject } from '../core/geo';
import { surveyStore } from '../state/survey';
import { parseFxl } from '../survey/fxl';
import { parseJobXml } from '../survey/jobxml';

const SHOWN_KEY = 'connectsection.surveyJobs';
const LIBRARY_KEY = 'connectsection.featureLibrary';
const SHOW3D_KEY = 'connectsection.survey3d';

type Saved = Record<string, string[]>;
const readSaved = (key: string): Saved => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Saved;
  } catch {
    return {};
  }
};
const writeSaved = (key: string, all: Saved) => {
  try {
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // Not critical.
  }
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]) {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props as Record<string, unknown>;
  if (cls) el.className = String(cls);
  Object.assign(el, rest);
  el.append(...kids);
  return el;
}

export interface SurveyPanel {
  /** Tells the panel which project is open and the JobXML files and feature libraries found in it */
  setProject(projectId: string, files: ProjectFiles, jobs: ProjectFile[], libraries: ProjectFile[]): Promise<void>;
}

/**
 * The Survey button and panel: choose which JobXML files from the project (or this computer) are shown, and which
 * feature library draws their codes. The project's own library is used automatically: the one the job was coded
 * with if it's in the project, otherwise the project's only one. Choices are remembered per project.
 */
export function createSurveyPanel(button: HTMLElement, after: { zoom: () => void; status: (text: string) => void }): SurveyPanel {
  let projectId = 'local';
  let files: ProjectFiles | null = null;
  let jobs: ProjectFile[] = [];
  let libraries: ProjectFile[] = [];
  /** The library the person picked: a project file id, "none", or "" for automatic */
  let libraryChoice = '';
  const loading = new Set<string>();
  const failed = new Map<string, string>();

  try {
    surveyStore.setShow3d(localStorage.getItem(SHOW3D_KEY) !== '0');
  } catch {
    // storage unavailable
  }

  const panel = h('aside', { class: 'models-panel survey-panel' });
  panel.hidden = true;
  document.body.append(panel);
  button.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    button.classList.toggle('active', !panel.hidden);
    if (!panel.hidden) render();
  });

  const shownIds = () => new Set(readSaved(SHOWN_KEY)[projectId] ?? []);
  const saveShown = () => {
    const all = readSaved(SHOWN_KEY);
    all[projectId] = surveyStore.jobs.filter((j) => jobs.some((p) => p.id === j.id)).map((j) => j.id);
    writeSaved(SHOWN_KEY, all);
  };

  /** Picks the library: the person's choice, else the one the loaded jobs were coded with, else the only one. */
  const autoLibrary = (): ProjectFile | null => {
    if (libraryChoice === 'none') return null;
    if (libraryChoice) return libraries.find((l) => l.id === libraryChoice) ?? null;
    const wanted = surveyStore.jobs.map((j) => j.job.libraryFile?.toLowerCase()).filter(Boolean);
    return libraries.find((l) => wanted.includes(l.name.toLowerCase())) ?? (libraries.length === 1 ? libraries[0] : null);
  };

  let libraryLoadedFor = '';
  const applyLibrary = async () => {
    const pick = autoLibrary();
    const key = pick?.id ?? 'none';
    if (key === libraryLoadedFor) return;
    libraryLoadedFor = key;
    if (!pick || !files) {
      surveyStore.setLibrary(null, '');
      render();
      return;
    }
    try {
      const file = await files.download(pick);
      const lib = parseFxl(await file.text(), pick.name);
      surveyStore.setLibrary(lib, `${pick.name} (${pick.folder})`);
    } catch (err) {
      libraryLoadedFor = '';
      console.warn('[section viewer] could not read the feature library', pick.name, err);
      surveyStore.setLibrary(null, `Could not read ${pick.name}`);
    }
    render();
  };

  const loadJob = async (id: string, name: string, read: () => Promise<string>) => {
    loading.add(id);
    failed.delete(id);
    render();
    try {
      const job = parseJobXml(await read(), (lon, lat) => toProject(lon, lat));
      if (!job.points.length) throw new Error('it has no points with a position');
      const first = surveyStore.jobs.length === 0;
      surveyStore.addJob(id, name, job);
      if (first) after.zoom();
      await applyLibrary();
    } catch (err) {
      failed.set(id, err instanceof Error ? err.message : String(err));
      console.warn('[section viewer] could not read the JobXML file', name, err);
    } finally {
      loading.delete(id);
      render();
    }
  };

  const loadProjectJob = (f: ProjectFile) => {
    if (!files) return;
    const project = files;
    return loadJob(f.id, f.name, async () => (await project.download(f)).text());
  };

  const addLocal = () => {
    const input = h('input', { type: 'file', accept: '.jxl,.xml', multiple: true });
    input.addEventListener('change', () => {
      for (const file of Array.from(input.files ?? [])) void loadJob(`local:${file.name}:${file.size}`, file.name, () => file.text());
    });
    input.click();
  };

  const addLocalLibrary = () => {
    const input = h('input', { type: 'file', accept: '.fxl,.xml' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        surveyStore.setLibrary(parseFxl(await file.text(), file.name), `${file.name} (this computer, this visit only)`);
        libraryLoadedFor = `local:${file.name}`;
      } catch (err) {
        surveyStore.setLibrary(null, `Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      render();
    });
    input.click();
  };

  function render() {
    if (panel.hidden) return;
    const close = h('button', { type: 'button', class: 'source-close', title: 'Close', textContent: '×' });
    close.addEventListener('click', () => {
      panel.hidden = true;
      button.classList.remove('active');
    });

    // Feature library
    const lib = surveyStore.library;
    const select = h('select', { class: 'survey-select' });
    select.append(h('option', { value: '', textContent: 'Automatic' }), ...libraries.map((l) => h('option', { value: l.id, textContent: `${l.name} · ${l.folder}` })), h('option', { value: 'none', textContent: 'None (codes only)' }));
    select.value = libraryChoice;
    select.addEventListener('change', () => {
      libraryChoice = select.value;
      const all = readSaved(LIBRARY_KEY);
      all[projectId] = libraryChoice ? [libraryChoice] : [];
      writeSaved(LIBRARY_KEY, all);
      libraryLoadedFor = '';
      void applyLibrary();
    });
    const fromComputer = h('button', { type: 'button', textContent: 'From this computer…' });
    fromComputer.addEventListener('click', addLocalLibrary);
    const unknown = [...new Set(surveyStore.jobs.flatMap((j) => j.unknownCodes))];
    const libNote = lib
      ? `Using ${surveyStore.librarySource}: ${lib.features.size} feature codes, ${lib.controls.size} control codes.${unknown.length ? ` Not in the library: ${unknown.slice(0, 12).join(', ')}${unknown.length > 12 ? '…' : ''}` : ''}`
      : surveyStore.librarySource || (libraries.length ? 'No library chosen: codes are shown as points, with standard control codes for any lines.' : 'No feature library (.fxl) found in the project.');

    // Jobs
    const shown = new Set(surveyStore.jobs.map((j) => j.id));
    const rows: HTMLElement[] = [];
    let lastFolder = '';
    for (const f of jobs) {
      if (f.folder !== lastFolder) {
        lastFolder = f.folder;
        rows.push(h('div', { class: 'models-folder', textContent: f.folder }));
      }
      rows.push(jobRow(f.id, f.name, shown.has(f.id), () => void loadProjectJob(f)));
    }
    const local = surveyStore.jobs.filter((j) => !jobs.some((f) => f.id === j.id));
    if (local.length) {
      rows.push(h('div', { class: 'models-folder', textContent: 'From this computer (this visit only)' }));
      for (const j of local) rows.push(jobRow(j.id, j.fileName, true, () => undefined));
    }
    if (!rows.length) rows.push(h('div', { class: 'topics-note', textContent: files ? 'No JobXML (.jxl) files found in the project.' : 'JobXML files in the project are listed when the extension runs inside Trimble Connect.' }));

    const addBtn = h('button', { type: 'button', textContent: 'Add JobXML from this computer…' });
    addBtn.addEventListener('click', addLocal);
    const show3d = h('input', { type: 'checkbox', checked: surveyStore.show3d });
    show3d.addEventListener('change', () => {
      surveyStore.setShow3d(show3d.checked);
      try {
        localStorage.setItem(SHOW3D_KEY, show3d.checked ? '1' : '0');
      } catch {
        // storage unavailable
      }
    });

    panel.replaceChildren(
      h('div', { class: 'models-head' }, h('strong', { textContent: 'Survey data' }), close),
      h('div', { class: 'survey-section' }, h('span', { class: 'models-folder', textContent: 'Feature library' }), h('div', { class: 'models-actions' }, select, fromComputer), h('div', { class: 'models-note', textContent: libNote })),
      h('span', { class: 'models-folder', textContent: 'JobXML files' }),
      h('div', { class: 'models-list' }, ...rows),
      h('div', { class: 'models-actions' }, addBtn),
      h('label', { class: 'models-row' }, show3d, h('span', { textContent: 'Show in the 3D view (only what is inside the section, when one is drawn)' })),
    );
  }

  function jobRow(id: string, name: string, on: boolean, load: () => void): HTMLElement {
    const box = h('input', { type: 'checkbox', checked: on || loading.has(id), disabled: loading.has(id) });
    box.addEventListener('change', () => {
      if (box.checked) load();
      else {
        surveyStore.removeJob(id);
        void applyLibrary();
      }
      // Remembered once loading has finished, in the listener below.
      setTimeout(saveShown, 0);
    });
    const job = surveyStore.jobs.find((j) => j.id === id);
    const info = loading.has(id)
      ? 'Loading…'
      : failed.get(id)
        ? `Could not read: ${failed.get(id)}`
        : job
          ? `${job.points.length} points, ${job.strings.length} lines${job.job.skipped ? `, ${job.job.skipped} left out` : ''}${job.job.coordinateSystem ? ` · ${job.job.coordinateSystem}` : ''}`
          : '';
    const vis = job ? h('input', { type: 'checkbox', checked: job.visible, title: 'Show or hide' }) : null;
    vis?.addEventListener('change', () => surveyStore.setVisible(id, vis.checked));
    return h(
      'div',
      { class: 'survey-job' },
      h('label', { class: 'models-row' }, box, h('span', { textContent: name, title: name })),
      ...(info ? [h('div', { class: `models-note${failed.has(id) ? ' error' : ''}`, textContent: info })] : []),
    );
  }

  surveyStore.subscribe(() => {
    saveShown();
    render();
  });

  return {
    async setProject(id, projectFiles, found, libs) {
      projectId = id;
      files = projectFiles;
      jobs = found;
      libraries = libs;
      libraryChoice = readSaved(LIBRARY_KEY)[id]?.[0] ?? '';
      if (libraryChoice && libraryChoice !== 'none' && !libs.some((l) => l.id === libraryChoice)) libraryChoice = '';
      render();
      const wanted = jobs.filter((f) => shownIds().has(f.id));
      if (wanted.length) after.status(`Loading ${wanted.length} JobXML file${wanted.length === 1 ? '' : 's'}…`);
      for (const f of wanted) await loadProjectJob(f);
      await applyLibrary();
      if (wanted.length) {
        const n = surveyStore.jobs.reduce((sum, j) => sum + j.points.length, 0);
        after.status(`Survey: ${n.toLocaleString()} points from ${surveyStore.jobs.length} JobXML file${surveyStore.jobs.length === 1 ? '' : 's'}`);
      }
    },
  };
}

import { ProjectFiles } from './connect/projectFiles';
import { connectToHost, type WorkspaceApi } from './connect/workspace';
import { objectName, readElements } from './connect/elementIndex';
import { excludedModels, findProjectModels, loadModels, saveExcluded, unloadModels, type ProjectModel } from './connect/modelLoader';
import { initGeoreference, onGeoChange } from './core/geo';
import { updatePlacement } from './core/mapGeo';
import { RangeClient } from './core/geotiffTiles';
import { createMapPane } from './panes/mapPane';
import { createModelPane } from './panes/modelPane';
import { refKey, store } from './state/store';
import { TopicsApi } from './connect/topicsApi';
import { createTopicsPanel } from './ui/topicsPanel';
import { chooseSource } from './ui/sourceDialog';
import { initSplitter } from './ui/splitters';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let projectFiles: ProjectFiles | null = null;
let viewerApi: WorkspaceApi | null = null;

initSplitter(el('panes'), el('split-v'));

const mapPane = createMapPane(el('map'), {
  chooseGeoTiff: async () => {
    const choice = await chooseSource({
      title: 'Choose GeoTIFFs for the base map',
      accept: '.tif,.tiff,image/tiff',
      multiple: true,
      suits: (name) => /\.tiff?$/i.test(name),
      project: projectFiles,
    });
    if (!choice) return [];
    if ('files' in choice) return choice.files.map((file) => ({ file }));
    // Project files are read in place a piece at a time, never downloaded whole (they can be tens of GB).
    return projectFiles ? choice.project.map((item) => ({ item })) : [];
  },
  projectTiffClient: (item) => {
    const project = projectFiles;
    if (!project) return null;
    let cached: { url: string; at: number } | null = null;
    return new RangeClient(async (fresh) => {
      if (!fresh && cached && Date.now() - cached.at < 5 * 60_000) return cached.url;
      cached = { url: await project.downloadUrl(item), at: Date.now() };
      return cached.url;
    });
  },
  wantName: (ref) => {
    const key = refKey(ref);
    if (!viewerApi || naming.has(key)) return;
    naming.add(key);
    void objectName(viewerApi, ref.modelId, ref.id).then((name) => store.setName(ref, name));
  },
  selectInModel: (ref) => void modelPane.select(ref),
  drawingChanged: (on) => drawingChanged(on),
});
const naming = new Set<string>();

const modelPane = createModelPane(el('model'));

// ---- Topics: the same Connect topics as the 360 viewer, saved with the section ----
let topicsApi: TopicsApi | null = null;
let myEmail: string | undefined;
const topicsPanel = createTopicsPanel({
  button: el('btn-topics'),
  api: () => topicsApi,
  captureModel: () => modelPane.capture(),
  captureMap: () => mapPane.capture(),
  currentView: () => modelPane.currentView(),
  showSection: (sec) => {
    store.restoreSection([sec.a, sec.b], sec.side, sec.depth);
    mapPane.flyTo((sec.a[0] + sec.b[0]) / 2, (sec.a[1] + sec.b[1]) / 2);
  },
  showPlace: (x, y) => mapPane.flyTo(x, y),
  me: () => myEmail,
});

// ---- Toolbar ----
const drawBtn = el<HTMLButtonElement>('btn-draw');
const flipBtn = el<HTMLButtonElement>('btn-flip');
const clearBtn = el<HTMLButtonElement>('btn-clear');
const snapBtn = el<HTMLButtonElement>('btn-snap');
const depthAuto = el<HTMLInputElement>('depth-auto');
const depthNumber = el<HTMLInputElement>('depth-number');
const isolateBox = el<HTMLInputElement>('isolate');
const orthoBox = el<HTMLInputElement>('ortho');
const statusEl = el<HTMLSpanElement>('status');
const sectionInfo = el<HTMLSpanElement>('section-info');

drawBtn.addEventListener('click', () => mapPane.startDrawing());
const drawingChanged = (on: boolean) => {
  drawBtn.classList.toggle('active', on);
  drawBtn.textContent = on ? 'Cancel drawing' : 'Draw section';
};
flipBtn.addEventListener('click', () => store.flipSide());
clearBtn.addEventListener('click', () => store.setLine(null));
snapBtn.addEventListener('click', () => void modelPane.snapToSection());
el('btn-invert').addEventListener('click', () => modelPane.invertPlanes());
el('btn-fit').addEventListener('click', () => mapPane.fitModels());
el('reload-model').addEventListener('click', () => void modelPane.restart().catch((err) => console.error('Could not reload the 3D viewer', err)));
isolateBox.checked = store.isolate;
isolateBox.addEventListener('change', () => store.setIsolate(isolateBox.checked));
orthoBox.checked = store.ortho;
orthoBox.addEventListener('change', () => store.setOrtho(orthoBox.checked));
depthAuto.addEventListener('change', () => {
  depthNumber.disabled = depthAuto.checked;
  store.setDepth(depthAuto.checked ? null : Number(depthNumber.value));
});
depthNumber.addEventListener('change', () => {
  if (!depthAuto.checked) store.setDepth(Number(depthNumber.value));
});

const render = () => {
  const s = store.section;
  flipBtn.disabled = clearBtn.disabled = snapBtn.disabled = !s;
  depthAuto.checked = store.depth === null;
  depthNumber.disabled = store.depth === null;
  if (s && store.depth === null && document.activeElement !== depthNumber) depthNumber.value = s.depth.toFixed(1);
  if (!s) {
    sectionInfo.textContent = store.elements.length ? 'Draw a line on the map to cut a section' : '';
  } else {
    const n = s.crossed.length;
    const length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    sectionInfo.textContent = `${length.toFixed(1)} m line · cuts ${n} element${n === 1 ? '' : 's'} · ${s.depth.toFixed(1)} m deep · ${(s.zMax - s.zMin).toFixed(1)} m high`;
  }
  statusEl.textContent = store.status;
  statusEl.classList.toggle('busy', store.busy);
};
store.subscribe(render);
render();

// ---- The object index: every object's bounding box, read again when models are loaded or unloaded ----
let indexTimer: number | undefined;
let indexing = false;
let indexAgain = false;
const reindex = () => {
  window.clearTimeout(indexTimer);
  indexTimer = window.setTimeout(async () => {
    if (!viewerApi) return;
    if (indexing) {
      indexAgain = true;
      return;
    }
    indexing = true;
    try {
      do {
        indexAgain = false;
        const result = await readElements(viewerApi, (text) => store.setStatus(text, true));
        updatePlacement(result.elements[0]?.min[0]);
        store.setElements(result.elements);
        const total = result.elements.length;
        store.setStatus(
          result.models.length === 0
            ? 'No models loaded in the 3D view'
            : `${result.models.length} model${result.models.length === 1 ? '' : 's'}, ${total.toLocaleString()} objects${result.partial ? ' (only the first 200,000 are used)' : ''}`,
        );
      } while (indexAgain);
    } catch (err) {
      console.warn('[section viewer] could not read the models', err);
      store.setStatus('Could not read the models in the 3D view');
    } finally {
      indexing = false;
    }
  }, 800);
};
modelPane.onModelsChanged(reindex);
onGeoChange(() => updatePlacement(store.elements[0]?.min[0]));

// ---- Models panel: every model in the project, loaded automatically unless unticked ----
let projectModels: ProjectModel[] = [];
let currentProject = '';
const modelsPanel = el<HTMLDivElement>('models-panel');
const modelsList = el<HTMLDivElement>('models-list');
el('btn-models').addEventListener('click', () => {
  modelsPanel.hidden = !modelsPanel.hidden;
  if (!modelsPanel.hidden) renderModels();
});
el('models-close').addEventListener('click', () => (modelsPanel.hidden = true));
const setAll = (on: boolean) => {
  const excluded = on ? new Set<string>() : new Set(projectModels.map((m) => m.id));
  saveExcluded(currentProject, excluded);
  renderModels();
  if (viewerApi) void (on ? loadModels(viewerApi, projectModels) : unloadModels(viewerApi, projectModels)).catch((err) => console.warn('[section viewer] could not change the models', err));
};
el('models-all').addEventListener('click', () => setAll(true));
el('models-none').addEventListener('click', () => setAll(false));

function renderModels() {
  const excluded = excludedModels(currentProject);
  if (!projectModels.length) {
    modelsList.textContent = projectFiles ? 'No model files found in this project.' : 'Models are listed when the extension runs inside Trimble Connect.';
    return;
  }
  let lastFolder = '';
  modelsList.replaceChildren(
    ...projectModels.flatMap((m) => {
      const rows: HTMLElement[] = [];
      if (m.folder !== lastFolder) {
        lastFolder = m.folder;
        const h = document.createElement('div');
        h.className = 'models-folder';
        h.textContent = m.folder;
        rows.push(h);
      }
      const row = document.createElement('label');
      row.className = 'models-row';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !excluded.has(m.id) });
      box.addEventListener('change', () => {
        const now = excludedModels(currentProject);
        if (box.checked) now.delete(m.id);
        else now.add(m.id);
        saveExcluded(currentProject, now);
        if (viewerApi) void (box.checked ? loadModels(viewerApi, [m]) : unloadModels(viewerApi, [m])).catch((err) => console.warn('[section viewer] could not change a model', err));
      });
      const name = document.createElement('span');
      name.textContent = m.name;
      row.append(box, name);
      rows.push(row);
      return rows;
    }),
  );
}

/** Finds every model in the project and loads the ones not unticked, so a section can be cut straight away. */
async function ingestModels(api: WorkspaceApi) {
  if (!projectFiles) return;
  try {
    projectModels = await findProjectModels(projectFiles, (text) => store.setStatus(text, true));
    renderModels();
    const excluded = excludedModels(currentProject);
    const wanted = projectModels.filter((m) => !excluded.has(m.id));
    if (wanted.length) {
      store.setStatus(`Loading ${wanted.length} model${wanted.length === 1 ? '' : 's'}…`, true);
      await loadModels(api, wanted);
    } else {
      store.setStatus(projectModels.length ? 'All models are unticked. Choose some under Models.' : 'No model files found in this project');
    }
  } catch (err) {
    console.warn('[section viewer] could not load the project models', err);
    store.setStatus('Could not list the project models');
  }
  reindex();
}

/** Made-up objects on a local grid: three buildings with walls, slabs and columns, and a pipe run. */
function demoElements() {
  const out: { modelId: string; id: number; min: [number, number, number]; max: [number, number, number] }[] = [];
  let id = 1;
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => out.push({ modelId: 'demo', id: id++, min: [x0, y0, z0], max: [x1, y1, z1] });
  [[0, 0], [40, 10], [10, 45]].forEach(([bx, by], b) => {
    const floors = 3 + b;
    for (let f = 0; f < floors; f++) {
      const z = f * 3.5;
      box(bx, by, z, bx + 24, by + 16, z + 0.3); // slab
      box(bx, by, z, bx + 24, by + 0.3, z + 3.5); // walls
      box(bx, by + 15.7, z, bx + 24, by + 16, z + 3.5);
      box(bx, by, z, bx + 0.3, by + 16, z + 3.5);
      box(bx + 23.7, by, z, bx + 24, by + 16, z + 3.5);
      for (let c = 6; c < 24; c += 6) box(bx + c - 0.2, by + 7.8, z, bx + c + 0.2, by + 8.2, z + 3.5); // columns
    }
  });
  for (let i = 0; i < 12; i++) box(-5 + i * 6, -8, -2, 1 + i * 6, -7.6, -1.6); // pipe
  return out;
}

// ---- Start inside Trimble Connect ----
connectToHost()
  .then((host) => {
    if (!host) {
      mapPane.setProject(null);
      // Opened on its own (for example `npm run dev`): a few made-up buildings so the map and the section can be tried.
      const demo = demoElements();
      updatePlacement(demo[0].min[0]);
      store.setElements(demo);
      store.setStatus('Demo data: open this extension inside a Trimble Connect project to load its models.');
      return;
    }
    currentProject = host.projectId;
    mapPane.setProject(host.projectId);
    projectFiles = new ProjectFiles(host.projectId, host.token, host.location);
    topicsApi = new TopicsApi(projectFiles, host.projectId);
    // Load the topics now so their icons are on the map from the start.
    topicsPanel.load();
    void host.api.user.getUser().then((u) => (myEmail = u?.email)).catch((err) => console.warn('[section viewer] could not read the signed-in user', err));
    void initGeoreference(host.crs);
    let started = false;
    host.onToken((token) => {
      if (started) {
        void modelPane.refreshToken(token);
        return;
      }
      started = true;
      modelPane
        .start(host.projectId, host.token, (api) => {
          viewerApi = api;
          void ingestModels(api);
        })
        .catch((err) => {
          started = false;
          console.error('Could not start the 3D viewer', err);
        });
    });
  })
  .catch((err) => console.error('Could not connect to Trimble Connect', err));

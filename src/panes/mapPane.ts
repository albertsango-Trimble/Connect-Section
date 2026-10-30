import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { readGeoTiff } from '../core/geotiff';
import { registerTiles, tileUrl, TiffTiles, unregisterTiles, type RangeClient, type TilesInfo } from '../core/geotiffTiles';
import type { ProjectItem } from '../connect/projectFiles';
import { deleteGeoTiff, listGeoTiffs, putGeoTiff } from '../state/geotiffStore';
import { buildTileUrl, isTileTemplate, normalizeTemplate, parseCapabilities, type WmtsCapabilities } from '../core/wmts';
import { getProjectCrsName } from '../core/geo';
import { isLocalGrid, mapToModel, modelToMap, onPlacementChange } from '../core/mapGeo';
import { elementAt, type Element, type XY } from '../core/section';
import { refKey, store, type ObjectRef } from '../state/store';
import { topicsStore } from '../state/topics';
import { surveyStore } from '../state/survey';
import topicIconUrl from '../assets/topics-icon.png';

type BaseMode = 'street' | 'satellite' | 'wmts' | 'geotiff';

interface WmtsSetting {
  tiles: string;
  attribution: string;
  title: string;
}

interface SavedBase {
  mode: BaseMode;
  wmts?: WmtsSetting;
}

const STORAGE_KEY = 'connectsection.basemap';

const ESRI_ATTRIBUTION = 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/** Colours shared with the 3D pane */
export const COLORS = {
  line: '#c62828',
  slab: '#0063a3',
  crossed: '#ff8a00',
  hover: '#f5a300',
  selected: '#1e88e5',
  footprint: '#5b6875',
};

function loadSaved(): SavedBase {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SavedBase>;
      if (parsed.mode === 'street' || parsed.mode === 'satellite' || parsed.mode === 'wmts' || parsed.mode === 'geotiff') {
        return { mode: parsed.mode, wmts: parsed.wmts };
      }
    }
  } catch {
    // Storage can be blocked; fall back to the default.
  }
  return { mode: 'street' };
}

function save(state: SavedBase): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Not critical.
  }
}

/** Left pane: base map, model footprints, and the section line. */
export interface MapPane {
  /** Says which project is open (null when not inside Connect), so its saved GeoTIFF base maps can be brought back */
  setProject(projectId: string | null): void;
  /** Starts drawing a section line, or stops if already drawing */
  startDrawing(): void;
  /** Zooms the map to the loaded models */
  fitModels(): void;
  /** Centres the map on a place in model coordinates */
  flyTo(x: number, y: number): void;
  /** The map as it is now, as a JPEG data URL (at most `maxWidth` wide), or null if it can't be read */
  capture(maxWidth?: number): string | null;
}

/** A GeoTIFF chosen to add: a file from this computer, or one in the project (read in place, never downloaded whole) */
export type GeoTiffChoice = { file: File } | { item: ProjectItem };

export interface MapPaneOptions {
  /** Asks the person for a GeoTIFF (from this computer or the project), one or several; empty when they cancel */
  chooseGeoTiff?: () => Promise<GeoTiffChoice[]>;
  /** Reads a project file a piece at a time; null when no project is open */
  projectTiffClient?: (item: ProjectItem) => RangeClient | null;
  /** Asks for an object's name, which arrives later through the store */
  wantName?: (ref: ObjectRef) => void;
  /** Told when drawing a section line starts or stops */
  drawingChanged?: (on: boolean) => void;
  /** Selects an element in the 3D view (a click on its footprint) */
  selectInModel?: (ref: ObjectRef) => void;
}

const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

/** An element's footprint on the map as a closed ring, or null if it can't be placed. */
function ringOf(e: Element): [number, number][] | null {
  const pts = [modelToMap(e.min[0], e.min[1]), modelToMap(e.max[0], e.min[1]), modelToMap(e.max[0], e.max[1]), modelToMap(e.min[0], e.max[1])];
  if (!pts.every((p): p is XY => !!p)) return null;
  return [...pts, pts[0]] as [number, number][];
}

function polygon(rings: ([number, number][] | null)[], props: Record<string, unknown> = {}): GeoJSON.Feature[] {
  return rings.filter((r): r is [number, number][] => !!r).map((r) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [r] } }));
}

export function createMapPane(container: HTMLElement, options: MapPaneOptions = {}): MapPane {
  const saved = loadSaved();
  let mode: BaseMode = saved.mode === 'wmts' && !saved.wmts ? 'street' : saved.mode;
  let wmts: WmtsSetting | undefined = saved.wmts;
  let hadChoice = true;
  try {
    hadChoice = localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    // storage unavailable
  }
  let wantTiff = saved.mode === 'geotiff' || !hadChoice;
  const hasContent = () => store.elements.length > 0 || surveyStore.jobs.length > 0;

  const map = new maplibregl.Map({
    container,
    center: [0, 20],
    zoom: 1,
    dragRotate: true,
    preserveDrawingBuffer: true, // so the map can be captured for topics
    style: {
      version: 8,
      sources: {
        street: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19, attribution: '© OpenStreetMap contributors' },
        satellite: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: ESRI_ATTRIBUTION },
      },
      layers: [
        { id: 'blank', type: 'background', paint: { 'background-color': '#eef1f4' } },
        { id: 'street', type: 'raster', source: 'street' },
        { id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
      ],
    },
  });

  let ready = false;

  const hint = document.createElement('div');
  hint.className = 'map-hint';
  hint.hidden = true;
  container.appendChild(hint);

  // ---- North arrow: turns with the map, and a click turns the map back to north ----
  const north = document.createElement('button');
  north.type = 'button';
  north.className = 'north-arrow';
  north.title = 'North. Click to turn the map back to north (right-drag or two fingers turn the map)';
  north.setAttribute('aria-label', 'North arrow: click to face north');
  north.innerHTML = `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
    <circle cx="20" cy="20" r="18" fill="rgba(255,255,255,0.92)" stroke="#8a96a1" />
    <g class="north-needle"><path d="M20 5 L26 20 L14 20 Z" fill="#c62828" /><path d="M20 35 L26 20 L14 20 Z" fill="#8a96a1" /></g>
  </svg>`;
  container.appendChild(north);
  const needle = north.querySelector('.north-needle') as SVGGElement;
  map.on('rotate', () => needle.setAttribute('transform', `rotate(${-map.getBearing()} 20 20)`));
  north.addEventListener('click', () => map.easeTo({ bearing: 0, duration: 400 }));

  // ---- Base map control ----
  const control = document.createElement('div');
  control.className = 'basemap-ctl';
  control.innerHTML = `
    <div class="basemap-buttons" role="group" aria-label="Base map">
      <button type="button" data-mode="street">Street</button>
      <button type="button" data-mode="satellite">Satellite</button>
      <button type="button" data-mode="wmts">WMTS</button>
      <button type="button" data-mode="geotiff" title="Use a georeferenced TIFF as the base map">GeoTIFF</button>
    </div>
    <div class="wmts-panel geotiff-panel" hidden>
      <div class="geotiff-empty">No GeoTIFFs added yet.</div>
      <div class="geotiff-list"></div>
      <div class="geotiff-progress" hidden>
        <div class="geotiff-progress-label"></div>
        <div class="geotiff-bar"><i></i></div>
      </div>
      <div class="wmts-actions">
        <button type="button" class="geotiff-choose">Add GeoTIFF…</button>
      </div>
      <div class="wmts-status geotiff-status" role="status"></div>
    </div>
    <div class="wmts-panel" hidden>
      <label>WMTS capabilities URL, or a tile URL with {z}/{x}/{y}
        <input type="text" class="wmts-url" spellcheck="false" placeholder="https://…/WMTSCapabilities.xml  or  https://…/{z}/{x}/{y}.png" />
      </label>
      <label class="wmts-layer-row" hidden>Layer <select class="wmts-layer"></select></label>
      <label>Attribution (optional)
        <input type="text" class="wmts-attribution" placeholder="© Provider" />
      </label>
      <div class="wmts-actions">
        <button type="button" class="wmts-load">Load</button>
        <button type="button" class="wmts-apply" hidden>Use this layer</button>
        <button type="button" class="wmts-clear">Clear</button>
      </div>
      <div class="wmts-status" role="status"></div>
    </div>`;
  container.appendChild(control);

  const q = <T extends HTMLElement>(selector: string) => control.querySelector(selector) as T;
  const panel = q<HTMLDivElement>('.wmts-panel:not(.geotiff-panel)');
  const tiffPanel = q<HTMLDivElement>('.geotiff-panel');
  const tiffEmpty = q<HTMLDivElement>('.geotiff-empty');
  const tiffList = q<HTMLDivElement>('.geotiff-list');
  const tiffChoose = q<HTMLButtonElement>('.geotiff-choose');
  const tiffProgress = q<HTMLDivElement>('.geotiff-progress');
  const tiffProgressLabel = q<HTMLDivElement>('.geotiff-progress-label');
  const tiffBar = q<HTMLDivElement>('.geotiff-bar');
  const tiffStatus = q<HTMLDivElement>('.geotiff-status');
  const urlInput = q<HTMLInputElement>('.wmts-url');
  const layerRow = q<HTMLLabelElement>('.wmts-layer-row');
  const layerSelect = q<HTMLSelectElement>('.wmts-layer');
  const attributionInput = q<HTMLInputElement>('.wmts-attribution');
  const loadBtn = q<HTMLButtonElement>('.wmts-load');
  const applyBtn = q<HTMLButtonElement>('.wmts-apply');
  const clearBtn = q<HTMLButtonElement>('.wmts-clear');
  const statusEl = q<HTMLDivElement>('.wmts-status');

  let capabilities: WmtsCapabilities | null = null;

  const setStatus = (kind: 'ok' | 'warn' | 'err' | '', message: string) => {
    statusEl.className = `wmts-status ${kind}`;
    statusEl.textContent = message;
  };

  const updateButtons = () => {
    control.querySelectorAll<HTMLButtonElement>('.basemap-buttons button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  };

  const showBase = () => {
    if (!ready) return;
    // With no coordinate system the models are on a local grid, so there is no earth to draw: blank background.
    // GeoTIFFs are drawn over the street map so that their see-through edges show it.
    (['street', 'satellite', 'wmts'] as const).forEach((id) => {
      const on = id === mode || (id === 'street' && mode === 'geotiff');
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on && !isLocalGrid() ? 'visible' : 'none');
    });
    tiffs.forEach((t) => {
      if (map.getLayer(tiffLayer(t.id))) map.setLayoutProperty(tiffLayer(t.id), 'visibility', mode === 'geotiff' && t.visible && !isLocalGrid() ? 'visible' : 'none');
    });
    control.classList.toggle('local-grid', isLocalGrid());
    hint.hidden = !(isLocalGrid() && hasContent());
    const crsName = getProjectCrsName();
    hint.textContent = crsName
      ? `The models don't line up with the project's coordinate system (${crsName}), so they are drawn on a blank grid.`
      : 'No coordinate system is set for this project, so the models are drawn on a blank grid.';
    updateButtons();
  };

  const persist = () => save({ mode: wantTiff && mode !== 'geotiff' && tiffs.length === 0 ? 'geotiff' : mode, wmts });
  /** Switches to the GeoTIFF base map once there are GeoTIFFs, when that is the person's usual choice. */
  const preferTiff = () => {
    if (!wantTiff || tiffs.length === 0 || mode === 'geotiff') return;
    mode = 'geotiff';
    showBase();
    updateButtons();
  };

  // ---- GeoTIFF base maps: several can be added, and they are remembered for the project ----
  interface TiffEntry {
    id: string;
    name: string;
    crs: string;
    coordinates: [[number, number], [number, number], [number, number], [number, number]];
    width: number;
    height: number;
    addedAt: number;
    visible: boolean;
    /** Reduced picture (a file that can't be reopened), shown as an image */
    png?: Blob;
    url?: string;
    /** Set when shown as tiles drawn from the original file, at its own resolution */
    tiles?: TilesInfo;
    /** The project file, so it can be read again */
    item?: ProjectItem;
    /** The file from this computer, for this visit */
    local?: File;
    overview?: Blob;
    opening?: Promise<TiffTiles>;
  }
  const tiffs: TiffEntry[] = [];
  const tiffLayer = (id: string) => `geotiff-${id}`;
  let projectKey: string | null = null;
  let projectKnown = false;
  let loadingTiff = false;
  const HIDDEN_KEY = 'connectsection.geotiffs-hidden';
  const hiddenIds = (): string[] => {
    try {
      const all = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as Record<string, string[]>;
      return all[projectKey ?? 'local'] ?? [];
    } catch {
      return [];
    }
  };
  const saveHidden = () => {
    try {
      const all = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '{}') as Record<string, string[]>;
      all[projectKey ?? 'local'] = tiffs.filter((t) => !t.visible).map((t) => t.id);
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(all));
    } catch {
      // Not critical.
    }
  };
  const boundsOf = (t: TiffEntry): [[number, number], [number, number]] => {
    const lons = t.coordinates.map((c) => c[0]);
    const lats = t.coordinates.map((c) => c[1]);
    return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  };
  const tiffMessage = (kind: 'ok' | 'warn' | 'err' | '', text: string) => {
    tiffStatus.className = `wmts-status geotiff-status ${kind}`;
    tiffStatus.textContent = text;
  };
  const showProgress = (fraction: number, label: string, indeterminate = false) => {
    tiffProgress.hidden = false;
    tiffBar.classList.toggle('busy', indeterminate);
    tiffBar.style.setProperty('--progress', `${Math.round(fraction * 100)}%`);
    tiffProgressLabel.textContent = indeterminate ? label : `${label} ${Math.round(fraction * 100)}%`;
  };
  const toRecord = (t: TiffEntry) => ({
    id: t.id,
    name: t.name,
    crs: t.crs,
    coordinates: t.coordinates,
    width: t.width,
    height: t.height,
    addedAt: t.addedAt,
    png: t.png,
    item: t.item,
    tiles: t.item ? t.tiles : undefined,
    overview: t.overview,
  });
  /** Keeps (or updates) what is remembered about a GeoTIFF: project files and files with a reduced picture can be brought back. */
  const keepTiff = async (t: TiffEntry) => {
    if (!t.item && !t.png) return;
    await putGeoTiff(projectKey ?? 'local', toRecord(t));
  };
  /** Opens the original file the first time a tile of it is wanted. */
  const openTiles = (t: TiffEntry): Promise<TiffTiles> =>
    (t.opening ??= (async () => {
      const source = t.local ?? (t.item ? options.projectTiffClient?.(t.item) : null);
      if (!source) throw new Error("it can't be read here; open the extension in its project");
      const tiles = await TiffTiles.open(source);
      tiles.onProblem = (message) => tiffMessage('err', `${t.name}: ${message}`);
      if (tiles.info.needsOverview) {
        if (t.overview) {
          await tiles.loadOverview(t.overview);
        } else {
          // A file without overviews needs a coarse one for zooming out; built once and kept.
          tiffPanel.hidden = false;
          await tiles.buildOverview((fraction) => showProgress(fraction, `Preparing ${t.name} for zooming out…`));
          tiffProgress.hidden = true;
          t.overview = tiles.overviewPicture ?? undefined;
          await keepTiff(t).catch(() => undefined);
        }
      }
      return tiles;
    })().catch((err: unknown) => {
      t.opening = undefined;
      tiffProgress.hidden = true;
      tiffMessage('err', `${t.name}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }));
  const addTiffLayer = (t: TiffEntry) => {
    const before = map.getLayer('element-footprints') ? 'element-footprints' : undefined; // under the extents, every route line and position dot
    if (t.tiles) {
      const [[west, south], [east, north]] = boundsOf(t);
      registerTiles(t.id, () => openTiles(t));
      map.addSource(tiffLayer(t.id), { type: 'raster', tiles: [tileUrl(t.id)], tileSize: 256, maxzoom: t.tiles.maxZoom, bounds: [west, south, east, north] });
    } else {
      map.addSource(tiffLayer(t.id), { type: 'image', url: t.url as string, coordinates: t.coordinates });
    }
    map.addLayer({ id: tiffLayer(t.id), type: 'raster', source: tiffLayer(t.id), layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } }, before);
  };
  const dropTiff = (t: TiffEntry) => {
    if (map.getLayer(tiffLayer(t.id))) map.removeLayer(tiffLayer(t.id));
    if (map.getSource(tiffLayer(t.id))) map.removeSource(tiffLayer(t.id));
    unregisterTiles(t.id);
    if (t.url) URL.revokeObjectURL(t.url);
    tiffs.splice(tiffs.indexOf(t), 1);
  };
  const renderTiffList = () => {
    tiffEmpty.hidden = tiffs.length > 0;
    tiffList.replaceChildren(
      ...tiffs.map((t) => {
        const row = document.createElement('div');
        row.className = 'geotiff-row';
        const label = document.createElement('label');
        label.title = `${t.name} (${t.crs}, ${t.width} × ${t.height} px)`;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = t.visible;
        box.addEventListener('change', () => {
          t.visible = box.checked;
          saveHidden();
          showBase();
        });
        const text = document.createElement('span');
        text.textContent = t.name + (!t.tiles ? ' (reduced)' : !t.item && !t.png ? ' (this visit only)' : '');
        label.append(box, text);
        const zoom = document.createElement('button');
        zoom.type = 'button';
        zoom.textContent = 'Zoom';
        zoom.addEventListener('click', () => {
          if (!t.visible) {
            t.visible = true;
            saveHidden();
            showBase();
            renderTiffList();
          }
          map.fitBounds(boundsOf(t), { padding: 20, duration: 400 });
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          const id = t.id;
          dropTiff(t);
          saveHidden();
          if (tiffs.length === 0 && mode === 'geotiff') mode = 'street';
          showBase();
          persist();
          renderTiffList();
          tiffMessage('', '');
          deleteGeoTiff(projectKey ?? 'local', id).catch((err) => console.warn('[section viewer] could not forget a GeoTIFF', err));
          
        });
        row.append(label, zoom, remove);
        return row;
      }),
    );
  };
  /** Brings back the GeoTIFFs saved for this project. */
  const restoreTiffs = async () => {
    if (!ready || !projectKnown) return;
    const key = projectKey ?? 'local';
    [...tiffs].forEach(dropTiff);
    try {
      const saved = await listGeoTiffs(key);
      if ((projectKey ?? 'local') !== key) return;
      const hidden = hiddenIds();
      for (const rec of saved) {
        const projectTiles = !!(rec.item && rec.tiles);
        if (!projectTiles && !rec.png) continue;
        const entry: TiffEntry = { ...rec, url: projectTiles ? undefined : URL.createObjectURL(rec.png as Blob), tiles: projectTiles ? rec.tiles : undefined, visible: !hidden.includes(rec.id) };
        tiffs.push(entry);
        addTiffLayer(entry);
      }
    } catch (err) {
      console.warn('[section viewer] could not load the saved GeoTIFFs', err);
    }
    if (tiffs.length === 0 && mode === 'geotiff') mode = 'street';
    preferTiff();
    showBase();
    renderTiffList();
    // With no capture positions to frame, show where the GeoTIFFs are.
    const shown = tiffs.filter((t) => t.visible).map(boundsOf);
    if (mode === 'geotiff' && shown.length > 0 && !hasContent()) {
      const west = Math.min(...shown.map((b) => b[0][0]));
      const south = Math.min(...shown.map((b) => b[0][1]));
      const east = Math.max(...shown.map((b) => b[1][0]));
      const north = Math.max(...shown.map((b) => b[1][1]));
      map.fitBounds([[west, south], [east, north]], { padding: 20, duration: 0 });
    }
  };
  /** Files with no overviews are read through once to build one; beyond this size that is too slow in a browser. */
  const MAX_NO_OVERVIEW = 8e9;
  const chooseTiff = async () => {
    if (loadingTiff) return;
    if (!options.chooseGeoTiff) return tiffMessage('err', 'GeoTIFFs can be chosen from the toolbar once the extension has loaded.');
    const choices = await options.chooseGeoTiff();
    if (choices.length === 0) return;
    tiffPanel.hidden = false;
    loadingTiff = true;
    tiffChoose.disabled = true;
    tiffMessage('', '');
    const added: TiffEntry[] = [];
    const failed: string[] = [];
    const visitOnly: string[] = [];
    let remembered = true;
    try {
      if (!ready) throw new Error('The map is still loading, try again in a moment');
      for (const [n, choice] of choices.entries()) {
        const local = 'file' in choice ? choice.file : undefined;
        const item = 'item' in choice ? choice.item : undefined;
        const name = (local?.name ?? item?.name) as string;
        const size = local?.size ?? item?.size ?? 0;
        const prefix = choices.length > 1 ? `(${n + 1} of ${choices.length}) ` : '';
        showProgress(0, `${prefix}Opening ${name}…`, true);
        try {
          const source = local ?? (item ? options.projectTiffClient?.(item) : null);
          if (!source) throw new Error('open the extension inside the project to use its files');
          const tiles = await TiffTiles.open(source);
          if (tiles.info.needsOverview) {
            if (size > MAX_NO_OVERVIEW) {
              throw new Error(`has no overviews and is too large (${(size / 1e9).toFixed(0)} GB) to prepare in the browser. Convert it to a Cloud Optimized GeoTIFF first, for example: gdal_translate -of COG in.tif out.tif`);
            }
            await tiles.buildOverview((fraction) => showProgress(fraction, `${prefix}Preparing ${name} for zooming out…`));
          }
          // Adding a file with the same name again replaces the earlier copy.
          const old = tiffs.find((t) => t.name === name);
          if (old) {
            const oldId = old.id;
            dropTiff(old);
            deleteGeoTiff(projectKey ?? 'local', oldId).catch(() => undefined);
          }
          const entry: TiffEntry = {
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            name,
            crs: tiles.info.crs,
            coordinates: tiles.info.coordinates,
            width: tiles.info.width,
            height: tiles.info.height,
            addedAt: Date.now(),
            visible: true,
            tiles: tiles.info,
            item,
            local,
            overview: tiles.overviewPicture ?? undefined,
            opening: Promise.resolve(tiles),
          };
          tiles.onProblem = (message) => tiffMessage('err', `${name}: ${message}`);
          tiffs.push(entry);
          addTiffLayer(entry);
          added.push(entry);
          wantTiff = true;
          mode = 'geotiff';
          showBase();
          persist();
          renderTiffList();
          try {
            await keepTiff(entry);
            
          } catch {
            remembered = false;
          }
          if (local) {
            // A file from this computer can't be reopened next time, so keep a reduced picture of it instead (if it is small enough to read whole).
            if (local.size <= 1.5e9) {
              void readGeoTiff(local)
                .then(async (image) => {
                  URL.revokeObjectURL(image.url);
                  entry.png = image.blob;
                  renderTiffList();
                  await keepTiff(entry);
                  
                })
                .catch((err) => console.warn('[section viewer] could not keep a reduced picture', err));
            } else {
              visitOnly.push(name);
            }
          }
        } catch (err) {
          failed.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (added.length > 0) {
        const bounds = added.map(boundsOf);
        map.fitBounds(
          [[Math.min(...bounds.map((b) => b[0][0])), Math.min(...bounds.map((b) => b[0][1]))], [Math.max(...bounds.map((b) => b[1][0])), Math.max(...bounds.map((b) => b[1][1]))]],
          { padding: 20, duration: 0 },
        );
      }
      const summary = added.length === 1 ? `Added ${added[0].name}.` : `Added ${added.length} of ${choices.length} GeoTIFFs.`;
      if (failed.length > 0) tiffMessage('err', `${added.length > 0 ? `${summary} ` : ''}Could not add ${failed.join('; ')}`);
      else if (!remembered) tiffMessage('warn', `${summary} Some could not be remembered for next time.`);
      else if (visitOnly.length > 0) tiffMessage('warn', `${summary} ${visitOnly.join(', ')} is too large to keep from this computer, so it is here for this visit only. Put it in the project and add it from there to keep and share it.`);
      else tiffMessage('ok', summary);
    } catch (err) {
      tiffMessage('err', err instanceof Error ? err.message : String(err));
    } finally {
      loadingTiff = false;
      tiffChoose.disabled = false;
      tiffProgress.hidden = true;
    }
  };
  tiffChoose.addEventListener('click', () => void chooseTiff());
  renderTiffList();

  /** Replaces the custom tile layer, keeping it under the frame markers. */
  const setWmtsLayer = (setting: WmtsSetting) => {
    if (map.getLayer('wmts')) map.removeLayer('wmts');
    if (map.getSource('wmts')) map.removeSource('wmts');
    map.addSource('wmts', {
      type: 'raster',
      tiles: [setting.tiles],
      tileSize: 256,
      maxzoom: 22,
      attribution: setting.attribution,
    });
    map.addLayer(
      { id: 'wmts', type: 'raster', source: 'wmts', layout: { visibility: 'none' } },
      // Keep the base map under the section and footprints.
      map.getLayer('element-footprints') ? 'element-footprints' : undefined,
    );
  };

  const applyWmts = (setting: WmtsSetting, bbox?: { west: number; south: number; east: number; north: number } | null) => {
    wmts = setting;
    mode = 'wmts';
    if (ready) {
      setWmtsLayer(setting);
      showBase();
      // Show the layer's extent if there are no capture positions to frame instead.
      if (bbox && !hasContent()) {
        map.fitBounds([[bbox.west, bbox.south], [bbox.east, bbox.north]], { padding: 20, duration: 0 });
      }
    }
    persist();
    updateButtons();
    setStatus('ok', `Using “${setting.title}”.`);
  };

  const clearWmts = () => {
    wmts = undefined;
    capabilities = null;
    layerRow.hidden = true;
    applyBtn.hidden = true;
    layerSelect.replaceChildren();
    urlInput.value = '';
    attributionInput.value = '';
    if (ready && map.getLayer('wmts')) map.removeLayer('wmts');
    if (ready && map.getSource('wmts')) map.removeSource('wmts');
    if (mode === 'wmts') mode = 'street';
    showBase();
    persist();
    setStatus('', '');
  };

  control.querySelectorAll<HTMLButtonElement>('.basemap-buttons button').forEach((button) => {
    button.addEventListener('click', () => {
      const requested = button.dataset.mode as BaseMode;
      wantTiff = requested === 'geotiff';
      if (requested === 'geotiff') {
        panel.hidden = true;
        if (tiffs.length > 0) {
          // Clicking GeoTIFF again while it is the active base map closes its panel.
          tiffPanel.hidden = mode === 'geotiff' ? !tiffPanel.hidden : false;
          mode = 'geotiff';
          showBase();
          persist();
        } else {
          tiffPanel.hidden = false;
          void chooseTiff();
        }
        updateButtons();
        return;
      }
      tiffPanel.hidden = true;
      if (requested === 'wmts') {
        // Clicking WMTS again while it's the active base map closes the settings panel.
        panel.hidden = !panel.hidden && mode === 'wmts';
        if (wmts) {
          mode = 'wmts';
          showBase();
          persist();
        }
        if (!wmts) setStatus('', 'Enter a WMTS capabilities URL or a tile URL to add a layer.');
      } else {
        mode = requested;
        panel.hidden = true;
        showBase();
        persist();
      }
      updateButtons();
    });
  });

  loadBtn.addEventListener('click', async () => {
    const value = urlInput.value.trim();
    if (!value) {
      setStatus('err', 'Paste a URL first.');
      return;
    }
    const attribution = attributionInput.value.trim();

    // A tile template can be used straight away.
    if (isTileTemplate(value)) {
      applyWmts({ tiles: normalizeTemplate(value), attribution, title: 'Custom tiles' });
      return;
    }

    setStatus('warn', 'Fetching capabilities…');
    layerRow.hidden = true;
    applyBtn.hidden = true;
    try {
      const res = await fetch(value);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      capabilities = parseCapabilities(await res.text());
      layerSelect.replaceChildren(
        ...capabilities.layers.map((layer, i) => {
          const option = document.createElement('option');
          option.value = String(i);
          option.textContent = layer.title;
          return option;
        }),
      );
      layerRow.hidden = false;
      applyBtn.hidden = false;
      const n = capabilities.layers.length;
      setStatus('ok', `Found ${n} layer${n === 1 ? '' : 's'}. Pick one and click “Use this layer”.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setStatus(
        'err',
        `Couldn't read the capabilities (${reason}). If the server blocks browser requests, paste a tile URL with {z}/{x}/{y} instead.`,
      );
    }
  });

  applyBtn.addEventListener('click', () => {
    if (!capabilities) return;
    const layer = capabilities.layers[Number(layerSelect.value)];
    const tiles = layer ? buildTileUrl(layer, capabilities.kvpBase) : null;
    if (!layer || !tiles) {
      setStatus('err', 'This layer has no tile URL I can use (no RESTful template and no GetTile endpoint).');
      return;
    }
    applyWmts({ tiles, attribution: attributionInput.value.trim(), title: layer.title }, layer.bbox);
  });

  clearBtn.addEventListener('click', clearWmts);

  // Restore the saved custom layer's settings into the form.
  if (wmts) {
    urlInput.value = wmts.tiles;
    attributionInput.value = wmts.attribution;
    setStatus('ok', `Using “${wmts.title}”.`);
  }
  updateButtons();
  // ---- Section line, model footprints and the links to the 3D pane ----
  const byKey = new Map<string, Element>();
  let fitted = false;

  const setData = (id: string, data: GeoJSON.FeatureCollection) => (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data);
  const featuresFor = (refs: (ObjectRef | null)[]) =>
    polygon(refs.map((r) => (r ? byKey.get(refKey(r)) : undefined)).map((e) => (e ? ringOf(e) : null)));

  /** Bounds of every element on the map, for zooming to the models. */
  const modelBounds = (): maplibregl.LngLatBounds | null => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of store.elements) {
      x0 = Math.min(x0, e.min[0]);
      y0 = Math.min(y0, e.min[1]);
      x1 = Math.max(x1, e.max[0]);
      y1 = Math.max(y1, e.max[1]);
    }
    for (const { points } of surveyStore.visible()) {
      for (const p of points) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    }
    if (!Number.isFinite(x0)) return null;
    const sw = modelToMap(x0, y0);
    const ne = modelToMap(x1, y1);
    const nw = modelToMap(x0, y1);
    const se = modelToMap(x1, y0);
    if (!sw || !ne || !nw || !se) return null;
    const b = new maplibregl.LngLatBounds(sw, ne);
    b.extend(nw);
    b.extend(se);
    return b;
  };
  const fitModels = (duration = 0) => {
    const b = modelBounds();
    if (b) map.fitBounds(b, { padding: 40, maxZoom: 20, duration });
  };

  const renderElements = () => {
    if (!ready) return;
    byKey.clear();
    for (const e of store.elements) byKey.set(refKey(e), e);
    showBase();
    setData('element-footprints', { type: 'FeatureCollection', features: polygon(store.elements.map(ringOf)) });
    if (!fitted && store.elements.length) {
      fitted = true;
      fitModels();
    }
  };

  // The view direction arrow, at the middle of the section line, pointing into the kept part.
  const arrowEl = document.createElement('div');
  arrowEl.className = 'section-arrow';
  arrowEl.title = 'The 3D view looks this way. Use Flip side to look from the other side.';
  arrowEl.innerHTML = '<svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true"><path d="M20 4 L32 22 L24 22 L24 36 L16 36 L16 22 L8 22 Z" fill="#0063a3" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
  const arrow = new maplibregl.Marker({ element: arrowEl, rotationAlignment: 'map', anchor: 'center' });

  // Handles at the two ends of the line, dragged to move them.
  const handle = (label: string) => {
    const el = document.createElement('div');
    el.className = 'section-handle';
    el.textContent = label;
    el.title = `Drag to move end ${label} of the section line`;
    return new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' });
  };
  const handleA = handle('A');
  const handleB = handle('B');
  const dragLine = () => {
    const a = handleA.getLngLat();
    const b = handleB.getLngLat();
    setData('section-draft', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [b.lng, b.lat]] } }] });
  };
  const dropLine = () => {
    setData('section-draft', empty());
    const a = handleA.getLngLat();
    const b = handleB.getLngLat();
    const ma = mapToModel(a.lng, a.lat);
    const mb = mapToModel(b.lng, b.lat);
    if (ma && mb) store.setLine([ma, mb]);
  };
  for (const h of [handleA, handleB]) {
    h.on('drag', dragLine);
    h.on('dragend', dropLine);
  }

  const renderSection = () => {
    if (!ready) return;
    const s = store.section;
    const line = store.line;
    const a = line ? modelToMap(line[0][0], line[0][1]) : null;
    const b = line ? modelToMap(line[1][0], line[1][1]) : null;
    if (!line || !a || !b) {
      setData('section-line', empty());
      setData('section-slab', empty());
      setData('crossed', empty());
      arrow.remove();
      handleA.remove();
      handleB.remove();
      return;
    }
    setData('section-line', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [a, b] } }] });
    handleA.setLngLat(a).addTo(map);
    handleB.setLngLat(b).addTo(map);
    if (!s) {
      setData('section-slab', empty());
      setData('crossed', empty());
      arrow.remove();
      return;
    }
    const ring = s.footprint.map(([x, y]) => modelToMap(x, y));
    setData('section-slab', { type: 'FeatureCollection', features: ring.every((p) => !!p) ? polygon([ring as [number, number][]]) : [] });
    setData('crossed', { type: 'FeatureCollection', features: polygon(s.crossed.map(ringOf)) });
    const mid = modelToMap((line[0][0] + line[1][0]) / 2 + s.into[0] * 0.01, (line[0][1] + line[1][1]) / 2 + s.into[1] * 0.01);
    if (mid) {
      arrow
        .setLngLat(mid)
        .setRotation((Math.atan2(s.into[0], s.into[1]) * 180) / Math.PI)
        .addTo(map);
    }
  };

  // Where the 3D camera stands and which way it looks.
  const camEl = document.createElement('div');
  camEl.className = 'camera-marker';
  camEl.title = 'Where the 3D view is looking from';
  camEl.innerHTML = '<svg viewBox="0 0 60 60" width="60" height="60" aria-hidden="true"><path d="M30 30 L14 4 A30 30 0 0 1 46 4 Z" fill="rgba(0,99,163,0.25)" stroke="#0063a3" stroke-width="1.5"/><circle cx="30" cy="30" r="5" fill="#0063a3" stroke="#fff" stroke-width="2"/></svg>';
  const camMarker = new maplibregl.Marker({ element: camEl, rotationAlignment: 'map', anchor: 'center' });

  let shownHover = '';
  let shownSelection = '';
  const renderLinks = () => {
    if (!ready) return;
    const hoverKey = store.mapHover ? refKey(store.mapHover) : '';
    if (hoverKey !== shownHover) {
      shownHover = hoverKey;
      setData('hover', { type: 'FeatureCollection', features: featuresFor([store.mapHover]) });
    }
    const selKey = store.modelSelection.map(refKey).join('|');
    if (selKey !== shownSelection) {
      shownSelection = selKey;
      setData('selected', { type: 'FeatureCollection', features: featuresFor(store.modelSelection) });
    }
    const p = store.modelPick ? modelToMap(store.modelPick.x, store.modelPick.y) : null;
    setData('pick', { type: 'FeatureCollection', features: p ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }] : [] });
    const c = store.camera ? modelToMap(store.camera.x, store.camera.y) : null;
    if (c && store.camera) camMarker.setLngLat(c).setRotation(store.camera.heading).addTo(map);
    else camMarker.remove();
    updateTip();
  };

  // ---- Hover: the smallest element footprint under the mouse is highlighted here and in the 3D view ----
  const tip = document.createElement('div');
  tip.className = 'extent-tip';
  tip.hidden = true;
  container.appendChild(tip);
  let tipAt: { x: number; y: number } | null = null;
  const surveyTip = (): string | null => {
    const sp = surveyStore.point(surveyStore.hover);
    if (!sp) return null;
    const lib = surveyStore.library;
    const def = sp.feature ? lib?.features.get(sp.feature.toUpperCase()) : undefined;
    const lines = [
      `Point ${sp.name}${sp.code ? ` · ${sp.code}` : ''}`,
      ...(def?.description ? [def.description] : []),
      ...(sp.description ? [sp.description] : []),
      `E ${sp.x.toFixed(3)}  N ${sp.y.toFixed(3)}  ${sp.z === null ? '(no height)' : `Z ${sp.z.toFixed(3)}`}`,
      ...sp.features.flatMap((f) => f.attributes.map((a) => `${a.name}: ${a.value}`)),
    ];
    return lines.join('\n');
  };
  const updateTip = () => {
    const ref = store.mapHover;
    const survey = drawing === 'idle' && tipAt ? surveyTip() : null;
    if (!survey && (!ref || !tipAt || drawing !== 'idle')) {
      tip.hidden = true;
      return;
    }
    if (survey) tip.textContent = survey;
    else if (ref) {
      const name = store.names.get(refKey(ref));
      const crossed = store.section?.crossed.some((e) => e.modelId === ref.modelId && e.id === ref.id);
      tip.textContent = `${name ?? 'Loading name…'}${crossed ? '\nCut by the section' : ''}`;
    }
    if (!tipAt) return;
    tip.hidden = false;
    tip.style.left = `${Math.min(tipAt.x + 14, Math.max(0, container.clientWidth - tip.offsetWidth - 6))}px`;
    tip.style.top = `${tipAt.y + 14}px`;
  };
  let hoverFrame = 0;
  let lastMove: maplibregl.MapMouseEvent | null = null;
  map.on('mousemove', (e) => {
    lastMove = e;
    if (drawing === 'second' && drawStart) {
      setData('section-draft', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [drawStart, [e.lngLat.lng, e.lngLat.lat]] } }] });
    }
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      const ev = lastMove;
      if (!ev) return;
      tipAt = { x: ev.point.x, y: ev.point.y };
      if (drawing === 'idle') map.getCanvas().style.cursor = topicAt(ev.point) ? 'pointer' : '';
      // A surveyed point under the mouse is shown in place of the element beneath it.
      const sp = drawing === 'idle' ? surveyAt(ev.point) : null;
      surveyStore.setHover(sp);
      if (sp) {
        store.setMapHover(null);
        updateTip();
        return;
      }
      const p = mapToModel(ev.lngLat.lng, ev.lngLat.lat);
      const el = p ? elementAt(p, store.elements) : null;
      const ref = el ? { modelId: el.modelId, id: el.id } : null;
      if (ref && !store.names.has(refKey(ref))) options.wantName?.(ref);
      store.setMapHover(ref);
      updateTip();
    });
  });
  container.addEventListener('mouseleave', () => {
    tipAt = null;
    store.setMapHover(null);
    surveyStore.setHover(null);
    tip.hidden = true;
  });

  // ---- Survey data from JobXML: linework and points in their feature library colours ----
  const surveyAt = (point: maplibregl.Point) => {
    if (!map.getLayer('survey-points')) return null;
    const hit = map.queryRenderedFeatures([[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]], { layers: ['survey-points'] })[0];
    const props = hit?.properties as { job?: string; name?: string } | undefined;
    return props?.job && props.name !== undefined ? { jobId: props.job, name: String(props.name) } : null;
  };
  const renderSurvey = () => {
    if (!ready) return;
    const points: GeoJSON.Feature[] = [];
    const lines: GeoJSON.Feature[] = [];
    for (const { job, points: pts, strings } of surveyStore.visible()) {
      for (const p of pts) {
        const at = modelToMap(p.x, p.y);
        if (at) points.push({ type: 'Feature', properties: { job: job.id, name: p.name, color: p.color, line: !p.isPointFeature }, geometry: { type: 'Point', coordinates: at } });
      }
      for (const s of strings) {
        const coords = s.coords.map(([x, y]) => modelToMap(x, y));
        if (coords.every((c): c is XY => !!c)) lines.push({ type: 'Feature', properties: { color: s.color, code: s.key }, geometry: { type: 'LineString', coordinates: coords } });
      }
    }
    setData('survey-points', { type: 'FeatureCollection', features: points });
    setData('survey-lines', { type: 'FeatureCollection', features: lines });
  };
  const renderSurveyHover = () => {
    if (!ready) return;
    const sp = surveyStore.point(surveyStore.hover);
    const at = sp ? modelToMap(sp.x, sp.y) : null;
    setData('survey-hover', { type: 'FeatureCollection', features: at ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: at } }] : [] });
  };
  let shownSurvey = -1;
  surveyStore.subscribe(() => {
    if (surveyStore.version !== shownSurvey) {
      shownSurvey = surveyStore.version;
      renderSurvey();
    }
    renderSurveyHover();
  });

  // ---- Topics: an icon at each topic's section (or where its camera stood); a click opens it ----
  let showTopics = true;
  try {
    showTopics = localStorage.getItem('connectsection.showTopics') !== '0';
  } catch {
    // storage unavailable
  }
  const topicsBtn = document.createElement('button');
  topicsBtn.type = 'button';
  topicsBtn.className = 'topics-toggle';
  topicsBtn.innerHTML = `<img src="${topicIconUrl}" alt="" width="22" height="22" />`;
  container.appendChild(topicsBtn);
  const applyTopics = () => {
    topicsBtn.classList.toggle('off', !showTopics);
    topicsBtn.title = showTopics ? 'Topics are shown on the map. Click to hide them' : 'Topics are hidden. Click to show them on the map';
    topicsBtn.setAttribute('aria-pressed', String(showTopics));
    for (const id of ['topics', 'topic-lines']) if (ready && map.getLayer(id)) map.setLayoutProperty(id, 'visibility', showTopics ? 'visible' : 'none');
  };
  topicsBtn.addEventListener('click', () => {
    showTopics = !showTopics;
    try {
      localStorage.setItem('connectsection.showTopics', showTopics ? '1' : '0');
    } catch {
      // storage unavailable
    }
    applyTopics();
  });
  applyTopics();
  const renderTopics = () => {
    if (!ready) return;
    const features: GeoJSON.Feature[] = [];
    const lines: GeoJSON.Feature[] = [];
    for (const t of topicsStore.topics) {
      const sec = t.section;
      const at = sec ? modelToMap((sec.a[0] + sec.b[0]) / 2, (sec.a[1] + sec.b[1]) / 2) : t.pin ? modelToMap(t.pin.x, t.pin.y) : null;
      if (!at) continue;
      features.push({ type: 'Feature', properties: { guid: t.guid, title: t.title }, geometry: { type: 'Point', coordinates: at } });
      const a = sec ? modelToMap(sec.a[0], sec.a[1]) : null;
      const b = sec ? modelToMap(sec.b[0], sec.b[1]) : null;
      if (a && b) lines.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [a, b] } });
    }
    setData('topics', { type: 'FeatureCollection', features });
    setData('topic-lines', { type: 'FeatureCollection', features: lines });
  };
  topicsStore.subscribe(renderTopics);
  const topicAt = (point: maplibregl.Point): string | null => {
    if (!showTopics || !map.getLayer('topics')) return null;
    const hit = map.queryRenderedFeatures([[point.x - 4, point.y - 4], [point.x + 4, point.y + 4]], { layers: ['topics'] })[0];
    return (hit?.properties?.guid as string | undefined) ?? null;
  };

  // ---- Drawing a section line: click the start, then click the end ----
  let drawing: 'idle' | 'first' | 'second' = 'idle';
  let drawStart: [number, number] | null = null;
  const drawHint = document.createElement('div');
  drawHint.className = 'draw-hint';
  drawHint.hidden = true;
  container.appendChild(drawHint);

  const setDrawing = (next: typeof drawing) => {
    drawing = next;
    options.drawingChanged?.(next !== 'idle');
    map.getCanvas().style.cursor = next === 'idle' ? '' : 'crosshair';
    drawHint.hidden = next === 'idle';
    drawHint.textContent = next === 'first' ? 'Click where the section starts' : 'Click where the section ends · Esc to cancel';
    if (next === 'idle') {
      drawStart = null;
      setData('section-draft', empty());
      map.doubleClickZoom.enable();
    } else {
      map.doubleClickZoom.disable();
      tip.hidden = true;
    }
  };
  const startDrawing = () => setDrawing(drawing === 'idle' ? 'first' : 'idle');
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawing !== 'idle') setDrawing('idle');
  });

  map.on('click', (e) => {
    const here: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    if (drawing === 'first') {
      drawStart = here;
      setDrawing('second');
      return;
    }
    if (drawing === 'second' && drawStart) {
      const a = mapToModel(drawStart[0], drawStart[1]);
      const b = mapToModel(here[0], here[1]);
      setDrawing('idle');
      if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.05) store.setLine([a, b]);
      return;
    }
    // Not drawing: a click on a topic opens it, and a click on an element selects it in the 3D view.
    const guid = topicAt(e.point);
    if (guid) {
      topicsStore.set({ openGuid: guid });
      return;
    }
    if (store.mapHover) options.selectInModel?.(store.mapHover);
  });

  map.on('load', () => {
    for (const id of ['survey-lines', 'survey-points', 'survey-hover', 'topics', 'topic-lines', 'element-footprints', 'crossed', 'selected', 'hover', 'section-slab', 'section-line', 'section-draft', 'pick']) map.addSource(id, { type: 'geojson', data: empty() });
    map.addLayer({ id: 'element-footprints', type: 'line', source: 'element-footprints', paint: { 'line-color': COLORS.footprint, 'line-width': 0.6, 'line-opacity': 0.45 } });
    map.addLayer({ id: 'section-slab', type: 'fill', source: 'section-slab', paint: { 'fill-color': COLORS.slab, 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'section-slab-line', type: 'line', source: 'section-slab', paint: { 'line-color': COLORS.slab, 'line-width': 1.2, 'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'crossed-fill', type: 'fill', source: 'crossed', paint: { 'fill-color': COLORS.crossed, 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'crossed-line', type: 'line', source: 'crossed', paint: { 'line-color': COLORS.crossed, 'line-width': 1.4 } });
    map.addLayer({ id: 'selected-fill', type: 'fill', source: 'selected', paint: { 'fill-color': COLORS.selected, 'fill-opacity': 0.3 } });
    map.addLayer({ id: 'selected-line', type: 'line', source: 'selected', paint: { 'line-color': COLORS.selected, 'line-width': 2.5 } });
    map.addLayer({ id: 'hover-fill', type: 'fill', source: 'hover', paint: { 'fill-color': COLORS.hover, 'fill-opacity': 0.35 } });
    map.addLayer({ id: 'hover-line', type: 'line', source: 'hover', paint: { 'line-color': COLORS.hover, 'line-width': 3 } });
    map.addLayer({ id: 'section-casing', type: 'line', source: 'section-line', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6 } });
    map.addLayer({ id: 'section-line', type: 'line', source: 'section-line', layout: { 'line-cap': 'round' }, paint: { 'line-color': COLORS.line, 'line-width': 3 } });
    map.addLayer({ id: 'section-draft', type: 'line', source: 'section-draft', paint: { 'line-color': COLORS.line, 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
    map.addLayer({ id: 'survey-lines', type: 'line', source: 'survey-lines', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 2 } });
    map.addLayer({ id: 'survey-points', type: 'circle', source: 'survey-points', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 1.5, 19, 4], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 19, 1.2] } });
    map.addLayer({ id: 'survey-hover', type: 'circle', source: 'survey-hover', paint: { 'circle-radius': 8, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': COLORS.hover, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'topic-lines', type: 'line', source: 'topic-lines', layout: { visibility: showTopics ? 'visible' : 'none' }, paint: { 'line-color': '#8e44ad', 'line-width': 1.5, 'line-dasharray': [1, 1.5] } });
    void map
      .loadImage(topicIconUrl)
      .then(({ data }) => {
        if (!map.hasImage('topic-icon')) map.addImage('topic-icon', data, { pixelRatio: 2 });
        if (!map.getLayer('topics')) map.addLayer({ id: 'topics', type: 'symbol', source: 'topics', layout: { 'icon-image': 'topic-icon', 'icon-allow-overlap': true, 'icon-ignore-placement': true, visibility: showTopics ? 'visible' : 'none' } });
      })
      .catch((err) => console.warn('[section viewer] could not load the topics icon', err));
    map.addLayer({ id: 'pick', type: 'circle', source: 'pick', paint: { 'circle-radius': 6, 'circle-color': COLORS.selected, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    ready = true;
    if (wmts) setWmtsLayer(wmts);
    showBase();
    renderElements();
    renderSection();
    renderLinks();
    renderTopics();
    renderSurvey();
    void restoreTiffs();
  });

  // Tell the user when custom tiles fail to load, instead of leaving a blank map.
  let tileErrorShown = false;
  map.on('error', (e) => {
    const sourceId = (e as { sourceId?: string }).sourceId;
    if (!sourceId) console.warn('[section viewer] map error', (e as { error?: unknown }).error);
    if (sourceId === 'wmts' && !tileErrorShown) {
      tileErrorShown = true;
      setStatus('warn', 'Some tiles failed to load. Check the URL or token, and that the provider allows this site.');
    }
  });

  let shownElements = -1;
  let shownSection = -1;
  store.subscribe(() => {
    if (store.elementsVersion !== shownElements) {
      shownElements = store.elementsVersion;
      renderElements();
    }
    if (store.sectionVersion !== shownSection) {
      shownSection = store.sectionVersion;
      renderSection();
    }
    renderLinks();
  });
  onPlacementChange(() => {
    renderTopics();
    renderSurvey();
    showBase();
    fitted = false;
    renderElements();
    renderSection();
    shownHover = shownSelection = '#';
    renderLinks();
  });

  new ResizeObserver(() => map.resize()).observe(container);

  return {
    startDrawing,
    fitModels: () => fitModels(400),
    flyTo: (x, y) => {
      const ll = modelToMap(x, y);
      if (ll) map.easeTo({ center: ll, zoom: Math.max(map.getZoom(), 18), duration: 600 });
    },
    capture: (maxWidth = 1280) => {
      try {
        map.triggerRepaint();
        const src = map.getCanvas();
        const scale = Math.min(1, maxWidth / src.width);
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(src.width * scale));
        out.height = Math.max(1, Math.round(src.height * scale));
        const g = out.getContext('2d') as CanvasRenderingContext2D;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, out.width, out.height);
        g.drawImage(src, 0, 0, out.width, out.height);
        return out.toDataURL('image/jpeg', 0.85);
      } catch (err) {
        console.warn('[section viewer] could not capture the map', err);
        return null;
      }
    },
    setProject: (id) => {
      projectKey = id;
      projectKnown = true;
      void restoreTiffs();
    },
  };
}

import * as WorkspaceAPI from 'trimble-connect-workspace-api';
import { sectionCamera, type Element, type Section } from '../core/section';
import { runtimeIds } from '../connect/elementIndex';
import { refKey, sameRef, store, type ObjectRef } from '../state/store';
import { COLORS } from './mapPane';
import type { WorkspaceApi } from '../connect/workspace';

const PLANE_SIGN_KEY = 'connectsection.planeSign';
const readSign = (): 1 | -1 => {
  try {
    return localStorage.getItem(PLANE_SIGN_KEY) === '-1' ? -1 : 1;
  } catch {
    return 1;
  }
};

export interface ModelPane {
  /** Loads the 3D viewer for the project. `getToken` must return a current access token. */
  start(projectId: string, getToken: () => string | undefined, onReady: (api: WorkspaceApi) => void): Promise<void>;
  refreshToken(token: string): Promise<void>;
  restart(): Promise<void>;
  /** Puts the camera square-on to the section again */
  snapToSection(): Promise<void>;
  /** Swaps which way the clipping planes cut, for viewers that read the plane direction the other way */
  invertPlanes(): void;
  /** Selects one object in the 3D view */
  select(ref: ObjectRef): Promise<void>;
  /** Called after the models in the viewer change (loaded or unloaded) */
  onModelsChanged(callback: () => void): void;
}

/** Groups object references by model, the way the viewer's selectors want them. */
function selector(refs: ObjectRef[]) {
  const byModel = new Map<string, number[]>();
  for (const r of refs) byModel.set(r.modelId, [...(byModel.get(r.modelId) ?? []), r.id]);
  return { modelObjectIds: [...byModel].map(([modelId, objectRuntimeIds]) => ({ modelId, objectRuntimeIds })) };
}

export function createModelPane(container: HTMLElement): ModelPane {
  const message = document.createElement('div');
  message.className = 'empty';
  message.textContent = 'The 3D model loads when this extension runs inside Trimble Connect.';
  container.appendChild(message);

  let api: WorkspaceApi | null = null;
  let planeSign = readSign();
  /** Ids of the clipping planes this extension added, so only those are removed */
  let ours: number[] = [];
  let isolated = false;
  let modelsChanged: () => void = () => {};
  let ignoreCameraUntil = 0;

  const elementOf = (ref: ObjectRef): Element | undefined => store.elements.find((e) => e.modelId === ref.modelId && e.id === ref.id);

  // ---- Clipping and camera, applied one change at a time ----
  let applying = false;
  let pending = false;
  let appliedVersion = -1;
  let snapNext = true;

  const toPlane = (p: Section['planes'][number]) => ({
    positionX: p.point[0] * 1000,
    positionY: p.point[1] * 1000,
    positionZ: p.point[2] * 1000,
    directionX: p.inward[0] * planeSign,
    directionY: p.inward[1] * planeSign,
    directionZ: p.inward[2] * planeSign,
    controlsVisible: false,
  });

  const removeOurs = async (viewer: WorkspaceApi['viewer']) => {
    if (!ours.length) return;
    try {
      await viewer.removeSectionPlanes(ours);
    } catch (err) {
      console.warn('[section viewer] could not remove the section planes', err);
    }
    ours = [];
  };

  const placeCamera = async (viewer: WorkspaceApi['viewer'], s: Section) => {
    const aspect = container.clientWidth > 0 && container.clientHeight > 0 ? container.clientWidth / container.clientHeight : 1.5;
    const cam = sectionCamera(s, aspect);
    ignoreCameraUntil = Date.now() + 800;
    await viewer.setCamera(
      {
        position: cam.position,
        lookAt: cam.lookAt,
        upDirection: { x: 0, y: 0, z: 1 },
        fieldOfView: cam.fieldOfView,
        projectionType: store.ortho ? 'ortho' : 'perspective',
        ...(store.ortho ? { orthoSize: cam.orthoSize } : {}),
      },
      { animationTime: 500 },
    );
  };

  const apply = async () => {
    if (!api) return;
    if (applying) {
      pending = true;
      return;
    }
    applying = true;
    try {
      do {
        pending = false;
        const viewer = api.viewer;
        const version = store.sectionVersion;
        const s = store.section;
        await removeOurs(viewer);
        if (!s) {
          if (isolated) {
            await viewer.setObjectState(undefined, { visible: 'reset' }).catch(() => undefined);
            isolated = false;
          }
          appliedVersion = version;
          continue;
        }
        const added = await viewer.addSectionPlane(s.planes.map(toPlane));
        ours = (Array.isArray(added) ? added : []).map((p) => p?.id).filter((id): id is number => typeof id === 'number');
        console.info('[section viewer] section planes added', { ids: ours, planeSign, crossed: s.crossed.length, depth: s.depth.toFixed(2), along: [s.from.toFixed(2), s.to.toFixed(2)] });

        if (store.isolate && s.crossed.length) {
          await viewer.setObjectState(undefined, { visible: false });
          await viewer.setObjectState(selector(s.crossed), { visible: true });
          isolated = true;
        } else if (isolated) {
          await viewer.setObjectState(undefined, { visible: 'reset' });
          isolated = false;
        }
        if (snapNext) await placeCamera(viewer, s);
        snapNext = true;
        appliedVersion = version;
      } while (pending || (api && store.sectionVersion !== appliedVersion));
    } catch (err) {
      console.warn('[section viewer] could not apply the section', err);
    } finally {
      applying = false;
    }
  };

  let applyTimer: number | undefined;
  let seenVersion = store.sectionVersion;
  store.subscribe(() => {
    if (store.sectionVersion === seenVersion) return;
    seenVersion = store.sectionVersion;
    window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(() => void apply(), 150);
  });

  // ---- Map hover → colour the same object in the 3D view ----
  let lit: ObjectRef | null = null;
  let lighting = false;
  const light = async () => {
    if (!api || lighting) return;
    lighting = true;
    try {
      while (!sameRef(lit, store.mapHover) && !(lit === null && store.mapHover === null)) {
        const next = store.mapHover;
        if (lit) await api.viewer.setObjectState(selector([lit]), { color: 'reset' }).catch(() => undefined);
        if (next) await api.viewer.setObjectState(selector([next]), { color: COLORS.hover }).catch(() => undefined);
        lit = next;
      }
    } finally {
      lighting = false;
    }
  };
  store.subscribe(() => void light());

  // ---- 3D selection, picks and camera → map ----
  const readSelection = async () => {
    if (!api) return;
    try {
      const refs = runtimeIds(await api.viewer.getObjects({ selected: true }));
      store.setModelSelection(refs.slice(0, 500));
    } catch (err) {
      console.warn('[section viewer] could not read the selection', err);
    }
  };

  const onPicked = (data: unknown) => {
    const d = (data ?? {}) as { position?: { x: number; y: number; z: number }; modelId?: string; objectRuntimeId?: number };
    const p = d.position;
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return;
    // The viewer gives metres for some events and millimetres for others; take whichever lands on the picked object.
    const e = d.modelId && typeof d.objectRuntimeId === 'number' ? elementOf({ modelId: d.modelId, id: d.objectRuntimeId }) : undefined;
    const inside = (q: { x: number; y: number }) => !!e && q.x >= e.min[0] - 1 && q.x <= e.max[0] + 1 && q.y >= e.min[1] - 1 && q.y <= e.max[1] + 1;
    const mm = { x: p.x / 1000, y: p.y / 1000, z: p.z / 1000 };
    store.setModelPick(inside(p) ? p : inside(mm) ? mm : Math.abs(p.x) > 1e5 && !e ? mm : p);
  };

  const onCamera = (data: unknown) => {
    const c = (data ?? {}) as { position?: { x: number; y: number; z: number }; lookAt?: { x: number; y: number; z: number }; yaw?: number };
    const p = c.position;
    if (!p) return;
    let heading = store.camera?.heading ?? 0;
    if (c.lookAt && (c.lookAt.x !== p.x || c.lookAt.y !== p.y)) heading = (Math.atan2(c.lookAt.x - p.x, c.lookAt.y - p.y) * 180) / Math.PI;
    store.setCamera({ x: p.x, y: p.y, z: p.z, heading });
  };

  let cameraTimer: number | undefined;
  let lastCamera: unknown = null;

  async function begin(projectId: string, getToken: () => string | undefined, onReady: (api: WorkspaceApi) => void): Promise<void> {
    const token = getToken();
    if (!token) throw new Error('No access token yet');
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:0;';
    container.replaceChildren(iframe);
    ours = [];
    isolated = false;
    lit = null;
    try {
      // Set the address, then connect straight away: waiting for the load event can miss the embedded app's handshake.
      iframe.src = WorkspaceAPI.getConnectEmbedUrl();
      api = await WorkspaceAPI.connect(
        iframe,
        (event: string, args: unknown) => {
          const data = (args as { data?: unknown } | undefined)?.data;
          if (event === 'viewer.onModelStateChanged' || event === 'viewer.onModelReset') modelsChanged();
          else if (event === 'viewer.onSelectionChanged') void readSelection();
          else if (event === 'viewer.onPicked') onPicked(data);
          else if (event === 'viewer.onCameraChanged') {
            lastCamera = data;
            window.clearTimeout(cameraTimer);
            cameraTimer = window.setTimeout(() => onCamera(lastCamera), Date.now() < ignoreCameraUntil ? 600 : 60);
          } else if (event === 'viewer.onSectionPlaneChanged') {
            console.log('[section viewer] section plane event', data);
          } else if (event === 'extension.sessionInvalid' || event === 'embed.session.invalid') {
            const fresh = getToken();
            if (fresh) void api?.embed.setTokens({ accessToken: fresh });
          }
        },
        30000,
      );
      await api.embed.setTokens({ accessToken: token });
      await api.embed.init3DViewer({ projectId });
      onReady(api);
      if (store.section) void apply();
    } catch (err) {
      api = null;
      const el = document.createElement('div');
      el.className = 'empty';
      el.style.background = '#fff';
      el.textContent = `Could not load the Connect 3D viewer: ${err instanceof Error ? err.message : String(err)}`;
      container.appendChild(el);
      throw err;
    }
  }

  let lastStart: { projectId: string; getToken: () => string | undefined; onReady: (api: WorkspaceApi) => void } | null = null;
  let keepAlive: number | undefined;

  return {
    start(projectId, getToken, onReady) {
      lastStart = { projectId, getToken, onReady };
      if (!keepAlive) {
        // Connect's session for the embedded viewer lapses after a while, so hand it a fresh token regularly.
        const renew = () => {
          const fresh = lastStart?.getToken();
          if (fresh) void api?.embed.setTokens({ accessToken: fresh }).catch((err) => console.warn('[section viewer] could not renew the 3D viewer token', err));
        };
        keepAlive = window.setInterval(renew, 5 * 60 * 1000);
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && renew());
      }
      return begin(projectId, getToken, onReady);
    },
    async restart() {
      if (!lastStart) return;
      api = null;
      await begin(lastStart.projectId, lastStart.getToken, lastStart.onReady);
    },
    async refreshToken(token) {
      await api?.embed.setTokens({ accessToken: token });
    },
    async snapToSection() {
      if (api && store.section) await placeCamera(api.viewer, store.section).catch((err) => console.warn('[section viewer] could not move the camera', err));
    },
    invertPlanes() {
      planeSign = planeSign === 1 ? -1 : 1;
      try {
        localStorage.setItem(PLANE_SIGN_KEY, String(planeSign));
      } catch {
        // storage unavailable
      }
      snapNext = false; // the camera is already in place
      seenVersion = -1;
      store.setDepth(store.depth); // re-applies the section with the new direction
    },
    async select(ref) {
      if (!api) return;
      await api.viewer.setSelection(selector([ref]), 'set').catch((err) => console.warn('[section viewer] could not select', refKey(ref), err));
    },
    onModelsChanged(callback) {
      modelsChanged = callback;
    },
  };
}

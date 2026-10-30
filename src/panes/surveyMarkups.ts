import { clipToSlab, inSlab } from '../core/section';
import { store } from '../state/store';
import { surveyStore } from '../state/survey';
import type { V3 } from '../survey/linework';
import type { WorkspaceApi } from '../connect/workspace';

/** Most points and line pieces drawn in the 3D view at once, so the viewer stays responsive. */
const MAX_POINTS = 3000;
const MAX_SEGMENTS = 20000;
/** How far either side of the slab survey data is still drawn (metres) */
const TOLERANCE = 0.25;

const rgba = (hex: string, a = 255) => {
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a } : { r: 90, g: 104, b: 117, a };
};
const mm = (x: number, y: number, z: number) => ({ positionX: x * 1000, positionY: y * 1000, positionZ: z * 1000 });

/**
 * Draws the visible survey data in the embedded 3D viewer as markups: points as point markups and linework as
 * freeline markups, each in its feature library colour. With a section drawn, only what lies inside the cut (and
 * a little either side) is drawn, so the survey shows against the cut model. Points without a height are placed
 * at the bottom of the section. The point under the mouse on the map gets a label.
 */
export function createSurveyMarkups(getApi: () => WorkspaceApi | null): { refresh: () => void; onReset: () => void } {
  let ours: number[] = [];
  let label: number[] = [];
  let busy = false;
  let again = false;

  const remove = async (api: WorkspaceApi, ids: number[]) => {
    if (!ids.length) return;
    await api.markup.removeMarkups(ids).catch((err) => console.warn('[section viewer] could not remove survey markups', err));
  };

  const draw = async () => {
    const api = getApi();
    if (!api) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        await remove(api, ours);
        ours = [];
        if (!surveyStore.show3d) continue;
        const s = store.section;
        const floor = s ? s.zMin : 0;
        const z = (v: number | null) => v ?? floor;

        type Markups = WorkspaceApi['markup'];
        const pointMarkups: Parameters<Markups['addSinglePointMarkups']>[0] = [];
        const lineMarkups: Parameters<Markups['addFreelineMarkups']>[0] = [];
        let segments = 0;
        for (const { points, strings } of surveyStore.visible()) {
          for (const p of points) {
            if (pointMarkups.length >= MAX_POINTS) break;
            if (s && !inSlab(s, p.x, p.y, TOLERANCE)) continue;
            pointMarkups.push({ color: rgba(p.color), start: mm(p.x, p.y, z(p.z)) });
          }
          for (const str of strings) {
            const lines: { start: ReturnType<typeof mm>; end: ReturnType<typeof mm> }[] = [];
            for (let i = 0; i + 1 < str.coords.length && segments < MAX_SEGMENTS; i++) {
              const a: V3 = str.coords[i];
              const b: V3 = str.coords[i + 1];
              let t: [number, number] | null = [0, 1];
              if (s) t = clipToSlab(s, [a[0], a[1]], [b[0], b[1]], TOLERANCE);
              if (!t) continue;
              const at = (f: number) => mm(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, z(a[2]) + (z(b[2]) - z(a[2])) * f);
              lines.push({ start: at(t[0]), end: at(t[1]) });
              segments++;
            }
            if (lines.length) lineMarkups.push({ color: rgba(str.color), lines: lines.map((l) => ({ ...l, color: rgba(str.color) })) });
          }
        }
        if (pointMarkups.length) {
          const added = await api.markup.addSinglePointMarkups(pointMarkups);
          ours.push(...added.map((m) => m.id).filter((id): id is number => typeof id === 'number'));
        }
        if (lineMarkups.length) {
          const added = await api.markup.addFreelineMarkups(lineMarkups);
          ours.push(...added.map((m) => m.id).filter((id): id is number => typeof id === 'number'));
        }
        console.info('[section viewer] survey drawn in 3D', { points: pointMarkups.length, lines: lineMarkups.length, segments, clippedToSection: !!s });
      } while (again);
    } catch (err) {
      console.warn('[section viewer] could not draw the survey data in 3D', err);
    } finally {
      busy = false;
    }
  };

  // The point under the mouse on the map: a label on a short leader above it.
  let labelling = false;
  const drawLabel = async () => {
    const api = getApi();
    if (!api || labelling) return;
    labelling = true;
    try {
      await remove(api, label);
      label = [];
      const p = surveyStore.point(surveyStore.hover);
      if (!p || !surveyStore.show3d) return;
      const base = p.z ?? store.section?.zMin ?? 0;
      const added = await api.markup.addTextMarkup([{ color: rgba('#f5a300'), start: mm(p.x, p.y, base), end: mm(p.x, p.y, base + 1.5), text: `${p.name}${p.code ? ` ${p.code}` : ''}` }]);
      label = added.map((m) => m.id).filter((id): id is number => typeof id === 'number');
    } catch (err) {
      console.warn('[section viewer] could not label the survey point', err);
    } finally {
      labelling = false;
    }
  };

  let timer: number | undefined;
  const refresh = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void draw(), 250);
  };
  let seenSurvey = -1;
  let seenSection = -1;
  let seenHover: unknown = undefined;
  const watch = () => {
    if (surveyStore.version !== seenSurvey || store.sectionVersion !== seenSection) {
      seenSurvey = surveyStore.version;
      seenSection = store.sectionVersion;
      refresh();
    }
    if (surveyStore.hover !== seenHover) {
      seenHover = surveyStore.hover;
      void drawLabel();
    }
  };
  surveyStore.subscribe(watch);
  store.subscribe(watch);

  return {
    refresh,
    // The viewer was loaded again: its markups are gone, so forget their ids and draw afresh.
    onReset: () => {
      ours = [];
      label = [];
      refresh();
    },
  };
}

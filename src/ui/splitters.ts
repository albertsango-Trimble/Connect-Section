const STORAGE_KEY = 'connectsection.layout';
const MIN = 0.15;
const MAX = 0.85;
const GAP = 6; // splitter thickness in px, keep in sync with styles.css
const DEFAULT = 0.45;

const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

function load(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(v) && v > 0) return clamp(v);
  } catch {
    // Storage can be blocked; fall back to the default.
  }
  return DEFAULT;
}

/**
 * Makes the map and 3D panes resizable with the splitter between them.
 * Double-click the splitter to reset. The width is remembered per browser.
 */
export function initSplitter(grid: HTMLElement, handle: HTMLElement): void {
  let col = load();
  const apply = () => (grid.style.gridTemplateColumns = `${col * 100}fr ${GAP}px ${(1 - col) * 100}fr`);
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(col));
    } catch {
      // Not critical.
    }
  };

  handle.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    handle.classList.add('active');
    document.body.classList.add('resizing');
    const move = (e: PointerEvent) => {
      const rect = grid.getBoundingClientRect();
      col = clamp((e.clientX - rect.left - GAP / 2) / (rect.width - GAP));
      apply();
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  handle.addEventListener('dblclick', () => {
    col = DEFAULT;
    apply();
    save();
  });
  apply();
}

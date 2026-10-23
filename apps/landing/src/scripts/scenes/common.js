// Shared by the scenes' small loader and the lazy world: which sun phase to light, the product
// accent as a colour, whether motion is allowed, and how far a stage has scrolled. Phase and accent
// come from vibekit's plain (no Svelte) entry, so the scenes follow the same day as the apps.
import { ACCENTS, ACCENT_HUES, PHASES, PRODUCT_ACCENTS, phaseAt } from '@superjackfruit/vibekit/appearance';

export const PRODUCT = 'agentpod';

/** The visitor's local sun phase. A vibekit page that turned time of day off gets plain noon. */
export function scenePhase() {
  const html = document.documentElement;
  if (html.dataset.time === 'off') return 'noon';
  return PHASES.includes(html.dataset.phase) ? html.dataset.phase : phaseAt(new Date());
}

/** The accent's OKLCH hue as linear-sRGB [r, g, b], at a lamp-like lightness and chroma. */
export function accentRGB(L = 0.74, C = 0.13) {
  const pick = document.documentElement.dataset.accent;
  const h = (ACCENT_HUES[ACCENTS.includes(pick) ? pick : PRODUCT_ACCENTS[PRODUCT]] * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const c = (v) => Math.min(1, Math.max(0, v));
  return [c(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), c(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), c(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

const rm = matchMedia('(prefers-reduced-motion: reduce)');
/** The system setting or vibekit's data-motion="reduce": either one keeps every scene a still. */
export const reducedMotion = () => rm.matches || document.documentElement.dataset.motion === 'reduce';
export const onMotionChange = (fn) => {
  rm.addEventListener('change', fn);
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
};

export function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch { return false; }
}

export const clamp = (v) => Math.min(1, Math.max(0, v));
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
/** How far a stage has scrolled through the viewport, 0 (entering) to 1 (gone). Native scroll only. */
export function stageProgress(el) {
  const r = el.getBoundingClientRect();
  return clamp((innerHeight - r.top) / (innerHeight + r.height));
}

/**
 * Where a stage's scene stands, read from native scroll: the beats done plus the current beat's
 * part, 0 to n. A pinned stage beside a list of steps follows the steps: each step's beat plays
 * while that step crosses the middle of the viewport. Any other stage plays as it rises into view
 * (its pinned column, for a sticky one); its beat is data-beat. Scrolling back reverses it.
 */
export function timeline(stage) {
  const steps = stage.classList.contains('pinned') && stage.closest('[data-steps]');
  if (steps) {
    const mid = innerHeight / 2;
    let v = 0;
    for (const st of steps.querySelectorAll('[data-step]')) {
      const r = st.getBoundingClientRect();
      v += clamp(((mid - r.top) / r.height - 0.1) / 0.55);
    }
    return v;
  }
  return (+stage.dataset.beat || 1) - 1 + clamp((stageProgress(stage.closest('.pin') ?? stage) - 0.2) / 0.4);
}
/** The timeline value a stage's still shows: the end of its beat. */
export const stillAt = (stage) => +stage.dataset.beat || 1;

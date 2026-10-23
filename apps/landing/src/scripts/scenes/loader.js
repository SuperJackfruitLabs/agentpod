// The scenes' loader: the only scene code in the first page load. Every `.stage[data-scene]` gets
// the still for the visitor's sun phase at once. three and the world (world.js) are fetched only
// when the first stage nears the viewport and the page's own load is done, so the hero is
// untouched. Reduced motion (the system setting or vibekit's data-motion="reduce"), no WebGL and a
// lost context all keep the stills. Every label and line of copy is HTML in the page either way.
//
// A section with several steps (`[data-steps]`) has one pinned stage beside them on a wide screen,
// and a stage above each step on a narrow one. The step crossing the middle of the viewport is the
// current one: the others dim a little, and the pinned stage's still is that step's. The scenes
// themselves are scrubbed by scroll (world.js). Only native scroll is read; nothing is pinned or
// scrolled by script.
import { hasWebGL, onMotionChange, reducedMotion, scenePhase } from './common.js';

const stages = [...document.querySelectorAll('.stage[data-scene]')];
if (stages.length) {
  const phase = scenePhase();
  const still = (s) => {
    const img = s.querySelector('img[data-still]');
    if (img) img.src = `/scenes/${s.dataset.scene}${s.dataset.beat ? `-${s.dataset.beat}` : ''}-${phase}.webp`;
  };
  stages.forEach(still);
  let world = null, loading = false;

  for (const box of document.querySelectorAll('[data-steps]')) {
    const pinned = box.querySelector('.stage.pinned');
    const steps = [...box.querySelectorAll('[data-step]')];
    const at = new IntersectionObserver((es) => {
      const e = es.filter((x) => x.isIntersecting).pop();
      if (!e) return;
      const beat = e.target.dataset.step;
      box.classList.add('walking');
      steps.forEach((st) => st.classList.toggle('current', st === e.target));
      if (pinned && pinned.dataset.beat !== beat) {
        pinned.dataset.beat = beat;
        still(pinned);
      }
    }, { rootMargin: '-50% 0px -50% 0px' });
    steps.forEach((st) => at.observe(st));
  }

  function stop() {
    world?.dispose();
    world = null;
    for (const s of stages) s.classList.remove('live', 'pending');
  }
  async function start() {
    if (world || loading || reducedMotion() || !hasWebGL()) return;
    loading = true;
    // While the world loads no still shows, so none shows a state the scene then rewinds from.
    for (const s of stages) s.classList.add('pending');
    try {
      const { mountWorld } = await import('./world.js');
      if (reducedMotion()) return stop();
      world = mountWorld(stages, { phase, onLost: stop });
      if (!world) stop();
    } catch { stop(); } finally { loading = false; }
  }

  // Not before the page's own load is done, so three never competes with the hero for bandwidth.
  const loaded = document.readyState === 'complete' ? Promise.resolve() : new Promise((r) => addEventListener('load', r, { once: true }));
  const near = new Set();
  const io = new IntersectionObserver((es) => {
    for (const e of es) e.isIntersecting ? near.add(e.target) : near.delete(e.target);
    if (near.size) loaded.then(start);
  }, { rootMargin: '300px 0px' });
  stages.forEach((s) => io.observe(s));
  onMotionChange(() => { if (reducedMotion()) stop(); else if (near.size) loaded.then(start); });

  // Renders the stills in public/scenes (scripts/render-stills.mjs): ?scene-still exposes a hook
  // that draws one scene at one beat, settled, for one phase and returns it as a WebP.
  if (new URLSearchParams(location.search).has('scene-still')) {
    window.__sceneStill = async (scene, p, beat) => {
      stop();
      const { renderStill } = await import('./world.js');
      // The stage this viewport shows: a pinned stage on a wide screen, the per-step ones on a narrow one.
      return renderStill(stages.find((s) => s.dataset.scene === scene && s.offsetWidth), p, beat);
    };
  }
}

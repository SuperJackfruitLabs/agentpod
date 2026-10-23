// One renderer and one canvas for every scene on the page. Loaded by loader.js only when the first
// stage nears the viewport.
//
// Each stage holds a still. The canvas moves into whichever stage is most in view, draws that
// stage's scene there, and leaves it when another stage takes over.
//
// Every movement is scrubbed by native scroll, never played on a timer: a scene's timeline is read
// from where its stage, or the step beside it, is on screen (common.js timeline), and the scene
// follows it with a light damping. Scrolling back reverses it. A scene can have beats, one per step
// of a section (1 to n); each beat is one movement, and the beats before it are shown done. A stage
// without the canvas shows its still (its beat, done) once scroll has passed that point, and nothing
// before it, so it never shows a later state than the scene would.
//
// Calm by construction: no post-processing, no auto-orbit, no animation loop of its own. A frame is
// drawn only while the timeline, the camera or the stage's size is changing, and drawing stops once
// it has settled. Scroll turns the camera at most 3° across a stage.
import { Color, DirectionalLight, HemisphereLight, PCFShadowMap, PerspectiveCamera, Scene, SpotLight, Vector3, WebGLRenderer } from 'three';
import { accentRGB, stageProgress, stillAt, timeline } from './common.js';
import { disposeMaterials } from './kit.js';
import fleet from './fleet.js';
import dialOut from './dial-out.js';

const SCENES = { fleet, 'dial-out': dialOut };

// Sun direction (degrees: elevation, azimuth from the front, + to the right), colour and sky per
// phase. The same table as the other SJL landing pages, so their scenes share one day.
const PHASE = {
  dawn: { el: 14, az: -58, sun: '#ffc8ae', i: 1.7, sky: '#d4d6f2', ground: '#7d6a60', hemi: 1.0, lamp: 0 },
  morning: { el: 58, az: -34, sun: '#e9f1ff', i: 2.3, sky: '#d2e3ff', ground: '#8a8274', hemi: 1.15, lamp: 0 },
  noon: { el: 70, az: 18, sun: '#fff7ec', i: 2.4, sky: '#ebeef4', ground: '#8f8578', hemi: 1.15, lamp: 0 },
  golden: { el: 11, az: 62, sun: '#ffaa55', i: 2.6, sky: '#ffd8b4', ground: '#6b5240', hemi: 0.75, lamp: 0 },
  dusk: { el: 5, az: 70, sun: '#ff9478', i: 1.0, sky: '#8c80b4', ground: '#3d3242', hemi: 0.75, lamp: 0.45 },
  night: { el: 48, az: -30, sun: '#8ea2d8', i: 0.35, sky: '#3a4266', ground: '#1a1720', hemi: 0.9, lamp: 1 },
};

/** A scene from its definition, lit for a phase. `night` lets a scene turn on its own lights. */
function make(name, phase, small) {
  const def = SCENES[name];
  const P = PHASE[phase] ?? PHASE.noon;
  const scene = new Scene();
  const accent = new Color().setRGB(...accentRGB());
  const parts = def.build(scene, { accent, night: phase === 'night' ? 1 : phase === 'dusk' ? 0.5 : 0 });
  const sun = new DirectionalLight(P.sun, P.i);
  const el = (P.el * Math.PI) / 180, az = (P.az * Math.PI) / 180;
  sun.position.set(Math.sin(az) * Math.cos(el) * 8, Math.sin(el) * 8 + 0.8, Math.cos(az) * Math.cos(el) * 8);
  sun.target.position.set(0, 0.6, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(small ? 512 : 1024, small ? 512 : 1024);
  Object.assign(sun.shadow.camera, { near: 0.5, far: 20 }, def.shadow);
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(new HemisphereLight(P.sky, P.ground, P.hemi), sun, sun.target);
  // After dark a soft work light, tinted with the product accent, hangs above the front of the scene.
  if (P.lamp > 0) {
    const [x, y, z] = def.view.look;
    const lamp = new SpotLight(new Color('#fff1dc').lerp(accent, 0.45), 30 * P.lamp, 9, 0.7, 0.8, 1.2);
    lamp.position.set(x - 0.6, y + 3.2, z + 2.6);
    lamp.target.position.set(x, y - 0.2, z);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(512, 512);
    lamp.shadow.bias = -0.001;
    scene.add(lamp, lamp.target);
  }
  const camera = new PerspectiveCamera(def.view.fov ?? 28, 1, 0.1, 60);
  return { def, scene, parts, camera, look: new Vector3(...def.view.look), v: 0, yaw: 0 };
}

/** Shows timeline value `v` (0 to the scene's beats): beat = the one in progress, t = its part. */
function show(w, v) {
  const n = w.def.beats ?? 1;
  const beat = Math.min(n, Math.floor(v) + 1);
  w.parts.set(beat, Math.min(1, v - (beat - 1)));
}

function aim(w, aspect, yaw) {
  const v = w.def.view, c = w.camera;
  c.aspect = aspect;
  // A stage narrower than the scene was framed for steps back, so nothing is cut off at the sides.
  const d = v.dist * Math.max(1, v.aspect / aspect);
  const a = v.yaw + yaw;
  c.position.set(w.look.x + Math.sin(a) * d, w.look.y + d * v.rise, w.look.z + Math.cos(a) * d);
  c.lookAt(w.look);
  c.updateProjectionMatrix();
}

function newRenderer(still) {
  const r = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: still });
  r.setPixelRatio(still ? 1.5 : Math.min(devicePixelRatio || 1, 1.5));
  r.setClearColor(0x000000, 0);
  r.shadowMap.enabled = true;
  r.shadowMap.type = PCFShadowMap;
  r.domElement.setAttribute('aria-hidden', 'true');
  return r;
}

function disposeScene(w) { w.scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }

/**
 * Mounts one renderer for `stages` (sized, positioned elements with data-scene). Returns null when
 * WebGL fails. opts.phase: one of vibekit's PHASES. opts.onLost(): the context was lost.
 */
export function mountWorld(stages, opts) {
  let renderer;
  try { renderer = newRenderer(false); } catch { return null; }
  const canvas = renderer.domElement;
  const small = matchMedia('(pointer: coarse)').matches || innerWidth < 600;
  const worlds = new Map(), ratios = new Map();
  let active = null, raf = 0, last = 0, dirty = false;
  const get = (st) => { if (!worlds.has(st)) worlds.set(st, make(st.dataset.scene, opts.phase, small)); return worlds.get(st); };

  function size() {
    const w = active.clientWidth, h = active.clientHeight;
    if (w && h) renderer.setSize(w, h, false);
  }
  // A stage without the canvas shows its still only once scroll has reached the end of its beat.
  function stills() {
    for (const st of stages) if (st !== active && st.offsetWidth) st.classList.toggle('pending', timeline(st) < stillAt(st) - 0.01);
  }
  function activate(st) {
    if (active) active.classList.remove('live');
    active = st;
    stills();
    if (!st) { canvas.remove(); return; }
    const w = get(st);
    // Arrive where scroll already is: no catching up from the start.
    w.v = timeline(st);
    w.yaw = yawAt(st);
    st.classList.add('pending');
    st.appendChild(canvas);
    size();
    request();
  }
  // The stage most in view gets the canvas; one only just in view keeps it until another is further in.
  function pick() {
    let best = null, top = 0;
    for (const [st, r] of ratios) if (r > top) { top = r; best = st; }
    const next = top >= 0.4 ? best : active && ratios.get(active) > 0 ? active : null;
    if (next !== active) activate(next);
  }
  const yawAt = (st) => ((stageProgress(st) - 0.5) * 3 * Math.PI) / 180; // ±1.5°: 3° across the stage

  function frame(now) {
    raf = 0;
    if (!active) return;
    const w = get(active);
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    const k = 1 - Math.exp(-dt * 9);
    let moving = false;
    const to = timeline(active), yawTo = yawAt(active);
    if (Math.abs(to - w.v) > 1e-4) { w.v += (to - w.v) * k; moving = true; } else w.v = to;
    if (Math.abs(yawTo - w.yaw) > 1e-5) { w.yaw += (yawTo - w.yaw) * k; moving = true; }
    show(w, w.v);
    aim(w, active.clientWidth / Math.max(1, active.clientHeight), w.yaw);
    renderer.render(w.scene, w.camera);
    active.classList.add('live');
    if (moving || dirty) { dirty = false; raf = requestAnimationFrame(frame); } else last = 0;
  }
  function request() { dirty = true; if (!raf) raf = requestAnimationFrame(frame); }

  const io = new IntersectionObserver((es) => {
    for (const e of es) ratios.set(e.target, e.isIntersecting ? e.intersectionRatio : 0);
    pick();
  }, { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] });
  stages.forEach((s) => io.observe(s));
  const ro = new ResizeObserver(() => { if (active) { size(); request(); } });
  stages.forEach((s) => ro.observe(s));
  const onScroll = () => { stills(); if (active) request(); };
  addEventListener('scroll', onScroll, { passive: true });
  canvas.addEventListener('webglcontextlost', () => opts.onLost?.());
  stills();

  return {
    dispose() {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      removeEventListener('scroll', onScroll);
      worlds.forEach(disposeScene);
      disposeMaterials();
      renderer.dispose();
      canvas.remove();
    },
  };
}

/** One scene at one beat, settled and seen straight on, for one phase, as a WebP data URL: the stills' source. */
export async function renderStill(stage, phase, beat = 1) {
  const renderer = newRenderer(true);
  const w = make(stage.dataset.scene, phase, false);
  renderer.setSize(stage.clientWidth, stage.clientHeight, false);
  show(w, beat);
  aim(w, stage.clientWidth / stage.clientHeight, 0);
  renderer.render(w.scene, w.camera);
  const url = renderer.domElement.toDataURL('image/webp', 0.86);
  disposeScene(w);
  disposeMaterials();
  renderer.dispose();
  return url;
}

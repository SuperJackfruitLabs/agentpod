// Renders the scenes' stills, one WebP per scene (and beat) and sun phase, into public/scenes/. They are what
// reduced motion, no WebGL and a lost context show, and what a stage shows once its scene has played.
//
// Usage: PLAYWRIGHT=<path to playwright's index.mjs> node scripts/render-stills.mjs [base-url]
// (default base: http://127.0.0.1:4397/, `pnpm exec astro dev --port 4397 --host 127.0.0.1`).
// Playwright is not a landing dependency, so point PLAYWRIGHT at a checkout that has it; Chrome must
// be installed. The page opens with ?scene-still, which exposes a hook (src/scripts/scenes/loader.js)
// that draws one scene, settled, at 1.5x and returns a WebP.
import fs from 'node:fs';

const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:4397/';
const out = new URL('../public/scenes/', import.meta.url).pathname;
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: 'chrome', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 });
await p.goto(new URL('?scene-still', base).href, { waitUntil: 'load' });
await p.waitForFunction(() => window.__sceneStill);
// One still per scene, or per scene and beat when the stage has beats (data-beat; the pinned stage
// of a list of steps carries all of them).
const scenes = await p.$$eval('.stage[data-scene]', (els) => [...new Set(els.map((e) => {
  const n = e.closest('[data-steps]')?.querySelectorAll('[data-step]').length;
  return e.dataset.beat ? `${e.dataset.scene}:${n || 1}` : e.dataset.scene;
}))]);
for (const entry of scenes) {
  const [scene, n] = entry.split(':');
  for (const beat of n ? Array.from({ length: +n }, (_, i) => i + 1) : [undefined]) {
    for (const phase of ['dawn', 'morning', 'noon', 'golden', 'dusk', 'night']) {
      const url = await p.evaluate(([s, ph, bt]) => window.__sceneStill(s, ph, bt), [scene, phase, beat]);
      const buf = Buffer.from(url.split(',')[1], 'base64');
      const name = `${scene}${beat ? `-${beat}` : ''}-${phase}.webp`;
      fs.writeFileSync(`${out}${name}`, buf);
      console.log(`${name} ${(buf.length / 1024).toFixed(1)} KB`);
    }
  }
}
await b.close();

// "How it works", one beat per step. One machine and the hub: a rack of five bays holds four pods
// (the agent runtimes on the host) and one empty bay, the node agent sits on top, and the hub
// stands apart with a row on its console for each station.
//   1. Install: a light leaves the node agent and travels out to the hub. The link starts at the
//      machine; the hub's node light comes on when it arrives.
//   2. It finds the agents there: a thin light crosses the bays once, and each pod it passes lights
//      as a station, with its row on the hub. The empty bay stays dark: detection finds what is
//      running and creates nothing.
//   3. You work from the console: a light comes back from the hub down the same link to the first
//      station, which is marked adopted on both ends. Nothing reaches the machine except over the
//      link it opened.
import { CatmullRomCurve3, Group, IcosahedronGeometry, Mesh, TubeGeometry, Vector3 } from 'three';
import { box, mat, plinth } from './kit.js';
import { clamp, smooth } from './common.js';

const BAYS = 5, EMPTY = 3, BW = 0.36, T = 0.04, H = 0.86, D = 0.8;
const W = BAYS * BW + (BAYS + 1) * T, RX = -0.62;
const GREEN = '#63c9a0', OFF = '#232c36'; // the page's own --green for a live station
const SEG = 64, RADIAL = 6;

const glowing = (m, c, k) => { m.color.set(c); m.emissive.set(c).multiplyScalar(k); };

export default {
  view: { look: [0.12, 0.6, 0.1], dist: 7.3, rise: 0.36, yaw: -0.3, aspect: 4 / 3, fov: 28 },
  shadow: { left: -2.8, right: 2.8, top: 2.4, bottom: -1.4 },
  duration: 2200,
  build(scene, { accent, night }) {
    const root = new Group();
    scene.add(root);
    const top = plinth(4.3, 2.0, root);
    const frame = mat('#24313f'), inside = mat('#141c26'), pod = mat('#4a5a6d'), podDark = mat('#3a4858');
    const lit = 0.7 + 0.5 * night;

    // The rack: a base rail, then a hollow carcass so the empty bay is a real gap.
    const y0 = top + 0.08;
    box(W + 0.06, 0.08, D + 0.04, frame, RX, top + 0.04, 0, root);
    box(W + 0.06, T * 1.5, D + 0.06, frame, RX, y0 + H + T * 0.75, 0, root);
    box(W, H, T, inside, RX, y0 + H / 2, -D / 2 + T / 2, root);
    for (let c = 0; c <= BAYS; c++) box(T, H, D, frame, RX - W / 2 + T / 2 + c * (BW + T), y0 + H / 2, 0, root);
    box(W, T, D, frame, RX, y0 + T / 2, 0, root);
    const pods = [];
    for (let i = 0; i < BAYS; i++) {
      if (i === EMPTY) continue;
      const x = RX - W / 2 + T + BW / 2 + i * (BW + T), ph = H - T - 0.05, fz = D / 2 - 0.025;
      box(BW - 0.03, ph, D - 0.1, i % 2 ? podDark : pod, x, y0 + T + ph / 2, 0.02, root);
      for (const v of [0.12, 0.2]) box(BW - 0.14, 0.014, 0.01, inside, x, y0 + T + v, fz, root);
      // The station light, dark until detection reaches this pod, and the adopted tag beside it.
      const led = box(0.1, 0.035, 0.012, mat(OFF, true), x - 0.05, y0 + H - 0.14, fz, root);
      const tag = box(0.05, 0.035, 0.012, mat(OFF, true), x + 0.07, y0 + H - 0.14, fz, root);
      led.castShadow = tag.castShadow = false;
      pods.push({ x, led: led.material, tag: tag.material });
    }
    // The node agent: a small unit on the rack's top, with an accent stripe.
    const unitY = y0 + H + T * 1.5, ux = RX - W / 2 + 0.42;
    box(0.56, 0.14, 0.4, mat('#2c3a4a'), ux, unitY + 0.07, 0.05, root);
    const stripe = box(0.44, 0.025, 0.012, mat('#ffffff', true), ux, unitY + 0.07, 0.255, root).material;
    stripe.color.copy(accent);
    stripe.emissive.copy(accent).multiplyScalar(0.5);

    // The hub, apart from the machine: a node light on top, and one console row per station.
    const hx = 1.45, hz = -0.25, hy = top + 0.65;
    box(0.66, 1.3, 0.56, mat('#2c3a4a'), hx, hy, hz, root);
    box(0.5, 0.5, 0.01, inside, hx, hy + 0.12, hz + 0.285, root);
    const nodeLed = box(0.14, 0.03, 0.01, mat(OFF, true), hx, hy + 0.48, hz + 0.285, root).material;
    const rows = pods.map((_, i) => {
      const r = box(0.38, 0.05, 0.006, mat(OFF, true), hx, hy + 0.3 - i * 0.1, hz + 0.292, root);
      r.castShadow = false;
      return r.material;
    });

    // The link the node opens: from the unit, up and across, into the hub's side.
    const path = new CatmullRomCurve3([
      [ux, unitY + 0.14, 0.05], [ux + 0.1, unitY + 0.55, 0.05], [0.25, unitY + 0.78, 0], [0.85, unitY + 0.6, -0.15], [hx - 0.33, hy + 0.4, hz],
    ].map((p) => new Vector3(...p)));
    root.add(new Mesh(new TubeGeometry(path, SEG, 0.016, RADIAL), mat('#3a4858')));
    const glow = new Mesh(new TubeGeometry(path, SEG, 0.019, RADIAL), mat('#ffffff', true));
    glow.material.color.copy(accent);
    glow.material.emissive.copy(accent).multiplyScalar(0.45);
    glow.castShadow = false;
    const bead = new Mesh(new IcosahedronGeometry(0.05, 0), mat('#ffffff', true));
    bead.material.emissive.copy(accent).lerp(bead.material.color, 0.4);
    root.add(glow, bead);
    // The detection pass: a thin bar of accent light in front of the bays.
    const bar = box(0.03, H - 0.06, 0.02, mat('#ffffff', true), 0, y0 + H / 2, D / 2 + 0.03, root);
    bar.castShadow = false;
    bar.material.color.copy(accent);
    bar.material.emissive.copy(accent);
    const from = RX - W / 2 - 0.05, to = RX + W / 2 + 0.05, perSeg = RADIAL * 6, at = new Vector3();

    return {
      set(beat, t) {
        const b = (k) => (k < beat ? 1 : k > beat ? 0 : t);
        // 1: out along the link.
        const out = smooth(clamp(b(1) / 0.85)), linked = b(1) >= 0.85 || beat > 1;
        glow.geometry.setDrawRange(0, Math.round(out * SEG) * perSeg);
        glowing(nodeLed, linked ? GREEN : OFF, linked ? lit : 0);
        // 2: the detection pass.
        const x = from + (to - from) * smooth(b(2));
        bar.visible = beat === 2 && t > 0 && t < 1;
        bar.position.x = x;
        pods.forEach((p, i) => {
          const found = b(2) >= 1 || (beat === 2 && t > 0 && x > p.x);
          glowing(p.led, found ? GREEN : OFF, found ? lit : 0);
          glowing(rows[i], found ? GREEN : OFF, found ? lit * 0.8 : 0);
        });
        // 3: back down the same link to the first station.
        const back = smooth(clamp(b(3) / 0.85)), adopted = b(3) >= 0.85;
        const moving = (beat === 1 && t > 0 && !linked) || (beat === 3 && t > 0 && !adopted);
        bead.visible = moving;
        path.getPointAt(beat === 3 ? 1 - back : Math.min(out, 1), at);
        bead.position.copy(at);
        if (adopted) pods[0].tag.color.copy(accent); else pods[0].tag.color.set(OFF);
        pods[0].tag.emissive.copy(accent).multiplyScalar(adopted ? 0.8 : 0);
        if (adopted) { rows[0].color.copy(accent); rows[0].emissive.copy(accent).multiplyScalar(0.7); }
      },
    };
  },
};

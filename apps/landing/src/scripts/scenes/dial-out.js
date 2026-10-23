// "What it's like to use": the laptop behind a home router, and the hub outside. Inside two low
// walls sit the laptop and its router; outside stand the hub and a VPS already in the fleet. The
// one movement is the laptop dialling out: a light leaves the laptop, passes the router and travels
// out over the wall to the hub, and the hub's second row lights. Nothing comes in through the wall;
// the connection starts inside, which is why no port is forwarded.
import { CatmullRomCurve3, Group, IcosahedronGeometry, Mesh, TubeGeometry, Vector3 } from 'three';
import { box, mat, plinth } from './kit.js';
import { smooth } from './common.js';

const GREEN = '#63c9a0', OFF = '#232c36';
const SEG = 64, RADIAL = 6;

export default {
  view: { look: [0.12, 0.6, 0.2], dist: 6.2, rise: 0.42, yaw: -0.34, aspect: 4 / 3, fov: 28 },
  shadow: { left: -2.2, right: 2.2, top: 2.2, bottom: -1.6 },
  duration: 2400,
  build(scene, { accent, night }) {
    const root = new Group();
    scene.add(root);
    const top = plinth(3.2, 2.3, root);
    const wall = mat('#c9b9a6'), desk = mat('#8a5a3b'), shell = mat('#2c3a4a'), dark = mat('#141c26');

    // Home: two low walls, the back one and the one between the room and the outside.
    box(1.5, 0.34, 0.08, wall, -0.78, top + 0.17, -0.3, root);
    box(0.08, 0.34, 1.32, wall, -0.03, top + 0.17, 0.32, root);
    // The laptop on a low table, and the router beside the wall.
    box(0.7, 0.05, 0.46, desk, -0.82, top + 0.2, 0.36, root);
    for (const [x, z] of [[-1.13, 0.17], [-0.51, 0.17], [-1.13, 0.55], [-0.51, 0.55]]) box(0.04, 0.18, 0.04, desk, x, top + 0.09, z, root);
    const ly = top + 0.225;
    box(0.44, 0.022, 0.3, mat('#9aa6b3'), -0.82, ly + 0.011, 0.38, root);
    const lid = new Group();
    lid.position.set(-0.82, ly + 0.022, 0.23);
    lid.rotation.x = -0.32;
    box(0.44, 0.3, 0.018, mat('#9aa6b3'), 0, 0.15, 0, lid);
    const screen = box(0.4, 0.26, 0.004, mat('#ffffff', true), 0, 0.15, 0.011, lid);
    screen.material.color.set('#1d2733');
    screen.material.emissive.copy(accent).multiplyScalar(0.18 + 0.2 * night);
    root.add(lid);
    const lapLed = box(0.03, 0.01, 0.01, mat(OFF, true), -0.66, ly + 0.017, 0.535, root);
    box(0.3, 0.07, 0.2, shell, -0.3, top + 0.035, 0.62, root);
    for (const x of [-0.41, -0.19]) box(0.016, 0.2, 0.016, shell, x, top + 0.17, 0.54, root);
    const routerLed = box(0.03, 0.012, 0.01, mat('#ffffff', true), -0.36, top + 0.045, 0.725, root);
    routerLed.material.color.set(GREEN);
    routerLed.material.emissive.set(GREEN).multiplyScalar(0.6);

    // Outside: the hub, with a console face of two rows, and a VPS whose row is lit already.
    const hx = 0.95, hz = -0.35;
    box(0.72, 1.12, 0.62, shell, hx, top + 0.56, hz, root);
    box(0.56, 0.42, 0.01, dark, hx, top + 0.78, hz + 0.315, root);
    const row = (y, on) => {
      const r = box(0.44, 0.06, 0.006, mat(OFF, true), hx, top + y, hz + 0.322, root);
      r.castShadow = false;
      if (on) { r.material.color.set(GREEN); r.material.emissive.set(GREEN).multiplyScalar(0.55); }
      return r;
    };
    row(0.88, true);
    const laptopRow = row(0.76, false);
    box(0.56, 0.2, 0.44, shell, 1.0, top + 0.1, 0.72, root);
    const vpsLed = box(0.08, 0.025, 0.01, mat('#ffffff', true), 0.84, top + 0.13, 0.945, root);
    vpsLed.material.color.set(GREEN);
    vpsLed.material.emissive.set(GREEN).multiplyScalar(0.6);

    const tube = (pts) => new TubeGeometry(new CatmullRomCurve3(pts.map((p) => new Vector3(...p))), SEG, 0.016, RADIAL);
    const cable = mat('#3a4858');
    // The VPS's own link to the hub, lit: it dialled out the same way, earlier.
    const vps = new Mesh(tube([[1.05, top + 0.12, 0.49], [1.05, top + 0.1, 0.2], [1.05, top + 0.14, hz + 0.32]]), mat('#ffffff', true));
    vps.material.color.copy(accent);
    vps.material.emissive.copy(accent).multiplyScalar(0.35);
    root.add(vps);
    // The laptop's link: laptop, router, up over the wall, down into the hub's side.
    const path = new CatmullRomCurve3([
      [-0.82, ly + 0.03, 0.2], [-0.42, top + 0.1, 0.5], [-0.3, top + 0.12, 0.6], [-0.12, top + 0.52, 0.45],
      [0.18, top + 0.95, 0.2], [0.48, top + 0.94, -0.16], [hx - 0.36, top + 0.9, hz + 0.05],
    ].map((p) => new Vector3(...p)));
    const dim = new Mesh(new TubeGeometry(path, SEG, 0.016, RADIAL), cable);
    const glow = new Mesh(new TubeGeometry(path, SEG, 0.019, RADIAL), mat('#ffffff', true));
    glow.material.color.copy(accent);
    glow.material.emissive.copy(accent).multiplyScalar(0.45);
    glow.castShadow = false;
    const bead = new Mesh(new IcosahedronGeometry(0.05, 0), mat('#ffffff', true));
    bead.material.color.set('#ffffff');
    bead.material.emissive.copy(accent).lerp(bead.material.color, 0.4);
    root.add(dim, glow, bead);
    const perSeg = RADIAL * 6, at = new Vector3();

    return {
      set(_beat, t) {
        const p = smooth(t / 0.85), arrived = t >= 0.85;
        glow.geometry.setDrawRange(0, Math.round(p * SEG) * perSeg);
        bead.visible = t > 0 && !arrived;
        path.getPointAt(Math.min(p, 1), at);
        bead.position.copy(at);
        for (const r of [laptopRow, lapLed]) {
          r.material.color.set(arrived ? GREEN : OFF);
          r.material.emissive.set(GREEN).multiplyScalar(arrived ? 0.6 : 0);
        }
      },
    };
  },
};

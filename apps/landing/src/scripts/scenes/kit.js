// The pieces every scene is built from: flat-shaded Lambert materials and boxes. Nothing is
// loaded from a file; every object on the page is made here, in code.
import { BoxGeometry, Mesh, MeshLambertMaterial } from 'three';

const cache = new Map();
/** A flat-shaded material, shared by colour. Pass `own` for one the scene will change (a light). */
export function mat(color, own = false) {
  if (!own && cache.has(color)) return cache.get(color);
  const m = new MeshLambertMaterial({ color, flatShading: true });
  if (!own) cache.set(color, m);
  return m;
}
export const disposeMaterials = () => { cache.forEach((m) => m.dispose()); cache.clear(); };

export function box(w, h, d, m, x = 0, y = 0, z = 0, parent) {
  const b = new Mesh(new BoxGeometry(w, h, d), m);
  b.position.set(x, y, z);
  b.castShadow = b.receiveShadow = true;
  parent?.add(b);
  return b;
}

/** The plinth every scene stands on: two flat stone steps, as on the other SJL landing pages. */
export function plinth(w, d, parent) {
  box(w, 0.25, d, mat('#d6cdc1'), 0, 0.125, 0, parent);
  box(w - 0.3, 0.06, d - 0.26, mat('#e4ddd3'), 0, 0.28, 0, parent);
  return 0.31; // the top
}

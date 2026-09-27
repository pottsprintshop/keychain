// Meshes from the layer polygons: the preview draws them, and the STL exports (single and batch) are
// written from them, so what you see is what you print.

import * as THREE from 'three';
import { stlFromGeometries } from './exporters.js';

// A 0.1-0.2 micron deterministic nudge per vertex. Perfectly aligned holes (a QR code's modules all
// share exact row edges) make the cap triangulator produce open edges; breaking the ties fixes that,
// and 0.2 um is far below anything a printer can resolve.
function nudge(x, y) {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const g = Math.sin(x * 39.3468 + y * 11.135) * 24634.6345;
  return [x + ((h - Math.floor(h)) - 0.5) * 2e-4, y + ((g - Math.floor(g)) - 0.5) * 2e-4];
}

export function layerGeometry(polys, z0, z1) {
  const v = ([x, y]) => new THREE.Vector2(...nudge(x, y));
  const shapes = polys.map(({ outer, holes }) => {
    const shape = new THREE.Shape(outer.map(v));
    shape.holes = holes.map((h) => new THREE.Path(h.map(v)));
    return shape;
  });
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth: z1 - z0,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  });
  g.translate(0, 0, z0);
  return g;
}


// Triangles as flat [x,y,z] * 3 arrays, from a (possibly indexed) geometry.
function trianglesOf(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  return Array.from(g.attributes.position.array);
}

// Drop the triangles (from a flat triangle array) that lie flat at height z (a slab's top or bottom cap).
function withoutCapAt(triangles, z) {
  const out = [];
  for (let t = 0; t < triangles.length; t += 9) {
    const flat = Math.abs(triangles[t + 2] - z) < 1e-6 && Math.abs(triangles[t + 5] - z) < 1e-6 && Math.abs(triangles[t + 8] - z) < 1e-6;
    if (!flat) for (let k = 0; k < 9; k++) out.push(triangles[t + k]);
  }
  return out;
}

// A flat cap over `polys` at height z: the ceiling of a pocket cut into the underside (faceDown) or the floor of
// one cut into the front (faceDown = false).
function flatCap(polys, z, faceDown) {
  const v = ([x, y]) => new THREE.Vector2(...nudge(x, y));
  const shapes = polys.map(({ outer, holes }) => {
    const shape = new THREE.Shape(outer.map(v));
    shape.holes = holes.map((h) => new THREE.Path(h.map(v)));
    return shape;
  });
  const a = trianglesOf(new THREE.ShapeGeometry(shapes)); // faces up (+Z) by default
  const out = [];
  for (let t = 0; t < a.length; t += 9) {
    if (faceDown) out.push(a[t], a[t + 1], z, a[t + 6], a[t + 7], z, a[t + 3], a[t + 4], z); // swap two vertices to flip it
    else out.push(a[t], a[t + 1], z, a[t + 3], a[t + 4], z, a[t + 6], a[t + 7], z);
  }
  return out;
}

function geometryFrom(triangles) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
  return g;
}

// The base is more than one slab when something is recessed into it — the underside (back content, a wall
// hanger), the front (embedded text + outline), or both, sharing its thickness from opposite faces. Stacked as
// separate solids their touching faces would double up, so join them into one closed shell: drop the faces where
// slabs meet, and close each pocket's ceiling (or floor) with its own cut outline. `cuts` is `model.baseCuts`.
function joinedBase(slabs, cuts) {
  const geoms = slabs.map((s) => layerGeometry(s.polys, s.z0, s.z1));
  const tris = [];
  slabs.forEach((s, i) => {
    let t = trianglesOf(geoms[i]);
    for (const c of cuts) if (Math.abs(s.z0 - c.z) < 1e-6 || Math.abs(s.z1 - c.z) < 1e-6) t = withoutCapAt(t, c.z);
    tris.push(...t);
  });
  for (const c of cuts) tris.push(...flatCap(c.polys, c.z, c.faceDown));
  geoms.forEach((g) => g.dispose());
  return geometryFrom(tris);
}

// One STL per body. Returns [{ key, name, data }] ready for zipStore.
export function stlFilesFromModel(model, name) {
  const groups = new Map();
  for (const l of model.layers) {
    if (!groups.has(l.key)) groups.set(l.key, []);
    groups.get(l.key).push(l);
  }
  return [...groups].map(([key, layers], i) => {
    const geometries =
      key === 'base' && layers.length > 1 && model.baseCuts && model.baseCuts.length
        ? [joinedBase(layers, model.baseCuts)]
        : layers.map((l) => layerGeometry(l.polys, l.z0, l.z1));
    const data = stlFromGeometries(geometries);
    geometries.forEach((g) => g.dispose());
    return { key, name: `${name}-${i + 1}-${key}.stl`, data };
  });
}

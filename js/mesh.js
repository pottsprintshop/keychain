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

// Drop the triangles that lie flat at height z (a slab's top or bottom cap).
function withoutCapAt(geometry, z) {
  const a = trianglesOf(geometry);
  const out = [];
  for (let t = 0; t < a.length; t += 9) {
    const flat = Math.abs(a[t + 2] - z) < 1e-6 && Math.abs(a[t + 5] - z) < 1e-6 && Math.abs(a[t + 8] - z) < 1e-6;
    if (!flat) for (let k = 0; k < 9; k++) out.push(a[t + k]);
  }
  return out;
}

// A flat cap over `polys` at height z, facing down (the ceiling of a pocket cut into the underside).
function downwardCap(polys, z) {
  const v = ([x, y]) => new THREE.Vector2(...nudge(x, y));
  const shapes = polys.map(({ outer, holes }) => {
    const shape = new THREE.Shape(outer.map(v));
    shape.holes = holes.map((h) => new THREE.Path(h.map(v)));
    return shape;
  });
  const a = trianglesOf(new THREE.ShapeGeometry(shapes));
  const out = [];
  for (let t = 0; t < a.length; t += 9) {
    // swap two vertices so the face points down, and lift to z
    out.push(a[t], a[t + 1], z, a[t + 6], a[t + 7], z, a[t + 3], a[t + 4], z);
  }
  return out;
}

function geometryFrom(triangles) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
  return g;
}

// The base is two slabs when something is recessed into its underside: a lower one (with the pocket cut out)
// and the rest. Stacked as separate solids their touching faces would double up, so join them into one closed
// shell: drop the faces where they meet, and close the pocket's ceiling with the recessed body's outline.
function joinedBase(slabs, back) {
  const [lower, upper] = slabs;
  const z = lower.z1;
  const g1 = layerGeometry(lower.polys, lower.z0, lower.z1);
  const g2 = layerGeometry(upper.polys, upper.z0, upper.z1);
  const tris = [...withoutCapAt(g1, z), ...withoutCapAt(g2, z), ...downwardCap(back.polys, z)];
  g1.dispose();
  g2.dispose();
  return geometryFrom(tris);
}

// One STL per body. Returns [{ key, name, data }] ready for zipStore.
export function stlFilesFromModel(model, name) {
  const groups = new Map();
  for (const l of model.layers) {
    if (!groups.has(l.key)) groups.set(l.key, []);
    groups.get(l.key).push(l);
  }
  const back = (groups.get('back') || groups.get('qr') || [])[0];
  return [...groups].map(([key, layers], i) => {
    const geometries =
      key === 'base' && layers.length === 2 && back
        ? [joinedBase(layers, back)]
        : layers.map((l) => layerGeometry(l.polys, l.z0, l.z1));
    const data = stlFromGeometries(geometries);
    geometries.forEach((g) => g.dispose());
    return { key, name: `${name}-${i + 1}-${key}.stl`, data };
  });
}

// Shared 2D geometry helpers (Clipper). Everything is in mm; Clipper itself works in whole microns,
// so its unions and offsets are exact integer arithmetic and can't fail on awkward outlines.

import '../vendor/clipper.js';

export const CL = globalThis.ClipperLib;
export const SCALE = 1000; // 1 Clipper unit = 1 micron
export const ARC_TOL = 4; // offset arc tolerance, microns
export const MIN_AREA = 0.02; // mm^2, drop slivers smaller than this
export const SIMPLIFY_EPS = 0.015; // mm

// ---- Clipper helpers -------------------------------------------------------

export const toPath = (pts) => pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
export const fromPath = (path) => path.map((p) => [p.X / SCALE, p.Y / SCALE]);

export function polyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function runClipper(type, subject, clip, fill = CL.PolyFillType.pftNonZero) {
  const c = new CL.Clipper();
  c.AddPaths(subject, CL.PolyType.ptSubject, true);
  if (clip) c.AddPaths(clip, CL.PolyType.ptClip, true);
  const tree = new CL.PolyTree();
  c.Execute(type, tree, fill, fill);
  return tree;
}

export const unionTree = (paths, fill) => runClipper(CL.ClipType.ctUnion, paths, null, fill);

export function offsetTree(paths, deltaMM, join = CL.JoinType.jtRound) {
  if (Math.abs(deltaMM) < 1e-9) return unionTree(paths);
  const co = new CL.ClipperOffset(2, ARC_TOL);
  co.AddPaths(paths, join, CL.EndType.etClosedPolygon);
  const tree = new CL.PolyTree();
  co.Execute(tree, deltaMM * SCALE);
  return tree;
}

export const allPaths = (tree) => CL.Clipper.PolyTreeToPaths(tree);

// Fillets in 2D. Growing then shrinking rounds inside (concave) corners and closes
// gaps narrower than 2r; shrinking then growing rounds outside (convex) corners.
export function roundPaths(paths, inside, outside) {
  let cur = paths;
  if (inside > 0) cur = allPaths(offsetTree(allPaths(offsetTree(cur, inside)), -inside));
  if (outside > 0) cur = allPaths(offsetTree(allPaths(offsetTree(cur, -outside)), outside));
  return cur;
}
export const outerPaths = (tree) => tree.Childs().map((n) => n.Contour());

// PolyTree -> [{ outer, holes }], in mm. Islands inside holes become new entries.
export function treeToPolys(tree) {
  const out = [];
  const visit = (node) => {
    const outer = fromPath(node.Contour());
    const holes = [];
    for (const child of node.Childs()) {
      holes.push(fromPath(child.Contour()));
      for (const island of child.Childs()) visit(island);
    }
    const area = Math.abs(polyArea(outer)) - holes.reduce((t, h) => t + Math.abs(polyArea(h)), 0);
    if (outer.length >= 3 && area >= MIN_AREA) out.push({ outer, holes });
  };
  for (const n of tree.Childs()) visit(n);
  return out;
}

// Ramer-Douglas-Peucker on a closed ring: drops vertices that deviate less than eps (mm).
// Keeps STEP files small — the offset outlines are dense arcs.
export function simplifyRing(pts, eps) {
  const n = pts.length;
  if (n < 12) return pts;
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, n]]; // second run wraps back to point 0 via index n
  const at = (i) => pts[i % n];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = at(a), [bx, by] = at(b);
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = at(i);
      const d = len > 0 ? Math.abs((px - ax) * dy - (py - ay) * dx) / len : Math.hypot(px - ax, py - ay);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) {
      keep[idx % n] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}


export function simplifyPolys(polys, eps = SIMPLIFY_EPS) {
  return polys.map(({ outer, holes }) => ({
    outer: simplifyRing(outer, eps),
    holes: holes.map((h) => simplifyRing(h, eps)).filter((h) => h.length >= 3),
  }));
}

// Drop only exactly-collinear vertices (Clipper works in whole microns, so 0.5 um can't touch real
// geometry). The cap triangulator drops them anyway, and leaving them in the side walls makes T-junctions.
export const dropCollinear = (polys) => simplifyPolys(polys, 0.0005);

export function circlePoints(cx, cy, r, tol = 0.005) {
  let n = Math.ceil(Math.PI / Math.acos(1 - Math.min(tol / r, 0.5)));
  n = Math.max(48, n + (n % 2));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}


// Bounding box of Clipper paths, in mm.
export const pathsBBox = (paths) => {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const path of paths) for (const { X, Y } of path) { x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); }
  return { cx: (x0 + x1) / 2 / SCALE, cy: (y0 + y1) / 2 / SCALE, w: (x1 - x0) / SCALE, h: (y1 - y0) / SCALE };
};

export const rectPath = (cx, cy, hw, hh) => {
  const x0 = Math.round((cx - hw) * SCALE), x1 = Math.round((cx + hw) * SCALE);
  const y0 = Math.round((cy - hh) * SCALE), y1 = Math.round((cy + hh) * SCALE);
  return [{ X: x0, Y: y0 }, { X: x1, Y: y0 }, { X: x1, Y: y1 }, { X: x0, Y: y1 }];
};

// Outline of the rectangle base (centred, corners rounded), as a polyline in mm.
export const plateRing = (hw, hh, r) => fromPath(roundPaths([rectPath(0, 0, hw, hh)], 0, Math.min(r, hw, hh))[0]);

export const squarePath = (cx, cy, side) => {
  const x0 = Math.round((cx - side / 2) * SCALE), x1 = Math.round((cx + side / 2) * SCALE);
  const y0 = Math.round((cy - side / 2) * SCALE), y1 = Math.round((cy + side / 2) * SCALE);
  return [{ X: x0, Y: y0 }, { X: x1, Y: y0 }, { X: x1, Y: y1 }, { X: x0, Y: y1 }];
};


// [{ outer, holes }] (mm) -> Clipper paths, outer rings counter-clockwise and holes clockwise.
export const polysToPaths = (polys) =>
  polys.flatMap(({ outer, holes }) => [
    toPath(polyArea(outer) < 0 ? [...outer].reverse() : outer),
    ...holes.map((h) => toPath(polyArea(h) > 0 ? [...h].reverse() : h)),
  ]);

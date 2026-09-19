// Keychain geometry: fits the text to the requested size, then builds the three
// layer outlines (text, outline, base) and the key hole as polygons.
//
// Everything is in mm, y-up, centered on the origin. Polygons come from Clipper
// (integer arithmetic, so the offsets can't fail on awkward fonts); the exact
// glyph curves are kept alongside for the STEP export.

import '../vendor/clipper.js';
import { layoutText, transformContours, flattenContour, bboxOfPolylines, NOMINAL } from './layout.js';

const CL = globalThis.ClipperLib;
const SCALE = 1000; // Clipper works in integers: 1 unit = 1 micron
const ARC_TOL = 4; // offset arc tolerance, microns
const FLATTEN_TOL = 0.01; // mm, glyph curve flattening for the final polygons
const FIT_TOL = 0.05; // nominal units, coarse flattening used only while fitting
const MIN_AREA = 0.02; // mm^2, drop slivers smaller than this

export const DEFAULTS = {
  text: 'Potts\nPrint Shop',
  align: 'center',
  lineSpacing: 1.0,
  width: 63.5, // 2.5"
  height: 38.1, // 1.5"
  fit: 'contain', // 'contain' keeps the font's proportions, 'stretch' fills the box
  sizeIncludesTab: false, // false: width x height is the body; the key hole tab sticks out beyond it
  textH: 0.6,
  midH: 0.6,
  baseH: 1.2,
  outline: 0.8, // outline layer extends this far past the text
  baseMargin: 2.0, // base layer extends this far past the outline
  fillGaps: true, // base is a solid silhouette (no see-through counters)
  holeEnabled: true,
  holeDia: 4.2,
  holeEdge: 2.0, // material between the hole and the outside edge of the base
  holeGap: 1.0, // clearance between the hole and the outline layer
  holeSide: 'left',
  holePos: 0.3, // 0..1 along the chosen edge (top->bottom, or left->right)
};

// ---- Clipper helpers -------------------------------------------------------

const toPath = (pts) => pts.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
const fromPath = (path) => path.map((p) => [p.X / SCALE, p.Y / SCALE]);

function polyArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function runClipper(type, subject, clip) {
  const c = new CL.Clipper();
  c.AddPaths(subject, CL.PolyType.ptSubject, true);
  if (clip) c.AddPaths(clip, CL.PolyType.ptClip, true);
  const tree = new CL.PolyTree();
  const fill = CL.PolyFillType.pftNonZero;
  c.Execute(type, tree, fill, fill);
  return tree;
}

const unionTree = (paths) => runClipper(CL.ClipType.ctUnion, paths);

function offsetTree(paths, deltaMM) {
  if (Math.abs(deltaMM) < 1e-9) return unionTree(paths);
  const co = new CL.ClipperOffset(2, ARC_TOL);
  co.AddPaths(paths, CL.JoinType.jtRound, CL.EndType.etClosedPolygon);
  const tree = new CL.PolyTree();
  co.Execute(tree, deltaMM * SCALE);
  return tree;
}

const allPaths = (tree) => CL.Clipper.PolyTreeToPaths(tree);
const outerPaths = (tree) => tree.Childs().map((n) => n.Contour());

// PolyTree -> [{ outer, holes }], in mm. Islands inside holes become new entries.
function treeToPolys(tree) {
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
function simplifyRing(pts, eps) {
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

const SIMPLIFY_EPS = 0.015; // mm

function simplifyPolys(polys) {
  return polys.map(({ outer, holes }) => ({
    outer: simplifyRing(outer, SIMPLIFY_EPS),
    holes: holes.map((h) => simplifyRing(h, SIMPLIFY_EPS)).filter((h) => h.length >= 3),
  }));
}

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

// ---- Key hole placement -----------------------------------------------------

function toSegments(polylines) {
  let count = 0;
  for (const pl of polylines) count += pl.length;
  const segs = new Float64Array(count * 4);
  let k = 0;
  for (const pl of polylines) {
    for (let i = 0, n = pl.length; i < n; i++) {
      const a = pl[i], b = pl[(i + 1) % n];
      segs[k++] = a[0]; segs[k++] = a[1]; segs[k++] = b[0]; segs[k++] = b[1];
    }
  }
  return segs;
}

// True if any segment is closer than r to (px, py).
function anyCloser(segs, px, py, r) {
  const r2 = r * r;
  for (let i = 0; i < segs.length; i += 4) {
    const ax = segs[i], ay = segs[i + 1];
    const dx = segs[i + 2] - ax, dy = segs[i + 3] - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - px, ey = ay + t * dy - py;
    if (ex * ex + ey * ey < r2) return true;
  }
  return false;
}

// Slide a hole in from the chosen side until it just clears the outline layer.
// `polylines` are the (scaled, centered) text outlines. Returns { cx, cy, R, Rt }.
export function placeHole(polylines, inkW, inkH, p) {
  const R = p.holeDia / 2;
  const Rt = R + p.holeEdge;
  const M = p.outline + p.baseMargin;
  // Distance from the hole centre to the text: hole radius + clearance + outline
  // layer. Capped so the tab still overlaps the base by ~1 mm and stays attached.
  let need = R + p.holeGap + p.outline;
  need = Math.max(R + p.outline + 0.1, Math.min(need, Rt + M - 1));

  const segs = toSegments(polylines);
  const hw = inkW / 2, hh = inkH / 2;
  const far = Math.max(hw, hh) + M + Rt + need + 10;
  const pos = Math.min(1, Math.max(0, p.holePos));
  let dx = 0, dy = 0, sx = 0, sy = 0;
  switch (p.holeSide) {
    case 'right': dx = -1; sx = far; sy = hh - pos * inkH; break;
    case 'top': dy = -1; sx = -hw + pos * inkW; sy = far; break;
    case 'bottom': dy = 1; sx = -hw + pos * inkW; sy = -far; break;
    default: dx = 1; sx = -far; sy = hh - pos * inkH; // left
  }

  const step = 0.25;
  let lo = 0, hi = -1;
  for (let t = 0; t <= far * 2; t += step) {
    if (anyCloser(segs, sx + dx * t, sy + dy * t, need)) { hi = t; break; }
    lo = t;
  }
  let t;
  if (hi < 0) {
    // Nothing on this line: rest the hole just outside the text's bounding box.
    t = far - (dx !== 0 ? hw : hh) - need;
  } else {
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (anyCloser(segs, sx + dx * mid, sy + dy * mid, need)) hi = mid;
      else lo = mid;
    }
    t = lo;
  }
  return { cx: sx + dx * t, cy: sy + dy * t, R, Rt, need };
}

// ---- Fit + build ------------------------------------------------------------

export function buildKeychain(font, params) {
  const p = { ...DEFAULTS, ...params };
  const raw = layoutText(font, p.text, p);
  if (!raw.length) return null;

  const warnings = [];
  const M = p.outline + p.baseMargin;
  const coarse = raw.map((c) => flattenContour(c, FIT_TOL));
  const ink = bboxOfPolylines(coarse);
  if (!(ink.w > 0) || !(ink.h > 0)) return null;

  const scaledCoarse = (sx, sy) =>
    coarse.map((pl) => pl.map(([x, y]) => [(x - ink.cx) * sx, (y - ink.cy) * sy]));
  const bodyBox = (sx, sy) => {
    const hw = (ink.w * sx) / 2 + M, hh = (ink.h * sy) / 2 + M;
    return { x0: -hw, x1: hw, y0: -hh, y1: hh };
  };
  const overall = (sx, sy, hole) => {
    const b = bodyBox(sx, sy);
    if (hole) {
      b.x0 = Math.min(b.x0, hole.cx - hole.Rt);
      b.x1 = Math.max(b.x1, hole.cx + hole.Rt);
      b.y0 = Math.min(b.y0, hole.cy - hole.Rt);
      b.y1 = Math.max(b.y1, hole.cy + hole.Rt);
    }
    return b;
  };
  // The box the requested width x height applies to.
  const sizing = (sx, sy, hole) => (p.sizeIncludesTab ? overall(sx, sy, hole) : bodyBox(sx, sy));
  const solve = (extraW, extraH) => {
    let sx = (p.width - extraW) / ink.w;
    let sy = (p.height - extraH) / ink.h;
    if (p.fit !== 'stretch') sx = sy = Math.min(sx, sy);
    return [sx, sy];
  };

  // Margins and the tab don't scale with the text, so iterate to a fixed point.
  let [sx, sy] = solve(2 * M, 2 * M);
  const MIN_SCALE = 0.01;
  for (let it = 0; it < 8; it++) {
    sx = Math.max(sx, MIN_SCALE);
    sy = Math.max(sy, MIN_SCALE);
    const hole = p.holeEnabled ? placeHole(scaledCoarse(sx, sy), ink.w * sx, ink.h * sy, p) : null;
    const b = sizing(sx, sy, hole);
    const [nsx, nsy] = solve(b.x1 - b.x0 - ink.w * sx, b.y1 - b.y0 - ink.h * sy);
    const done = Math.abs(nsx - sx) < 1e-5 && Math.abs(nsy - sy) < 1e-5;
    sx = nsx;
    sy = nsy;
    if (done) break;
  }
  if (sx < MIN_SCALE || sy < MIN_SCALE) {
    warnings.push('The size is too small for the outline, base and key hole — text is clamped to a tiny size.');
  }
  sx = Math.max(sx, MIN_SCALE);
  sy = Math.max(sy, MIN_SCALE);
  const emMM = NOMINAL * Math.min(sx, sy);
  if (emMM < 4) {
    warnings.push(`The text is only about ${emMM.toFixed(1)} mm tall — make the keychain bigger or the outline and base thinner.`);
  }

  // Final placement with the fine-flattened outlines.
  const centered = transformContours(raw, sx, sy, -ink.cx * sx, -ink.cy * sy);
  let fine = centered.map((c) => flattenContour(c, FLATTEN_TOL));
  let hole = p.holeEnabled ? placeHole(fine, ink.w * sx, ink.h * sy, p) : null;
  const ref = sizing(sx, sy, hole);
  const shx = -(ref.x0 + ref.x1) / 2, shy = -(ref.y0 + ref.y1) / 2;
  const b = overall(sx, sy, hole);

  const contours = transformContours(centered, 1, 1, shx, shy);
  fine = fine.map((pl) => pl.map(([x, y]) => [x + shx, y + shy]));
  if (hole) hole = { ...hole, cx: hole.cx + shx, cy: hole.cy + shy };

  // Layer outlines.
  const inkTree = unionTree(fine.map(toPath));
  const inkPaths = allPaths(inkTree);
  const textPolys = treeToPolys(inkTree);
  const midPolys = simplifyPolys(treeToPolys(offsetTree(inkPaths, p.outline)));
  const baseTree = offsetTree(inkPaths, M);
  let basePaths = p.fillGaps ? outerPaths(baseTree) : allPaths(baseTree);
  const basePlain = simplifyPolys(treeToPolys(p.fillGaps ? unionTree(basePaths) : baseTree));

  let basePolys = basePlain;
  if (hole) {
    const merged = allPaths(runClipper(CL.ClipType.ctUnion, basePaths, [toPath(circlePoints(hole.cx, hole.cy, hole.Rt))]));
    const punched = runClipper(CL.ClipType.ctDifference, merged, [toPath(circlePoints(hole.cx, hole.cy, hole.R))]);
    basePolys = simplifyPolys(treeToPolys(punched));
  }

  const width = b.x1 - b.x0, height = b.y1 - b.y0;
  const z1 = p.baseH, z2 = p.baseH + p.midH, z3 = p.baseH + p.midH + p.textH;
  return {
    params: p,
    size: { w: width, h: height, d: z3 },
    scale: { x: sx, y: sy },
    layers: [
      { key: 'base', name: 'Base', polys: basePolys, z0: 0, z1 },
      { key: 'outline', name: 'Outline', polys: midPolys, z0: z1, z1: z2 },
      { key: 'text', name: 'Text', polys: textPolys, z0: z2, z1: z3 },
    ],
    // Extras the STEP export uses to build exact curves and a true circular hole.
    exact: { contours, basePlain, hole },
    warnings,
  };
}

// Keychain geometry: fits the text to the requested size, then builds the three
// layer outlines (text, outline, base) and the key hole as polygons.
//
// Everything is in mm, y-up, centered on the origin. Polygons come from Clipper
// (integer arithmetic, so the offsets can't fail on awkward fonts); the exact
// glyph curves are kept alongside for the STEP export.

import '../vendor/clipper.js';
import { layoutText, widestLine, transformContours, flattenContour, bboxOfPolylines, NOMINAL } from './layout.js';
import { makeQr } from './qr.js';

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
  baseShape: 'text', // 'text' follows the letters; 'plate' is a rounded rectangle behind them
  plateRadius: 3, // corner radius of the rectangle base (mm)
  roundIn: 1.0, // base: fillet radius on inside (concave) corners, incl. where the key hole tab joins
  roundOut: 0, // base: rounding radius on outside (convex) corners
  holeEnabled: true,
  holeDia: 4.2,
  holeEdge: 2.0, // material between the hole and the outside edge of the base
  holeGap: 1.0, // clearance between the hole and the outline layer
  holeAngle: 180, // where around the keychain the hole sits, degrees: 0 = right, 90 = top, 180 = left (centered), 270 = bottom
  holePush: 0, // 0..1: how far the tab sticks out past its snug position
  lineShifts: [], // per-line sideways nudge, % of the widest line
  lineShiftsY: [], // per-line vertical nudge, % of the font size
  fixed: null, // while dragging a line: the previous build's `layout`, so nothing re-fits or re-centres
  qrEnabled: false, // a QR code on the back
  qrText: '',
  qrEcc: 'M', // error correction: L, M, Q or H
  qrPlate: false, // false: just the code's modules, in a color that contrasts with the base; true: modules on a plate
  qrSize: 0, // side of the QR square in mm incl. its quiet zone; 0 = as big as fits
  qrDepth: 0.6, // how deep the QR plate is recessed into the base (mm)
};

const QR_QUIET = 2; // light border around the QR code, in modules
const QR_WALL = 1; // keep the QR plate at least this far inside the base's edge (mm)
const QR_MIN_MODULE = 0.8; // smaller than this won't print reliably on a 0.4 mm nozzle
const QR_GAP = 0.02; // dark modules shrink by this (mm) so ones touching only at a corner don't pinch

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

function offsetTree(paths, deltaMM, join = CL.JoinType.jtRound) {
  if (Math.abs(deltaMM) < 1e-9) return unionTree(paths);
  const co = new CL.ClipperOffset(2, ARC_TOL);
  co.AddPaths(paths, join, CL.EndType.etClosedPolygon);
  const tree = new CL.PolyTree();
  co.Execute(tree, deltaMM * SCALE);
  return tree;
}

const allPaths = (tree) => CL.Clipper.PolyTreeToPaths(tree);

// Fillets in 2D. Growing then shrinking rounds inside (concave) corners and closes
// gaps narrower than 2r; shrinking then growing rounds outside (convex) corners.
function roundPaths(paths, inside, outside) {
  let cur = paths;
  if (inside > 0) cur = allPaths(offsetTree(allPaths(offsetTree(cur, inside)), -inside));
  if (outside > 0) cur = allPaths(offsetTree(allPaths(offsetTree(cur, -outside)), outside));
  return cur;
}
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

function simplifyPolys(polys, eps = SIMPLIFY_EPS) {
  return polys.map(({ outer, holes }) => ({
    outer: simplifyRing(outer, eps),
    holes: holes.map((h) => simplifyRing(h, eps)).filter((h) => h.length >= 3),
  }));
}

// Drop only exactly-collinear vertices (Clipper works in whole microns, so 0.5 um can't touch real
// geometry). The cap triangulator drops them anyway, and leaving them in the side walls makes T-junctions.
const dropCollinear = (polys) => simplifyPolys(polys, 0.0005);

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

function holeMetrics(p) {
  const R = p.holeDia / 2;
  const Rt = R + p.holeEdge; // tab radius
  const M = p.outline + p.baseMargin;
  // The hole centre must be at least this far from the text so the hole clears the
  // outline layer, but no further than this or the tab stops overlapping the base.
  const attachMax = Rt + M - 1;
  const need = Math.max(R + p.outline + 0.1, Math.min(R + p.holeGap + p.outline, attachMax));
  return { R, Rt, M, need, reach: Math.max(0, attachMax - need) };
}

// The curve the hole centre slides along: the text pushed out by `need` (outer edge only),
// oriented clockwise so the outside is on the left of the direction of travel.
function holeTrack(polylines, need) {
  const paths = allPaths(unionTree(polylines.map(toPath)));
  return offsetTree(paths, need)
    .Childs()
    .map((n) => fromPath(n.Contour()))
    .map((ring) => (polyArea(ring) > 0 ? [...ring].reverse() : ring));
}

// Farthest crossing of the ray (cx,cy)+t(dx,dy) with any ring: { t, x, y, ex, ey } or null.
function rayHit(rings, cx, cy, dx, dy) {
  let best = null;
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % n];
      const ex = bx - ax, ey = by - ay;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((ax - cx) * ey - (ay - cy) * ex) / den;
      const u = ((ax - cx) * dy - (ay - cy) * dx) / den;
      if (t >= 0 && u >= 0 && u <= 1 && (!best || t > best.t)) best = { t, x: cx + dx * t, y: cy + dy * t, ex, ey };
    }
  }
  return best;
}

// Slide the hole to the requested angle around the text. `polylines` are the text
// outlines (any frame). Returns { cx, cy, R, Rt, need }.
export function placeHole(polylines, p, plate = null, origin = null) {
  const h = holeMetrics(p);
  const bb = bboxOfPolylines(polylines);
  const ox = origin ? origin[0] : bb.cx, oy = origin ? origin[1] : bb.cy; // the ray starts at the text's centre (frozen while dragging)
  const a = (p.holeAngle * Math.PI) / 180;
  const dx = Math.cos(a), dy = Math.sin(a);
  // For a rectangle base the hole slides along the plate's edge (far enough out to clear the
  // outline layer); otherwise along the text's outline.
  const rings = plate ? holeTrack([plate.ring], Math.max(0, h.need - plate.margin)) : holeTrack(polylines, h.need);
  const hit = rayHit(rings, ox, oy, dx, dy);
  let cx, cy;
  if (hit) {
    const len = Math.hypot(hit.ex, hit.ey) || 1;
    const push = Math.min(1, Math.max(0, p.holePush)) * h.reach;
    cx = hit.x + (-hit.ey / len) * push; // outward normal of a clockwise ring
    cy = hit.y + (hit.ex / len) * push;
  } else {
    cx = ox + dx * (bb.w / 2 + h.need);
    cy = oy + dy * (bb.h / 2 + h.need);
  }
  return { cx, cy, R: h.R, Rt: h.Rt, need: h.need, track: { rings, cx: ox, cy: oy } };
}

// The angle (degrees) that puts the hole on the given side at `frac` of the way down
// the track (0 = top, 1 = bottom). Used by the 20% / 50% / 80% height buttons.
export function angleForHeight(track, side, frac) {
  let y0 = Infinity, y1 = -Infinity;
  for (const ring of track.rings) for (const [, y] of ring) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const y = y1 - Math.min(1, Math.max(0, frac)) * (y1 - y0);
  let x = null;
  for (const ring of track.rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % n];
      if (ay === by || (ay - y) * (by - y) > 0) continue;
      const cx = ax + ((y - ay) / (by - ay)) * (bx - ax);
      if (x === null || (side === 'left' ? cx < x : cx > x)) x = cx;
    }
  }
  if (x === null) return side === 'left' ? 180 : 0;
  const deg = (Math.atan2(y - track.cy, x - track.cx) * 180) / Math.PI;
  return Math.round((deg + 360) % 360);
}


// ---- QR code on the back ------------------------------------------------------

const rectPath = (cx, cy, hw, hh) => {
  const x0 = Math.round((cx - hw) * SCALE), x1 = Math.round((cx + hw) * SCALE);
  const y0 = Math.round((cy - hh) * SCALE), y1 = Math.round((cy + hh) * SCALE);
  return [{ X: x0, Y: y0 }, { X: x1, Y: y0 }, { X: x1, Y: y1 }, { X: x0, Y: y1 }];
};

// Outline of the rectangle base (centred, corners rounded), as a polyline in mm.
const plateRing = (hw, hh, r) => fromPath(roundPaths([rectPath(0, 0, hw, hh)], 0, Math.min(r, hw, hh))[0]);

const squarePath = (cx, cy, side) => {
  const x0 = Math.round((cx - side / 2) * SCALE), x1 = Math.round((cx + side / 2) * SCALE);
  const y0 = Math.round((cy - side / 2) * SCALE), y1 = Math.round((cy + side / 2) * SCALE);
  return [{ X: x0, Y: y0 }, { X: x1, Y: y0 }, { X: x1, Y: y1 }, { X: x0, Y: y1 }];
};

// Lay a QR code on the back of the base, centred at (cx, cy). Seen from the back it reads
// correctly (the pattern is mirrored left-right in model space). Returns the light plate
// (light modules + quiet zone) as paths; the dark modules are simply left as base material.
function layoutQr(qr, basePunchedPaths, cx, cy, p, warnings) {
  const cells = qr.n + 2 * QR_QUIET;
  const inner = allPaths(offsetTree(basePunchedPaths, -QR_WALL));
  const fits = (side) => treeToPolys(runClipper(CL.ClipType.ctDifference, [squarePath(cx, cy, side)], inner)).length === 0;

  let side;
  if (p.qrSize > 0) {
    side = p.qrSize;
    if (!fits(side)) warnings.push('The QR code is bigger than the back of the keychain, so part of it hangs off the edge.');
  } else {
    const bb = { w: 0, h: 0 };
    for (const path of basePunchedPaths) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const { X, Y } of path) { x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); }
      bb.w = Math.max(bb.w, (x1 - x0) / SCALE);
      bb.h = Math.max(bb.h, (y1 - y0) / SCALE);
    }
    let lo = 0, hi = Math.min(bb.w, bb.h);
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    // Round the module size down to 0.05 mm so the numbers stay tidy.
    side = Math.floor(lo / cells / 0.05) * 0.05 * cells;
  }
  const module = side / cells;
  if (!(module > 0)) return null;
  if (module < QR_MIN_MODULE) {
    warnings.push(
      `The QR modules are only ${module.toFixed(2)} mm — too small to print reliably. Use a shorter link, lower error correction, a bigger keychain${p.baseShape === 'plate' ? '' : ', or the Rectangle base shape'}.`,
    );
  }

  // Grid lines in integer microns, so neighbouring modules share exact edges.
  const gx = [], gy = [];
  for (let k = 0; k <= cells; k++) {
    gx.push(Math.round((cx - side / 2 + k * module) * SCALE));
    gy.push(Math.round((cy + side / 2 - k * module) * SCALE)); // row 0 is the top
  }
  const dark = [];
  for (let r = 0; r < qr.n; r++) {
    for (let c = 0; c < qr.n; c++) {
      if (!qr.isDark(r, c)) continue;
      const col = QR_QUIET + (qr.n - 1 - c); // mirrored: it's on the back
      const row = QR_QUIET + r;
      dark.push([{ X: gx[col], Y: gy[row + 1] }, { X: gx[col + 1], Y: gy[row + 1] }, { X: gx[col + 1], Y: gy[row] }, { X: gx[col], Y: gy[row] }]);
    }
  }
  const plate = [[{ X: gx[0], Y: gy[cells] }, { X: gx[cells], Y: gy[cells] }, { X: gx[cells], Y: gy[0] }, { X: gx[0], Y: gy[0] }]];
  // Shrink the modules a hair: two that touch only at a corner would make a pinched, invalid face.
  const darkShrunk = allPaths(offsetTree(allPaths(unionTree(dark)), -QR_GAP, CL.JoinType.jtMiter));
  // The QR body is just the code's modules, in a color that contrasts with the base: no plate, no border
  // (the base around it is the quiet zone). On a dark base that's a light-on-dark (negative) code; on a
  // light base it's the usual dark-on-light. With `qrPlate`, it's a plate with the modules left as base.
  const light = p.qrPlate ? allPaths(runClipper(CL.ClipType.ctDifference, plate, darkShrunk)) : darkShrunk;
  return { light, side, module, cells, n: qr.n };
}

// Which line of text is under (x, y)? An exact hit on the letters wins; otherwise the nearest line
// whose (slightly padded) box contains the point. Returns the line number or -1.
export function pickLine(lines, x, y, pad = 1.5) {
  const inside = (polylines) => {
    let odd = false;
    for (const pl of polylines) {
      for (let i = 0, n = pl.length, j = n - 1; i < n; j = i++) {
        const [xi, yi] = pl[i], [xj, yj] = pl[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
      }
    }
    return odd;
  };
  for (const l of lines) if (inside(l.ink)) return l.index;
  let best = -1, bestD = Infinity;
  for (const l of lines) {
    const b = l.bbox;
    if (x < b.x0 - pad || x > b.x1 + pad || y < b.y0 - pad || y > b.y1 + pad) continue;
    const d = Math.abs(y - b.cy);
    if (d < bestD) { bestD = d; best = l.index; }
  }
  return best;
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
  const plateMode = p.baseShape === 'plate';
  // Half-extents of the base body. A rectangle base fills the whole width x height you asked
  // for ("expanded"); while fitting, and for the text-shaped base, it just hugs the text.
  const halfBox = (sx, sy, expanded) => {
    if (p.fixed) return { hw: p.fixed.hw, hh: p.fixed.hh };
    let hw = (ink.w * sx) / 2 + M, hh = (ink.h * sy) / 2 + M;
    if (expanded && plateMode && !p.sizeIncludesTab) {
      hw = Math.max(hw, p.width / 2);
      hh = Math.max(hh, p.height / 2);
    }
    return { hw, hh };
  };
  const bodyBox = (sx, sy, expanded = false) => {
    const { hw, hh } = halfBox(sx, sy, expanded);
    return { x0: -hw, x1: hw, y0: -hh, y1: hh };
  };
  const overall = (sx, sy, hole, expanded = false) => {
    const b = bodyBox(sx, sy, expanded);
    if (hole) {
      b.x0 = Math.min(b.x0, hole.cx - hole.Rt);
      b.x1 = Math.max(b.x1, hole.cx + hole.Rt);
      b.y0 = Math.min(b.y0, hole.cy - hole.Rt);
      b.y1 = Math.max(b.y1, hole.cy + hole.Rt);
    }
    return b;
  };
  // The box the requested width x height applies to.
  const sizing = (sx, sy, hole, expanded = false) => (p.sizeIncludesTab ? overall(sx, sy, hole, expanded) : bodyBox(sx, sy, expanded));
  // What the key hole slides along, for a rectangle base: the plate's edge.
  const plateFor = (sx, sy, expanded) => {
    if (!plateMode) return null;
    const { hw, hh } = halfBox(sx, sy, expanded);
    return { ring: plateRing(hw, hh, p.plateRadius), margin: Math.min(hw - (ink.w * sx) / 2, hh - (ink.h * sy) / 2) };
  };
  const solve = (extraW, extraH) => {
    let sx = (p.width - extraW) / ink.w;
    let sy = (p.height - extraH) / ink.h;
    if (p.fit !== 'stretch') sx = sy = Math.min(sx, sy);
    return [sx, sy];
  };

  // Margins and the tab don't scale with the text, so iterate to a fixed point.
  let [sx, sy] = p.fixed ? [p.fixed.sx, p.fixed.sy] : solve(2 * M, 2 * M);
  const MIN_SCALE = 0.01;
  for (let it = 0; !p.fixed && it < 8; it++) {
    sx = Math.max(sx, MIN_SCALE);
    sy = Math.max(sy, MIN_SCALE);
    // The tab only matters for sizing when the size is meant to include it.
    const hole = p.holeEnabled && p.sizeIncludesTab ? placeHole(scaledCoarse(sx, sy), p, plateFor(sx, sy, false)) : null;
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
  const centered = p.fixed
    ? transformContours(raw, sx, sy, p.fixed.tx - p.fixed.shx, p.fixed.ty - p.fixed.shy)
    : transformContours(raw, sx, sy, -ink.cx * sx, -ink.cy * sy);
  let fine = centered.map((c) => flattenContour(c, FLATTEN_TOL));
  let hole = p.holeEnabled ? placeHole(fine, p, plateFor(sx, sy, true), p.fixed ? [0, 0] : null) : null;
  const ref = sizing(sx, sy, hole, true);
  const shx = p.fixed ? p.fixed.shx : -(ref.x0 + ref.x1) / 2;
  const shy = p.fixed ? p.fixed.shy : -(ref.y0 + ref.y1) / 2;
  const b = overall(sx, sy, hole, true);

  const contours = transformContours(centered, 1, 1, shx, shy);
  fine = fine.map((pl) => pl.map(([x, y]) => [x + shx, y + shy]));
  let holeTrackShifted = null;
  if (hole) {
    holeTrackShifted = {
      rings: hole.track.rings.map((r) => r.map(([x, y]) => [x + shx, y + shy])),
      cx: hole.track.cx + shx,
      cy: hole.track.cy + shy,
    };
    hole = { cx: hole.cx + shx, cy: hole.cy + shy, R: hole.R, Rt: hole.Rt, need: hole.need };
  }

  // Layer outlines.
  const inkTree = unionTree(fine.map(toPath));
  const inkPaths = allPaths(inkTree);
  const textPolys = treeToPolys(inkTree);
  // The outline layer stays a pure offset of the text; only the base gets fillets.
  const midPolys = simplifyPolys(treeToPolys(offsetTree(inkPaths, p.outline)));
  let basePaths;
  if (plateMode) {
    const { hw, hh } = halfBox(sx, sy, true);
    basePaths = roundPaths([rectPath(shx, shy, hw, hh)], 0, Math.min(p.plateRadius, hw, hh));
  } else {
    const baseTree = offsetTree(inkPaths, M);
    basePaths = p.fillGaps ? outerPaths(baseTree) : allPaths(baseTree);
  }
  // Join the key hole tab on before rounding, so the fillets blend it into the body.
  if (hole) {
    basePaths = allPaths(runClipper(CL.ClipType.ctUnion, basePaths, [toPath(circlePoints(hole.cx, hole.cy, hole.Rt))]));
  }
  basePaths = roundPaths(basePaths, p.roundIn, p.roundOut);
  // A tab sitting in a notch can trap a little pocket; a solid base shouldn't keep it.
  if (p.fillGaps || p.baseShape === 'plate') basePaths = outerPaths(unionTree(basePaths));
  // basePlain has the tab but no hole (the STEP export bores an exact hole);
  // basePolys has the hole cut as a polygon, for the preview and STL.
  const basePlain = simplifyPolys(treeToPolys(unionTree(basePaths)));
  // Lines dragged far apart leave a base in separate pieces; say so, since it would print as separate parts.
  if (!plateMode && basePlain.length > 1) {
    warnings.push(`The base is in ${basePlain.length} separate pieces — move the text closer together so it prints as one keychain.`);
  }
  let basePolys = basePlain;
  let basePunchedPaths = basePaths;
  if (hole) {
    const punched = runClipper(CL.ClipType.ctDifference, basePaths, [toPath(circlePoints(hole.cx, hole.cy, hole.R))]);
    basePolys = simplifyPolys(treeToPolys(punched));
    basePunchedPaths = allPaths(punched);
  }

  const width = b.x1 - b.x0, height = b.y1 - b.y0;
  const z1 = p.baseH, z2 = p.baseH + p.midH, z3 = p.baseH + p.midH + p.textH;

  // Optional QR code on the back: a light plate recessed flush into the underside of the base.
  let qr = null;
  let qrLayer = null;
  let baseLayers = [{ key: 'base', name: 'Base', polys: basePolys, z0: 0, z1 }];
  let baseLowerPlain = null;
  if (p.qrEnabled && p.qrText.trim()) {
    try {
      const code = makeQr(p.qrText, p.qrEcc);
      const depth = Math.max(0.2, Math.min(p.qrDepth, p.baseH - 0.2));
      // Centre on the body (the tab, if any, sticks out beyond it).
      const laid = layoutQr(code, basePunchedPaths, shx, shy, p, warnings);
      if (laid) {
        // (Only collinear vertices are dropped: the QR's features are tiny and rectilinear.)
        const lightPolys = dropCollinear(treeToPolys(unionTree(laid.light)));
        const lowerPolys = dropCollinear(treeToPolys(runClipper(CL.ClipType.ctDifference, basePunchedPaths, laid.light)));
        baseLowerPlain = dropCollinear(treeToPolys(runClipper(CL.ClipType.ctDifference, basePaths, laid.light)));
        baseLayers = [
          { key: 'base', name: 'Base', polys: lowerPolys, z0: 0, z1: depth },
          { key: 'base', name: 'Base', polys: basePolys, z0: depth, z1 },
        ];
        qrLayer = { key: 'qr', name: 'QR code', polys: lightPolys, z0: 0, z1: depth };
        qr = { n: laid.n, cells: laid.cells, module: laid.module, side: laid.side, depth, ecc: p.qrEcc, plate: p.qrPlate, cx: shx, cy: shy };
      }
    } catch (err) {
      warnings.push(`Can't make that QR code: ${err.message || err}. Try shorter text or lower error correction.`);
    }
  }

  // Per-line ink (final frame) for picking a line under the pointer, and the numbers a drag needs
  // to turn millimetres back into slider units.
  const inkByLine = new Map();
  fine.forEach((pl, i) => {
    const k = raw[i].line;
    if (!inkByLine.has(k)) inkByLine.set(k, []);
    inkByLine.get(k).push(pl);
  });
  const lines = [...inkByLine].map(([index, inkLines]) => ({ index, ink: inkLines, bbox: bboxOfPolylines(inkLines) }));
  const half = halfBox(sx, sy, true);
  const layout = p.fixed || { sx, sy, tx: -ink.cx * sx + shx, ty: -ink.cy * sy + shy, shx, shy, hw: half.hw, hh: half.hh, widest: widestLine(font, p.text) };

  return {
    params: p,
    lines,
    layout,
    size: { w: width, h: height, d: z3 },
    scale: { x: sx, y: sy },
    layers: [
      ...baseLayers,
      { key: 'outline', name: 'Outline', polys: midPolys, z0: z1, z1: z2 },
      { key: 'text', name: 'Text', polys: textPolys, z0: z2, z1: z3 },
      ...(qrLayer ? [qrLayer] : []),
    ],
    qr,
    // Extras the STEP export uses to build exact curves and a true circular hole.
    exact: { contours, basePlain, baseLowerPlain, hole, holeTrack: holeTrackShifted },
    warnings,
  };
}

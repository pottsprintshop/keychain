// Keychain geometry: fits the text to the requested size, then builds the three
// layer outlines (text, outline, base) and the key hole as polygons.
//
// Everything is in mm, y-up, centered on the origin. Polygons come from Clipper
// (integer arithmetic, so the offsets can't fail on awkward fonts); the exact
// glyph curves are kept alongside for the STEP export.

import {
  CL, SCALE, SIMPLIFY_EPS, toPath, fromPath, polyArea, runClipper, unionTree, offsetTree, allPaths, outerPaths,
  treeToPolys, roundPaths, simplifyPolys, polysToPaths, circlePoints, pathsBBox, rectPath, squarePath, plateRing,
} from './clip.js';
import { layoutText, widestLine, transformContours, flattenContour, bboxOfPolylines, NOMINAL } from './layout.js';
import { layoutBack } from './back.js';
import { placeArt } from './art.js';

const FLATTEN_TOL = 0.01; // mm, glyph curve flattening for the final polygons
const FIT_TOL = 0.05; // nominal units, coarse flattening used only while fitting

export const DEFAULTS = {
  text: 'Potts\nPrint Shop',
  align: 'center',
  lineSpacing: 1.0,
  width: 63.5, // 2.5"
  height: 38.1, // 1.5"
  fit: 'contain', // 'contain' keeps the font's proportions, 'stretch' fills the box
  textSize: 1, // 0.05..1: the text as a fraction of the biggest size that fits (a smaller keychain if the base follows the text)
  sizeIncludesTab: true, // true: width x height counts the key hole tab; false: it is the body, and the tab sticks out beyond it
  textOn: true, // the layers can each be taken away (a keychain needs at least one)
  baseOn: true,
  textH: 0.6,
  midH: 0.6,
  baseH: 1.2,
  outline: 0.8, // outline layer extends this far past the text
  baseMargin: 2.0, // base layer extends this far past the outline
  fillGaps: true, // base is a solid silhouette (no see-through counters)
  baseShape: 'text', // 'text' follows the letters; the rest fill the width x height: 'plate' (rounded rectangle), 'sports' (a long thin one), 'round' (ellipse), 'hex', 'dogbone'
  plateRadius: 3, // corner radius of the rectangle and hexagon bases (mm)
  boneShaft: 0.5, // dog bone: how thick the shaft is, as a fraction of the height
  borderW: 0, // a raised rim this wide (mm) around the edge of the base, in the color of the layer above the base; 0 = none
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
  // Extra outline rings, each one further out from the text (ring 1 is `outline`/`midH` above).
  rings: 1, // 0..3
  ring2W: 0.8,
  ring2H: 0.6,
  ring3W: 0.8,
  ring3H: 0.6,
  // The back: nothing, a QR code, text, or the artwork. A body recessed flush into the underside of the base.
  backKind: 'none', // 'none' | 'qr' | 'text' | 'art'
  backText: '',
  backSize: 0, // longest side of the content in mm (a QR plate: the plate's side); 0 = as big as fits
  backMargin: 1.2, // the content keeps at least this far (mm) from the base's edge, and from the key hole
  backDepth: 0.6, // how deep it is recessed into the base (mm)
  qrText: '',
  qrEcc: 'M', // error correction: L, M, Q or H
  qrPlate: false, // false: just the code's modules, in a color that contrasts with the base; true: modules on a plate
  art: null, // traced artwork ({ contours, aspect }), see art.js
  artMode: 'off', // on the front: 'off' | 'above' the text | 'below' it | 'right' or 'left' of it | 'only' (instead of the text)
  artLines: 2, // artwork height, in font sizes
  artShiftX: 0, // nudge, % of the font size
  artShiftY: 0,
};

// ---- Base shapes -------------------------------------------------------------

// Bases that fill the requested width x height (everything except 'text', which follows the letters).
export const PLATE_SHAPES = ['plate', 'sports', 'round', 'hex', 'dogbone'];

function ellipsePoints(a, b, tol = 0.004) {
  const R = Math.max(a, b);
  let n = Math.ceil(Math.PI / Math.acos(1 - Math.min(tol / R, 0.5)));
  n = Math.max(48, n + (n % 2));
  return Array.from({ length: n }, (_, i) => [a * Math.cos((2 * Math.PI * i) / n), b * Math.sin((2 * Math.PI * i) / n)]);
}

// The outline of a base shape with half-extents hw x hh, centred on the origin: a counter-clockwise polyline (mm).
//   plate    rounded rectangle (the Sports tag is one too, just long and thin)
//   round    ellipse (a circle when width = height)
//   hex      hexagon with points left and right, flat top and bottom, corners rounded like the plate's
//   dogbone  a shaft with two round knobs at each end
export function shapeRing(kind, hw, hh, p) {
  if (kind === 'round') return ellipsePoints(hw, hh);
  if (kind === 'hex') {
    const r = Math.min(p.plateRadius, hh / 2, hw / 4);
    const hexagon = (w) => {
      const pts = [[w, 0], [w / 2, hh], [-w / 2, hh], [-w, 0], [-w / 2, -hh], [w / 2, -hh]];
      return r > 0 ? fromPath(roundPaths([toPath(pts)], 0, r)[0]) : pts;
    };
    // Rounding the points pulls them in, so start from a wider hexagon until the rounded one reaches the width asked for.
    let w = hw, ring = hexagon(w);
    for (let i = 0; i < 4 && r > 0; i++) {
      w += hw - Math.max(...ring.map((q) => q[0]));
      ring = hexagon(w);
    }
    return ring;
  }
  if (kind === 'dogbone') {
    const r = Math.min(0.56 * hh, 0.98 * hw); // knob radius: the two knobs at an end overlap a little, leaving a shallow notch
    const th = Math.min(hh, Math.max(0.1 * hh, p.boneShaft * hh)); // shaft half-thickness
    const parts = [toPath([[-(hw - r), -th], [hw - r, -th], [hw - r, th], [-(hw - r), th]])];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push(toPath(circlePoints(sx * (hw - r), sy * (hh - r), r, 0.004)));
    return fromPath(outerPaths(unionTree(parts))[0]);
  }
  return plateRing(hw, hh, p.plateRadius);
}

// ---- Key hole placement -----------------------------------------------------

// The outline rings, nearest the text first: how far each extends from the text, and how tall it is.
export function ringDefs(p) {
  const n = Math.min(3, Math.max(0, Number.isFinite(Number(p.rings)) ? Math.round(p.rings) : 1));
  const widths = [p.outline, p.ring2W, p.ring3W];
  const heights = [p.midH, p.ring2H, p.ring3H];
  let offset = 0;
  return Array.from({ length: n }, (_, i) => {
    offset += widths[i];
    return { index: i + 1, key: i === 0 ? 'outline' : `outline${i + 1}`, name: i === 0 ? 'Outline' : `Outline ${i + 1}`, offset, h: heights[i] };
  });
}

function holeMetrics(p) {
  const R = p.holeDia / 2;
  const Rt = R + p.holeEdge; // tab radius
  const O = ringDefs(p).at(-1)?.offset ?? 0; // how far the outermost ring reaches from the text
  const M = O + p.baseMargin;
  // The hole centre must be at least this far from the text so the hole clears the
  // outline layer, but no further than this or the tab stops overlapping the base.
  const attachMax = Rt + M - 1;
  const need = Math.max(R + O + 0.1, Math.min(R + p.holeGap + O, attachMax));
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
  // Without a base there is nothing to bore a key hole in, recess a back into, or put a border on.
  const hasBase = p.baseOn !== false;
  if (!hasBase) Object.assign(p, { holeEnabled: false, backKind: 'none', borderW: 0 });
  // The front: the text, and/or the artwork placed above, below or instead of it.
  let raw = p.art && p.artMode === 'only' ? [] : layoutText(font, p.text, p);
  if (p.art && p.artMode !== 'off') raw = raw.concat(placeArt(p.art, raw, p));
  if (!raw.length) return null;

  const warnings = [];
  const rings = ringDefs(p);
  const M = (rings.at(-1)?.offset ?? 0) + (hasBase ? p.baseMargin : 0); // how far the outside of the keychain is from the text
  const coarse = raw.map((c) => flattenContour(c, FIT_TOL));
  const ink = bboxOfPolylines(coarse);
  if (!(ink.w > 0) || !(ink.h > 0)) return null;

  const scaledCoarse = (sx, sy) =>
    coarse.map((pl) => pl.map(([x, y]) => [(x - ink.cx) * sx, (y - ink.cy) * sy]));
  const plateMode = hasBase && PLATE_SHAPES.includes(p.baseShape); // the base is a shape drawn at the size asked for
  const shaped = plateMode; // ...and the text is fitted inside it
  let shapeBox = null; // half-extents of a plate (they don't depend on the text)
  // Half-extents of the base body: a plate is drawn at the size you asked for; a base that follows the text
  // (or no base at all) just hugs the text.
  const halfBox = (sx, sy) => {
    if (p.fixed) return { hw: p.fixed.hw, hh: p.fixed.hh };
    if (shaped) return shapeBox;
    return { hw: (ink.w * sx) / 2 + M, hh: (ink.h * sy) / 2 + M };
  };
  const bodyBox = (sx, sy) => {
    const { hw, hh } = halfBox(sx, sy);
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
  // What the key hole slides along, for a plate: its edge. The text stays at least M inside the edge everywhere,
  // which is all the hole needs to know.
  const plateFor = (sx, sy) => {
    if (!plateMode) return null;
    const { hw, hh } = halfBox(sx, sy);
    return { ring: shapeRing(p.baseShape, hw, hh, p), margin: M };
  };
  // The biggest text that fits inside a shaped base with the full margin M all the way round: the text's bounding
  // box must lie inside the shape pulled in by M. Stretched text fills a box with the shape's own proportions.
  const fitInShape = () => {
    const { hw, hh } = shapeBox;
    const stretch = p.fit === 'stretch';
    if (p.baseShape === 'plate' || p.baseShape === 'sports') {
      // A rectangle: the text box is the plate pulled in by M.
      const iw = Math.max(0, 2 * (hw - M)), ih = Math.max(0, 2 * (hh - M));
      const s = Math.min(iw / ink.w, ih / ink.h);
      return stretch ? [iw / ink.w, ih / ink.h] : [s, s];
    }
    const inner = allPaths(offsetTree([toPath(shapeRing(p.baseShape, hw, hh, p))], -(M + SIMPLIFY_EPS)));
    const half = (s) => (stretch ? [s * hw, s * hh] : [(s * ink.w) / 2, (s * ink.h) / 2]);
    const fits = (s) => {
      const [a, b] = half(s);
      return inner.length > 0 && allPaths(runClipper(CL.ClipType.ctDifference, [rectPath(0, 0, a, b)], inner)).length === 0;
    };
    let lo = 0, hi = stretch ? 1 : Math.max((2 * hw) / ink.w, (2 * hh) / ink.h);
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    return stretch ? [(2 * lo * hw) / ink.w, (2 * lo * hh) / ink.h] : [lo, lo];
  };
  const solve = (extraW, extraH) => {
    let sx = (p.width - extraW) / ink.w;
    let sy = (p.height - extraH) / ink.h;
    if (p.fit !== 'stretch') sx = sy = Math.min(sx, sy);
    return [sx, sy];
  };

  // A plate is drawn first, at a size that doesn't depend on the text: the full width x height, or with the
  // key hole tab counted, small enough that plate and tab together come to that size.
  if (shaped && !p.fixed) {
    let hw = p.width / 2, hh = p.height / 2;
    for (let it = 0; p.sizeIncludesTab && p.holeEnabled && it < 12; it++) {
      const ring = shapeRing(p.baseShape, hw, hh, p);
      const h = placeHole([ring], p, { ring, margin: M });
      const w = Math.max(hw, h.cx + h.Rt) - Math.min(-hw, h.cx - h.Rt);
      const t = Math.max(hh, h.cy + h.Rt) - Math.min(-hh, h.cy - h.Rt);
      const dw = (p.width - w) / 2, dh = (p.height - t) / 2;
      hw = Math.max(1, hw + dw);
      hh = Math.max(1, hh + dh);
      if (Math.abs(dw) < 1e-4 && Math.abs(dh) < 1e-4) break;
    }
    shapeBox = { hw, hh };
  }
  // Margins and the tab don't scale with the text, so iterate to a fixed point.
  let [sx, sy] = p.fixed ? [p.fixed.sx, p.fixed.sy] : shaped ? fitInShape() : solve(2 * M, 2 * M);
  const MIN_SCALE = 0.01;
  for (let it = 0; !p.fixed && !shaped && it < 8; it++) {
    sx = Math.max(sx, MIN_SCALE);
    sy = Math.max(sy, MIN_SCALE);
    // The tab only matters for sizing when the size is meant to include it.
    const hole = p.holeEnabled && p.sizeIncludesTab ? placeHole(scaledCoarse(sx, sy), p, plateFor(sx, sy)) : null;
    const b = sizing(sx, sy, hole);
    const [nsx, nsy] = solve(b.x1 - b.x0 - ink.w * sx, b.y1 - b.y0 - ink.h * sy);
    const done = Math.abs(nsx - sx) < 1e-5 && Math.abs(nsy - sy) < 1e-5;
    sx = nsx;
    sy = nsy;
    if (done) break;
  }
  // The text size setting shrinks the text on its own: a plate keeps its width x height and just has more room
  // around the text (a base that follows the text follows it down).
  if (!p.fixed) {
    const k = Math.min(1, Math.max(0.05, Number(p.textSize) || 1));
    sx *= k;
    sy *= k;
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
  let hole = p.holeEnabled ? placeHole(fine, p, plateFor(sx, sy), p.fixed ? [0, 0] : null) : null;
  const ref = sizing(sx, sy, hole);
  const shx = p.fixed ? p.fixed.shx : -(ref.x0 + ref.x1) / 2;
  const shy = p.fixed ? p.fixed.shy : -(ref.y0 + ref.y1) / 2;
  const b = overall(sx, sy, hole);

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
  // Glyphs union by winding; traced artwork by even-odd (its outlines have no reliable direction).
  const isArt = raw.map((c) => c.line === -1);
  let inkTree;
  if (isArt.some(Boolean)) {
    const parts = [];
    const textPaths = fine.filter((_, i) => !isArt[i]).map(toPath);
    const artPaths = fine.filter((_, i) => isArt[i]).map(toPath);
    if (textPaths.length) parts.push(...allPaths(unionTree(textPaths)));
    if (artPaths.length) parts.push(...allPaths(unionTree(artPaths, CL.PolyFillType.pftEvenOdd)));
    inkTree = unionTree(parts);
  } else {
    inkTree = unionTree(fine.map(toPath));
  }
  const inkPaths = allPaths(inkTree);
  const textPolys = treeToPolys(inkTree);
  // The outline rings stay pure offsets of the text; only the base gets fillets.
  const ringPolys = rings.map((r) => simplifyPolys(treeToPolys(offsetTree(inkPaths, r.offset))));
  // The base (with the key hole tab and its fillets), unless it has been taken away.
  let basePaths = [];
  let bodyBounds = null; // the base body without the key hole tab: what the QR code is centred on
  let basePlain = []; // has the tab but no hole (the STEP export bores an exact hole)
  let basePolys = []; // has the hole cut as a polygon, for the preview and STL
  let basePunchedPaths = [];
  if (hasBase) {
    if (plateMode) {
      const { hw, hh } = halfBox(sx, sy);
      basePaths = [toPath(shapeRing(p.baseShape, hw, hh, p).map(([x, y]) => [x + shx, y + shy]))];
    } else {
      const baseTree = offsetTree(inkPaths, M);
      basePaths = p.fillGaps ? outerPaths(baseTree) : allPaths(baseTree);
    }
    bodyBounds = pathsBBox(basePaths);
    // Join the key hole tab on before rounding, so the fillets blend it into the body.
    if (hole) {
      basePaths = allPaths(runClipper(CL.ClipType.ctUnion, basePaths, [toPath(circlePoints(hole.cx, hole.cy, hole.Rt))]));
    }
    basePaths = roundPaths(basePaths, p.roundIn, p.roundOut);
    // A tab sitting in a notch can trap a little pocket; a solid base shouldn't keep it.
    if (p.fillGaps || plateMode) basePaths = outerPaths(unionTree(basePaths));
    basePlain = simplifyPolys(treeToPolys(unionTree(basePaths)));
    // Lines dragged far apart leave a base in separate pieces; say so, since it would print as separate parts.
    if (!plateMode && basePlain.length > 1) {
      warnings.push(`The base is in ${basePlain.length} separate pieces — move the text closer together so it prints as one keychain.`);
    }
    basePolys = basePlain;
    basePunchedPaths = basePaths;
    if (hole) {
      const punched = runClipper(CL.ClipType.ctDifference, basePaths, [toPath(circlePoints(hole.cx, hole.cy, hole.R))]);
      basePolys = simplifyPolys(treeToPolys(punched));
      basePunchedPaths = allPaths(punched);
    }
  }

  const width = b.x1 - b.x0, height = b.y1 - b.y0;
  // Stack, bottom to top: the base, the outer rings down to ring 1, then the text.
  const z1 = hasBase ? p.baseH : 0;
  let zTop = z1;
  const ringLayers = [];
  for (let i = rings.length - 1; i >= 0; i--) {
    ringLayers.push({ key: rings[i].key, name: rings[i].name, polys: ringPolys[i], z0: zTop, z1: zTop + rings[i].h });
    zTop += rings[i].h;
  }
  const zText0 = zTop, z3 = zTop + (p.textOn === false ? 0 : p.textH);

  // A raised rim around the edge of the base (tab included), as tall as the layer above the base. It is its own
  // body, and the preview and exports color it like that layer.
  let borderLayer = null;
  if (hasBase && p.borderW > 0) {
    const edge = outerPaths(unionTree(basePaths));
    let band = runClipper(CL.ClipType.ctDifference, edge, allPaths(offsetTree(edge, -p.borderW)));
    if (hole) band = runClipper(CL.ClipType.ctDifference, allPaths(band), [toPath(circlePoints(hole.cx, hole.cy, hole.R + 0.4))]); // never over the hole
    const polys = simplifyPolys(treeToPolys(band));
    if (polys.length) {
      borderLayer = { key: 'border', name: 'Border', polys, z0: z1, z1: z1 + (rings.at(-1)?.h ?? p.textH) };
      const above = rings.length ? ringPolys.at(-1) : p.textOn === false ? [] : textPolys;
      if (above.length && allPaths(runClipper(CL.ClipType.ctIntersection, polysToPaths(polys), polysToPaths(above))).length) {
        warnings.push('The border runs into the layer next to it. Make the base margin wider than the border, or the border thinner.');
      }
    }
  }

  // Optional back content (QR code, text or artwork): a body recessed flush into the underside of the base.
  let back = null;
  let backLayer = null;
  let baseLayers = hasBase ? [{ key: 'base', name: 'Base', polys: basePolys, z0: 0, z1 }] : [];
  let baseLowerPlain = null;
  if (p.backKind !== 'none') {
    try {
      const laid = layoutBack({ p, font, art: p.art, basePunchedPaths, body: bodyBounds, warnings });
      if (laid) {
        const depth = Math.max(0.2, Math.min(p.backDepth, p.baseH - 0.2));
        // The lower slab starts from the very same simplified outline as the upper slab (basePolys), so their
        // edges line up exactly where they meet and the STL export can join them into one closed shell.
        const lightPolys = treeToPolys(unionTree(laid.light));
        const lowerPolys = treeToPolys(runClipper(CL.ClipType.ctDifference, polysToPaths(basePolys), laid.light));
        baseLowerPlain = treeToPolys(runClipper(CL.ClipType.ctDifference, polysToPaths(basePlain), laid.light)); // (simplified, like the upper slab: dense outlines make the bore boolean invalid)
        baseLayers = [
          { key: 'base', name: 'Base', polys: lowerPolys, z0: 0, z1: depth },
          { key: 'base', name: 'Base', polys: basePolys, z0: depth, z1 },
        ];
        backLayer = { key: 'back', name: laid.name, polys: lightPolys, z0: 0, z1: depth };
        const { light, ...info } = laid;
        back = { ...info, depth, margin: p.backMargin, cx: bodyBounds.cx, cy: bodyBounds.cy };
      }
    } catch (err) {
      warnings.push(p.backKind === 'qr'
        ? `Can't make that QR code: ${err.message || err}. Try shorter text or lower error correction.`
        : `Can't make the back: ${err.message || err}.`);
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
  const lines = [...inkByLine].filter(([index]) => index >= 0).map(([index, inkLines]) => ({ index, ink: inkLines, bbox: bboxOfPolylines(inkLines) })); // (artwork isn't draggable)
  // Lines of text (or artwork) dragged into each other overlap. The STEP export builds the glyph solids line by line
  // and fuses them when that happens, so say whether it will need to.
  const groupPaths = [...inkByLine].map(([index, group]) => allPaths(unionTree(group.map(toPath), index === -1 ? CL.PolyFillType.pftEvenOdd : CL.PolyFillType.pftNonZero)));
  const groupBoxes = groupPaths.map((paths) => pathsBBox(paths));
  let textOverlap = false;
  for (let a = 0; a < groupPaths.length && !textOverlap; a++) {
    for (let b = a + 1; b < groupPaths.length && !textOverlap; b++) {
      const A = groupBoxes[a], B = groupBoxes[b];
      if (Math.abs(A.cx - B.cx) * 2 > A.w + B.w || Math.abs(A.cy - B.cy) * 2 > A.h + B.h) continue;
      const both = runClipper(CL.ClipType.ctIntersection, groupPaths[a], groupPaths[b]);
      textOverlap = allPaths(both).length > 0;
    }
  }
  const half = halfBox(sx, sy);
  const layout = p.fixed || { sx, sy, tx: -ink.cx * sx + shx, ty: -ink.cy * sy + shy, shx, shy, hw: half.hw, hh: half.hh, widest: widestLine(font, p.text) };

  return {
    params: p,
    lines,
    layout,
    size: { w: width, h: height, d: z3 },
    scale: { x: sx, y: sy },
    layers: [
      ...baseLayers,
      ...(borderLayer ? [borderLayer] : []),
      ...ringLayers,
      ...(p.textOn === false ? [] : [{ key: 'text', name: 'Text', polys: textPolys, z0: zText0, z1: z3 }]),
      ...(backLayer ? [backLayer] : []),
    ],
    back,
    // Extras the STEP export uses to build exact curves and a true circular hole.
    exact: { contours, textOverlap, basePlain, baseLowerPlain, hole, holeTrack: holeTrackShifted },
    warnings,
  };
}

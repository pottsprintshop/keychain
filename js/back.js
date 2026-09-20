// What goes on the back of the keychain: a QR code, text, or artwork. Whatever it is, it becomes a body
// recessed flush into the underside of the base, in a color that contrasts with it. The pattern is mirrored
// left-right, so it reads correctly when you turn the keychain over like a page.
//
// Each layout function returns { light, ...info }: `light` is Clipper paths for the recessed body.

import {
  CL, SCALE, SIMPLIFY_EPS, toPath, runClipper, unionTree, offsetTree, allPaths, treeToPolys, rectPath, squarePath,
} from './clip.js';
import { makeQr } from './qr.js';
import { layoutText, flattenContour, bboxOfPolylines } from './layout.js';

const QR_QUIET = 2; // border around a code that's on a plate, in modules
const QR_MIN_MODULE = 0.8; // smaller than this won't print reliably on a 0.4 mm nozzle
const QR_GAP = 0.02; // modules shrink by this (mm) so ones touching only at a corner don't pinch

// The area the back content may occupy: the base, pulled in by the edge margin (plus the tolerance the final
// outline is simplified by, so the margin is a true minimum).
const innerRegion = (basePunchedPaths, margin) =>
  allPaths(offsetTree(basePunchedPaths, -(Math.max(0, margin) + SIMPLIFY_EPS)));

const isInside = (shapePath, inner) => treeToPolys(runClipper(CL.ClipType.ctDifference, [shapePath], inner)).length === 0;

// ---- QR code ----------------------------------------------------------------------

// As big as fits while staying `backMargin` from the base's edge, centred on `body` (the base's bounding box,
// not counting the key hole tab), so it grows and shrinks smoothly with the keychain.
function layoutQr(p, basePunchedPaths, body, warnings) {
  const { cx, cy } = body;
  const code = makeQr(p.qrText, p.qrEcc);
  const quiet = p.qrPlate ? QR_QUIET : 0; // a plate needs a border; the bare code doesn't
  const cells = code.n + 2 * quiet;
  const inner = innerRegion(basePunchedPaths, p.backMargin);
  const fits = (side) => isInside(squarePath(cx, cy, side), inner);

  let side;
  if (p.backSize > 0) {
    side = p.backSize;
    if (!fits(side)) warnings.push('The QR code is bigger than the back of the keychain (or closer to its edge than the margin), so part of it may hang off.');
  } else {
    let lo = 0, hi = Math.min(body.w, body.h);
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    side = Math.max(0, lo - 0.002); // a hair under, so rounding to whole microns never eats the margin
  }
  const module = side / cells;
  if (!(module > 0)) return null;
  if (module < QR_MIN_MODULE) {
    warnings.push(
      `The QR modules are only ${module.toFixed(2)} mm — too small to print reliably. Use a shorter link, lower error correction, a smaller edge margin, a bigger keychain${p.baseShape === 'plate' ? '' : ', or the Rectangle base shape'}.`,
    );
  }

  // Grid lines in whole microns, so neighbouring modules share exact edges.
  const gx = [], gy = [];
  for (let k = 0; k <= cells; k++) {
    gx.push(Math.round((cx - side / 2 + k * module) * SCALE));
    gy.push(Math.round((cy + side / 2 - k * module) * SCALE)); // row 0 is the top
  }
  const dark = [];
  for (let r = 0; r < code.n; r++) {
    for (let c = 0; c < code.n; c++) {
      if (!code.isDark(r, c)) continue;
      const col = quiet + (code.n - 1 - c); // mirrored: it's on the back
      const row = quiet + r;
      dark.push([{ X: gx[col], Y: gy[row + 1] }, { X: gx[col + 1], Y: gy[row + 1] }, { X: gx[col + 1], Y: gy[row] }, { X: gx[col], Y: gy[row] }]);
    }
  }
  const plate = [[{ X: gx[0], Y: gy[cells] }, { X: gx[cells], Y: gy[cells] }, { X: gx[cells], Y: gy[0] }, { X: gx[0], Y: gy[0] }]];
  // Shrink the modules a hair: two that touch only at a corner would make a pinched, invalid face.
  const darkShrunk = allPaths(offsetTree(allPaths(unionTree(dark)), -QR_GAP, CL.JoinType.jtMiter));
  // Just the code's modules, in a color that contrasts with the base: no plate, no border (the base around it
  // is the quiet zone). On a dark base that's a light-on-dark (negative) code; on a light base it's the usual
  // dark-on-light. With `qrPlate`, it's a plate with the modules left as base material.
  const light = p.qrPlate ? allPaths(runClipper(CL.ClipType.ctDifference, plate, darkShrunk)) : darkShrunk;
  return { light, kind: 'qr', name: 'QR code', side, module, n: code.n, quiet, plate: !!p.qrPlate };
}

// ---- Text or artwork ------------------------------------------------------------------

// Fit contours (any scale, y-up) as large as possible inside the base, mirrored, centred on the body.
// `tol` is the curve-flattening tolerance in the contours' own units (the fit scale isn't known yet).
function layoutShape(contours, tol, fill, p, basePunchedPaths, body, kind, name, warnings) {
  if (!contours.length) return null;
  const polylines = contours.map((c) => flattenContour(c, tol));
  const bb = bboxOfPolylines(polylines);
  if (!(bb.w > 0) || !(bb.h > 0)) return null;
  const { cx, cy } = body;
  const inner = innerRegion(basePunchedPaths, p.backMargin);
  const fits = (s) => isInside(rectPath(cx, cy, (bb.w * s) / 2, (bb.h * s) / 2), inner);

  let s;
  const cap = p.backSize > 0 ? p.backSize / Math.max(bb.w, bb.h) : Infinity;
  if (p.backSize > 0 && !fits(cap)) warnings.push('The back content is bigger than the back of the keychain (or closer to its edge than the margin), so part of it may hang off.');
  let lo = 0, hi = Math.min(body.w / bb.w, body.h / bb.h);
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  s = Math.min(Math.max(0, lo - 0.002 / Math.max(bb.w, bb.h)), cap);
  if (!(s > 0)) return null;

  // Mirrored left-right and centred on the body.
  const paths = polylines.map((pl) => toPath(pl.map(([x, y]) => [cx - (x - bb.cx) * s, cy + (y - bb.cy) * s])));
  const light = allPaths(unionTree(paths, fill));
  return { light, kind, name, side: Math.max(bb.w, bb.h) * s, width: bb.w * s, height: bb.h * s };
}

// -> { light, kind, name, ... } or null. Throws (with a readable message) if the QR text can't be encoded.
export function layoutBack(ctx) {
  const { p, font, art, basePunchedPaths, body, warnings } = ctx;
  if (p.backKind === 'qr') return p.qrText.trim() ? layoutQr(p, basePunchedPaths, body, warnings) : null;
  if (p.backKind === 'text') {
    if (!p.backText.trim()) return null;
    const contours = layoutText(font, p.backText, { align: 'center', lineSpacing: p.lineSpacing });
    return layoutShape(contours, 0.03, CL.PolyFillType.pftNonZero, p, basePunchedPaths, body, 'text', 'Back text', warnings);
  }
  if (p.backKind === 'art') {
    if (!art) return null;
    return layoutShape(art.contours, 0.0004, CL.PolyFillType.pftEvenOdd, p, basePunchedPaths, body, 'art', 'Back artwork', warnings);
  }
  return null;
}

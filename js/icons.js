// Built-in icons for the Sports tag: a tennis racquet, a baseball, a football and a soccer ball.
//
// Each is drawn with a little solid geometry (Clipper: unions and cut-outs) in units of roughly a hundredth of the
// icon's size, then comes out like traced artwork (see art.js): contours with height 1, bottom at y = 0, centred on
// x = 0, plus the width/height `aspect`. Details are cut-outs (seams, laces, strings), and none is narrower than about
// half a millimetre on an icon 16 mm tall.

import { CL, toPath, runClipper, unionTree, allPaths, treeToPolys, circlePoints, simplifyRing } from './clip.js';

// ---- a tiny CSG kit: a "shape" is a list of Clipper paths -------------------------------------

const ccw = (pts) => {
  let a = 0;
  pts.forEach(([x1, y1], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; });
  return a < 0 ? [...pts].reverse() : pts;
};
const poly = (pts) => [toPath(ccw(pts))];
const disc = (cx, cy, r) => [toPath(circlePoints(cx, cy, r, 0.05))];
const rect = (x0, y0, x1, y1) => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
const ellipse = (cx, cy, a, b) => {
  const n = 120;
  return poly(Array.from({ length: n }, (_, i) => [cx + a * Math.cos((2 * Math.PI * i) / n), cy + b * Math.sin((2 * Math.PI * i) / n)]));
};
// A straight bar of width w from (x0, y0) to (x1, y1).
const bar = (x0, y0, x1, y1, w) => {
  const len = Math.hypot(x1 - x0, y1 - y0), nx = (-(y1 - y0) / len) * (w / 2), ny = ((x1 - x0) / len) * (w / 2);
  return poly([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]);
};
// A regular polygon with `n` corners, the first at `deg` degrees.
const regular = (cx, cy, r, n, deg) => poly(Array.from({ length: n }, (_, i) => { const a = ((deg + (360 * i) / n) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }));

const union = (...shapes) => allPaths(unionTree(shapes.flat()));
const cut = (shape, ...holes) => allPaths(runClipper(CL.ClipType.ctDifference, shape, union(...holes)));
const both = (a, b) => allPaths(runClipper(CL.ClipType.ctIntersection, a, b));
const turn = (shape, deg) => {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  return shape.map((path) => path.map(({ X, Y }) => ({ X: Math.round(X * c - Y * s), Y: Math.round(X * s + Y * c) })));
};

// Shapes -> artwork contours (height 1, bottom at y = 0, centred on x = 0).
function toArt(icon, name, shape) {
  const rings = treeToPolys(unionTree(shape)).flatMap(({ outer, holes }) => [outer, ...holes]).map((r) => simplifyRing(r, 0.12));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const H = y1 - y0, cx = (x0 + x1) / 2;
  const P = ([x, y]) => [(x - cx) / H, (y - y0) / H];
  return {
    icon,
    name,
    aspect: (x1 - x0) / H,
    contours: rings.map((r) => ({ start: P(r[0]), segs: r.slice(1).map((pt) => ['L', ...P(pt)]) })),
  };
}

// ---- the icons ----------------------------------------------------------------------------------

// A disc with the two seams that bound the middle panel cut out, sweeping from one edge of the ball to the other.
function baseball() {
  const seam = (side) => both(both(cut(disc(-side * 55, 0, 123), disc(-side * 55, 0, 113)), disc(0, 0, 93)), side < 0 ? rect(-100, -100, 0, 100) : rect(0, -100, 100, 100));
  return toArt('baseball', 'Baseball', cut(disc(0, 0, 100), seam(-1), seam(1)));
}

// A disc with the centre pentagon, the seams running out from it and five half-hidden pentagons at the edge cut out.
function soccer() {
  const spokes = [0, 1, 2, 3, 4].map((k) => {
    const a = ((90 + 72 * k) * Math.PI) / 180;
    return bar(18 * Math.cos(a), 18 * Math.sin(a), 66 * Math.cos(a), 66 * Math.sin(a), 8); // (starting inside the pentagon, so they overlap it rather than touch a corner)
  });
  const rim = [0, 1, 2, 3, 4].map((k) => {
    const a = ((90 + 72 * k) * Math.PI) / 180;
    return both(regular(80 * Math.cos(a), 80 * Math.sin(a), 24, 5, 90 + 72 * k + 180), disc(0, 0, 89));
  });
  return toArt('soccer', 'Soccer ball', cut(disc(0, 0, 100), regular(0, 0, 30, 5, 90), ...spokes, ...rim));
}

// A pointed oval with the laces and the two stripes cut out, tipped at an angle.
function football() {
  const lens = both(disc(0, -76, 114), disc(0, 76, 114));
  const laces = union(rect(-32, -4, 32, 4), ...[-24, -12, 0, 12, 24].map((x) => rect(x - 4, -13, x + 4, 13)));
  const stripes = union(rect(-60, -15, -52, 15), rect(52, -15, 60, 15));
  return toArt('football', 'Football', turn(cut(lens, laces, stripes), 40));
}

// A racquet: the frame (a ring, the throat and the handle) with strings across it, tipped at an angle.
function tennis() {
  const head = ellipse(0, 45, 48, 60), bed = ellipse(0, 45, 39, 51);
  const frame = union(cut(head, bed), poly([[-26, 0], [26, 0], [8, -45], [-8, -45]]), rect(-8, -112, 8, -40), rect(-10, -120, 10, -100));
  // (the strings reach a little way into the frame, so they are one piece with it)
  const strings = both(union(...[-19.5, 0, 19.5].map((x) => rect(x - 4, -10, x + 4, 100)), ...[-26, 0, 26].map((y) => rect(-45, 45 + y - 4, 45, 45 + y + 4))), ellipse(0, 45, 42, 54));
  return toArt('tennis', 'Tennis racquet', turn(union(frame, strings), -45));
}

export const ICONS = {
  tennis: { name: 'Tennis racquet', build: tennis },
  baseball: { name: 'Baseball', build: baseball },
  football: { name: 'Football', build: football },
  soccer: { name: 'Soccer ball', build: soccer },
};

const cache = new Map();
// The artwork for an icon key ('tennis', 'baseball', 'football', 'soccer'), or null.
export function getIcon(key) {
  if (!ICONS[key]) return null;
  if (!cache.has(key)) cache.set(key, ICONS[key].build());
  return cache.get(key);
}

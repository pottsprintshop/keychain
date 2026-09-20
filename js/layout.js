// Text layout: turns a string + a parsed font into closed glyph contours.
//
// Coordinates are y-up. A "contour" is { start: [x, y], segs: [...] } where each
// seg is ['L', x, y] | ['Q', cx, cy, x, y] | ['C', c1x, c1y, c2x, c2y, x, y].
// Contours are implicitly closed.

import opentype from '../vendor/opentype.module.js';

// Layout happens at this nominal font size and is scaled to mm afterwards.
export const NOMINAL = 100;

export function parseFont(arrayBuffer) {
  return opentype.parse(arrayBuffer);
}

export function fontDisplayName(font) {
  const n = font.names || {};
  const pick = (o) => o && (o.en || Object.values(o)[0]);
  return pick(n.fullName) || pick(n.fontFamily) || 'Uploaded font';
}

// Advance width of the widest line, in nominal units (the unit the sideways offsets are relative to).
export function widestLine(font, text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  return Math.max(1, ...lines.map((l) => (l.trim() ? font.getAdvanceWidth(l, NOMINAL) : 0)));
}

// Lay out `text` (newlines split lines) and return unscaled contours, each tagged with its line number.
// lineShifts[i] nudges line i sideways (percent of the widest line); lineShiftsY[i] nudges it up
// (percent of the font size).
export function layoutText(font, text, { align = 'center', lineSpacing = 1, lineShifts = [], lineShiftsY = [] } = {}) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const lineHeight = NOMINAL * lineSpacing;
  const contours = [];
  const widest = widestLine(font, text);

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const width = font.getAdvanceWidth(line, NOMINAL);
    const shift = ((Number(lineShifts[i]) || 0) / 100) * widest;
    const x0 = (align === 'left' ? 0 : align === 'right' ? -width : -width / 2) + shift;
    const baseline = -i * lineHeight + ((Number(lineShiftsY[i]) || 0) / 100) * NOMINAL;
    const path = font.getPath(line, x0, 0, NOMINAL);

    // opentype paths are y-down with the baseline at y = 0; flip to y-up.
    const X = (x) => x;
    const Y = (y) => -y + baseline;
    let cur = null;
    const finish = () => {
      if (cur && cur.segs.length >= 2) contours.push(cur);
      cur = null;
    };
    for (const c of path.commands) {
      if (c.type === 'M') {
        finish();
        cur = { start: [X(c.x), Y(c.y)], segs: [], line: i };
      } else if (!cur) {
        continue;
      } else if (c.type === 'L') {
        cur.segs.push(['L', X(c.x), Y(c.y)]);
      } else if (c.type === 'Q') {
        cur.segs.push(['Q', X(c.x1), Y(c.y1), X(c.x), Y(c.y)]);
      } else if (c.type === 'C') {
        cur.segs.push(['C', X(c.x1), Y(c.y1), X(c.x2), Y(c.y2), X(c.x), Y(c.y)]);
      } else if (c.type === 'Z') {
        finish();
      }
    }
    finish();
  });
  return contours;
}

// Scale about the origin, then translate.
export function transformContours(contours, sx, sy, tx = 0, ty = 0) {
  const P = (x, y) => [x * sx + tx, y * sy + ty];
  return contours.map((c) => ({
    start: P(c.start[0], c.start[1]),
    segs: c.segs.map((s) => {
      if (s[0] === 'L') return ['L', ...P(s[1], s[2])];
      if (s[0] === 'Q') return ['Q', ...P(s[1], s[2]), ...P(s[3], s[4])];
      return ['C', ...P(s[1], s[2]), ...P(s[3], s[4]), ...P(s[5], s[6])];
    }),
  }));
}

function distToChord2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const cross = (px - ax) * dy - (py - ay) * dx;
  return (cross * cross) / len2;
}

function flatCubic(p0, p1, p2, p3, tol2, out, depth) {
  const flat = Math.max(
    distToChord2(p1[0], p1[1], p0[0], p0[1], p3[0], p3[1]),
    distToChord2(p2[0], p2[1], p0[0], p0[1], p3[0], p3[1]),
  );
  if (flat <= tol2 || depth > 14) {
    out.push(p3);
    return;
  }
  const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = m(p0, p1), p12 = m(p1, p2), p23 = m(p2, p3);
  const p012 = m(p01, p12), p123 = m(p12, p23);
  const mid = m(p012, p123);
  flatCubic(p0, p01, p012, mid, tol2, out, depth + 1);
  flatCubic(mid, p123, p23, p3, tol2, out, depth + 1);
}

// Flatten a contour into a polyline (closed implicitly, no repeated end point).
export function flattenContour(contour, tol) {
  const tol2 = tol * tol;
  const pts = [contour.start];
  let cur = contour.start;
  for (const s of contour.segs) {
    if (s[0] === 'L') {
      cur = [s[1], s[2]];
      pts.push(cur);
    } else if (s[0] === 'Q') {
      // Elevate the quadratic to a cubic so one flattener covers both.
      const c = [s[1], s[2]], e = [s[3], s[4]];
      const c1 = [cur[0] + (2 / 3) * (c[0] - cur[0]), cur[1] + (2 / 3) * (c[1] - cur[1])];
      const c2 = [e[0] + (2 / 3) * (c[0] - e[0]), e[1] + (2 / 3) * (c[1] - e[1])];
      flatCubic(cur, c1, c2, e, tol2, pts, 0);
      cur = e;
    } else {
      const e = [s[5], s[6]];
      flatCubic(cur, [s[1], s[2]], [s[3], s[4]], e, tol2, pts, 0);
      cur = e;
    }
  }
  // Drop consecutive duplicates and a closing point equal to the start.
  const clean = [];
  for (const p of pts) {
    const q = clean[clean.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-9 || Math.abs(q[1] - p[1]) > 1e-9) clean.push(p);
  }
  while (clean.length > 1) {
    const a = clean[0], b = clean[clean.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) clean.pop();
    else break;
  }
  return clean;
}

export function bboxOfPolylines(polylines) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of polylines) {
    for (const [x, y] of pl) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

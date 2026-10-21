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

// Letter-pair fixes for particular fonts (matched on the font's name). Potts Graffiti's T is as wide as its advance
// (and t is the same glyph), so two in a row run together into one long crossbar. The second T of a pair drops by
// `dy` and tucks left by `dx` (fractions of the font size; up and right are positive), which slides its crossbar
// under the first one's and leaves a clear gap all round. The letters after it follow it left, so the word stays
// tight. In a run of three, every other T moves.
const PAIR_FIXES = [{ font: /potts\s*graffiti/i, letter: 'T', dx: -0.32, dy: -0.16 }];

const pairFixesFor = (font) => PAIR_FIXES.filter((f) => f.font.test(fontDisplayName(font)));

// How each glyph of a line is moved by the fixes (fractions of the font size), and how far the line's end moved.
function glyphShifts(font, line, fixes) {
  const ids = fixes.map((f) => font.charToGlyph(f.letter).index);
  const runs = fixes.map(() => 0);
  let carry = 0;
  const shifts = font.stringToGlyphs(line).map((glyph) => {
    let dx = carry, dy = 0;
    fixes.forEach((f, i) => {
      runs[i] = glyph.index === ids[i] ? runs[i] + 1 : 0;
      if (runs[i] > 0 && runs[i] % 2 === 0) { // the 2nd, 4th... letter of a run
        dx += f.dx;
        dy += f.dy;
        carry += f.dx;
      }
    });
    return { dx, dy };
  });
  return { shifts, carry, any: shifts.some((s) => s.dx || s.dy) };
}

// The path for a line of text with those shifts applied glyph by glyph (positions and kerning are opentype's own).
function pathWithShifts(font, line, x0, shifts, size) {
  const commands = [];
  let i = 0;
  font.forEachGlyph(line, x0, 0, size, {}, (glyph, x, y, fontSize) => {
    const s = shifts[i++];
    commands.push(...glyph.getPath(x + s.dx * size, y - s.dy * size, fontSize, {}, font).commands); // (opentype paths are y-down)
  });
  return { commands };
}

// Advance width of the widest line, in nominal units (the unit the sideways offsets are relative to).
// lineFonts[i], if set, is that line's own font in place of `font` (the Advanced "font per line" setting).
export function widestLine(font, text, lineFonts = []) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  return Math.max(1, ...lines.map((l, i) => (l.trim() ? (lineFonts[i] || font).getAdvanceWidth(l, NOMINAL) : 0)));
}

// Search word wraps; explicit newlines remain mandatory breaks.
// The geometry fitter chooses the candidate with the largest printable font size.
export function wrapCandidates(font, text) {
  const words = [], breaks = new Set();
  for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
    const tokens = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length && tokens.length) breaks.add(words.length);
    words.push(...tokens);
  }
  const n = words.length;
  if (!n) return [text];
  if (n <= 8) {
    const candidates = [];
    for (let mask = 0; mask < 2 ** (n - 1); mask++) {
      if ([...breaks].some((i) => !(mask & (1 << (i - 1))))) continue;
      const lines = [words[0]];
      for (let i = 1; i < n; i++) {
        if (mask & (1 << (i - 1))) lines.push(words[i]);
        else lines[lines.length - 1] += ' ' + words[i];
      }
      candidates.push(lines.join('\n'));
    }
    return candidates;
  }
  // shortcut: long phrases use one balanced wrap per line count, expand the search if finer packing is needed.
  const widths = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j <= n; j++) {
      if (j > i + 1 && breaks.has(j - 1)) break;
      widths[i][j] = font.getAdvanceWidth(words.slice(i, j).join(' '), NOMINAL);
    }
  }
  let previous = Array(n + 1).fill(null);
  previous[0] = { width: 0, lines: [] };
  const candidates = [];
  for (let count = 1; count <= n; count++) {
    const current = Array(n + 1).fill(null);
    for (let end = count; end <= n; end++) {
      for (let start = count - 1; start < end; start++) {
        if (!previous[start] || widths[start][end] === undefined) continue;
        const width = Math.max(previous[start].width, widths[start][end]);
        if (!current[end] || width < current[end].width) {
          current[end] = { width, lines: [...previous[start].lines, words.slice(start, end).join(' ')] };
        }
      }
    }
    if (current[n]) candidates.push(current[n].lines.join('\n'));
    previous = current;
  }
  return candidates;
}

// Lay out `text` (newlines split lines) and return unscaled contours, each tagged with its line number.
// lineShifts[i] nudges line i sideways (percent of the widest line); lineShiftsY[i] nudges it up
// (percent of the font size); lineFonts[i] swaps that line to its own font (see widestLine above).
export function layoutText(font, text, { align = 'center', lineSpacing = 1, lineShifts = [], lineShiftsY = [], lineFonts = [] } = {}) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const lineHeight = NOMINAL * lineSpacing;
  const contours = [];
  const widest = widestLine(font, text, lineFonts);

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const f = lineFonts[i] || font;
    const fixes = pairFixesFor(f);
    const fixed = fixes.length ? glyphShifts(f, line, fixes) : null;
    const width = f.getAdvanceWidth(line, NOMINAL) + (fixed ? fixed.carry * NOMINAL : 0); // (a tucked letter shortens the line)
    const shift = ((Number(lineShifts[i]) || 0) / 100) * widest;
    const x0 = (align === 'left' ? 0 : align === 'right' ? -width : -width / 2) + shift;
    const baseline = -i * lineHeight + ((Number(lineShiftsY[i]) || 0) / 100) * NOMINAL;
    const path = fixed && fixed.any ? pathWithShifts(f, line, x0, fixed.shifts, NOMINAL) : f.getPath(line, x0, 0, NOMINAL);

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
    line: c.line, // which line of text (or -1 for artwork) it belongs to
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

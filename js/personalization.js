// Kernel-independent outline boundary. Keep font shaping and pair fixes in layout.js.
import { layoutText, transformContours, NOMINAL } from './layout.js';

export class PersonalizationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new PersonalizationError(code); };

// Exact extrema of quadratic/cubic Beziers, rather than advance widths or sampled text.
export function contourBounds(contours) {
  const xs = [], ys = [];
  const add = (p) => { xs.push(p[0]); ys.push(p[1]); };
  for (const contour of contours) {
    let p = contour.start;
    add(p);
    for (const seg of contour.segs) {
      const pts = [p];
      for (let i = 1; i < seg.length; i += 2) pts.push([seg[i], seg[i + 1]]);
      const end = pts.at(-1);
      add(end);
      for (let axis = 0; axis < 2; axis++) {
        const v = pts.map((q) => q[axis]);
        let roots = [];
        if (v.length === 3) {
          const d = v[0] - 2 * v[1] + v[2];
          if (Math.abs(d) > 1e-12) roots = [(v[0] - v[1]) / d];
        } else if (v.length === 4) {
          const a = -v[0] + 3 * v[1] - 3 * v[2] + v[3];
          const b = 2 * (v[0] - 2 * v[1] + v[2]);
          const c = v[1] - v[0];
          if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) roots = [-c / b]; }
          else if (b * b - 4 * a * c >= 0) {
            const d = Math.sqrt(b * b - 4 * a * c);
            roots = [(-b + d) / (2 * a), (-b - d) / (2 * a)];
          }
        }
        for (const t of roots.filter((r) => r > 0 && r < 1)) {
          let work = pts;
          while (work.length > 1) work = work.slice(1).map((q, i) => q.map((x, j) => (1 - t) * work[i][j] + t * x));
          add(work[0]);
        }
      }
      p = end;
    }
  }
  const x0 = xs.reduce((a, b) => Math.min(a, b), Infinity), x1 = xs.reduce((a, b) => Math.max(a, b), -Infinity);
  const y0 = ys.reduce((a, b) => Math.min(a, b), Infinity), y1 = ys.reduce((a, b) => Math.max(a, b), -Infinity);
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function normalizePersonalizationText(text) {
  if (typeof text !== 'string' || [...text].length > 512) fail('text_budget');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(text)) fail('unsupported_control');
  // Batch compatibility: trim around |, preserve other whitespace and explicit empty lines.
  return text.replace(/\r\n?/g, '\n').replace(/[^\S\n]*\|[^\S\n]*/g, '\n');
}

export function validateLayoutRequest(request) {
  const keys = ['version', 'text', 'font_id', 'font_sha256', 'width_mm', 'height_mm', 'margin_mm',
    'font_size_mm', 'minimum_font_size_mm', 'fit', 'align', 'vertical_align', 'line_spacing'];
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).some((k) => !keys.includes(k)) || keys.some((k) => !(k in request))) fail('invalid_request');
  if (request.version !== 1) fail('unsupported_version');
  if (typeof request.font_id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(request.font_id) ||
      typeof request.font_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.font_sha256)) fail('invalid_font_identity');
  for (const k of ['width_mm', 'height_mm', 'font_size_mm', 'minimum_font_size_mm']) {
    if (typeof request[k] !== 'number' || !Number.isFinite(request[k]) || request[k] <= 0 || request[k] > 1000) fail('invalid_dimensions');
  }
  if (!Number.isFinite(request.margin_mm) || request.margin_mm < 0 ||
      request.margin_mm * 2 >= Math.min(request.width_mm, request.height_mm)) fail('invalid_margins');
  if (!Number.isFinite(request.line_spacing) || request.line_spacing < 0.2 || request.line_spacing > 5) fail('invalid_line_spacing');
  if (!['fixed', 'scale_to_fit', 'scale_to_fit_minimum'].includes(request.fit) ||
      !['left', 'center', 'right'].includes(request.align) ||
      !['bottom', 'middle', 'top'].includes(request.vertical_align)) fail('invalid_layout');
  const text = normalizePersonalizationText(request.text);
  if (!text.trim()) fail('empty_text');
  return text;
}

export function layoutPersonalization(font, request) {
  const text = validateLayoutRequest(request);
  // No .notdef substitution, including whitespace lacking actual font coverage.
  if ([...text].some((c) => c !== '\n' && font.charToGlyphIndex(c) === 0)) fail('missing_glyph');
  const raw = layoutText(font, text, { align: request.align, lineSpacing: request.line_spacing });
  if (raw.length > 8192 || raw.reduce((n, c) => n + c.segs.length, 0) > 65536) fail('outline_budget');
  const ink = contourBounds(raw);
  if (!(ink.w > 0 && ink.h > 0)) fail('empty_outline');
  const availableW = request.width_mm - 2 * request.margin_mm;
  const availableH = request.height_mm - 2 * request.margin_mm;
  const fitted = Math.min(availableW / ink.w, availableH / ink.h);
  const scale = request.fit === 'fixed' ? request.font_size_mm / NOMINAL : fitted;
  if (scale > fitted + 1e-10) fail('overflow');
  if (request.fit === 'scale_to_fit_minimum' && scale * NOMINAL < request.minimum_font_size_mm - 1e-9) fail('minimum_font_size');
  const anchor = (kind, lo, hi) => kind === 'left' || kind === 'bottom' ? lo : kind === 'right' || kind === 'top' ? hi : (lo + hi) / 2;
  const tx = anchor(request.align, -availableW / 2, availableW / 2) - scale * anchor(request.align, ink.x0, ink.x1);
  const ty = anchor(request.vertical_align, -availableH / 2, availableH / 2) - scale * anchor(request.vertical_align, ink.y0, ink.y1);
  const contours = transformContours(raw, scale, scale, tx, ty);
  return { version: 1, units: 'mm', axes: 'x-right-y-up', fill_rule: 'nonzero',
    font_id: request.font_id, font_sha256: request.font_sha256,
    font_size_mm: scale * NOMINAL, line_count: text.split('\n').length,
    bounds: contourBounds(contours), contours,
    manufacturing_validated: false };
}

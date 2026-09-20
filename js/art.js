// Artwork import: turns a picture (PNG, JPG, SVG...) into outlines, the same way img2dxf does: flatten onto
// white, threshold to black and white, and trace the black with ImageTracer.
//
// The traced outlines become contours in the same format as glyphs (see layout.js), normalized to a height
// of 1 with the bottom at y = 0 and centred on x = 0, so they can be placed like a line of text.

import { flattenContour, bboxOfPolylines, NOMINAL } from './layout.js';

const MAX_DIM = 700; // downscale big images before tracing, for speed

let tracer = null;
async function loadTracer() {
  if (!tracer) {
    await import('../vendor/imagetracer.js'); // sets self.ImageTracer
    tracer = globalThis.ImageTracer;
  }
  return tracer;
}

// -> { img, w, h, name } from an image file. SVGs without an intrinsic size are given 1024 x 1024.
export function loadArtSource(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
      resolve({ img, w, h, name: file.name });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file isn't an image the browser can read (try PNG, JPG or SVG)."));
    };
    img.src = url;
  });
}

// Drop isolated specks: erode then dilate over a 3x3 neighbourhood.
function despeckle(imgd, w, h) {
  const d = imgd.data;
  const fg = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4] === 0;
  const eroded = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!fg(x, y)) continue;
      let keep = true;
      for (let dy = -1; dy <= 1 && keep; dy++) for (let dx = -1; dx <= 1; dx++) if (!fg(x + dx, y + dy)) { keep = false; break; }
      if (keep) eroded[y * w + x] = 1;
    }
  }
  const er = (x, y) => x >= 0 && y >= 0 && x < w && y < h && eroded[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let any = false;
      for (let dy = -1; dy <= 1 && !any; dy++) for (let dx = -1; dx <= 1; dx++) if (er(x + dx, y + dy)) { any = true; break; }
      const i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = any ? 0 : 255;
      d[i + 3] = 255;
    }
  }
}

// opts: { threshold 0-255, invert, detail 0-10, denoise } -> { contours, aspect } or null if nothing traced
export async function traceArt(source, opts) {
  const ImageTracer = await loadTracer();
  const scale = Math.min(1, MAX_DIM / Math.max(source.w, source.h));
  const w = Math.max(1, Math.round(source.w * scale)), h = Math.max(1, Math.round(source.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // transparent regions (logos, clipart) read as background, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source.img, 0, 0, w, h);
  const imgd = ctx.getImageData(0, 0, w, h);
  const d = imgd.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const isFg = opts.invert ? lum >= opts.threshold : lum < opts.threshold;
    d[i] = d[i + 1] = d[i + 2] = isFg ? 0 : 255;
    d[i + 3] = 255;
  }
  if (opts.denoise) despeckle(imgd, w, h);

  const detail = Math.min(10, Math.max(0, opts.detail)); // higher = more detail
  const tol = 5.0 - (detail / 10) * 4.8;
  const traced = ImageTracer.imagedataToTracedata(imgd, {
    numberofcolors: 2,
    pathomit: Math.round(60 - (detail / 10) * 58),
    ltres: tol,
    qtres: tol,
    rightangleenhance: true,
    colorsampling: 0,
  });
  let fgIndex = 0, darkest = Infinity;
  traced.palette.forEach((c, i) => {
    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    if (lum < darkest) { darkest = lum; fgIndex = i; }
  });

  // Paths -> contours (y-down image space for now), keeping the curves.
  const raw = [];
  for (const path of traced.layers[fgIndex] || []) {
    const segs = path.segments;
    if (!segs || segs.length < 2) continue;
    raw.push({
      start: [segs[0].x1, segs[0].y1],
      segs: segs.map((s) => (s.type === 'Q' ? ['Q', s.x2, s.y2, s.x3, s.y3] : ['L', s.x2, s.y2])),
    });
  }
  if (!raw.length) return null;

  // Normalize: height 1, bottom at y = 0, centred on x = 0, y up.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const c of raw) {
    const pts = [c.start, ...c.segs.map((s) => [s[s.length - 2], s[s.length - 1]])];
    for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  const H = y1 - y0;
  if (!(H > 0) || !(x1 - x0 > 0)) return null;
  const cx = (x0 + x1) / 2;
  const P = (x, y) => [(x - cx) / H, (y1 - y) / H];
  const contours = raw.map((c) => ({
    start: P(...c.start),
    segs: c.segs.map((s) => (s.length === 5 ? ['Q', ...P(s[1], s[2]), ...P(s[3], s[4])] : ['L', ...P(s[1], s[2])])),
  }));
  return { contours, aspect: (x1 - x0) / H, name: source.name };
}

// Place artwork on the front, like another line of text. Returns contours in the text's nominal units,
// tagged `line: -1`. `text` is the text's contours (possibly none); mode is 'above', 'below' or 'only'.
export function placeArt(art, text, p) {
  const s = Math.max(0.1, p.artLines) * NOMINAL; // artwork height, in font sizes
  const dx = ((p.artShiftX || 0) / 100) * NOMINAL, dy = ((p.artShiftY || 0) / 100) * NOMINAL;
  let cx = 0, base;
  if (!text.length || p.artMode === 'only') {
    base = -s / 2;
  } else {
    const bb = bboxOfPolylines(text.map((c) => flattenContour(c, 0.05)));
    const gap = 0.3 * NOMINAL;
    cx = bb.cx;
    base = p.artMode === 'below' ? bb.y0 - gap - s : bb.y1 + gap;
  }
  const P = (x, y) => [cx + dx + x * s, base + dy + y * s];
  return art.contours.map((c) => ({
    line: -1,
    start: P(...c.start),
    segs: c.segs.map((seg) => (seg[0] === 'Q' ? ['Q', ...P(seg[1], seg[2]), ...P(seg[3], seg[4])] : ['L', ...P(seg[1], seg[2])])),
  }));
}

// Draw the traced outlines (even-odd, so holes show) on a small canvas.
export function drawArtPreview(canvas, art) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!art) return;
  const pad = 6;
  const s = Math.min((canvas.width - 2 * pad) / art.aspect, canvas.height - 2 * pad);
  const ox = canvas.width / 2, oy = canvas.height - pad - (canvas.height - 2 * pad - s) / 2;
  const P = (x, y) => [ox + x * s, oy - y * s];
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (const c of art.contours) {
    ctx.moveTo(...P(...c.start));
    for (const seg of c.segs) {
      if (seg[0] === 'Q') ctx.quadraticCurveTo(...P(seg[1], seg[2]), ...P(seg[3], seg[4]));
      else ctx.lineTo(...P(seg[1], seg[2]));
    }
    ctx.closePath();
  }
  ctx.fill('evenodd');
}

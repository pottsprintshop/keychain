// Self-test: builds keychains and checks them. Open tests/index.html (served over http) and press Run all.
// Results are also left on window.__testResults for scripts.

import { parseFont, layoutText, flattenContour, bboxOfPolylines } from '../js/layout.js';
import { buildKeychain } from '../js/geometry.js';
import { stlFilesFromModel } from '../js/mesh.js';
import { estimate, analyze, PRINT_DEFAULTS } from '../js/print.js';
import { dxfFromModel, svgFromModel } from '../js/laser.js';
import { parseBatch, runBatch } from '../js/batch.js';
import { snapshot, diffState, toQuery, parseQuery, applyValues } from '../js/state.js';
import { loadArtSource, traceArt, placeArt } from '../js/art.js';
import { ICONS, getIcon } from '../js/icons.js';
import { fitArcs, sampleFitted } from '../js/arcs.js';
import { circlePoints, plateRing, CL, toPath, allPaths, unionTree, offsetTree, runClipper, treeToPolys } from '../js/clip.js';

// ---- helpers ----------------------------------------------------------------------------

const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || 'values differ'}: ${a} vs ${b} (tolerance ${tol})`);

const ringArea = (pts) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s / 2);
};
const netArea = (polys) => polys.reduce((t, p) => t + ringArea(p.outer) - p.holes.reduce((h, x) => h + ringArea(x), 0), 0);
const volumeOf = (model, key) => model.layers.filter((l) => l.key === key).reduce((t, l) => t + netArea(l.polys) * (l.z1 - l.z0), 0);

// Open edges (an edge not shared by exactly two triangles) and the signed volume of a binary STL.
function stlStats(data) {
  const dv = new DataView(data.buffer, data.byteOffset);
  const n = dv.getUint32(80, true);
  const key = (x, y, z) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  const edges = new Map();
  let vol = 0;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const v = [];
    for (let k = 0; k < 3; k++) v.push([dv.getFloat32(o + 12 * k, true), dv.getFloat32(o + 12 * k + 4, true), dv.getFloat32(o + 12 * k + 8, true)]);
    const ks = v.map((p) => key(...p));
    if (new Set(ks).size < 3) continue;
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const e = ks[a] < ks[b] ? ks[a] + '|' + ks[b] : ks[b] + '|' + ks[a];
      edges.set(e, (edges.get(e) || 0) + 1);
    }
    vol += (v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) - v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) + v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0])) / 6;
  }
  return { open: [...edges.values()].filter((c) => c !== 2).length, vol, tris: n };
}

// Point to polygon-ring distance.
function distToRings(px, py, rings) {
  let d = Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let u = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      u = Math.max(0, Math.min(1, u));
      d = Math.min(d, Math.hypot(ax + u * dx - px, ay + u * dy - py));
    }
  }
  return d;
}
const ringsOf = (polys) => polys.flatMap((p) => [p.outer, ...p.holes]);
const bboxOf = (polys) => {
  const pts = polys.flatMap((p) => p.outer);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

// The model's back, drawn as you'd see it flipped over (mirrored left-right), decoded by jsQR.
function decodeBack(model, baseColor, backColor, px = 14, plate = false) {
  const upper = model.layers.filter((l) => l.key === 'base').pop();
  const back = model.layers.find((l) => l.key === 'back');
  const b = bboxOf(upper.polys);
  const W = Math.ceil((b.x1 - b.x0 + 2) * px), H = Math.ceil((b.y1 - b.y0 + 2) * px);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, W, H);
  const draw = (polys, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const ring of ringsOf(polys)) {
      ring.forEach(([x, y], i) => {
        const X = (b.x1 - x + 1) * px, Y = (b.y1 - y + 1) * px;
        if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  };
  draw(upper.polys, baseColor);
  draw(back.polys, backColor);
  const img = ctx.getImageData(0, 0, W, H);
  const light = (hex) => parseInt(hex.slice(1), 16) > 0x808080;
  if (!plate && light(backColor) && !light(baseColor)) for (let i = 0; i < img.data.length; i += 4) { img.data[i] = 255 - img.data[i]; img.data[i + 1] = 255 - img.data[i + 1]; img.data[i + 2] = 255 - img.data[i + 2]; }
  try { return globalThis.jsQR(img.data, W, H, { inversionAttempts: 'dontInvert' }); } catch (e) { return null; }
}

// A minimal zip reader (stored entries): -> [{ name, size }].
function zipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset);
  const eocd = buf.length - 22;
  const n = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < n; i++) {
    const nl = dv.getUint16(off + 28, true), xl = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
    out.push({ name: new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nl)), size: dv.getUint32(off + 24, true) });
    off += 46 + nl + xl + cl;
  }
  return out;
}

// ---- fixtures ---------------------------------------------------------------------------------

let fonts = null; // name -> parsed font
const font = (re) => [...fonts].find(([n]) => re.test(n))[1];
const TEXT = 'Potts\nPrint Shop';
const build = (f, over = {}) => buildKeychain(f, { text: TEXT, ...over });
const URL_MED = 'https://pottsprintshop.com/family/inlaws';

// ---- tests ----------------------------------------------------------------------------------------

const tests = [];
const test = (name, fn, opts = {}) => tests.push({ name, fn, ...opts });

test('the bundled fonts load', async () => {
  const list = await (await fetch('../fonts/fonts.json')).json();
  fonts = new Map();
  for (const f of list) fonts.set(f.name, parseFont(await (await fetch('../fonts/' + f.file)).arrayBuffer()));
  assert(fonts.size >= 4, `expected 4+ fonts, got ${fonts.size}`);
  return `${fonts.size} fonts`;
});

test('the size is 2.5 x 1.5 in; without the tab counted it is the body, and stretch fills it exactly', () => {
  for (const [name, f] of fonts) {
    const m = build(f, { sizeIncludesTab: false });
    const w = m.layout.hw * 2, h = m.layout.hh * 2;
    assert(w <= 63.51 && h <= 38.11, `${name}: body ${w.toFixed(2)} x ${h.toFixed(2)} exceeds 63.5 x 38.1`);
    assert(Math.abs(w - 63.5) < 0.05 || Math.abs(h - 38.1) < 0.05, `${name}: neither dimension reaches the target`);
    const s = build(f, { fit: 'stretch', sizeIncludesTab: false });
    near(s.layout.hw * 2, 63.5, 0.05, `${name} stretch width`);
    near(s.layout.hh * 2, 38.1, 0.05, `${name} stretch height`);
  }
});

test('the key hole tab is counted in the size by default, for every base shape', () => {
  const f = font(/Carter/);
  for (const shape of ['text', 'plate', 'round', 'hex', 'dogbone']) {
    const m = build(f, { baseShape: shape });
    assert(m.size.w <= 63.55 && m.size.h <= 38.15, `${shape}: overall ${m.size.w.toFixed(2)} x ${m.size.h.toFixed(2)} is over 63.5 x 38.1`);
    assert(Math.abs(m.size.w - 63.5) < 0.1 || Math.abs(m.size.h - 38.1) < 0.1, `${shape}: neither overall dimension reaches the target`);
    if (shape !== 'text') assert(Math.abs(m.size.w - 63.5) < 0.1 && Math.abs(m.size.h - 38.1) < 0.1, `${shape}: a plate fills the size (${m.size.w.toFixed(2)} x ${m.size.h.toFixed(2)})`);
  }
  const body = build(f, { sizeIncludesTab: false });
  assert(body.size.w > 63.6, 'with the tab left out of the size, the tab sticks out past it');
});

test('outline rings stack contiguously under the text', () => {
  for (const rings of [1, 2, 3]) {
    const m = build(font(/Carter/), { rings });
    const order = m.layers.filter((l) => l.key !== 'base');
    let z = m.layers.find((l) => l.key === 'base').z1;
    for (const l of order) { near(l.z0, z, 1e-9, `${l.key} starts where the layer below ends`); z = l.z1; }
    near(z, m.size.d, 1e-9, 'total thickness');
    assert(order.filter((l) => l.key.startsWith('outline')).length === rings, `ring layers for rings=${rings}`);
  }
});

test('STL bodies are watertight with the right volume (36 configurations)', async () => {
  let n = 0;
  for (const re of [/Carter/, /Bold/, /Graffiti/]) {
    for (const shape of ['text', 'plate']) {
      for (const back of ['none', 'qr', 'text']) {
        for (const rings of [1, 3]) {
          const m = build(font(re), { baseShape: shape, backKind: back, rings, qrText: URL_MED, backText: 'If found call\n303-555-0100' });
          for (const f of stlFilesFromModel(m, 't')) {
            const s = stlStats(f.data), exp = volumeOf(m, f.key);
            assert(s.open === 0, `${re}/${shape}/${back}/${rings} ${f.key}: ${s.open} open edges`);
            near(s.vol / exp, 1, 0.001, `${re}/${shape}/${back}/${rings} ${f.key} volume ratio`);
          }
          n++;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return `${n} configurations`;
});

test('STL bodies of the round, hexagon and dog bone bases are watertight with the right volume', () => {
  let n = 0;
  for (const re of [/Carter/, /Graffiti/]) {
    for (const shape of ['round', 'hex', 'dogbone']) {
      for (const back of ['none', 'qr', 'text']) {
        for (const rings of [1, 3]) {
          const m = build(font(re), { baseShape: shape, backKind: back, rings, qrText: 'https://x.co/a', backText: 'REX' });
          for (const f of stlFilesFromModel(m, 't')) {
            const s = stlStats(f.data), exp = volumeOf(m, f.key);
            assert(s.open === 0, `${re}/${shape}/${back}/${rings} ${f.key}: ${s.open} open edges`);
            near(s.vol / exp, 1, 0.001, `${re}/${shape}/${back}/${rings} ${f.key} volume ratio`);
          }
          n++;
        }
      }
    }
  }
  return `${n} configurations`;
});

test('the key hole clears the outline all the way around, and the base stays one piece', () => {
  let n = 0;
  for (const re of [/Carter/, /Graffiti/]) {
    for (const shape of ['text', 'plate', 'round', 'hex', 'dogbone']) {
      for (let angle = 0; angle < 360; angle += shape === 'text' || shape === 'plate' ? 15 : 30) {
        const m = build(font(re), { baseShape: shape, holeAngle: angle });
        const h = m.exact.hole;
        const text = m.layers.find((l) => l.key === 'text');
        assert(distToRings(h.cx, h.cy, ringsOf(text.polys)) >= h.need - 0.05, `${re}/${shape}@${angle}: hole too close to the text`);
        const base = m.layers.filter((l) => l.key === 'base').flatMap((l) => l.polys);
        assert(base.length === 1 && base[0].holes.length === 1, `${re}/${shape}@${angle}: base is ${base.length} piece(s) with ${base[0].holes.length} hole(s)`);
        n++;
      }
    }
  }
  return `${n} placements`;
});

// Even-odd point-in-polygons test.
const insidePolys = (x, y, polys) => {
  let odd = false;
  for (const ring of ringsOf(polys)) {
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
};

test('round, hexagon and dog bone bases: fill the size, keep the text inside with the full margin', () => {
  const f = font(/Carter/);
  const margin = 0.8 + 2.0; // outline + base margin
  let n = 0;
  for (const shape of ['round', 'hex', 'dogbone']) {
    for (const over of [{}, { fit: 'stretch' }, { text: 'REX', width: 70 }, { text: 'Erich\nDeutsch', width: 50, height: 50 }]) {
      const m = build(f, { baseShape: shape, holeEnabled: false, ...over });
      near(m.size.w, over.width || 63.5, 0.05, `${shape} ${JSON.stringify(over)}: width`);
      near(m.size.h, over.height || 38.1, 0.05, `${shape} ${JSON.stringify(over)}: height`);
      const base = m.layers.find((l) => l.key === 'base').polys;
      assert(base.length === 1 && base[0].holes.length === 0, `${shape}: one solid piece`);
      const text = m.layers.find((l) => l.key === 'text').polys;
      let worst = Infinity;
      for (const p of text) {
        for (const [x, y] of p.outer) {
          assert(insidePolys(x, y, base), `${shape} ${JSON.stringify(over)}: text sticks out of the base`);
          worst = Math.min(worst, distToRings(x, y, ringsOf(base)));
        }
      }
      assert(worst >= margin - 0.05, `${shape} ${JSON.stringify(over)}: text is only ${worst.toFixed(2)} mm from the edge (margin ${margin})`);
      assert(m.warnings.length === 0, `${shape}: ${m.warnings.join(' | ')}`);
      n++;
    }
  }
  // Counting the key hole tab in the size still comes to exactly the size asked for.
  for (const shape of ['round', 'hex', 'dogbone']) {
    const m = build(f, { baseShape: shape, sizeIncludesTab: true });
    near(m.size.w, 63.5, 0.05, `${shape} with tab: width`);
    near(m.size.h, 38.1, 0.05, `${shape} with tab: height`);
  }
  const wide = build(f, { baseShape: 'dogbone', boneShaft: 0.75 }), thin = build(f, { baseShape: 'dogbone', boneShaft: 0.4 });
  assert(wide.scale.x > thin.scale.x * 1.2, `a thicker shaft leaves room for bigger text (${wide.scale.x} vs ${thin.scale.x})`);
  const circle = build(f, { baseShape: 'round', width: 50, height: 50, holeEnabled: false });
  near(netArea(circle.layers.find((l) => l.key === 'base').polys), Math.PI * 625, 3, 'a round base with equal width and height is a circle');
  return `${n} designs`;
});

test('text size shrinks the text on its own: plates keep their size, a base that follows the text follows it', () => {
  const f = font(/Carter/);
  const textArea = (m) => netArea(m.layers.find((l) => l.key === 'text').polys);
  for (const shape of ['plate', 'round', 'hex', 'dogbone']) {
    const full = build(f, { baseShape: shape, holeEnabled: false });
    const half = build(f, { baseShape: shape, holeEnabled: false, textSize: 0.5 });
    near(half.size.w, full.size.w, 0.05, `${shape}: width unchanged`);
    near(half.size.h, full.size.h, 0.05, `${shape}: height unchanged`);
    near(half.scale.x / full.scale.x, 0.5, 1e-6, `${shape}: the text is half as big`);
    near(textArea(half) / textArea(full), 0.25, 0.01, `${shape}: a quarter of the ink`);
    // and it stays centred, with at least the full margin
    const base = half.layers.find((l) => l.key === 'base').polys;
    for (const p of half.layers.find((l) => l.key === 'text').polys) for (const [x, y] of p.outer) assert(insidePolys(x, y, base), `${shape}: text inside the base`);
  }
  const whole = build(f, { holeEnabled: false }), small = build(f, { holeEnabled: false, textSize: 0.5 });
  assert(small.size.w < whole.size.w * 0.7, `a base that follows the text shrinks with it (${small.size.w} vs ${whole.size.w})`);
  near(build(f, { textSize: 3 }).scale.x, build(f).scale.x, 1e-9, 'the text is never bigger than the biggest that fits');
});

test('dog bone: the key hole in the middle of the top edge clears the text and nests between the knobs', () => {
  const f = font(/Carter/);
  for (const shaft of [0.3, 0.4, 0.5, 0.65, 0.8]) {
    const m = build(f, { baseShape: 'dogbone', boneShaft: shaft, holeAngle: 90 });
    const h = m.exact.hole;
    const text = m.layers.find((l) => l.key === 'text');
    assert(distToRings(h.cx, h.cy, ringsOf(text.polys)) >= h.need - 0.05, `shaft ${shaft}: hole too close to the text`);
    near(h.cx, 0, 0.05, `shaft ${shaft}: hole is in the middle`);
    const base = m.layers.filter((l) => l.key === 'base').flatMap((l) => l.polys);
    assert(base.length === 1 && base[0].holes.length === 1, `shaft ${shaft}: one piece with one hole`);
    if (shaft <= 0.5) near(m.size.h, 38.1, 0.05, `shaft ${shaft}: the tab sits between the knobs, so the height is unchanged`);
  }
});

test('layers can be taken away: no outlines, no text, no base', () => {
  const f = font(/Carter/);
  const keys = (m) => [...new Set(m.layers.map((l) => l.key))].join();
  const none = build(f, { rings: 0 });
  assert(keys(none) === 'base,text', `no outline: ${keys(none)}`);
  near(none.layers.find((l) => l.key === 'text').z0, none.layers.find((l) => l.key === 'base').z1, 1e-9, 'the text sits right on the base');
  const noText = build(f, { textOn: false });
  assert(keys(noText) === 'base,outline', `no text: ${keys(noText)}`);
  near(noText.size.d, 1.2 + 0.6, 1e-9, 'total thickness without the text');
  const noBase = build(f, { baseOn: false, holeEnabled: true, backKind: 'qr', qrText: 'https://x.co', borderW: 0.8 });
  assert(keys(noBase) === 'outline,text', `no base: ${keys(noBase)}`);
  assert(!noBase.exact.hole && noBase.layers.every((l) => l.z0 >= 0) && noBase.layers[0].z0 === 0, 'the key hole, back and border need a base, so they drop away with it');
  near(noBase.size.w, 63.5, 0.1, 'no base: the size is still the size asked for');
  const lone = build(f, { rings: 0, textOn: false });
  assert(keys(lone) === 'base', `only a base: ${keys(lone)}`);
  const onlyText = build(f, { rings: 0, baseOn: false });
  assert(keys(onlyText) === 'text', `only text: ${keys(onlyText)}`);
  // every combination still makes watertight STLs with the right volume
  let n = 0;
  for (const rings of [0, 1, 3]) for (const textOn of [true, false]) for (const baseOn of [true, false]) {
    if (!rings && !textOn && !baseOn) continue;
    for (const baseShape of ['text', 'plate', 'dogbone']) {
      const m = build(f, { rings, textOn, baseOn, baseShape, borderW: baseShape === 'dogbone' ? 0.8 : 0 });
      for (const file of stlFilesFromModel(m, 't')) {
        const st = stlStats(file.data), exp = volumeOf(m, file.key);
        assert(st.open === 0, `rings ${rings} text ${textOn} base ${baseOn} ${baseShape} ${file.key}: ${st.open} open edges`);
        near(st.vol / exp, 1, 0.001, `rings ${rings} text ${textOn} base ${baseOn} ${baseShape} ${file.key} volume`);
      }
      n++;
    }
  }
  return `${n} combinations`;
});

test('a border is a raised rim along the edge of the base, as tall as the layer above the base', () => {
  const f = font(/Carter/);
  for (const shape of ['plate', 'round', 'hex', 'dogbone', 'text']) {
    const m = build(f, { baseShape: shape, borderW: 0.8, rings: 2, ring2H: 0.4 });
    const border = m.layers.find((l) => l.key === 'border');
    const base = m.layers.find((l) => l.key === 'base');
    assert(border, `${shape}: has a border`);
    near(border.z0, base.z1, 1e-9, `${shape}: the border sits on the base`);
    near(border.z1 - border.z0, 0.4, 1e-9, `${shape}: as tall as the outermost outline (0.4)`);
    // every point of the border is within 0.8 mm of the outer edge of the base, and none is outside it
    const edge = base.polys.map((p) => p.outer);
    for (const p of border.polys) for (const [x, y] of p.outer) {
      assert(distToRings(x, y, edge) < 0.05 || distToRings(x, y, base.polys.flatMap((q) => q.holes)) < 0.9, `${shape}: border point off the edge`);
    }
    assert(m.warnings.length === 0, `${shape}: ${m.warnings.join(' | ')}`);
    // its area is about the perimeter times its width
    let perimeter = 0;
    for (const p of base.polys) for (const ring of [p.outer]) for (let i = 0; i < ring.length; i++) { const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]; perimeter += Math.hypot(x2 - x1, y2 - y1); }
    const area = netArea(border.polys);
    assert(area > perimeter * 0.8 * 0.7 && area < perimeter * 0.8 * 1.15, `${shape}: border area ${area.toFixed(1)} vs perimeter ${perimeter.toFixed(1)} x 0.8`);
  }
  const plain = build(f, { baseShape: 'dogbone', borderW: 0.8 });
  const rim = plain.layers.find((l) => l.key === 'border');
  const h = plain.exact.hole;
  for (const p of rim.polys) for (const ring of [p.outer, ...p.holes]) for (const [x, y] of ring) assert(Math.hypot(x - h.cx, y - h.cy) >= h.R + 0.3, 'the border stays clear of the key hole');
  assert(!build(f, { borderW: 0 }).layers.some((l) => l.key === 'border'), 'no border by default');
  const wide = build(f, { baseMargin: 0.5, borderW: 1.5 });
  assert(wide.warnings.some((w) => /border/.test(w)), 'a border that runs into the outline is flagged');
});

test('Potts Graffiti: the second T of a pair drops and tucks left instead of merging with the first', () => {
  const f = font(/Graffiti/);
  const one = layoutText(f, 'T', { align: 'left' }).length; // contours per T
  const groups = (text) => {
    const cs = layoutText(f, text, { align: 'left' });
    assert(cs.length % one === 0, `${text}: ${cs.length} contours`);
    return Array.from({ length: cs.length / one }, (_, g) => cs.slice(g * one, (g + 1) * one).map((c) => flattenContour(c, 0.05)));
  };
  const paths = (polylines) => allPaths(unionTree(polylines.map(toPath)));
  const gap = (a, b) => { // how close two shapes come, by growing one until it meets the other
    let lo = 0, hi = 30;
    for (let i = 0; i < 9; i++) {
      const g = (lo + hi) / 2;
      const hit = allPaths(runClipper(CL.ClipType.ctIntersection, allPaths(offsetTree(paths(a), g)), paths(b))).length > 0;
      if (hit) hi = g; else lo = g;
    }
    return lo;
  };
  for (const text of ['TT', 'tt']) {
    const [a, b] = groups(text);
    assert(gap(a, b) >= 4, `${text}: the two T's come within ${gap(a, b).toFixed(1)} units of each other`);
    const A = bboxOfPolylines(a), B = bboxOfPolylines(b);
    near(A.y1 - B.y1, 16, 0.5, `${text}: the second T drops 0.16 of the font size`);
    assert(B.x0 < A.x1 - 20, `${text}: and tucks under the first one's crossbar`);
  }
  const [t1, t2, t3] = groups('TTT');
  near(bboxOfPolylines(t3).y1, bboxOfPolylines(t1).y1, 0.5, 'in a run of three, the third T is back up');
  assert(bboxOfPolylines(t2).y1 < bboxOfPolylines(t1).y1 - 10, 'and the second one is down');
  // the letters after the tucked T follow it, and everything else in the font is untouched
  const plain = layoutText(f, 'PO', { align: 'left' });
  assert(JSON.stringify(plain) === JSON.stringify(layoutText(f, 'PO', { align: 'left' })), 'PO is laid out as before');
  const before = bboxOfPolylines(layoutText(f, 'TS', { align: 'left' }).map((c) => flattenContour(c, 0.05)));
  const after = bboxOfPolylines(layoutText(f, 'TTS', { align: 'left' }).map((c) => flattenContour(c, 0.05)));
  near(after.x1 - before.x1, f.getAdvanceWidth('TTS', 100) - f.getAdvanceWidth('TS', 100) - 32, 1.5, 'the S follows the tucked T (one T wider, less the 32 units it moved left)');
  const carter = font(/Carter/);
  const c = layoutText(carter, 'TT', { align: 'left' });
  near(bboxOfPolylines(c.map((k) => flattenContour(k, 0.05))).y0, bboxOfPolylines(layoutText(carter, 'T', { align: 'left' }).map((k) => flattenContour(k, 0.05))).y0, 1e-6, 'other fonts are left alone');
});

test('the sports icons are clean artwork: in the unit box, no fragments, nothing thinner than half a millimetre at 16 mm tall', () => {
  const mm = 16;
  for (const key of Object.keys(ICONS)) {
    const art = getIcon(key);
    assert(art && art.contours.length >= 2 && art.aspect > 0.7 && art.aspect < 1.4, `${key}: ${art && art.contours.length} contours, aspect ${art && art.aspect}`);
    for (const c of art.contours) {
      for (const [x, y] of [c.start, ...c.segs.map((sg) => [sg[1], sg[2]])]) assert(y >= -1e-6 && y <= 1 + 1e-6 && Math.abs(x) <= art.aspect / 2 + 1e-6, `${key}: a point is outside the box`);
    }
    const paths = art.contours.map((c) => toPath([c.start, ...c.segs.map((sg) => [sg[1], sg[2]])].map(([x, y]) => [x * mm, y * mm])));
    const solid = allPaths(unionTree(paths, CL.PolyFillType.pftEvenOdd));
    const area = (ps) => netArea(treeToPolys(unionTree(ps)));
    const A = area(solid);
    assert(A > 0.15 * mm * mm, `${key}: the icon is nearly empty (${A.toFixed(1)} mm2)`);
    const opened = allPaths(offsetTree(allPaths(offsetTree(solid, -0.25)), 0.25));
    const closed = allPaths(offsetTree(allPaths(offsetTree(solid, 0.25)), -0.25));
    assert((A - area(opened)) / A < 0.03, `${key}: ${(((A - area(opened)) / A) * 100).toFixed(1)}% of it is thinner than 0.5 mm`);
    assert((area(closed) - A) / A < 0.03, `${key}: ${(((area(closed) - A) / A) * 100).toFixed(1)}% of it is gaps narrower than 0.5 mm`);
    // no two outlines touch at a point (that makes an invalid, pinched solid)
    const seen = new Map();
    art.contours.forEach((c, i) => {
      for (const [x, y] of [c.start, ...c.segs.map((sg) => [sg[1], sg[2]])]) {
        const k = `${Math.round(x * 1e5)},${Math.round(y * 1e5)}`;
        assert(!seen.has(k) || seen.get(k) === i, `${key}: two outlines touch at a point`);
        seen.set(k, i);
      }
    });
    // one solid piece, apart from the islands inside its cut-outs
    assert(treeToPolys(unionTree(solid)).length === 1, `${key}: the icon is in ${treeToPolys(unionTree(solid)).length} pieces`);
  }
});

test('artwork can sit beside the text, as tall as the text', () => {
  const f = font(/Carter/);
  const text = layoutText(f, 'Deutsch', { align: 'left' });
  const tb = bboxOfPolylines(text.map((c) => flattenContour(c, 0.05)));
  const art = getIcon('soccer');
  for (const mode of ['right', 'left']) {
    const placed = placeArt(art, text, { artMode: mode, artLines: 1, artShiftX: 0, artShiftY: 0 });
    const ab = bboxOfPolylines(placed.map((c) => flattenContour(c, 0.05)));
    near(ab.h, tb.h, 0.5, `${mode}: as tall as the text`);
    near(ab.cy, tb.cy, 0.5, `${mode}: centred on the text vertically`);
    assert(mode === 'right' ? ab.x0 > tb.x1 : ab.x1 < tb.x0, `${mode}: on the ${mode}, clear of the text`);
    assert(placed.every((c) => c.line === -1), 'tagged as artwork');
  }
  const half = placeArt(art, text, { artMode: 'right', artLines: 0.5, artShiftX: 0, artShiftY: 0 });
  near(bboxOfPolylines(half.map((c) => flattenContour(c, 0.05))).h, tb.h / 2, 0.5, 'artLines scales the icon');
});

test('the Sports tag: a long thin rectangle, a last name and an icon, all inside the base', () => {
  const f = font(/Carter/);
  const margin = 0.8 + 2.0;
  for (const key of ['tennis', 'baseball', 'football', 'soccer']) {
    const m = build(f, { baseShape: 'sports', text: 'Deutsch', width: 101.6, height: 25.4, art: getIcon(key), artMode: 'right', artLines: 1 });
    near(m.size.w, 101.6, 0.1, `${key}: 4 in long, key hole tab included`);
    near(m.size.h, 25.4, 0.1, `${key}: 1 in high`);
    const base = m.layers.find((l) => l.key === 'base').polys;
    const text = m.layers.find((l) => l.key === 'text').polys;
    let worst = Infinity;
    for (const p of text) for (const [x, y] of p.outer) {
      assert(insidePolys(x, y, base), `${key}: the text or icon sticks out of the base`);
      worst = Math.min(worst, distToRings(x, y, ringsOf(base)));
    }
    assert(worst >= margin - 0.05, `${key}: only ${worst.toFixed(2)} mm from the edge (margin ${margin})`);
    // the icon is the piece at the right, about as tall as the letters
    const b = bboxOf(text);
    const right = text.filter((p) => p.outer.every(([x]) => x > b.x1 - (b.y1 - b.y0) * 1.6));
    assert(right.length >= 1, `${key}: nothing at the right end`);
    assert(m.warnings.length === 0, `${key}: ${m.warnings.join(' | ')}`);
    for (const file of stlFilesFromModel(m, 't')) {
      const st = stlStats(file.data), exp = volumeOf(m, file.key);
      assert(st.open === 0, `${key} ${file.key}: ${st.open} open edges`);
      near(st.vol / exp, 1, 0.001, `${key} ${file.key} volume`);
    }
  }
  // without an icon it is just the name, and the hole sits at the left end
  const plain = build(f, { baseShape: 'sports', text: 'Deutsch', width: 101.6, height: 25.4 });
  assert(plain.exact.hole.cx < -40, 'the key hole is at the left end');
  assert(plain.scale.x > 0.05, 'the name is a reasonable size');
});

test('line offsets move a line relative to the others; a frozen layout rebuilds identically', () => {
  const f = font(/Carter/);
  const m0 = build(f);
  const m1 = build(f, { lineShifts: [0, 20], lineShiftsY: [0, -10] });
  const rel = (m) => m.lines[1].bbox.cx - m.lines[0].bbox.cx;
  assert(Math.abs(rel(m1) - rel(m0)) > 5, 'shifting line 2 changes its position relative to line 1');
  const frozen = build(f, { fixed: m0.layout });
  near(netArea(frozen.layers.find((l) => l.key === 'text').polys), netArea(m0.layers.find((l) => l.key === 'text').polys), 1e-6, 'frozen text area');
  near(frozen.exact.hole.cx, m0.exact.hole.cx, 1e-6, 'frozen hole position');
});

test('the back content stays inside the edge margin, centred, and grows smoothly', () => {
  const f = font(/Carter/);
  for (const kind of ['qr', 'text']) {
    for (const margin of [0.6, 1.2, 2]) {
      const m = build(f, { baseShape: 'plate', backKind: kind, qrText: URL_MED, backText: 'If found call\n303-555-0100', backMargin: margin });
      const upper = m.layers.filter((l) => l.key === 'base').pop();
      const back = m.layers.find((l) => l.key === 'back');
      let d = Infinity;
      for (const p of back.polys) for (const [x, y] of p.outer) d = Math.min(d, distToRings(x, y, ringsOf(upper.polys)));
      assert(d >= margin - 0.02, `${kind} margin ${margin}: only ${d.toFixed(3)} mm from the edge`);
      // The QR is a square, so it should come right up to the margin; text is fitted by its bounding box (and keeps
      // clear of the key hole's margin), so its letters can sit a little further in.
      assert(d <= margin + (kind === 'qr' ? 0.6 : 2.5), `${kind} margin ${margin}: ${d.toFixed(2)} mm from the edge is a lot more than asked`);
      const b = bboxOf(back.polys);
      near((b.x0 + b.x1) / 2, m.back.cx, 0.05, `${kind} centred (x)`);
      near((b.y0 + b.y1) / 2, m.back.cy, 0.05, `${kind} centred (y)`);
    }
  }
  const sizes = [1.4, 1.42, 1.44, 1.46, 1.48, 1.5].map((inches) => build(f, { baseShape: 'plate', height: inches * 25.4, backKind: 'qr', qrText: URL_MED }).back.side);
  for (let i = 1; i < sizes.length; i++) assert(sizes[i] > sizes[i - 1] + 0.1, `QR size should grow with every step: ${sizes.map((s) => s.toFixed(2)).join(' ')}`);
  return `QR sizes ${sizes.map((s) => s.toFixed(1)).join(' ')}`;
});

test('QR codes decode when read from the back (light on dark, dark on light, plate)', () => {
  const f = font(/Carter/);
  const urls = ['https://potts.co/inlaws', URL_MED, 'https://pottsprintshop.com/family/thanksgiving-2026/photos?album=inlaws&lang=en', 'WIFI:T:WPA;S:Potts Guest;P:correct horse battery;;', 'Hola, Ñandú 🎉 — Potts!'];
  let n = 0;
  for (const url of urls) {
    for (const ecc of ['L', 'M', 'H']) {
      for (const [baseColor, backColor, plate] of [['#16161a', '#f2f2f2', false], ['#f2f2f2', '#16161a', false], ['#16161a', '#f2f2f2', true]]) {
        const m = build(f, { baseShape: 'plate', backKind: 'qr', qrText: url, qrEcc: ecc, qrPlate: plate });
        if (m.back.module < 0.8) continue; // too small to print, so not promised to scan
        const d = decodeBack(m, baseColor, backColor, 14, plate);
        assert(d && d.data === url, `${ecc} ${baseColor} plate=${plate}: ${d ? 'decoded ' + JSON.stringify(d.data) : 'did not decode'} for ${JSON.stringify(url)}`);
        n++;
      }
    }
  }
  return `${n} decodes`;
});

test('QR codes decode on round and hexagon bases too', () => {
  const f = font(/Carter/);
  let n = 0;
  for (const shape of ['round', 'hex']) {
    for (const ecc of ['L', 'M']) {
      for (const [baseColor, backColor] of [['#16161a', '#f2f2f2'], ['#f2f2f2', '#16161a']]) {
        const m = build(f, { baseShape: shape, width: 76, height: 66, backKind: 'qr', qrText: 'https://potts.co/inlaws', qrEcc: ecc });
        assert(m.back && m.back.module >= 0.8, `${shape}: the QR modules are ${m.back && m.back.module}`);
        const d = decodeBack(m, baseColor, backColor, 14, false);
        assert(d && d.data === 'https://potts.co/inlaws', `${shape} ${ecc} ${baseColor}: ${d ? 'decoded ' + JSON.stringify(d.data) : 'did not decode'}`);
        n++;
      }
    }
  }
  return `${n} decodes`;
});

test('artwork traces (holes kept) and fits on the front and back', async () => {
  const c = document.createElement('canvas');
  c.width = 400;
  c.height = 300;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 300); g.fillStyle = '#000';
  g.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 60 : 130, a = -Math.PI / 2 + i * Math.PI / 5; g.lineTo(200 + r * Math.cos(a), 150 + r * Math.sin(a)); }
  g.closePath(); g.fill();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(200, 150, 32, 0, 7); g.fill();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const art = await traceArt(await loadArtSource(new File([blob], 'star.png', { type: 'image/png' })), { threshold: 128, detail: 7, invert: false, denoise: false });
  assert(art && art.contours.length === 2, `star with a hole should trace to 2 contours, got ${art && art.contours.length}`);
  const f = font(/Carter/);
  const front = build(f, { text: 'Potts', art, artMode: 'above', artLines: 2.5, baseShape: 'plate' });
  const text = front.layers.find((l) => l.key === 'text');
  assert(text.polys.some((p) => p.holes.length), 'the star keeps its hole');
  const only = build(f, { text: 'ignored', art, artMode: 'only' });
  assert(only.layers.find((l) => l.key === 'text').polys.length === 1, 'artwork-only has just the star');
  const back = build(f, { baseShape: 'plate', backKind: 'art', art });
  assert(back.back && back.back.kind === 'art', 'artwork on the back');
  for (const l of [front, only, back].flatMap((m) => m.layers)) assert(stlStats(stlFilesFromModel({ layers: [l] }, 't')[0].data).open === 0, `${l.key} watertight`);
});

test('every control the app reads exists in index.html (and the panels are where they should be)', async () => {
  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const js = await (await fetch('../js/app.js', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const ids = new Set([...doc.querySelectorAll('[id]')].map((e) => e.id));
  const used = new Set([...js.matchAll(/\bel\.([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]));
  for (const m of js.matchAll(/getElementById\('([^']+)'\)|\$\('([^']+)'\)/g)) used.add(m[1] || m[2]);
  const missing = [...used].filter((id) => !ids.has(id));
  assert(!missing.length, `app.js uses ids that index.html doesn't have: ${missing.join(', ')}`);
  const dupes = [...doc.querySelectorAll('[id]')].map((e) => e.id).filter((id, i, all) => all.indexOf(id) !== i);
  assert(!dupes.length, `duplicate ids: ${dupes.join(', ')}`);
  // Where things live: shape above the preview, size under it, then the downloads.
  const col = [...doc.querySelector('.preview-col').children].map((c) => c.id || c.className.split(' ')[0]);
  assert(col.join() === 'panelShape,preview-box,panelSize,panel', `right column order: ${col.join()}`);
  assert(doc.querySelector('#panelShape #baseShape') && doc.querySelector('#panelSize #width') && doc.querySelector('#nerdSize #fit') && doc.querySelector('#nerdSize #sizeIncludesTab'), 'shape, size and the Nerd Shite settings are in their panels');
  const download = doc.querySelector('.download-row');
  assert(['format', 'downloadBtn', 'copyLink'].every((id) => download.querySelector('#' + id)), 'download, format and copy link share a row');
  return `${used.size} ids checked`;
});

test('a shareable link round-trips through the form', () => {
  const html = '<input id="text" value="Hi"><input id="w" type="number" value="2.5"><input id="c" type="color" value="#f3cf1c"><input id="chk" type="checkbox" checked><select id="s"><option value="a" selected>a</option><option value="b">b</option></select><input id="skip" data-noshare value="x"><input id="n" class="numval" value="1"><input id="f" type="file">';
  const make = () => { const d = document.createElement('div'); d.innerHTML = html; return d; };
  const a = make();
  const defaults = snapshot(a);
  assert(!('skip' in defaults) && !('n' in defaults) && !('f' in defaults), 'no-share, number boxes and file inputs are left out');
  a.querySelector('#text').value = 'Bye\nnow';
  a.querySelector('#c').value = '#00ff88';
  a.querySelector('#chk').checked = false;
  a.querySelector('#s').value = 'b';
  const q = toQuery(diffState(snapshot(a), defaults));
  assert(!q.includes('w='), 'unchanged values are not in the link');
  const b = make();
  applyValues(b, parseQuery(q + '&nonsense=1'));
  assert(JSON.stringify(snapshot(b)) === JSON.stringify(snapshot(a)), `round trip: ${JSON.stringify(snapshot(b))}`);
});

test('batch: parses lists and makes a zip with a summary', async () => {
  const rows = parseBatch('Name,QR\nErich|Deutsch\n\n"A, B",https://x.co/b\nC\tsecond');
  assert(rows.length === 3 && rows[0].text === 'Erich\nDeutsch' && rows[1].text === 'A, B' && rows[1].extra === 'https://x.co/b' && rows[2].extra === 'second', JSON.stringify(rows));
  const f = font(/Carter/);
  const res = await runBatch({ items: parseBatch('Erich|Lizzie,https://x.co/e\nPotts'), font: f, baseParams: { ...build(f).params, backKind: 'qr', baseShape: 'plate', qrText: 'https://x.co/default' }, format: 'stl', colors: {}, printSettings: PRINT_DEFAULTS, buildStep: null, onProgress() {}, shouldCancel: () => false });
  const entries = zipEntries(new Uint8Array(await res.blob.arrayBuffer()));
  assert(res.count === 2 && entries.length === 9 && entries.some((e) => e.name === 'summary.csv'), `count ${res.count}, entries ${entries.length}`);
  assert(entries.filter((e) => e.name.endsWith('.stl')).every((e) => e.size > 1000), 'every STL has content');
});

test('laser: DXF and SVG carry every layer', () => {
  const m = build(font(/Carter/), { baseShape: 'plate', rings: 2, backKind: 'qr', qrText: URL_MED });
  const dxf = dxfFromModel(m);
  const expected = [m.layers.filter((l) => l.key === 'base').pop(), ...m.layers.filter((l) => l.key !== 'base')].reduce((t, l) => t + l.polys.reduce((a, p) => a + 1 + p.holes.length, 0), 0);
  assert((dxf.match(/LWPOLYLINE/g) || []).length === expected, `polylines: ${(dxf.match(/LWPOLYLINE/g) || []).length} vs ${expected}`);
  assert(dxf.trim().endsWith('EOF') && ['BASE', 'OUTLINE', 'OUTLINE2', 'TEXT', 'BACK'].every((n) => dxf.includes(n)), 'DXF layers');
  const doc = new DOMParser().parseFromString(svgFromModel(m, { text: '#f00' }), 'image/svg+xml');
  assert(!doc.querySelector('parsererror') && doc.querySelectorAll('g').length === 5, 'SVG is well-formed with one group per layer');
});

test('print check: estimates add up, thin details are found, settings are checked', () => {
  const f = font(/Carter/);
  const m = build(f);
  const est = estimate(m, PRINT_DEFAULTS);
  near(est.rows.reduce((t, r) => t + r.grams, 0), est.total, 1e-9, 'rows add up to the total');
  assert(est.total > 1 && est.total < 20, `implausible total ${est.total} g`);
  assert(analyze(m, PRINT_DEFAULTS).warnings.length === 0, 'the default design has no warnings: ' + analyze(m, PRINT_DEFAULTS).warnings.join(' | '));
  const spiky = analyze(build(font(/Graffiti/), { text: 'WHOOP\nWHOOP!!', width: 30, height: 20 }), PRINT_DEFAULTS);
  assert(spiky.thin.length > 0 && spiky.overlay.length > 0, 'a small spiky design has thin details and an overlay');
  const odd = analyze(build(f, { outline: 0.3, textH: 0.5, holeEdge: 0.8 }), PRINT_DEFAULTS).warnings.join(' | ');
  assert(/Outline is only/.test(odd) && /key hole/.test(odd) && /multiple/.test(odd), 'settings warnings: ' + odd);
});

test('overlapping lines are detected only when they really overlap', () => {
  const f = font(/Carter/);
  assert(build(f).exact.textOverlap === false, 'the default text does not overlap itself');
  assert(build(f, { lineShiftsY: [0, 35] }).exact.textOverlap === true, 'lines dragged together overlap');
  assert(build(f, { lineShifts: [-20, 20] }).exact.textOverlap === false, 'lines slid sideways past each other do not');
});

test('arc fitting: circles and rounded corners become arcs, corners stay lines, the shape holds', () => {
  const dev = (ring, fitted) => Math.max(...ring.map(([x, y]) => distToRings(x, y, [fitted])));
  const circle = circlePoints(5, -3, 6, 0.01);
  const c = fitArcs(circle);
  assert(c.segs.length <= 4 && c.segs.filter((s) => s[0] === 'A').length >= 2, `a circle is ${c.segs.length} segments, ${c.segs.filter((s) => s[0] === 'A').length} of them arcs`);
  const back = sampleFitted(c, 0.01);
  near(ringArea(back), Math.PI * 36, 0.35, 'circle area');
  assert(dev(circle, back) < 0.005, `circle deviates ${dev(circle, back)}`);

  const box = [[0, 0], [40, 0], [40, 20], [0, 20]];
  const b = fitArcs(box);
  assert(b.segs.length === 4 && b.segs.every((s) => s[0] === 'L'), 'a rectangle stays four lines');

  const plate = plateRing(20, 10, 3); // rounded rectangle, as a dense polyline
  const p = fitArcs(plate);
  const arcs = p.segs.filter((s) => s[0] === 'A').length;
  assert(arcs >= 4 && arcs <= 8 && p.segs.length <= 16 && p.segs.length < plate.length / 2, `plate: ${arcs} arcs of ${p.segs.length} segments from ${plate.length} points`);
  const pb = sampleFitted(p, 0.01);
  near(ringArea(pb), ringArea(plate), 0.15, 'plate area');
  assert(dev(plate, pb) < 0.005, `plate deviates ${dev(plate, pb)}`);

  const zig = Array.from({ length: 12 }, (_, i) => [i * 0.5, i % 2 ? 0.2 : 0]); // a zig-zag is not an arc
  assert(fitArcs(zig).segs.every((s) => s[0] === 'L'), 'a zig-zag has no arcs');
  const rev = fitArcs(plate.slice().reverse()); // the same shape wound the other way
  assert(Math.abs(rev.segs.length - p.segs.length) <= 2, `winding changes the fit: ${rev.segs.length} vs ${p.segs.length}`);
  near(ringArea(sampleFitted(rev, 0.01)), ringArea(plate), 0.15, 'reversed plate area');
});

// STEP round trips need the CAD engine: load it on the main thread too, to read the file back.
let R = null;
async function stepCheck(m, label, { maxMB, arcs = true, exactText = false } = {}) {
  const { buildStep } = await import('../js/step.js');
  if (!R) {
    R = await import('../vendor/replicad.js');
    R.setOC(await (await import('../vendor/replicad_single.js')).default());
  }
  const palette = { text: '#f3cf1c', outline: '#d4206a', outline2: '#ffffff', outline3: '#3fa7ff', base: '#16161a', back: '#f2f2f2' };
  const res = await buildStep(m, palette);
  const text = await res.blob.text();
  for (const l of m.layers) assert(text.includes(`'${l.name}'`), `${label}: STEP is missing a body named "${l.name}"`);
  const shape = await R.importSTEP(res.blob);
  const total = m.layers.reduce((t, l) => t + netArea(l.polys) * (l.z1 - l.z0), 0);
  // Arcs are the true curves the polygons only approximate, so the volumes differ by a fraction of a percent.
  near(R.measureVolume(shape) / total, 1, 0.005, `${label}: STEP volume vs model`);
  assert(res.report.base === 'exact', `${label}: the base fell back to polygons (${res.report.baseWhy || ''})`);
  if (arcs) assert(res.report.outline === 'arcs' && res.report.baseFaces === 'arcs', `${label}: outlines were not built from arcs (${JSON.stringify(res.report)})`);
  if (exactText) assert(res.report.text === 'exact', `${label}: the text fell back to polygons`);
  const mb = res.blob.size / 1e6;
  if (maxMB) assert(mb <= maxMB, `${label}: ${mb.toFixed(1)} MB is over the ${maxMB} MB budget`);
  return `${label}: ${mb.toFixed(1)} MB, ${res.report.edges.points} points -> ${res.report.edges.segments} edges`;
}
test('STEP: default plate with a QR code', () => stepCheck(build(font(/Carter/), { baseShape: 'plate', backKind: 'qr', qrText: URL_MED }), 'plate+QR', { maxMB: 8, exactText: true }), { step: true });
test('STEP: text-shaped base, 3 rings, back text', () => stepCheck(build(font(/Graffiti/), { text: 'WHOOP\nWHOOP!!', rings: 3, backKind: 'text', backText: 'If found call\n303-555-0100' }), 'graffiti', { maxMB: 12 }), { step: true });
test('STEP: dog bone base', () => stepCheck(build(font(/Carter/), { baseShape: 'dogbone', text: 'Rex', width: 70 }), 'dogbone', { maxMB: 4, exactText: true }), { step: true });
test('STEP: hexagon base with a QR code', () => stepCheck(build(font(/Carter/), { baseShape: 'hex', width: 60, height: 52, backKind: 'qr', qrText: 'https://x.co/a' }), 'hex+QR', { maxMB: 6 }), { step: true });
test('STEP: sports tag with an icon', () => stepCheck(build(font(/Carter/), { baseShape: 'sports', text: 'Deutsch', width: 101.6, height: 25.4, art: getIcon('tennis'), artMode: 'right', artLines: 1 }), 'sports', { maxMB: 5, exactText: true }), { step: true });
test('STEP: lines dragged together (overlapping glyphs) keep exact text', () => stepCheck(build(font(/Carter/), { lineShiftsY: [0, 35] }), 'overlap', { maxMB: 4, exactText: true }), { step: true });

// ---- runner ----------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
async function runAll() {
  $('run').disabled = true;
  $('results').replaceChildren();
  const results = [];
  const withStep = $('withStep').checked;
  for (const t of tests) {
    if (t.step && !withStep) continue;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<span class="mark">…</span><span class="name"></span><span class="detail"></span><span class="ms"></span>';
    row.querySelector('.name').textContent = t.name;
    $('results').append(row);
    const t0 = performance.now();
    let ok = true, detail = '';
    try {
      detail = (await t.fn()) || '';
    } catch (e) {
      ok = false;
      detail = String((e && e.message) || e);
    }
    const ms = Math.round(performance.now() - t0);
    row.className = 'row ' + (ok ? 'pass' : 'fail');
    row.querySelector('.mark').textContent = ok ? '✓' : '✗';
    row.querySelector('.detail').textContent = detail;
    row.querySelector('.ms').textContent = ms + ' ms';
    results.push({ name: t.name, ok, detail, ms });
    await new Promise((r) => setTimeout(r, 0));
  }
  const failed = results.filter((r) => !r.ok).length;
  $('summary').textContent = failed ? `${failed} of ${results.length} tests failed` : `All ${results.length} tests passed`;
  $('summary').className = failed ? 'bad' : 'ok';
  window.__testResults = { done: true, passed: results.length - failed, failed, results };
  $('run').disabled = false;
}
$('run').addEventListener('click', runAll);
if (new URLSearchParams(location.search).has('run')) runAll();

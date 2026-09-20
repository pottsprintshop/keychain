// Self-test: builds keychains and checks them. Open tests/index.html (served over http) and press Run all.
// Results are also left on window.__testResults for scripts.

import { parseFont } from '../js/layout.js';
import { buildKeychain } from '../js/geometry.js';
import { stlFilesFromModel } from '../js/mesh.js';
import { estimate, analyze, PRINT_DEFAULTS } from '../js/print.js';
import { dxfFromModel, svgFromModel } from '../js/laser.js';
import { parseBatch, runBatch } from '../js/batch.js';
import { snapshot, diffState, toQuery, parseQuery, applyValues } from '../js/state.js';
import { loadArtSource, traceArt } from '../js/art.js';
import { fitArcs, sampleFitted } from '../js/arcs.js';
import { circlePoints, plateRing } from '../js/clip.js';

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

test('the default size is 2.5 x 1.5 in, and stretch fills it exactly', () => {
  for (const [name, f] of fonts) {
    const m = build(f);
    const w = m.layout.hw * 2, h = m.layout.hh * 2;
    assert(w <= 63.51 && h <= 38.11, `${name}: body ${w.toFixed(2)} x ${h.toFixed(2)} exceeds 63.5 x 38.1`);
    assert(Math.abs(w - 63.5) < 0.05 || Math.abs(h - 38.1) < 0.05, `${name}: neither dimension reaches the target`);
    const s = build(f, { fit: 'stretch' });
    near(s.layout.hw * 2, 63.5, 0.05, `${name} stretch width`);
    near(s.layout.hh * 2, 38.1, 0.05, `${name} stretch height`);
  }
});

test('the size can include the key hole tab', () => {
  const m = build(font(/Carter/), { sizeIncludesTab: true });
  assert(m.size.w <= 63.51 && m.size.h <= 38.11, `overall ${m.size.w.toFixed(2)} x ${m.size.h.toFixed(2)}`);
  assert(Math.abs(m.size.w - 63.5) < 0.1 || Math.abs(m.size.h - 38.1) < 0.1, 'neither overall dimension reaches the target');
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

test('the key hole clears the outline all the way around, and the base stays one piece', () => {
  let n = 0;
  for (const re of [/Carter/, /Graffiti/]) {
    for (const shape of ['text', 'plate']) {
      for (let angle = 0; angle < 360; angle += 15) {
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
  const res = await runBatch({ items: parseBatch('Erich|Deutsch,https://x.co/e\nColleen'), font: f, baseParams: { ...build(f).params, backKind: 'qr', baseShape: 'plate', qrText: 'https://x.co/default' }, format: 'stl', colors: {}, printSettings: PRINT_DEFAULTS, buildStep: null, onProgress() {}, shouldCancel: () => false });
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

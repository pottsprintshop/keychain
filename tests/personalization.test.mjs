import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { layoutText, parseFont, transformContours } from '../js/layout.js';
import { contourBounds, layoutPersonalization, normalizePersonalizationText } from '../js/personalization.js';

const bytes = readFileSync(new URL('../fonts/Bangers-Regular.ttf', import.meta.url));
const font = parseFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const request = (extra = {}) => ({ version: 1, text: 'SAMPLE HOUSE|GAME NIGHT', font_id: 'bangers',
  font_sha256: createHash('sha256').update(bytes).digest('hex'), width_mm: 70, height_mm: 30, margin_mm: 2,
  font_size_mm: 10, minimum_font_size_mm: 2.5, fit: 'scale_to_fit_minimum', align: 'center', vertical_align: 'middle', line_spacing: 1, ...extra });
const run = (r) => spawnSync(process.execPath, [new URL('../scripts/personalization-outline.mjs', import.meta.url).pathname], { input: JSON.stringify(r), encoding: 'utf8' });

test('normalization preserves empty lines and ordinary whitespace; batch pipe compatibility', () => {
  assert.equal(normalizePersonalizationText(' A | B\r\n\rC\n\nD '), ' A\nB\n\nC\n\nD ');
  const r = layoutPersonalization(font, request({ text: 'SAMPLE\n\nHOUSE' }));
  assert.equal(r.line_count, 3);
  assert.deepEqual(layoutPersonalization(font, request({ text: 'A|B' })), layoutPersonalization(font, request({ text: 'A\nB' })));
});
test('exact quadratic/cubic bounds include interior extrema', () => {
  const q = contourBounds([{ start: [0, 0], segs: [['Q', 10, 20, 20, 0], ['L', 0, 0]] }]);
  assert.equal(q.h, 10);
  const c = contourBounds([{ start: [0, 0], segs: [['C', 0, 20, 20, 20, 20, 0], ['L', 0, 0]] }]);
  assert.equal(c.h, 15);
});
test('uses original Keychain contours, kerning, alignment, and spacing without replacing shaping', () => {
  const r = layoutPersonalization(font, request({ fit: 'fixed', font_size_mm: 5, align: 'left', vertical_align: 'bottom' }));
  const raw = layoutText(font, 'SAMPLE HOUSE\nGAME NIGHT', { align: 'left', lineSpacing: 1 });
  const b = contourBounds(raw), s = 0.05;
  assert.deepEqual(r.contours, transformContours(raw, s, s, -33 - s * b.x0, -13 - s * b.y0));
});
test('short, long, narrow, wide, punctuation and covered Unicode fit deterministically', () => {
  for (const text of ['A', 'WIDE|NARROW', 'III WWW', 'SYNTHETIC-LONG-HOUSEHOLD NAME', 'CAFÉ! & 2026', 'LINE\nTWO\nTHREE']) {
    const r = layoutPersonalization(font, request({ text, minimum_font_size_mm: 0.1 }));
    assert.ok(r.bounds.w <= 66 + 1e-8 && r.bounds.h <= 26 + 1e-8);
    assert.deepEqual(r, layoutPersonalization(font, request({ text, minimum_font_size_mm: 0.1 })));
  }
});
test('horizontal/vertical anchors and line spacing remain configurable', () => {
  for (const align of ['left', 'center', 'right']) for (const vertical_align of ['bottom', 'middle', 'top']) {
    const r = layoutPersonalization(font, request({ text: 'A\nB', fit: 'fixed', font_size_mm: 5, align, vertical_align }));
    const b = r.bounds;
    assert.ok(Math.abs(align === 'left' ? b.x0 + 33 : align === 'right' ? b.x1 - 33 : b.x0 + b.x1) < 1e-8);
    assert.ok(Math.abs(vertical_align === 'bottom' ? b.y0 + 13 : vertical_align === 'top' ? b.y1 - 13 : b.y0 + b.y1) < 1e-8);
  }
  const a = layoutPersonalization(font, request({ text: 'A\nB', fit: 'fixed', font_size_mm: 5 }));
  const b = layoutPersonalization(font, request({ text: 'A\nB', fit: 'fixed', font_size_mm: 5, line_spacing: 2 }));
  assert.ok(b.bounds.h > a.bounds.h);
});
test('rejects missing glyphs, overflow, minimum size, empty text, controls, excessive length and malformed settings', () => {
  for (const [extra, code] of [
    [{ text: 'A\u{10ffff}' }, 'missing_glyph'], [{ font_size_mm: 1000, fit: 'fixed' }, 'overflow'],
    [{ minimum_font_size_mm: 1000 }, 'minimum_font_size'], [{ text: ' | ' }, 'empty_text'],
    [{ text: 'A\0B' }, 'unsupported_control'], [{ text: 'A'.repeat(513) }, 'text_budget'],
    [{ text: '\ud800' }, 'unsupported_control'], [{ width_mm: NaN }, 'invalid_dimensions'],
    [{ margin_mm: 40 }, 'invalid_margins'], [{ line_spacing: 0 }, 'invalid_line_spacing'],
    [{ align: 'justify' }, 'invalid_layout'], [{ path: '/tmp/font' }, 'invalid_request'],
  ]) assert.throws(() => layoutPersonalization(font, request(extra)), (e) => e.code === code);
});
test('CLI pins bytes, rejects font paths and versions, never echoes failed customer values', () => {
  const a = run(request()), b = run(request());
  assert.equal(a.status, 0); assert.equal(a.stdout, b.stdout);
  assert.equal(JSON.parse(a.stdout).result.manufacturing_validated, false);
  for (const extra of [{ font_sha256: '0'.repeat(64) }, { font_id: '../Bangers' }, { version: 2 }, { font_id: 'sans' }, { text: 'PRIVATE\0VALUE' }]) {
    const result = run(request(extra));
    assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ok, false);
    assert.ok(!result.stdout.includes('PRIVATE')); assert.equal(result.stderr, '');
  }
});
test('all explicitly licensed registry fonts generate different, repeatable outlines', () => {
  for (const [font_id, file] of [['bangers', 'Bangers'], ['bungee', 'Bungee'], ['lilita-one', 'LilitaOne'], ['luckiest-guy', 'LuckiestGuy'], ['titan-one', 'TitanOne']]) {
    const b = readFileSync(new URL(`../fonts/${file}-Regular.ttf`, import.meta.url));
    const r = run(request({ font_id, font_sha256: createHash('sha256').update(b).digest('hex') }));
    assert.equal(r.status, 0, r.stdout);
  }
});

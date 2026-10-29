// Trusted local outline provider v2. No CAD kernel or request filesystem paths.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseFont, flattenContour } from '../js/layout.js';
import { contourBounds, layoutPersonalization, PersonalizationError } from '../js/personalization.js';

// The unchanged vendored Clipper expects a worker/browser global in ES-module mode.
// This process supplies that global; no browser or solid kernel is loaded.
globalThis.self = globalThis;
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'chrome', appName: 'Netscape' } });
const { thinAndGaps } = await import('../js/print.js');
const { toPath, unionTree, treeToPolys, polyArea } = await import('../js/clip.js');
const registry = {
  bangers: ['Bangers-Regular.ttf', 'bangers-OFL.txt'], bungee: ['Bungee-Regular.ttf', 'bungee-OFL.txt'],
  'lilita-one': ['LilitaOne-Regular.ttf', 'lilitaone-OFL.txt'],
  'luckiest-guy': ['LuckiestGuy-Regular.ttf', 'luckiestguy-LICENSE.txt'], 'titan-one': ['TitanOne-Regular.ttf', 'titanone-OFL.txt'],
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (code) => { throw new PersonalizationError(code); };
try {
  const files = (await readdir(new URL('../js/', import.meta.url))).filter(n => n.endsWith('.js')).sort().map(n => `../js/${n}`);
  files.push('../vendor/opentype.module.js', '../vendor/clipper.js', '../vendor/qrcode.mjs', './personalization-region.mjs', '../package.json');
  const engine_sha256 = sha(JSON.stringify(await Promise.all(files.map(async p => [p, sha(await readFile(new URL(p, import.meta.url)))]))));
  const fonts = await Promise.all(Object.entries(registry).map(async ([id, [file, license]]) => {
    const data = await readFile(new URL(`../fonts/${file}`, import.meta.url));
    await readFile(new URL(`../fonts/${license}`, import.meta.url));
    return { id, sha256: sha(data) };
  }));
  if (process.argv.length === 3 && process.argv[2] === '--catalog') {
    process.stdout.write(JSON.stringify({ version: 2, engine_sha256, fonts }));
  } else {
    if (process.argv.length !== 2) fail('invalid_arguments');
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 16384) fail('request_budget'); chunks.push(chunk); }
    const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!r || r.version !== 2) fail('unsupported_version');
    const { minimum_stroke_mm, minimum_ink_height_mm, engine_sha256: expected, ...layout } = r;
    for (const n of [minimum_stroke_mm, minimum_ink_height_mm]) if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 100) fail('invalid_printability');
    if (expected !== engine_sha256) fail('engine_revision_mismatch');
    const selected = fonts.find(f => f.id === r.font_id);
    if (!selected || selected.sha256 !== r.font_sha256) fail('font_revision_mismatch');
    const data = await readFile(new URL(`../fonts/${registry[selected.id][0]}`, import.meta.url));
    const font = parseFont(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    const result = layoutPersonalization(font, { ...layout, version: 1 });
    const lineIds = [...new Set(result.contours.map(c => c.line))];
    if (lineIds.some(line => contourBounds(result.contours.filter(c => c.line === line)).h < minimum_ink_height_mm - 1e-7)) fail('minimum_ink_height');
    const polys = treeToPolys(unionTree(result.contours.map(c => toPath(flattenContour(c, 0.005)))));
    const { thin, gaps } = thinAndGaps(polys, minimum_stroke_mm);
    if (thin.length) fail('thin_strokes');
    if (gaps.length) fail('narrow_gaps');
    if (polys.some(p => Math.abs(polyArea(p.outer)) - p.holes.reduce((s,h) => s + Math.abs(polyArea(h)),0) < minimum_stroke_mm ** 2)) fail('tiny_islands');
    result.version = 2;
    result.engine_sha256 = engine_sha256;
    result.printability = { minimum_stroke_mm, minimum_ink_height_mm, tolerance_mm: 0.005, ignored_tip_area_mm2: 0.12 };
    result.outline_sha256 = sha(JSON.stringify(result));
    process.stdout.write(JSON.stringify({ ok: true, result }));
  }
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e instanceof PersonalizationError ? e.code : 'outline_generation_failed' }));
  process.exitCode = 1;
}

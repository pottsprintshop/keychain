// Print planning: how much filament each color takes, what it costs, and what won't print well.
// It all comes from geometry we already have: layer areas times heights, and 2D morphology on the layers.

import { CL, polysToPaths, offsetTree, allPaths, treeToPolys, runClipper, polyArea } from './clip.js';
import { ringDefs } from './geometry.js';

export const PRINT_DEFAULTS = {
  density: 1.24, // g/cm^3 (PLA)
  costPerKg: 20, // dollars
  waste: 15, // percent extra for purging and supports the color changes cost
  layerHeight: 0.2, // mm, for the layer-multiple check
  minDetail: 0.5, // mm: thinner than this won't print well on a 0.4 mm nozzle
};

const netArea = (polys) =>
  polys.reduce((t, p) => t + Math.abs(polyArea(p.outer)) - p.holes.reduce((h, hole) => h + Math.abs(polyArea(hole)), 0), 0);

// Filament per body (the base's slabs are one body), the total, the waste allowance and the cost.
export function estimate(model, s) {
  const bodies = new Map();
  for (const l of model.layers) {
    const cur = bodies.get(l.key) || { key: l.key, name: l.name, volume: 0 };
    cur.volume += netArea(l.polys) * (l.z1 - l.z0); // mm^3
    bodies.set(l.key, cur);
  }
  const rows = [...bodies.values()].map((b) => ({ ...b, grams: (b.volume / 1000) * s.density }));
  const total = rows.reduce((t, r) => t + r.grams, 0);
  const wasteGrams = (total * s.waste) / 100;
  const billed = total + wasteGrams;
  return { rows, total, wasteGrams, billed, cost: (billed / 1000) * s.costPerKg };
}

// Regions of `polys` thinner than `minDetail` (an opening removes them), and gaps narrower than it
// (a closing fills them). Anything smaller than 0.12 mm^2 is just a sharp corner or a fin, not a problem.
function thinAndGaps(polys, minDetail) {
  const r = minDetail / 2;
  if (!(r > 0) || !polys.length) return { thin: [], gaps: [] };
  const paths = polysToPaths(polys);
  const grow = (ps, d) => allPaths(offsetTree(ps, d));
  const opened = grow(grow(paths, -r), r);
  const closed = grow(grow(paths, r), -r);
  const big = (list) => list.filter((p) => netArea([p]) >= 0.12);
  return {
    thin: big(treeToPolys(runClipper(CL.ClipType.ctDifference, paths, opened))),
    gaps: big(treeToPolys(runClipper(CL.ClipType.ctDifference, closed, paths))),
  };
}

// -> { warnings: [text], thin: polys, gaps: polys } for the front text, plus checks on the settings.
export function analyze(model, s) {
  const p = model.params;
  const warnings = [];
  const text = model.layers.find((l) => l.key === 'text');
  const { thin, gaps } = text ? thinAndGaps(text.polys, s.minDetail) : { thin: [], gaps: [] };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (thin.length) warnings.push(`${plural(thin.length, 'detail', 'details')} in the text ${thin.length === 1 ? 'is' : 'are'} thinner than ${s.minDetail} mm and may not print.`);
  if (gaps.length) warnings.push(`${plural(gaps.length, 'gap or counter', 'gaps or counters')} in the text ${gaps.length === 1 ? 'is' : 'are'} narrower than ${s.minDetail} mm and may fill in.`);
  const tiny = text ? text.polys.filter((pl) => netArea([pl]) < 1).length : 0;
  if (tiny) warnings.push(`${plural(tiny, 'tiny piece', 'tiny pieces')} of text (under 1 mm²) may not stick.`);

  const back = model.layers.find((l) => l.key === 'back');
  if (back && model.back && model.back.kind !== 'qr') {
    const b = thinAndGaps(back.polys, s.minDetail);
    if (b.thin.length) warnings.push(`${plural(b.thin.length, 'detail', 'details')} on the back ${b.thin.length === 1 ? 'is' : 'are'} thinner than ${s.minDetail} mm.`);
  }

  for (const r of ringDefs(p)) {
    const w = r.index === 1 ? p.outline : r.index === 2 ? p.ring2W : p.ring3W;
    if (w < s.minDetail) warnings.push(`${r.name} is only ${w} mm wide, thinner than ${s.minDetail} mm.`);
  }
  const hasBase = model.layers.some((l) => l.key === 'base');
  if (hasBase && p.baseMargin < s.minDetail) warnings.push(`The base only extends ${p.baseMargin} mm past the outline.`);
  const rim = model.layers.find((l) => l.key === 'border');
  if (rim && p.borderW < s.minDetail) warnings.push(`The border is only ${p.borderW} mm wide, thinner than ${s.minDetail} mm.`);
  if (p.holeEnabled && p.holeEdge < 1.2) warnings.push(`The wall around the key hole is ${p.holeEdge} mm, thinner than three extrusion lines (1.2 mm): it may snap.`);

  if (s.layerHeight > 0) {
    const heights = [];
    if (text) heights.push(['Text', p.textH]);
    ringDefs(p).forEach((r) => heights.push([r.name, r.h]));
    if (hasBase) heights.push(['Base', p.baseH]);
    if (model.back) heights.push(['Recess depth', model.back.depth]);
    const off = heights.filter(([, h]) => Math.abs(h / s.layerHeight - Math.round(h / s.layerHeight)) > 0.02);
    if (off.length) warnings.push(`${off.map(([n, h]) => `${n} ${+h.toFixed(2)} mm`).join(', ')} ${off.length === 1 ? "isn't a multiple" : "aren't multiples"} of ${s.layerHeight} mm layers, so the slicer will round.`);
  }
  // Grown a little, so the red overlay in the preview is big enough to see.
  const overlay = treeToPolys(offsetTree(polysToPaths([...thin, ...gaps]), 0.3));
  return { warnings, thin, gaps, overlay };
}

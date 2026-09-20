// Batch: many keychains from a list. Each line is one keychain (text, then optionally the QR or back text),
// built with the current design settings, and everything lands in one zip with a summary.csv.

import { buildKeychain } from './geometry.js';
import { stlFilesFromModel } from './mesh.js';
import { zipStore, slug } from './exporters.js';
import { estimate, analyze } from './print.js';
import { dxfFromModel, svgFromModel } from './laser.js';

// One CSV line -> cells. Handles "quoted, with commas" and "" escapes.
function parseCsvLine(line) {
  const cells = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

// Text -> [{ text, extra }]. Tabs (a spreadsheet paste) or commas separate the columns; `|` is a line break.
export function parseBatch(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const unquote = (c) => (/^"[\s\S]*"$/.test(c.trim()) ? c.trim().slice(1, -1).replace(/""/g, '"') : c);
    const cells = raw.includes('\t') ? raw.split('\t').map(unquote) : parseCsvLine(raw);
    const first = (cells[0] || '').trim();
    if (!first) continue;
    if (!rows.length && /^(name|names|text|label|title)$/i.test(first)) continue; // a header row
    const lines = (s) => s.trim().replace(/\s*\|\s*/g, '\n');
    rows.push({ text: lines(first), extra: lines(cells[1] || '') });
  }
  return rows;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Build every item and return { blob, count, problems }. `onProgress(done, total, item)` and `shouldCancel()`
// keep the page responsive; STEP goes through the CAD worker (about 10 s each), STL is nearly instant.
export async function runBatch({ items, font, baseParams, format, colors, printSettings, buildStep, onProgress, shouldCancel }) {
  const files = [];
  const rows = [['#', 'text', 'extra', 'width_mm', 'height_mm', 'thickness_mm', 'grams', 'cost_usd', 'warnings', 'file']];
  let problems = 0;
  for (let i = 0; i < items.length; i++) {
    if (shouldCancel()) break;
    const item = items[i];
    onProgress(i, items.length, item);
    const params = { ...baseParams, fixed: null, text: item.text };
    if (item.extra) {
      if (baseParams.backKind === 'qr') params.qrText = item.extra;
      else if (baseParams.backKind === 'text') params.backText = item.extra;
    }
    const model = buildKeychain(font, params);
    const label = item.text.replace(/\n/g, ' ');
    if (!model) {
      rows.push([i + 1, label, item.extra, '', '', '', '', '', 'nothing to build', '']);
      problems++;
      continue;
    }
    const name = `${String(i + 1).padStart(3, '0')}-${slug(label)}`;
    let where;
    if (format === 'step') {
      const { blob } = await buildStep(model, colors);
      files.push({ name: `${name}.step`, data: new Uint8Array(await blob.arrayBuffer()) });
      where = `${name}.step`;
    } else if (format === 'dxf' || format === 'svg') {
      const text = format === 'dxf' ? dxfFromModel(model) : svgFromModel(model, colors);
      files.push({ name: `${name}.${format}`, data: new TextEncoder().encode(text) });
      where = `${name}.${format}`;
    } else {
      for (const f of stlFilesFromModel(model, name)) files.push({ name: `${name}/${f.name}`, data: f.data });
      where = `${name}/`;
    }
    const est = estimate(model, printSettings);
    const warnings = [...model.warnings, ...analyze(model, printSettings).warnings];
    if (warnings.length) problems++;
    rows.push([i + 1, label, item.extra, model.size.w.toFixed(1), model.size.h.toFixed(1), model.size.d.toFixed(1), est.billed.toFixed(2), est.cost.toFixed(2), warnings.join(' '), where]);
    await new Promise((r) => setTimeout(r, 0)); // let the page breathe
  }
  files.push({ name: 'summary.csv', data: new TextEncoder().encode(rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n') });
  return { blob: zipStore(files), count: rows.length - 1, problems };
}

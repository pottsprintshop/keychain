// Batch: many keychains from a list. Each line is one keychain (text, then optionally the QR or back text),
// built with the current design settings. A single STL downloads directly; multiple designs use a ZIP.

import { buildKeychain } from './geometry.js';
import { stlFilesFromModel } from './mesh.js';
import { zipStore, slug, combineStls } from './exporters.js';
import { estimate, analyze } from './print.js';
import { dxfFromModel, svgFromModel } from './laser.js';
import { fontDisplayName } from './layout.js';

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

// Text lists keep commas literal. Tabs separate optional back content; CSV mode also accepts comma columns.
export function parseBatch(text, { csv = false } = {}) {
  const rows = [];
  let columns = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const unquote = (c) => (/^"[\s\S]*"$/.test(c.trim()) ? c.trim().slice(1, -1).replace(/""/g, '"') : c);
    const cells = raw.includes('\t') ? raw.split('\t').map(unquote) : csv ? parseCsvLine(raw) : [raw];
    const names = cells.map((c) => c.trim().toLowerCase()
      .replace(/^(name|names|label|title)$/, 'text').replace(/^(qr|url|back|back text)$/, 'extra'));
    if (!columns && !rows.length && names.length > 1 && names.includes('text') &&
        names.every((n) => ['text', 'extra', 'font'].includes(n)) && new Set(names).size === names.length) {
      columns = Object.fromEntries(names.map((name, i) => [name, i]));
      continue;
    }
    const first = (cells[columns ? columns.text : 0] || '').trim();
    if (!first) continue;
    const lines = (s) => s.trim().replace(/\s*\|\s*/g, '\n');
    const font = (cells[columns ? columns.font : 2] || '').trim();
    rows.push({ text: lines(first), extra: lines(cells[columns ? columns.extra : 1] || ''), ...(font ? { font } : {}) });
  }
  return rows;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Build every item; one STL design downloads directly, multiple designs use a ZIP with summary.csv. `onProgress(done, total, item)` and `shouldCancel()`
// keep the page responsive; STEP goes through the CAD worker (about 10 s each), STL is nearly instant.
export async function runBatch({ items, font, baseParams, format, colors, printSettings, buildStep, onProgress, shouldCancel, fontsByName = new Map() }) {
  const files = [];
  const rows = [['#', 'text', 'extra', 'font', 'width_mm', 'height_mm', 'thickness_mm', 'grams', 'cost_usd', 'warnings', 'file']];
  let problems = 0;
  let singleWarnings = [];
  for (let i = 0; i < items.length; i++) {
    if (shouldCancel()) break;
    const item = items[i];
    onProgress(i, items.length, item);
    const params = { ...baseParams, fixed: null, text: item.text };
    if (item.extra) {
      if (baseParams.backKind === 'qr') params.qrText = item.extra;
      else if (baseParams.backKind === 'text') params.backText = item.extra;
    }
    const selectedFont = item.font ? fontsByName.get(item.font.toLowerCase()) : font;
    if (item.font) params.lineFonts = []; // an explicit font applies to the whole batch entry
    const model = selectedFont ? buildKeychain(selectedFont, params) : null;
    const label = item.text.replace(/\n/g, ' ');
    if (!model) {
      rows.push([i + 1, label, item.extra, item.font || fontDisplayName(font), '', '', '', '', '', selectedFont ? 'nothing to build' : `Unknown font: ${item.font}`, '']);
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
      where = `${name}.stl`;
      files.push({ name: where, data: combineStls(stlFilesFromModel(model, name).map((f) => f.data)) });
    }
    const est = estimate(model, printSettings);
    const warnings = [...model.warnings, ...analyze(model, printSettings).warnings];
    if (warnings.length) problems++;
    if (items.length === 1) singleWarnings = warnings;
    rows.push([i + 1, label, item.extra, item.font || fontDisplayName(selectedFont), model.size.w.toFixed(1), model.size.h.toFixed(1), model.size.d.toFixed(1), est.billed.toFixed(2), est.cost.toFixed(2), warnings.join(' '), where]);
    await new Promise((r) => setTimeout(r, 0)); // let the page breathe
  }
  const singleStl = format === 'stl' && items.length === 1 && files.length === 1;
  if (!singleStl) files.push({ name: 'summary.csv', data: new TextEncoder().encode(rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n') });
  const count = rows.length - 1;
  return {
    blob: singleStl ? new Blob([files[0].data], { type: 'model/stl' }) : zipStore(files),
    filename: singleStl ? files[0].name : `keychains-${count}-${format}.zip`,
    count, problems, warnings: singleWarnings,
  };
}

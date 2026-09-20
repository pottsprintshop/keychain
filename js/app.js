import { parseFont, fontDisplayName, NOMINAL } from './layout.js';
import { buildKeychain, angleForHeight, pickLine, DEFAULTS } from './geometry.js';
import { createPreview } from './preview.js';
import { zipStore, downloadBlob, slug } from './exporters.js';
import { stlFilesFromModel } from './mesh.js';
import { loadArtSource, traceArt, drawArtPreview } from './art.js';
import { estimate, analyze, PRINT_DEFAULTS } from './print.js';
import { snapshot, diffState, toQuery, parseQuery, applyValues } from './state.js';
import { parseBatch, runBatch } from './batch.js';
import { dxfFromModel, svgFromModel } from './laser.js';

const $ = (id) => document.getElementById(id);
const MM_PER_IN = 25.4;

// Every element with an id, by id (all the ids are camelCase).
const el = Object.fromEntries([...document.querySelectorAll('[id]')].map((e) => [e.id, e]));

const fonts = new Map(); // option value -> { name, font }
let model = null;
let prevUnit = el.unit.value;
let timer = null;
let preview = null;
let lineShifts = []; // sideways nudge per text line (percent of the widest line), indexed by line number
let lineShiftsY = []; // vertical nudge per text line (percent of the font size)
const shiftUi = new Map(); // line number -> { rx, ry, show() }, so a drag can move the sliders
let dragBase = null; // while dragging a line: the layout to hold still, and where the line started
let dragQueued = false;
let artSource = null; // the loaded image
let art = null; // its traced outlines (see art.js)
let artTimer = null;
const SHIFT_X_MAX = 100, SHIFT_Y_MAX = 150;

// ---- Reading the form --------------------------------------------------------

function num(input, fallback, min = 0) {
  const v = parseFloat(input.value);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

function readParams() {
  const k = el.unit.value === 'in' ? MM_PER_IN : 1;
  return {
    text: el.text.value,
    align: el.align.value,
    lineSpacing: num(el.lineSpacing, 1, 0.1),
    width: num(el.width, DEFAULTS.width / k, 0.1) * k,
    height: num(el.height, DEFAULTS.height / k, 0.1) * k,
    fit: el.fit.value,
    textSize: num(el.textSize, 100, 20) / 100,
    sizeIncludesTab: el.sizeIncludesTab.checked,
    textH: num(el.textH, DEFAULTS.textH, 0.05),
    midH: num(el.midH, DEFAULTS.midH, 0.05),
    baseH: num(el.baseH, DEFAULTS.baseH, 0.05),
    outline: num(el.outline, DEFAULTS.outline, 0),
    baseMargin: num(el.baseMargin, DEFAULTS.baseMargin, 0),
    fillGaps: el.fillGaps.checked,
    baseShape: el.baseShape.value,
    plateRadius: num(el.plateRadius, DEFAULTS.plateRadius, 0),
    boneShaft: num(el.boneShaft, DEFAULTS.boneShaft * 100, 20) / 100,
    roundIn: num(el.roundIn, DEFAULTS.roundIn, 0),
    roundOut: num(el.roundOut, DEFAULTS.roundOut, 0),
    holeEnabled: el.holeEnabled.checked,
    holeDia: num(el.holeDia, DEFAULTS.holeDia, 0.5),
    holeEdge: num(el.holeEdge, DEFAULTS.holeEdge, 0.5),
    holeGap: num(el.holeGap, DEFAULTS.holeGap, 0),
    holeAngle: num(el.holeAngle, DEFAULTS.holeAngle, 0),
    holePush: num(el.holePush, 0, 0) / 100,
    lineShifts: lineShifts.slice(),
    lineShiftsY: lineShiftsY.slice(),
    rings: Number(el.rings.value),
    ring2W: num(el.ring2W, DEFAULTS.ring2W, 0),
    ring2H: num(el.ring2H, DEFAULTS.ring2H, 0.05),
    ring3W: num(el.ring3W, DEFAULTS.ring3W, 0),
    ring3H: num(el.ring3H, DEFAULTS.ring3H, 0.05),
    backKind: el.backKind.value,
    backText: el.backText.value,
    backSize: num(el.backSize, 0, 0),
    backMargin: num(el.backMargin, DEFAULTS.backMargin, 0),
    backDepth: num(el.backDepth, DEFAULTS.backDepth, 0.2),
    qrText: el.qrText.value,
    qrEcc: el.qrEcc.value,
    qrPlate: el.qrPlate.checked,
    art,
    artMode: el.artMode.value,
    artLines: num(el.artLines, DEFAULTS.artLines, 0.1),
    artShiftX: num(el.artShiftX, 0, -1000),
    artShiftY: num(el.artShiftY, 0, -1000),
  };
}

// Light or dark, whichever contrasts with the base (perceived brightness of the base color).
const brightness = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
function syncBackColor() {
  if (el.backAuto.checked) el.colorBack.value = brightness(el.colorBase.value) < 0.5 ? '#f2f2f2' : '#16161a';
  el.colorBack.disabled = el.backAuto.checked;
}
const colors = () => {
  syncBackColor();
  return {
    text: el.colorText.value,
    outline: el.colorOutline.value,
    outline2: el.colorOutline2.value,
    outline3: el.colorOutline3.value,
    base: el.colorBase.value,
    back: el.colorBack.value,
  };
};

function fmtSize(w, h, unit) {
  return unit === 'in' ? `${(w / MM_PER_IN).toFixed(2)} × ${(h / MM_PER_IN).toFixed(2)} in` : `${w.toFixed(1)} × ${h.toFixed(1)} mm`;
}

// A slider's value is also a number box: click it and type an exact value. Typing moves the slider (and
// rebuilds live); dragging the slider updates the box. Returns a function that refreshes the box.
function pairSliderAndBox(range, box, decimals = 0) {
  const show = () => {
    if (document.activeElement !== box) box.value = String(+Number(range.value).toFixed(decimals));
  };
  range.addEventListener('input', show);
  box.addEventListener('input', () => {
    const v = parseFloat(box.value);
    if (!Number.isFinite(v)) return;
    range.value = String(Math.min(Number(range.max), Math.max(Number(range.min), v)));
    range.dispatchEvent(new Event('input', { bubbles: true }));
  });
  box.addEventListener('change', () => (box.value = String(+Number(range.value).toFixed(decimals))));
  box.addEventListener('focus', () => box.select());
  show();
  return show;
}

const sliderBoxes = []; // show() for each of the fixed sliders; syncLabels refreshes them after a programmatic change

function syncLabels() {
  for (const show of sliderBoxes) show();
  const angle = Number(el.holeAngle.value);
  const compass = ['right', 'top right', 'top', 'top left', 'left', 'bottom left', 'bottom', 'bottom right'];
  el.holeAngleUnit.textContent = '\u00b0';
  el.holeAngleNum.title = compass[Math.round(angle / 45) % 8]; // (hover: which way that points)
  for (const b of el.holeQuick.children) b.classList.toggle('active', Math.round(angle) === Number(b.dataset.angle));
  el.holeControls.style.opacity = el.holeEnabled.checked ? '1' : '0.45';
  // Show only the parts of the Back panel that apply, and only the rings that exist.
  const kind = el.backKind.value;
  el.backControls.hidden = kind === 'none';
  el.backQrWrap.hidden = kind !== 'qr';
  el.qrEccWrap.hidden = kind !== 'qr';
  el.backTextWrap.hidden = kind !== 'text';
  el.backArtNote.hidden = kind !== 'art';
  for (const r of document.querySelectorAll('.ring-row')) r.hidden = Number(r.dataset.ring) > Number(el.rings.value);
  // The corner radius is for the rectangle and hexagon; the shaft thickness for the dog bone.
  el.plateRadiusWrap.hidden = !['plate', 'hex'].includes(el.baseShape.value);
  el.boneShaftWrap.hidden = el.baseShape.value !== 'dogbone';
}

// ---- Building ------------------------------------------------------------------

// `fixed` (only while dragging a line) is the previous build's layout, so the keychain doesn't re-fit or
// re-centre under the pointer; a normal rebuild when the drag ends snaps it back to the size you set.
function rebuild(fixed = null) {
  clearTimeout(timer);
  timer = null;
  syncLabels();
  const entry = fonts.get(el.font.value);
  if (!entry) return;
  try {
    const t0 = performance.now();
    const m = buildKeychain(entry.font, { ...readParams(), fixed });
    if (!m) {
      model = null;
      el.status.classList.remove('warn');
      el.status.textContent = 'Type some text to see your keychain.';
      el.downloadBtn.disabled = true;
      el.finalSize.textContent = ' ';
      updatePrint();
      return;
    }
    model = m;
    preview.setModel(m, colors());
    const p = m.params;
    el.finalSize.textContent =
      `Overall size${m.params.holeEnabled ? ' with key hole' : ''}: ${fmtSize(m.size.w, m.size.h, el.unit.value)} × ${m.size.d.toFixed(1)} mm thick` +
      ` (${fmtSize(m.size.w, m.size.h, el.unit.value === 'in' ? 'mm' : 'in')})`;
    if (m.back) {
      const b = m.back;
      const negative = b.kind === 'qr' && !b.plate && brightness(el.colorBack.value) > brightness(el.colorBase.value);
      el.backInfo.textContent =
        (b.kind === 'qr'
          ? `QR code: ${b.n}\u00d7${b.n} modules, ${b.module.toFixed(2)} mm each, ${b.side.toFixed(1)} mm square, ${b.margin} mm from the edge (about ${(b.margin / b.module).toFixed(1)} modules). Flip the keychain like a page to scan it.`
          : `${b.name}: ${b.width.toFixed(1)} \u00d7 ${b.height.toFixed(1)} mm, ${b.margin} mm from the edge. Mirrored, so it reads when you flip the keychain like a page.`) +
        (negative ? ' Light on dark is a negative image: most phones read it, but test yours (or tick the plate option).' : '');
    } else if (el.backKind.value !== 'none') {
      el.backInfo.textContent =
        el.backKind.value === 'qr' ? (el.qrText.value.trim() ? 'The QR code could not be made — see the note under the preview.' : 'Type what the QR code should say.')
        : el.backKind.value === 'text' ? 'Type the text for the back.'
        : 'Add artwork in the Artwork panel first.';
    }
    el.status.classList.toggle('warn', m.warnings.length > 0);
    el.status.textContent = m.warnings.length
      ? m.warnings.join(' ')
      : `Built in ${Math.round(performance.now() - t0)} ms — drag to rotate, scroll to zoom.`;
    el.downloadBtn.disabled = false;
    updatePrint(!fixed);
    if (!fixed) updateUrl();
    void p;
  } catch (err) {
    console.error(err);
    el.status.classList.add('warn');
    el.status.textContent = 'Could not build this design: ' + err.message;
    el.downloadBtn.disabled = true;
  }
}

function schedule() {
  syncLabels();
  clearTimeout(timer);
  timer = setTimeout(rebuild, 60);
}

// ---- Per-line offsets ---------------------------------------------------------------

function setShift(i, x, y) {
  lineShifts[i] = Math.max(-SHIFT_X_MAX, Math.min(SHIFT_X_MAX, x));
  lineShiftsY[i] = Math.max(-SHIFT_Y_MAX, Math.min(SHIFT_Y_MAX, y));
  const ui = shiftUi.get(i);
  if (ui) {
    ui.rx.value = String(lineShifts[i]);
    ui.ry.value = String(lineShiftsY[i]);
    ui.show();
  }
}

function renderLineShifts() {
  const lines = el.text.value.replace(/\r/g, '').split('\n');
  const used = lines.map((text, i) => [text.trim(), i]).filter(([text]) => text);
  el.lineShifts.hidden = used.length < 2;
  el.lineShiftList.replaceChildren();
  shiftUi.clear();
  if (used.length < 2) return;
  const slider = (min, max, value, label) => {
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(min);
    range.max = String(max);
    range.step = 'any';
    range.value = String(value || 0);
    range.setAttribute('aria-label', label);
    return range;
  };
  for (const [text, i] of used) {
    const block = document.createElement('div');
    block.className = 'shift-block';
    const head = document.createElement('div');
    head.className = 'shift-head';
    const title = document.createElement('span');
    title.append(`Line ${i + 1} `);
    const name = document.createElement('em');
    name.textContent = text.length > 18 ? text.slice(0, 17) + '\u2026' : text;
    title.append(name);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'secondary tiny';
    reset.textContent = '\u21ba';
    reset.title = 'Reset this line';
    reset.setAttribute('aria-label', `Reset line ${i + 1}`);
    head.append(title, reset);

    const rx = slider(-SHIFT_X_MAX, SHIFT_X_MAX, lineShifts[i], `Line ${i + 1} left or right`);
    const ry = slider(-SHIFT_Y_MAX, SHIFT_Y_MAX, lineShiftsY[i], `Line ${i + 1} up or down`);
    const row = (icon, name, range, step) => {
      const r = document.createElement('div');
      r.className = 'slider-row inline';
      const label = document.createElement('label');
      label.textContent = icon;
      label.title = name;
      const box = document.createElement('input');
      box.type = 'number';
      box.className = 'numval';
      box.min = range.min;
      box.max = range.max;
      box.step = step;
      box.setAttribute('aria-label', `${name}, line ${i + 1}`);
      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = '%';
      const val = document.createElement('span');
      val.className = 'val';
      val.append(box, unit);
      r.append(label, val, range);
      return { row: r, show: pairSliderAndBox(range, box, 1) };
    };
    const X = row('\u2194', 'Left / right', rx, 1);
    const Y = row('\u2195', 'Up / down', ry, 1);
    const pair = document.createElement('div');
    pair.className = 'shift-pair';
    pair.append(X.row, Y.row);
    block.append(head, pair);
    shiftUi.set(i, { rx, ry, show: () => { X.show(); Y.show(); } });
    rx.addEventListener('input', () => {
      lineShifts[i] = Number(rx.value);
      schedule();
    });
    ry.addEventListener('input', () => {
      lineShiftsY[i] = Number(ry.value);
      schedule();
    });
    reset.addEventListener('click', () => {
      setShift(i, 0, 0);
      schedule();
    });
    el.lineShiftList.append(block);
  }
}

// Drag a line of text in the Top view.
function enableLineDragging() {
  preview.enableDrag({
    // Only with two or more lines; a single line is always re-centred, so moving it would just snap back.
    pick: (x, y) => (model && model.lines.length > 1 ? pickLine(model.lines, x, y) : -1),
    start: (i) => {
      if (timer) rebuild();
      dragBase = { layout: model.layout, x: lineShifts[i] || 0, y: lineShiftsY[i] || 0 };
    },
    move: (i, dx, dy) => {
      if (!dragBase) return;
      const L = dragBase.layout;
      // millimetres -> slider units: sideways is relative to the widest line, vertical to the font size
      setShift(i, dragBase.x + (dx / (L.sx * L.widest)) * 100, dragBase.y + (dy / (L.sy * NOMINAL)) * 100);
      if (!dragQueued) {
        dragQueued = true;
        requestAnimationFrame(() => {
          dragQueued = false;
          if (dragBase) rebuild(dragBase.layout);
        });
      }
    },
    end: () => {
      dragBase = null;
      rebuild();
    },
  });
}

// Where the key hole naturally goes depends on the shape: a dog bone hangs from the middle of its top edge (the tab
// nests between the knobs), everything else from the left. Switching shape moves the hole to the new shape's spot,
// unless it was moved by hand.
const HOLE_ANGLE_FOR = { dogbone: 90 };
const holeAngleFor = (shape) => HOLE_ANGLE_FOR[shape] ?? DEFAULTS.holeAngle;
let prevShape = el.baseShape.value;
el.baseShape.addEventListener('change', () => {
  if (Number(el.holeAngle.value) === holeAngleFor(prevShape)) el.holeAngle.value = holeAngleFor(el.baseShape.value);
  prevShape = el.baseShape.value;
  schedule();
});

for (const b of el.holeQuick.children) {
  b.addEventListener('click', () => {
    el.holeAngle.value = b.dataset.angle;
    schedule();
  });
}

// 20% / 50% / 80% height: keep the ring on the left or right side and slide it to that height.
for (const b of el.holeHeights.children) {
  b.addEventListener('click', () => {
    if (timer) rebuild();
    const track = model && model.exact.holeTrack;
    if (!track) return;
    const angle = Number(el.holeAngle.value);
    const side = angle < 90 || angle > 270 ? 'right' : 'left';
    el.holeAngle.value = angleForHeight(track, side, Number(b.dataset.h) / 100);
    schedule();
  });
}

// ---- Print check -------------------------------------------------------------------

const PRINT_FIELDS = { density: 'printDensity', costPerKg: 'printCost', waste: 'printWaste', layerHeight: 'printLayer', minDetail: 'printMin' };

function printSettings() {
  const s = {};
  for (const [key, id] of Object.entries(PRINT_FIELDS)) s[key] = num(el[id], PRINT_DEFAULTS[key], 0);
  return s;
}

function loadPrintPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('keychainPrint') || '{}'); } catch (e) { /* no storage: use the defaults */ }
  for (const [key, id] of Object.entries(PRINT_FIELDS)) el[id].value = Number.isFinite(saved[key]) ? saved[key] : PRINT_DEFAULTS[key];
}

function savePrintPrefs() {
  try { localStorage.setItem('keychainPrint', JSON.stringify(printSettings())); } catch (e) { /* no storage */ }
}

// Estimate and printability warnings for the current model. `heavy: false` skips the (slower) analysis
// while a line is being dragged.
function updatePrint(heavy = true) {
  if (!model) {
    el.printTable.replaceChildren();
    el.printTotal.textContent = '';
    el.printSummary.textContent = '';
    el.printWarnings.replaceChildren();
    return;
  }
  const s = printSettings();
  const est = estimate(model, s);
  const palette = colors();
  const rows = est.rows.map((r) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = palette[r.key] || 'transparent';
    name.append(swatch, r.name);
    const grams = document.createElement('td');
    grams.textContent = `${r.grams.toFixed(2)} g`;
    tr.append(name, grams);
    return tr;
  });
  el.printTable.replaceChildren(...rows);
  el.printTotal.textContent = `Total ${est.total.toFixed(2)} g + ${s.waste}% waste = ${est.billed.toFixed(2)} g, about $${est.cost.toFixed(2)} of filament.`;
  if (!heavy) return;
  const result = analyze(model, s);
  el.printWarnings.replaceChildren(...result.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })));
  el.printSummary.textContent = `About ${est.billed.toFixed(1)} g · $${est.cost.toFixed(2)} in filament` + (result.warnings.length ? ` · ${result.warnings.length} print ${result.warnings.length === 1 ? 'warning' : 'warnings'}` : ' · no print warnings');
  const danger = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#ff8c73';
  preview.setHighlights(el.showThin.checked ? result.overlay : [], model.size.d + 0.02, danger);
}

function initPrint() {
  loadPrintPrefs();
  for (const id of [...Object.values(PRINT_FIELDS), 'showThin']) {
    el[id].addEventListener('input', () => {
      savePrintPrefs();
      updatePrint();
    });
  }
}

// ---- Shareable links ---------------------------------------------------------------

let defaultState = null;
let urlTimer = null;
const NOSHARE = ['artMode', 'artLines', 'artShiftX', 'artShiftY', 'artThreshold', 'artDetail', 'artInvert', 'artDenoise', 'showThin', ...Object.values(PRINT_FIELDS)];

const csv = (list) => list.map((v) => +(Number(v) || 0).toFixed(2)).join(',');

// The design as URL parameters: controls that differ from the defaults, plus the font and the per-line nudges.
function designQuery() {
  const values = diffState(snapshot(document.querySelector('main')), defaultState);
  const entry = fonts.get(el.font.value);
  const first = fonts.get(el.font.options[0] && el.font.options[0].value);
  if (entry && !el.font.value.startsWith('u:') && entry !== first) values.font = entry.name;
  if (lineShifts.some(Boolean)) values.lineShifts = csv(lineShifts);
  if (lineShiftsY.some(Boolean)) values.lineShiftsY = csv(lineShiftsY);
  // A shape whose usual hole spot isn't the default (the dog bone's top edge) always spells the angle out, so its links keep it.
  if (holeAngleFor(el.baseShape.value) !== DEFAULTS.holeAngle) values.holeAngle = el.holeAngle.value;
  return toQuery(values);
}

function updateUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    try { history.replaceState(null, '', location.pathname + designQuery()); } catch (e) { /* e.g. a sandboxed frame */ }
  }, 400);
}

// Apply a link's parameters to the form (before the first build).
function applyFromUrl() {
  const values = parseQuery(location.search);
  if (!Object.keys(values).length) return;
  const { font, lineShifts: ls, lineShiftsY: lsy, ...controls } = values;
  applyValues(document.querySelector('main'), controls);
  // A link that names a shape but not where the hole goes gets that shape's usual spot.
  if (controls.baseShape && !('holeAngle' in controls)) el.holeAngle.value = String(holeAngleFor(el.baseShape.value));
  if (font) {
    const opt = [...el.font.options].find((o) => o.textContent === font);
    if (opt) el.font.value = opt.value;
  }
  const list = (s) => String(s || '').split(',').map(Number).filter(Number.isFinite);
  lineShifts = list(ls);
  lineShiftsY = list(lsy);
  prevUnit = el.unit.value;
  renderLineShifts();
  el.nerdSize.open = el.fit.value !== 'contain' || el.sizeIncludesTab.checked; // show the folded settings if a link changed them
}

async function copyLink() {
  const text = location.origin + location.pathname + designQuery();
  try {
    await navigator.clipboard.writeText(text);
    el.exportInfo.textContent = 'Link copied. It recreates this design' + (usesUnsharable() ? ', except the uploaded font or artwork, which stay in your browser.' : '.');
  } catch (e) {
    el.exportInfo.textContent = 'Could not copy automatically. The address bar has the link.';
  }
}

const usesUnsharable = () => el.font.value.startsWith('u:') || !!art;

// ---- Batch ---------------------------------------------------------------------------

let batchCancelled = false;

function updateBatchCount() {
  const n = parseBatch(el.batchList.value).length;
  el.batchCount.textContent = n ? `${n} ${n === 1 ? 'keychain' : 'keychains'}` : '';
  el.batchRun.disabled = !n || !fonts.get(el.font.value);
}

async function makeBatch() {
  const items = parseBatch(el.batchList.value);
  const entry = fonts.get(el.font.value);
  if (!items.length || !entry) return;
  const format = el.batchFormat.value;
  if (format === 'step' && items.length > 30) {
    el.batchStatus.textContent = 'STEP batches are limited to 30 keychains (each takes about 10 seconds and 10 MB). Use STL for more.';
    return;
  }
  batchCancelled = false;
  el.batchRun.disabled = true;
  el.batchCancel.hidden = false;
  el.batchProgress.hidden = false;
  el.batchProgress.value = 0;
  try {
    const stepper = format === 'step' ? (await import('./step.js')).buildStep : null;
    const t0 = performance.now();
    const { blob, count, problems } = await runBatch({
      items,
      font: entry.font,
      baseParams: readParams(),
      format,
      colors: colors(),
      printSettings: printSettings(),
      buildStep: stepper,
      onProgress: (done, total, item) => {
        el.batchProgress.value = (100 * done) / total;
        el.batchStatus.textContent = `Making ${done + 1} of ${total}: ${item.text.replace(/\n/g, ' ')}`;
      },
      shouldCancel: () => batchCancelled,
    });
    if (count || !batchCancelled) downloadBlob(blob, `keychains-${count}-${format}.zip`);
    el.batchProgress.value = 100;
    el.batchStatus.textContent =
      `${batchCancelled ? 'Cancelled after' : 'Done:'} ${count} ${count === 1 ? 'keychain' : 'keychains'} in ${((performance.now() - t0) / 1000).toFixed(1)} s. summary.csv lists sizes, filament and any warnings` +
      (problems ? ` (${problems} need a look).` : '.');
  } catch (err) {
    console.error(err);
    el.batchStatus.textContent = 'The batch failed: ' + err.message;
  } finally {
    el.batchCancel.hidden = true;
    updateBatchCount();
  }
}

function initBatch() {
  el.batchList.addEventListener('input', updateBatchCount);
  el.batchLoad.addEventListener('click', () => el.batchFile.click());
  el.batchFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    el.batchList.value = await file.text();
    e.target.value = '';
    updateBatchCount();
  });
  el.batchRun.addEventListener('click', makeBatch);
  el.batchCancel.addEventListener('click', () => (batchCancelled = true));
  updateBatchCount();
}

// ---- Artwork ---------------------------------------------------------------------

function retraceSoon() {
  clearTimeout(artTimer);
  artTimer = setTimeout(retrace, 150);
}

async function retrace() {
  if (!artSource) return;
  try {
    art = await traceArt(artSource, {
      threshold: Number(el.artThreshold.value),
      detail: Number(el.artDetail.value),
      invert: el.artInvert.checked,
      denoise: el.artDenoise.checked,
    });
    drawArtPreview(el.artPreview, art);
    el.artInfo.textContent = art
      ? `${art.contours.length} ${art.contours.length === 1 ? 'shape' : 'shapes'} traced. If it looks wrong, move Threshold, or trace the light areas.`
      : 'Nothing traced. Move Threshold, or trace the light areas.';
    el.artInfo.classList.toggle('warn', !art);
  } catch (err) {
    console.error(err);
    art = null;
    el.artInfo.textContent = 'Could not trace that image: ' + err.message;
    el.artInfo.classList.add('warn');
  }
  schedule();
}

function clearArt() {
  artSource = null;
  art = null;
  el.artFile.value = '';
  el.artControls.hidden = true;
  el.artClear.hidden = true;
  el.artName.textContent = 'PNG, JPG or SVG — traced to an outline, like img2cad.';
  schedule();
}

function initArt() {
  el.artBtn.addEventListener('click', () => el.artFile.click());
  el.artClear.addEventListener('click', clearArt);
  el.artFile.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      artSource = await loadArtSource(file);
    } catch (err) {
      el.artName.textContent = err.message;
      return;
    }
    el.artName.textContent = file.name;
    el.artControls.hidden = false;
    el.artClear.hidden = false;
    if (el.artMode.value === 'off') el.artMode.value = 'above';
    retrace();
  });
  for (const id of ['artThreshold', 'artDetail']) el[id].addEventListener('input', retraceSoon);
  for (const id of ['artInvert', 'artDenoise']) el[id].addEventListener('input', retraceSoon);
  for (const [range, box] of [['artThreshold', 'artThresholdNum'], ['artDetail', 'artDetailNum'], ['artShiftX', 'artShiftXNum'], ['artShiftY', 'artShiftYNum']]) {
    sliderBoxes.push(pairSliderAndBox(el[range], el[box], 0));
  }
}

// ---- Fonts -----------------------------------------------------------------------

function addFontOption(value, label, font) {
  fonts.set(value, { name: label, font });
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  el.font.appendChild(opt);
}

async function loadBundledFonts() {
  const list = await (await fetch('fonts/fonts.json')).json();
  await Promise.all(
    list.map(async (f, i) => {
      try {
        const buf = await (await fetch('fonts/' + f.file)).arrayBuffer();
        fonts.set('b:' + i, { name: f.name, font: parseFont(buf) });
      } catch (e) {
        console.warn('Could not load font', f.file, e);
      }
    }),
  );
  // Keep the manifest's order in the dropdown.
  list.forEach((f, i) => {
    const entry = fonts.get('b:' + i);
    if (!entry) return;
    const opt = document.createElement('option');
    opt.value = 'b:' + i;
    opt.textContent = f.name;
    el.font.appendChild(opt);
  });
}

el.fontBtn.addEventListener('click', () => el.fontFile.click());
el.fontFile.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const font = parseFont(await file.arrayBuffer());
    const name = (fontDisplayName(font) || file.name) + ' (uploaded)';
    const value = 'u:' + fonts.size;
    addFontOption(value, name, font);
    el.font.value = value;
    el.fontNote.textContent = `Using ${name}. Uploaded fonts are only kept until you close this page.`;
    rebuild();
  } catch (err) {
    console.error(err);
    el.fontNote.textContent = "Couldn't read that font file. Try a .ttf, .otf or .woff (not .woff2).";
  }
});

// ---- Units -------------------------------------------------------------------------

el.unit.addEventListener('change', () => {
  const to = el.unit.value;
  if (to === prevUnit) return;
  const f = to === 'in' ? 1 / MM_PER_IN : MM_PER_IN;
  for (const input of [el.width, el.height]) {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) input.value = +(v * f).toFixed(to === 'in' ? 3 : 1);
  }
  el.width.step = el.height.step = to === 'in' ? '0.05' : '0.5';
  prevUnit = to;
  rebuild();
});

// ---- Exporting -----------------------------------------------------------------------

async function download() {
  if (timer) rebuild();
  if (!model) return;
  const name = slug(model.params.text);
  el.downloadBtn.disabled = true;
  try {
    if (el.format.value === 'stl') {
      const files = stlFilesFromModel(model, name);
      downloadBlob(zipStore(files), `${name}-stl.zip`);
      el.exportInfo.textContent = `STL zip saved: ${files.length} separate bodies (${files.map((f) => f.key).join(', ')}).`;
    } else if (el.format.value === 'dxf' || el.format.value === 'svg') {
      const dxf = el.format.value === 'dxf';
      const text = dxf ? dxfFromModel(model) : svgFromModel(model, colors());
      downloadBlob(new Blob([text], { type: dxf ? 'application/dxf' : 'image/svg+xml' }), `${name}.${el.format.value}`);
      el.exportInfo.textContent = `${dxf ? 'DXF' : 'SVG'} saved: the base (with the key hole) as the cut line, plus each layer's shapes, each on its own ${dxf ? 'layer' : 'group'}.`;
    } else {
      el.exportInfo.textContent = 'Building STEP… the CAD engine is a large one-time download (about 23 MB, cached afterwards).';
      const { buildStep } = await import('./step.js');
      const { blob, report } = await buildStep(model, colors(), (msg) => (el.exportInfo.textContent = msg));
      console.info('STEP built:', report);
      downloadBlob(blob, `${name}.step`);
      el.exportInfo.textContent = `STEP saved: ${[...new Set(model.layers.map((l) => l.name))].join(', ')} as separate colored bodies.`;
    }
  } catch (err) {
    console.error(err);
    el.exportInfo.textContent = 'Export failed: ' + err.message;
  } finally {
    el.downloadBtn.disabled = !model;
  }
}

function updateDownloadLabel() {
  el.downloadBtn.textContent = 'Download ' + (el.format.value === 'stl' ? 'STL' : el.format.value.toUpperCase());
}

// ---- Init ------------------------------------------------------------------------------

function initForm() {
  el.text.value = DEFAULTS.text;
  const k = el.unit.value === 'in' ? MM_PER_IN : 1;
  el.width.value = +(DEFAULTS.width / k).toFixed(3);
  el.height.value = +(DEFAULTS.height / k).toFixed(3);
  el.width.step = el.height.step = '0.05';
  for (const key of ['textH', 'midH', 'baseH', 'outline', 'baseMargin', 'roundIn', 'roundOut', 'holeDia', 'holeEdge', 'holeGap', 'backDepth', 'backMargin', 'plateRadius', 'ring2W', 'ring2H', 'ring3W', 'ring3H', 'artLines']) {
    el[key].value = DEFAULTS[key];
  }
  el.boneShaft.value = DEFAULTS.boneShaft * 100;
  el.holeAngle.value = DEFAULTS.holeAngle;
  el.holePush.value = Math.round(DEFAULTS.holePush * 100);
}

async function init() {
  initForm();
  preview = createPreview(el.preview);
  enableLineDragging();
  try {
    await loadBundledFonts();
  } catch (err) {
    console.error(err);
    el.status.textContent = 'Could not load the bundled fonts: ' + err.message;
    return;
  }
  el.font.value = el.font.options[0] ? el.font.options[0].value : '';

  el.text.addEventListener('input', renderLineShifts);
  // Every control rebuilds the keychain when it changes (the number boxes ride on their sliders).
  for (const input of document.querySelectorAll('main input, main select, main textarea')) {
    if (!input.id || input.type === 'file' || input.classList.contains('numval') || input.dataset.static !== undefined) continue;
    input.addEventListener('input', schedule);
  }
  el.backKind.addEventListener('change', () => {
    // Show the back when something goes on it, so it's the first thing they see.
    if (el.backKind.value !== 'none') setView('back');
    else if (el.viewBack.classList.contains('active')) setView('top');
  });
  for (const input of [el.colorText, el.colorOutline, el.colorOutline2, el.colorOutline3, el.colorBase, el.colorBack, el.backAuto]) {
    input.addEventListener('input', () => preview.setColors(colors()));
  }
  el.viewTop.addEventListener('click', () => setView('top'));
  el.view3d.addEventListener('click', () => setView('3d'));
  el.viewBack.addEventListener('click', () => setView('back'));
  el.format.addEventListener('change', updateDownloadLabel);
  el.downloadBtn.addEventListener('click', download);
  sliderBoxes.push(pairSliderAndBox(el.lineSpacing, el.lineSpacingNum, 2), pairSliderAndBox(el.textSize, el.textSizeNum, 0), pairSliderAndBox(el.holeAngle, el.holeAngleNum, 0), pairSliderAndBox(el.holePush, el.holePushNum, 0));
  initArt();
  initPrint();
  initBatch();
  for (const id of NOSHARE) el[id].dataset.noshare = '';
  updateDownloadLabel();
  renderLineShifts();
  syncLabels();
  defaultState = snapshot(document.querySelector('main')); // (after the form is filled with its defaults)
  applyFromUrl();
  prevShape = el.baseShape.value;
  el.copyLink.addEventListener('click', copyLink);
  rebuild();
  window.__kc = { rebuild, preview, get model() { return model; }, el, readParams, fonts, colors, printSettings };
}

function setView(v) {
  el.viewTop.classList.toggle('active', v === 'top');
  el.view3d.classList.toggle('active', v === '3d');
  el.viewBack.classList.toggle('active', v === 'back');
  preview.setView(v === 'top' ? 'top' : v === 'back' ? 'back' : 'iso');
}

init();

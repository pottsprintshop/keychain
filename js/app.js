import { parseFont, fontDisplayName, NOMINAL } from './layout.js';
import { buildKeychain, angleForHeight, pickLine, DEFAULTS } from './geometry.js';
import { createPreview } from './preview.js';
import { stlFromGeometries, zipStore, downloadBlob, slug } from './exporters.js';

const $ = (id) => document.getElementById(id);
const MM_PER_IN = 25.4;

const el = {
  text: $('text'), font: $('font'), fontBtn: $('fontBtn'), fontFile: $('fontFile'), fontNote: $('fontNote'),
  align: $('align'), lineSpacing: $('lineSpacing'), lineSpacingVal: $('lineSpacingVal'),
  width: $('width'), height: $('height'), unit: $('unit'), fit: $('fit'), sizeIncludesTab: $('sizeIncludesTab'), finalSize: $('finalSize'),
  textH: $('textH'), midH: $('midH'), baseH: $('baseH'), outline: $('outline'), baseMargin: $('baseMargin'),
  fillGaps: $('fillGaps'), baseShape: $('baseShape'), plateRadius: $('plateRadius'), roundIn: $('roundIn'), roundOut: $('roundOut'),
  colorText: $('colorText'), colorOutline: $('colorOutline'), colorBase: $('colorBase'),
  holeEnabled: $('holeEnabled'), holeControls: $('holeControls'), holeDia: $('holeDia'), holeEdge: $('holeEdge'),
  holeGap: $('holeGap'), holeAngle: $('holeAngle'), holeAngleVal: $('holeAngleVal'), holePush: $('holePush'), holePushVal: $('holePushVal'),
  holeQuick: $('holeQuick'), holeHeights: $('holeHeights'), lineShifts: $('lineShifts'), lineShiftList: $('lineShiftList'),
  qrEnabled: $('qrEnabled'), qrControls: $('qrControls'), qrText: $('qrText'), qrEcc: $('qrEcc'), qrAuto: $('qrAuto'), qrPlate: $('qrPlate'), qrSize: $('qrSize'),
  qrDepth: $('qrDepth'), colorQr: $('colorQr'), qrInfo: $('qrInfo'),
  viewTop: $('viewTop'), view3d: $('view3d'), viewBack: $('viewBack'), preview: $('preview'), status: $('status'),
  format: $('format'), downloadBtn: $('downloadBtn'), exportInfo: $('exportInfo'),
};

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
    sizeIncludesTab: el.sizeIncludesTab.checked,
    textH: num(el.textH, DEFAULTS.textH, 0.05),
    midH: num(el.midH, DEFAULTS.midH, 0.05),
    baseH: num(el.baseH, DEFAULTS.baseH, 0.05),
    outline: num(el.outline, DEFAULTS.outline, 0),
    baseMargin: num(el.baseMargin, DEFAULTS.baseMargin, 0),
    fillGaps: el.fillGaps.checked,
    baseShape: el.baseShape.value,
    plateRadius: num(el.plateRadius, DEFAULTS.plateRadius, 0),
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
    qrEnabled: el.qrEnabled.checked,
    qrText: el.qrText.value,
    qrEcc: el.qrEcc.value,
    qrPlate: el.qrPlate.checked,
    qrSize: num(el.qrSize, 0, 0),
    qrDepth: num(el.qrDepth, DEFAULTS.qrDepth, 0.2),
  };
}

// Light or dark, whichever contrasts with the base (perceived brightness of the base color).
const brightness = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
function syncQrColor() {
  if (el.qrAuto.checked) el.colorQr.value = brightness(el.colorBase.value) < 0.5 ? '#f2f2f2' : '#16161a';
  el.colorQr.disabled = el.qrAuto.checked;
}
const colors = () => {
  syncQrColor();
  return { text: el.colorText.value, outline: el.colorOutline.value, base: el.colorBase.value, qr: el.colorQr.value };
};

function fmtSize(w, h, unit) {
  return unit === 'in' ? `${(w / MM_PER_IN).toFixed(2)} × ${(h / MM_PER_IN).toFixed(2)} in` : `${w.toFixed(1)} × ${h.toFixed(1)} mm`;
}

function syncLabels() {
  el.lineSpacingVal.textContent = Number(el.lineSpacing.value).toFixed(2) + '×';
  const angle = Number(el.holeAngle.value);
  const compass = ['right', 'top right', 'top', 'top left', 'left', 'bottom left', 'bottom', 'bottom right'];
  el.holeAngleVal.textContent = `${angle}° · ${compass[Math.round(angle / 45) % 8]}`;
  el.holePushVal.textContent = `${el.holePush.value}%`;
  for (const b of el.holeQuick.children) b.classList.toggle('active', Number(b.dataset.angle) === angle);
  el.holeControls.style.opacity = el.holeEnabled.checked ? '1' : '0.45';
  el.qrControls.style.opacity = el.qrEnabled.checked ? '1' : '0.45';
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
      return;
    }
    model = m;
    preview.setModel(m, colors());
    const p = m.params;
    el.finalSize.textContent =
      `Overall size${m.params.holeEnabled ? ' with key hole' : ''}: ${fmtSize(m.size.w, m.size.h, el.unit.value)} × ${m.size.d.toFixed(1)} mm thick` +
      ` (${fmtSize(m.size.w, m.size.h, el.unit.value === 'in' ? 'mm' : 'in')})`;
    if (m.qr) {
      const negative = !m.qr.plate && brightness(el.colorQr.value) > brightness(el.colorBase.value);
      el.qrInfo.textContent =
        `QR code: ${m.qr.n}\u00d7${m.qr.n} modules, ${m.qr.module.toFixed(2)} mm each, ${m.qr.side.toFixed(1)} mm square. Flip the keychain like a page to scan it.` +
        (negative ? ' Light on dark is a negative image: most phones read it, but test yours (or use the plate under Nerd Shite).' : '');
    } else if (el.qrEnabled.checked) {
      el.qrInfo.textContent = el.qrText.value.trim() ? 'The QR code could not be made — see the note under the preview.' : 'Type what the QR code should say.';
    }
    el.status.classList.toggle('warn', m.warnings.length > 0);
    el.status.textContent = m.warnings.length
      ? m.warnings.join(' ')
      : `Built in ${Math.round(performance.now() - t0)} ms — drag to rotate, scroll to zoom.`;
    el.downloadBtn.disabled = false;
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
    ui.rx.value = String(Math.round(lineShifts[i]));
    ui.ry.value = String(Math.round(lineShiftsY[i]));
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
    range.step = '1';
    range.value = String(Math.round(value || 0));
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
    const vx = document.createElement('span');
    const vy = document.createElement('span');
    const sign = (v) => `${Number(v) > 0 ? '+' : ''}${v}%`;
    const show = () => {
      vx.textContent = sign(rx.value);
      vy.textContent = sign(ry.value);
    };
    const row = (icon, range, value) => {
      const r = document.createElement('div');
      r.className = 'control-row shift-row';
      const label = document.createElement('label');
      label.append(icon + ' ', value);
      r.append(label, range);
      return r;
    };
    block.append(head, row('\u2194', rx, vx), row('\u2195', ry, vy));
    show();
    shiftUi.set(i, { rx, ry, show });
    rx.addEventListener('input', () => {
      lineShifts[i] = Number(rx.value);
      show();
      schedule();
    });
    ry.addEventListener('input', () => {
      lineShiftsY[i] = Number(ry.value);
      show();
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
      // A body can be built from more than one slab (the base, when there's a QR code): merge them.
      const groups = new Map();
      for (const l of preview.layers()) groups.set(l.key, [...(groups.get(l.key) || []), l.geometry]);
      const files = [...groups].map(([key, geometries], i) => ({
        name: `${name}-${i + 1}-${key}.stl`,
        data: stlFromGeometries(geometries),
      }));
      downloadBlob(zipStore(files), `${name}-stl.zip`);
      el.exportInfo.textContent = `STL zip saved: ${files.length} separate bodies (${[...groups.keys()].join(', ')}).`;
    } else {
      el.exportInfo.textContent = 'Building STEP… the CAD engine is a large one-time download (about 23 MB, cached afterwards).';
      const { buildStep } = await import('./step.js');
      const { blob, report } = await buildStep(model, colors(), (msg) => (el.exportInfo.textContent = msg));
      console.info('STEP built:', report);
      downloadBlob(blob, `${name}.step`);
      el.exportInfo.textContent = `STEP saved: ${model.qr ? 'base, outline, text and QR' : 'base, outline and text'} as separate colored bodies.`;
    }
  } catch (err) {
    console.error(err);
    el.exportInfo.textContent = 'Export failed: ' + err.message;
  } finally {
    el.downloadBtn.disabled = !model;
  }
}

function updateDownloadLabel() {
  el.downloadBtn.textContent = el.format.value === 'stl' ? 'Download STL' : 'Download STEP';
}

// ---- Init ------------------------------------------------------------------------------

function initForm() {
  el.text.value = DEFAULTS.text;
  const k = el.unit.value === 'in' ? MM_PER_IN : 1;
  el.width.value = +(DEFAULTS.width / k).toFixed(3);
  el.height.value = +(DEFAULTS.height / k).toFixed(3);
  el.width.step = el.height.step = '0.05';
  for (const key of ['textH', 'midH', 'baseH', 'outline', 'baseMargin', 'roundIn', 'roundOut', 'holeDia', 'holeEdge', 'holeGap', 'qrDepth', 'plateRadius']) {
    el[key].value = DEFAULTS[key];
  }
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

  const live = [
    el.text, el.font, el.align, el.lineSpacing, el.width, el.height, el.fit, el.sizeIncludesTab,
    el.textH, el.midH, el.baseH, el.outline, el.baseMargin, el.fillGaps, el.baseShape, el.plateRadius, el.roundIn, el.roundOut,
    el.holeEnabled, el.holeDia, el.holeEdge, el.holeGap, el.holeAngle, el.holePush,
    el.qrEnabled, el.qrText, el.qrEcc, el.qrPlate, el.qrSize, el.qrDepth,
  ];
  el.text.addEventListener('input', renderLineShifts);
  for (const input of live) input.addEventListener('input', schedule);
  el.qrEnabled.addEventListener('change', () => {
    // Show the back when the QR turns on, so it's the first thing they see.
    if (el.qrEnabled.checked) setView('back');
    else if (el.viewBack.classList.contains('active')) setView('top');
  });
  for (const input of [el.colorText, el.colorOutline, el.colorBase, el.colorQr, el.qrAuto]) {
    input.addEventListener('input', () => {
      preview.setColors(colors());
      schedule(); // refreshes the QR note (light-on-dark or not)
    });
  }
  el.viewTop.addEventListener('click', () => setView('top'));
  el.view3d.addEventListener('click', () => setView('3d'));
  el.viewBack.addEventListener('click', () => setView('back'));
  el.format.addEventListener('change', updateDownloadLabel);
  el.downloadBtn.addEventListener('click', download);
  updateDownloadLabel();
  renderLineShifts();
  rebuild();
  window.__kc = { rebuild, preview, get model() { return model; }, el };
}

function setView(v) {
  el.viewTop.classList.toggle('active', v === 'top');
  el.view3d.classList.toggle('active', v === '3d');
  el.viewBack.classList.toggle('active', v === 'back');
  preview.setView(v === 'top' ? 'top' : v === 'back' ? 'back' : 'iso');
}

init();

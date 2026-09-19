// STEP export worker. Loads the OpenCascade kernel (replicad) on first use and builds
// the three bodies as real B-rep solids:
//   text     exact glyph curves (falls back to polygons if the curves don't check out)
//   outline  polygon prism
//   base     polygon prism (tab and fillets included) with an exact cylindrical hole
// Every "exact" build is checked (valid solid, volume matches the polygons) and
// silently falls back to the polygon version if it isn't.

import opencascade from '../vendor/replicad_single.js';
import * as R from '../vendor/replicad.js';

let oc = null;

async function init() {
  if (!oc) {
    oc = await opencascade();
    R.setOC(oc);
  }
}

// ---- helpers -----------------------------------------------------------------

const polyArea = (pts) => {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const netArea = (polys) =>
  polys.reduce((t, p) => t + Math.abs(polyArea(p.outer)) - p.holes.reduce((h, hole) => h + Math.abs(polyArea(hole)), 0), 0);

function isValid(shape) {
  try {
    const a = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
    const ok = a.IsValid_1 ? a.IsValid_1() : a.IsValid_2 ? a.IsValid_2() : a.IsValid();
    a.delete();
    return !!ok;
  } catch (e) {
    return false;
  }
}

function volumeOk(shape, expected, tolerance = 0.02) {
  try {
    const v = Math.abs(R.measureVolume(shape));
    return expected > 0 && Math.abs(v - expected) / expected <= tolerance;
  } catch (e) {
    return false;
  }
}

// Polygons -> a compound of prisms between z0 and z1.
function prisms(polys, z0, z1) {
  const up = new R.Vector([0, 0, z1 - z0]);
  const solids = polys.map(({ outer, holes }) => {
    const ring = polyArea(outer) < 0 ? [...outer].reverse() : outer;
    const face = R.makePolygon(ring.map(([x, y]) => [x, y, z0]));
    const withHoles = holes.length
      ? R.addHolesInFace(face, holes.map((h) => R.makePolygon(h.map(([x, y]) => [x, y, z0])).outerWire()))
      : face;
    return R.basicFaceExtrusion(withHoles, up);
  });
  return R.makeCompound(solids);
}

// Exact glyph curves -> a compound of solids.
function glyphSolids(contours, z0, z1) {
  const blueprints = [];
  for (const c of contours) {
    let pen = R.draw(c.start);
    let last = c.start;
    let count = 0;
    for (const s of c.segs) {
      const end = s[0] === 'L' ? [s[1], s[2]] : s[0] === 'Q' ? [s[3], s[4]] : [s[5], s[6]];
      if (Math.abs(end[0] - last[0]) < 1e-9 && Math.abs(end[1] - last[1]) < 1e-9) continue;
      if (s[0] === 'L') pen = pen.lineTo(end);
      else if (s[0] === 'Q') pen = pen.quadraticBezierCurveTo(end, [s[1], s[2]]);
      else pen = pen.cubicBezierCurveTo(end, [s[1], s[2]], [s[3], s[4]]);
      last = end;
      count++;
    }
    if (count >= 2) blueprints.push(pen.close().blueprint);
  }
  const drawing = new R.Drawing(R.organiseBlueprints(blueprints));
  return drawing.sketchOnPlane('XY', z0).extrude(z1 - z0);
}

// ---- build --------------------------------------------------------------------

function build(model, colors, progress) {
  const report = { text: 'exact', outline: 'polygon', base: 'exact' };
  const byKey = Object.fromEntries(model.layers.map((l) => [l.key, l]));
  const { text, outline, base } = byKey;
  const { contours, basePlain, hole } = model.exact;

  progress('Building the text…');
  let textShape = null;
  try {
    const candidate = glyphSolids(contours, text.z0, text.z1);
    if (isValid(candidate) && volumeOk(candidate, netArea(text.polys) * (text.z1 - text.z0), 0.03)) textShape = candidate;
  } catch (e) {
    console.warn('Exact text failed, using polygons:', e);
  }
  if (!textShape) {
    report.text = 'polygon';
    textShape = prisms(text.polys, text.z0, text.z1);
  }

  progress('Building the outline…');
  const outlineShape = prisms(outline.polys, outline.z0, outline.z1);

  progress('Building the base…');
  let baseShape = null;
  const baseH = base.z1 - base.z0;
  try {
    let shape = prisms(basePlain, base.z0, base.z1); // includes the tab and its fillets
    if (hole) {
      const bore = R.makeCylinder(hole.R, baseH + 2, [hole.cx, hole.cy, base.z0 - 1], [0, 0, 1]);
      shape = shape.cut(bore);
    }
    if (isValid(shape) && volumeOk(shape, netArea(base.polys) * baseH, 0.02)) baseShape = shape;
  } catch (e) {
    console.warn('Exact base failed, using polygons:', e);
  }
  if (!baseShape) {
    report.base = 'polygon';
    baseShape = prisms(base.polys, base.z0, base.z1);
  }

  progress('Writing the STEP file…');
  const blob = R.exportSTEP([
    { shape: baseShape, color: colors.base, name: 'Base' },
    { shape: outlineShape, color: colors.outline, name: 'Outline' },
    { shape: textShape, color: colors.text, name: 'Text' },
  ]);
  return { blob, report };
}

self.onmessage = async (e) => {
  const { id, model, colors } = e.data;
  const progress = (message) => self.postMessage({ id, progress: message });
  try {
    progress('Loading the CAD engine…');
    await init();
    const { blob, report } = build(model, colors, progress);
    const buffer = await blob.arrayBuffer();
    self.postMessage({ id, ok: true, buffer, report }, [buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

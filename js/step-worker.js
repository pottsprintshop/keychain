// STEP export worker. Loads the OpenCascade kernel (replicad) on first use and builds
// the three bodies as real B-rep solids:
//   text     exact glyph curves (falls back to polygons if the curves don't check out)
//   outline  prisms with lines and fitted arcs (one per ring)
//   base     the same (tab and fillets included) with an exact cylindrical hole
//   back     the same (the recessed QR / text / artwork body)
// Every "exact" build is checked (valid solid, volume matches the polygons) and
// silently falls back to the plain polygon version if it isn't.

import opencascade from '../vendor/replicad_single.js';
import * as R from '../vendor/replicad.js';
import { fitArcs } from './arcs.js';

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

// A ring fitted to lines and arcs (see arcs.js) -> a wire at height z.
function ringWire({ start, segs }, z) {
  let cur = [start[0], start[1], z];
  const edges = segs.map((s) => {
    const end = [s[1], s[2], z];
    const edge = s[0] === 'A' ? R.makeThreePointArc(cur, [s[3], s[4], z], end) : R.makeLine(cur, end);
    cur = end;
    return edge;
  });
  return R.assembleWire(edges);
}

// Like prisms(), but a run of facets that lies on a circle becomes one cylindrical face. That is what keeps the
// STEP file small: a rounded outline is a few dozen faces instead of a few hundred. -> { shape, segments }
function arcPrisms(polys, z0, z1) {
  const up = new R.Vector([0, 0, z1 - z0]);
  let segments = 0;
  const fit = (ring) => {
    const f = fitArcs(ring);
    segments += f.segs.length;
    return f;
  };
  const solids = polys.map(({ outer, holes }) => {
    const ring = polyArea(outer) < 0 ? [...outer].reverse() : outer;
    const face = R.makeFace(ringWire(fit(ring), z0));
    const withHoles = holes.length ? R.addHolesInFace(face, holes.map((h) => ringWire(fit(h), z0))) : face;
    return R.basicFaceExtrusion(withHoles, up);
  });
  return { shape: R.makeCompound(solids), segments };
}

const vertexCount = (polys) => polys.reduce((t, p) => t + p.outer.length + p.holes.reduce((h, r) => h + r.length, 0), 0);

// One body: lines and arcs if that checks out (a valid solid whose volume is within 1.5% of the polygons'),
// else the plain polygon prisms. -> { shape, how: 'arcs' | 'polygon', points, segments }
function bodyShape(polys, z0, z1) {
  const points = vertexCount(polys);
  try {
    const { shape, segments } = arcPrisms(polys, z0, z1);
    if (isValid(shape) && volumeOk(shape, netArea(polys) * (z1 - z0), 0.015)) return { shape, how: 'arcs', points, segments };
  } catch (e) {
    console.warn('Arc fitting failed, using polygons:', e);
  }
  return { shape: prisms(polys, z0, z1), how: 'polygon', points, segments: points };
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

// ---- writing ------------------------------------------------------------------

// The same writer replicad's exportSTEP uses, minus the "pcurves": otherwise every edge carries a 2D copy of its
// curve for each face it touches, which is over a third of the file, and importers rebuild them anyway.
function writeStep(shapes) {
  try {
    const r = R.GCWithScope();
    const doc = R.createAssembly(shapes);
    const session = r(new oc.XSControl_WorkSession());
    const writer = r(new oc.STEPCAFControl_Writer(session, false));
    writer.SetColorMode(true);
    writer.SetLayerMode(true);
    writer.SetNameMode(true);
    oc.Interface_Static.SetIVal('write.surfacecurve.mode', 0);
    oc.Interface_Static.SetIVal('write.precision.mode', 0);
    oc.Interface_Static.SetIVal('write.step.assembly', 2);
    oc.Interface_Static.SetIVal('write.step.schema', 5);
    const progress = r(new oc.Message_ProgressRange());
    if (!writer.Perform(doc.wrapped, 'export.step', progress)) throw new Error('the writer refused the model');
    const file = oc.FS.readFile('/export.step');
    oc.FS.unlink('/export.step');
    return new Blob([file], { type: 'application/STEP' });
  } catch (e) {
    console.warn('Compact STEP writer failed, using the standard one:', e);
    return R.exportSTEP(shapes);
  }
}

// ---- build --------------------------------------------------------------------

function build(model, colors, progress) {
  const report = { text: 'exact', outline: 'arcs', base: 'exact' };
  const text = model.layers.find((l) => l.key === 'text');
  const base = model.layers.find((l) => l.key === 'base');
  const ringLayers = model.layers.filter((l) => l.key.startsWith('outline'));
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

  // How much the arc fitting saved: polygon vertices in, edges out (an edge is a line or a whole arc).
  const tally = { points: 0, segments: 0 };
  const count = (r) => { tally.points += r.points; tally.segments += r.segments; return r; };

  progress('Building the outline…');
  const ringBodies = ringLayers.map((l) => ({ body: count(bodyShape(l.polys, l.z0, l.z1)), layer: l }));
  const ringShapes = ringBodies.map(({ body, layer }) => ({ shape: body.shape, color: colors[layer.key], name: layer.name }));
  report.outline = ringBodies.every(({ body }) => body.how === 'arcs') ? 'arcs' : 'polygon';

  progress('Building the base\u2026');
  const baseParts = model.layers.filter((l) => l.key === 'base');
  const backLayer = model.layers.find((l) => l.key === 'back');
  let baseShape = null;
  const baseVolume = baseParts.reduce((t, l) => t + netArea(l.polys) * (l.z1 - l.z0), 0);
  // With something recessed into its back the base is two slabs: a lower one with the pocket cut out, and the rest.
  // Both start from the simplified outline (with the tab and fillets) and get the exact bore cut through them.
  const slabs = backLayer
    ? [
        { polys: model.exact.baseLowerPlain, z0: baseParts[0].z0, z1: baseParts[0].z1 },
        { polys: basePlain, z0: baseParts[1].z0, z1: baseParts[1].z1 },
      ]
    : [{ polys: basePlain, z0: base.z0, z1: base.z1 }];
  for (const withArcs of [true, false]) {
    try {
      const bodies = slabs.map((s) => (withArcs ? bodyShape(s.polys, s.z0, s.z1) : { shape: prisms(s.polys, s.z0, s.z1), how: 'polygon', points: vertexCount(s.polys), segments: vertexCount(s.polys) }));
      if (withArcs && !bodies.every((b) => b.how === 'arcs')) continue; // one slab failed: try all polygons instead
      let shape = bodies.length === 1 ? bodies[0].shape : R.makeCompound(bodies.map((b) => b.shape));
      if (hole) {
        const bore = R.makeCylinder(hole.R, model.size.d + 2, [hole.cx, hole.cy, base.z0 - 1], [0, 0, 1]);
        shape = shape.cut(bore);
      }
      const valid = isValid(shape);
      const vol = Math.abs(R.measureVolume(shape));
      if (valid && volumeOk(shape, baseVolume, 0.02)) {
        baseShape = shape;
        report.baseFaces = withArcs ? 'arcs' : 'polygon';
        bodies.forEach(count);
        break;
      }
      report.baseWhy = `${withArcs ? 'arcs' : 'polygons'}: valid=${valid} volume=${vol.toFixed(1)} expected=${baseVolume.toFixed(1)}`;
    } catch (e) {
      console.warn(`Exact base (${withArcs ? 'arcs' : 'polygons'}) failed:`, e);
      report.baseWhy = String((e && e.message) || e);
    }
  }
  if (!baseShape) {
    report.base = 'polygon';
    report.baseFaces = 'polygon';
    baseShape = R.makeCompound(baseParts.map((l) => prisms(l.polys, l.z0, l.z1)));
    baseParts.forEach((l) => count({ points: vertexCount(l.polys), segments: vertexCount(l.polys) }));
  } else if (report.baseFaces === 'polygon') {
    delete report.baseWhy; // the arcs didn't fit but the polygons did: nothing to worry about
  }

  let backShape = null;
  if (backLayer) {
    progress(`Building the ${backLayer.name.toLowerCase()}\u2026`);
    const body = count(bodyShape(backLayer.polys, backLayer.z0, backLayer.z1));
    backShape = body.shape;
    report.back = body.how;
  }
  report.edges = tally;

  progress('Writing the STEP file…');
  const blob = writeStep([
    { shape: baseShape, color: colors.base, name: 'Base' },
    ...ringShapes,
    { shape: textShape, color: colors.text, name: 'Text' },
    ...(backShape ? [{ shape: backShape, color: colors.back, name: backLayer.name }] : []),
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

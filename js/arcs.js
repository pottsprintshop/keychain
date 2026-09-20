// Arc fitting for the STEP export. The outline and base are polygons, and a rounded corner or a curved edge is
// a run of dozens of tiny flat facets, each of which becomes its own face in the STEP file. Most of those runs
// sit on a circle (offsets of a curve with round joins are exactly that), so a run can be one arc instead.
//
// fitArcs(ring) -> { start: [x, y], segs: [['L', x, y] | ['A', x, y, mx, my], ...] }
// An 'A' segment ends at (x, y) and passes through (mx, my), which is all a three-point arc needs. Every arc
// starts, passes through and ends at real polygon vertices, so the ring still closes exactly.

const TOL = 0.004; // mm, how far a vertex may sit from the fitted circle
const MAX_SAG = 0.03; // mm, the most a chord of the original polygon may differ from the arc that replaces it
const MIN_R = 0.1; // mm, smaller radii are sharp corners, not curves
const MAX_R = 500; // mm, bigger ones are straight lines
const MAX_SWEEP = Math.PI; // keep every arc at most half a circle

// Circle through three points -> { cx, cy, r }, or null when they are (nearly) in a line.
function circumcircle([ax, ay], [bx, by], [cx, cy]) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) };
}

// Can the vertices q[i..j] be one arc? -> the circle, or null.
function tryArc(q, i, j) {
  const m = (i + j) >> 1;
  const circ = circumcircle(q[i], q[m], q[j]);
  if (!circ || circ.r < MIN_R || circ.r > MAX_R) return null;
  const { cx, cy, r } = circ;
  let sweep = 0, sign = 0;
  for (let k = i; k <= j; k++) {
    if (Math.abs(Math.hypot(q[k][0] - cx, q[k][1] - cy) - r) > TOL) return null;
  }
  for (let k = i; k < j; k++) {
    const chord = Math.hypot(q[k + 1][0] - q[k][0], q[k + 1][1] - q[k][1]);
    if (r - Math.sqrt(Math.max(0, r * r - (chord * chord) / 4)) > MAX_SAG) return null;
    sweep += 2 * Math.asin(Math.min(1, chord / (2 * r)));
    if (k > i) {
      // Every turn must bend the same way, or this is a zig-zag that merely touches the circle.
      const cross = (q[k][0] - q[k - 1][0]) * (q[k + 1][1] - q[k][1]) - (q[k][1] - q[k - 1][1]) * (q[k + 1][0] - q[k][0]);
      const s = Math.abs(cross) < 1e-9 ? 0 : Math.sign(cross);
      if (s !== 0) {
        if (sign !== 0 && s !== sign) return null;
        sign = s;
      }
    }
  }
  if (sweep > MAX_SWEEP) return null;
  return circ;
}

// The vertex with the sharpest turn: a natural place to start, so runs don't wrap around the start.
function sharpestVertex(pts) {
  const n = pts.length;
  let best = 0, bestCos = 2;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const cos = len > 0 ? (ux * vx + uy * vy) / len : 1; // smaller = sharper
    // Ties go to the lowest, leftmost vertex, so the same ring gives the same start however it is rotated
    // (the two slabs of a base must break their shared outline into arcs identically).
    const tie = Math.abs(cos - bestCos) < 1e-9 && (b[0] < pts[best][0] || (b[0] === pts[best][0] && b[1] < pts[best][1]));
    if (cos < bestCos - 1e-9 || tie) { bestCos = Math.min(cos, bestCos); best = i; }
  }
  return best;
}

export function fitArcs(ring) {
  const n = ring.length;
  const s = sharpestVertex(ring);
  const q = [];
  for (let k = 0; k <= n; k++) q.push(ring[(s + k) % n]); // q[n] is q[0] again: the ring, cut open at its sharpest corner
  const segs = [];
  let i = 0;
  while (i < n) {
    let best = null, bestJ = i + 1;
    for (let j = i + 2; j <= n; j++) {
      const c = tryArc(q, i, j);
      if (!c) break;
      best = c;
      bestJ = j;
    }
    if (best) {
      const m = (i + bestJ) >> 1;
      segs.push(['A', q[bestJ][0], q[bestJ][1], q[m][0], q[m][1]]);
    } else {
      segs.push(['L', q[i + 1][0], q[i + 1][1]]);
    }
    i = bestJ;
  }
  return { start: q[0], segs };
}

// { outer, holes } polygons -> the same, with each ring as fitted arcs, plus counts for reporting.
export function fitPolys(polys) {
  const stats = { points: 0, segments: 0, arcs: 0 };
  const fit = (ring) => {
    const r = fitArcs(ring);
    stats.points += ring.length;
    stats.segments += r.segs.length;
    stats.arcs += r.segs.filter((s) => s[0] === 'A').length;
    return r;
  };
  const out = polys.map(({ outer, holes }) => ({ outer: fit(outer), holes: holes.map(fit) }));
  return { polys: out, stats };
}

// The polyline a fitted ring stands for (arcs sampled every `step` radians), for tests and comparisons.
export function sampleFitted({ start, segs }, step = 0.05) {
  const pts = [start];
  let cur = start;
  for (const s of segs) {
    if (s[0] === 'A') {
      const circ = circumcircle(cur, [s[3], s[4]], [s[1], s[2]]);
      if (circ) {
        const a0 = Math.atan2(cur[1] - circ.cy, cur[0] - circ.cx);
        const am = Math.atan2(s[4] - circ.cy, s[3] - circ.cx);
        const a1 = Math.atan2(s[2] - circ.cy, s[1] - circ.cx);
        const wrap = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const ccw = wrap(am - a0) < wrap(a1 - a0); // going 0 -> m -> end anticlockwise?
        const span = ccw ? wrap(a1 - a0) : -wrap(a0 - a1);
        const steps = Math.max(2, Math.ceil(Math.abs(span) / step));
        for (let k = 1; k < steps; k++) {
          const a = a0 + (span * k) / steps;
          pts.push([circ.cx + circ.r * Math.cos(a), circ.cy + circ.r * Math.sin(a)]);
        }
      }
    }
    pts.push([s[1], s[2]]);
    cur = [s[1], s[2]];
  }
  pts.pop(); // the last point is the start again
  return pts;
}

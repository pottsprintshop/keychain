// Outlines for a laser: every layer's shapes as closed polylines, on their own DXF layers / SVG groups.
// BASE is the cut line (base outline, key hole and all); the others can be stacked cut-outs or engraving.
// Units are mm. The DXF writer follows img2cad's (LWPOLYLINE, AC1009 header), which the LaserPecker reads.

const DXF_COLORS = { BASE: 1, OUTLINE: 5, OUTLINE2: 4, OUTLINE3: 3, TEXT: 2, BACK: 6 }; // AutoCAD color indexes

// [{ name, key, polys }] for the model's layers, bottom to top. The base is its full slab (with the key
// hole), not the lower slab that has the back's pocket cut out.
export function laserLayers(model) {
  const layers = [];
  const base = model.layers.filter((l) => l.key === 'base');
  layers.push({ name: 'BASE', key: 'base', polys: base[base.length - 1].polys });
  for (const l of model.layers) {
    if (l.key.startsWith('outline')) layers.push({ name: l.key.toUpperCase(), key: l.key, polys: l.polys });
  }
  const text = model.layers.find((l) => l.key === 'text');
  if (text) layers.push({ name: 'TEXT', key: 'text', polys: text.polys });
  const back = model.layers.find((l) => l.key === 'back');
  if (back) layers.push({ name: 'BACK', key: 'back', polys: back.polys });
  return layers;
}

const rings = (polys) => polys.flatMap((p) => [p.outer, ...p.holes]);

export function dxfFromModel(model) {
  const layers = laserLayers(model);
  const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC'];
  out.push('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(layers.length));
  for (const l of layers) out.push('0', 'LAYER', '2', l.name, '70', '0', '62', String(DXF_COLORS[l.name] || 7), '6', 'CONTINUOUS');
  out.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
  for (const l of layers) {
    for (const ring of rings(l.polys)) {
      out.push('0', 'LWPOLYLINE', '8', l.name, '90', String(ring.length), '70', '1', '43', '0');
      for (const [x, y] of ring) out.push('10', x.toFixed(4), '20', y.toFixed(4));
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}

// `colors` maps layer keys to hex colors (the same ones the preview uses).
export function svgFromModel(model, colors) {
  const layers = laserLayers(model);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const l of layers) for (const ring of rings(l.polys)) for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const pad = 2, w = x1 - x0 + 2 * pad, h = y1 - y0 + 2 * pad;
  const groups = layers.map((l) => {
    const d = rings(l.polys)
      .map((ring) => 'M' + ring.map(([x, y]) => `${(x - x0 + pad).toFixed(3)} ${(y1 - y + pad).toFixed(3)}`).join('L') + 'Z') // y flipped: SVG is top-down
      .join(' ');
    return `  <g id="${l.name}" fill="none" stroke="${l.key === 'base' ? '#ff0000' : colors[l.key] || '#000000'}" stroke-width="0.1">\n    <path d="${d}" fill-rule="evenodd"/>\n  </g>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(3)}mm" height="${h.toFixed(3)}mm" viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}">\n${groups.join('\n')}\n</svg>\n`;
}

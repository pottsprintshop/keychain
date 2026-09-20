// Design state in the URL: every control's value, so a link recreates the design and a reload restores it.
// Only values that differ from the defaults go in the link, keyed by the control's id (so `?text=Hi&baseShape=plate`
// works from any tool that can build a URL). Colors are written without the '#'.

const isShared = (e) =>
  e.id && e.type !== 'file' && e.type !== 'button' && !e.classList.contains('numval') && e.dataset.noshare === undefined && e.id !== 'font';

// { id: value } for every shared control in `root`.
export function snapshot(root) {
  const s = {};
  for (const e of root.querySelectorAll('input, select, textarea')) {
    if (!isShared(e)) continue;
    s[e.id] = e.type === 'checkbox' ? (e.checked ? '1' : '0') : e.type === 'color' ? e.value.replace('#', '') : e.value;
  }
  return s;
}

// What differs from the defaults.
export function diffState(current, defaults) {
  const d = {};
  for (const [k, v] of Object.entries(current)) if (defaults[k] !== v) d[k] = v;
  return d;
}

export function toQuery(values) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) q.set(k, v);
  const s = q.toString();
  return s ? '?' + s : '';
}

export function parseQuery(search) {
  const v = {};
  for (const [k, val] of new URLSearchParams(search)) v[k] = val;
  return v;
}

// Set the controls named in `values` (ids that don't exist are ignored). Returns how many were set.
export function applyValues(root, values) {
  let n = 0;
  for (const [id, v] of Object.entries(values)) {
    const e = root.querySelector(`#${CSS.escape(id)}`);
    if (!e || !isShared(e)) continue;
    if (e.type === 'checkbox') e.checked = v === '1' || v === 'true';
    else if (e.type === 'color') e.value = /^[0-9a-f]{6}$/i.test(v) ? '#' + v : v;
    else e.value = v;
    n++;
  }
  return n;
}

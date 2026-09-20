// Live 3D preview (three.js). Renders on demand — no animation loop.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

// A 0.1-0.2 micron deterministic nudge per vertex. Perfectly aligned holes (a QR code's modules all
// share exact row edges) make the cap triangulator produce open edges; breaking the ties fixes that,
// and 0.2 um is far below anything a printer can resolve.
function nudge(x, y) {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const g = Math.sin(x * 39.3468 + y * 11.135) * 24634.6345;
  return [x + ((h - Math.floor(h)) - 0.5) * 2e-4, y + ((g - Math.floor(g)) - 0.5) * 2e-4];
}

function layerGeometry(polys, z0, z1) {
  const v = ([x, y]) => new THREE.Vector2(...nudge(x, y));
  const shapes = polys.map(({ outer, holes }) => {
    const shape = new THREE.Shape(outer.map(v));
    shape.holes = holes.map((h) => new THREE.Path(h.map(v)));
    return shape;
  });
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth: z1 - z0,
    bevelEnabled: false,
    curveSegments: 1,
    steps: 1,
  });
  g.translate(0, 0, z0);
  return g;
}

export function createPreview(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  scene.add(camera);
  // Lights ride with the camera so every view is lit the same way.
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(-0.6, 0.9, 1.6);
  camera.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(1, -0.5, 0.8);
  camera.add(fill);

  // Dragging a line of text (Top view). This listener is added before the orbit controls' own, in the
  // capture phase, so grabbing a line moves it and grabbing anything else still rotates the view.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hitPoint = new THREE.Vector3();
  let handlers = null; // { pick(x, y) -> line | -1, start(line), move(line, dx, dy), end(line) }
  let drag = null;
  const canvas = renderer.domElement;
  const toModel = (ev) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    dragPlane.constant = -size.d; // the top of the text
    return raycaster.ray.intersectPlane(dragPlane, hitPoint) ? [hitPoint.x, hitPoint.y] : null;
  };
  canvas.addEventListener(
    'pointerdown',
    (ev) => {
      if (!handlers || mode !== 'top' || ev.button !== 0) return;
      const pt = toModel(ev);
      const line = pt ? handlers.pick(pt[0], pt[1]) : -1;
      if (line < 0) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
      controls.enabled = false;
      canvas.setPointerCapture(ev.pointerId);
      drag = { line, x0: pt[0], y0: pt[1] };
      canvas.style.cursor = 'grabbing';
      handlers.start(line);
    },
    { capture: true },
  );
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      const pt = toModel(ev);
      if (pt) handlers.move(drag.line, pt[0] - drag.x0, pt[1] - drag.y0);
    } else if (handlers && mode === 'top' && ev.buttons === 0) {
      const pt = toModel(ev);
      canvas.style.cursor = pt && handlers.pick(pt[0], pt[1]) >= 0 ? 'grab' : '';
    }
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const { line } = drag;
    drag = null;
    controls.enabled = true;
    canvas.style.cursor = '';
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
    handlers.end(line);
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;

  const group = new THREE.Group();
  scene.add(group);

  let size = { w: 60, h: 30, d: 2.4 };
  let layers = []; // { key, name, geometry, mesh }
  let mode = 'top';

  const render = () => renderer.render(scene, camera);
  controls.addEventListener('change', render);

  function resize() {
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }
  new ResizeObserver(resize).observe(container);

  function frame(view) {
    mode = view;
    const fov = (camera.fov * Math.PI) / 180;
    const tan = Math.tan(fov / 2);
    const fitH = size.h / 2 / tan;
    const fitW = size.w / 2 / (tan * camera.aspect);
    const dist = Math.max(fitH, fitW) * 1.15 + size.d;
    controls.target.set(0, 0, size.d / 2);
    if (view === 'top') camera.position.set(0, 0, dist + size.d / 2);
    else if (view === 'back') camera.position.set(0, 0, -dist); // looking up at the underside; a QR reads correctly
    else camera.position.set(-dist * 0.45, -dist * 0.6, dist * 0.75 + size.d / 2);
    camera.up.set(0, 1, 0);
    camera.lookAt(controls.target);
    controls.update();
    render();
  }

  function setModel(model, colors) {
    for (const l of layers) {
      group.remove(l.mesh);
      l.geometry.dispose();
      l.mesh.material.dispose();
    }
    layers = model.layers.map((layer) => {
      const geometry = layerGeometry(layer.polys, layer.z0, layer.z1);
      // Matte, like a slicer preview: no specular glare washing out the black base.
      const material = new THREE.MeshLambertMaterial({ color: colors[layer.key] });
      const mesh = new THREE.Mesh(geometry, material);
      group.add(mesh);
      return { key: layer.key, name: layer.name, geometry, mesh };
    });
    const sizeChanged = Math.abs(size.w - model.size.w) > 1e-6 || Math.abs(size.h - model.size.h) > 1e-6;
    size = model.size;
    if (sizeChanged && !setModel.first) {
      setModel.first = true;
      frame(mode);
    } else {
      render();
    }
  }

  function setColors(colors) {
    for (const l of layers) l.mesh.material.color.set(colors[l.key]);
    render();
  }

  return {
    setModel,
    setColors,
    setView: frame,
    enableDrag: (h) => { handlers = h; },
    resize,
    layers: () => layers,
    png: () => renderer.domElement.toDataURL('image/png'),
    canvas: renderer.domElement,
  };
}

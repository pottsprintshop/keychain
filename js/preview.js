// Live 3D preview (three.js). Renders on demand — no animation loop.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { layerGeometry } from './mesh.js';

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
  let handlers = null; // { pick(x, y) -> line | 'art' | -1, start(line), move(line, dx, dy), end(line) }
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
      if (line === -1) return;
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
      canvas.style.cursor = pt && handlers.pick(pt[0], pt[1]) !== -1 ? 'grab' : '';
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

  let framedAspect = null; // the aspect ratio the camera was last fitted for
  let moved = false; // has the user orbited or zoomed since?
  controls.addEventListener('start', () => (moved = true));

  function resize() {
    const w = container.clientWidth || 300;
    const h = container.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // A canvas that changes shape (a window resized, a phone turned, a panel that wasn't laid out yet when the
    // keychain was fitted) needs the fit redone, unless the user has set the view themselves.
    if (framedAspect && !moved && Math.abs(camera.aspect / framedAspect - 1) > 0.05) frame(mode);
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
    framedAspect = camera.aspect;
    moved = false;
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
    clearOverlay();
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
    // A much bigger or differently shaped keychain (a new shape, a new size) gets the camera pulled back to fit it;
    // small tweaks leave the view where you put it.
    const jumped = Math.abs(model.size.w / size.w - 1) > 0.2 || Math.abs(model.size.h / size.h - 1) > 0.2;
    size = model.size;
    if (sizeChanged && (!setModel.first || jumped)) {
      setModel.first = true;
      frame(mode);
    } else {
      render();
    }
  }

  // A thin red overlay just above the text (thin spots and gaps), or none.
  let overlay = null;
  function clearOverlay() {
    if (!overlay) return;
    group.remove(overlay);
    overlay.geometry.dispose();
    overlay.material.dispose();
    overlay = null;
  }
  function setHighlights(polys, z, color) {
    clearOverlay();
    if (polys && polys.length) {
      overlay = new THREE.Mesh(layerGeometry(polys, z, z + 0.1), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      group.add(overlay);
    }
    render();
  }

  function setColors(colors) {
    for (const l of layers) l.mesh.material.color.set(colors[l.key]);
    render();
  }

  return {
    setModel,
    setColors,
    setView: frame,
    setHighlights,
    enableDrag: (h) => { handlers = h; },
    resize,
    layers: () => layers,
    png: () => renderer.domElement.toDataURL('image/png'),
    canvas: renderer.domElement,
  };
}

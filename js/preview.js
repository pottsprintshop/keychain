// Live 3D preview (three.js). Renders on demand — no animation loop.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

function layerGeometry(polys, z0, z1) {
  const v = ([x, y]) => new THREE.Vector2(x, y);
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
    resize,
    layers: () => layers,
    png: () => renderer.domElement.toDataURL('image/png'),
    canvas: renderer.domElement,
  };
}

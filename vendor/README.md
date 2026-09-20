# Vendored libraries

Third-party code, copied verbatim (source-map comments stripped). No build step.

| File | Package | Version | License |
| --- | --- | --- | --- |
| `replicad.js`, `casting-*.js` | [replicad](https://github.com/sgenoud/replicad) | 1.1.0 | MIT |
| `replicad_single.js`, `replicad_single.wasm` | replicad-opencascadejs (OpenCascade Technology build) | 1.1.0 | LGPL-2.1 |
| `opentype.module.js` | [opentype.js](https://github.com/opentypejs/opentype.js) | 1.3.4 | MIT |
| `imagetracer.js` | [imagetracer.js](https://github.com/jankovicsandras/imagetracerjs) (András Jankovics; as used in img2cad) | 1.2.6 | Unlicense (public domain) |
| `clipper.js` | [clipper-lib](https://github.com/junmer/clipper-lib) (Clipper 6.4.2, Angus Johnson) | 6.4.2 | Boost Software License 1.0 |
| `qrcode.mjs` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (Kazuhiko Arase) | 2.0.4 | MIT |
| `three.module.min.js`, `three.core.js`, `OrbitControls.js` | [three.js](https://threejs.org) | 0.186.0 | MIT |

`replicad_single.wasm` is the OpenCascade kernel (LGPL-2.1). Its source is available at
<https://github.com/Open-Cascade-SAS/OCCT> and the build scripts at
<https://github.com/sgenoud/replicad/tree/main/packages/replicad-opencascadejs>.

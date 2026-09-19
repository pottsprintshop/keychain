# Keychain Maker

A static, in-browser web app that generates a three-color keychain and exports it as
**STEP** (preferred) or **STL** for multi-color 3D printing. Nothing is uploaded — it all
runs in your browser.

Part of Potts Print Shop. Styled to the Potts blueprint theme (Lemon Milk headings).

## What it makes

Three stacked bodies, so a slicer can give each one its own filament:

| Layer | What it is | Default |
| --- | --- | --- |
| **Text** (top) | The letters themselves | 0.6 mm tall |
| **Outline** (middle) | The text offset outward | +0.8 mm past the text, 0.6 mm tall |
| **Base** (bottom) | The outline offset outward again, as a solid silhouette | +2.0 mm past the outline, 1.2 mm tall |

Plus a **key hole** (Ø4.2 mm, 2.0 mm of material around it) on a small tab that slides in from
the chosen side until it just clears the outline layer, so the hole never cuts through the text.

Default size is **2.5 × 1.5 in**; the text is scaled to fit. Every number above is adjustable.

## Controls

- **Text** — multi-line (Enter starts a new line), alignment, line spacing.
- **Font** — the bundled fonts (see `fonts/fonts.json`), or **Upload font…** (TTF / OTF / WOFF)
  for the current session only.
- **Size** — width and height in inches or mm. *Keep font proportions* fits the text inside the
  box; *Stretch text to fill* fills it exactly. By default the size is the keychain body and the
  key hole tab sticks out beyond it; tick *Count the key hole tab in the size* to include it.
- **Layers** — color (preview and STEP), height, and how far the outline / base extend.
  *Solid base* fills the gaps between letters.
- **Key hole** — diameter, edge distance, side, position along the edge. *Nerd Shite* has the gap
  between the hole and the outline layer.
- **Preview** — live 3D view (Top / 3D, drag to rotate, scroll to zoom).

## Exports

- **STEP (3 bodies)** — bodies named *Base*, *Outline*, *Text* with their colors. The letters are
  true curves and the key hole is an exact cylinder. The outline and base are polygons
  (0.015 mm tolerance), so files run a few MB. The export runs in a Web Worker and loads the CAD
  engine (23 MB raw, about 7 MB gzipped, then cached by the browser) only when you click Download.
- **STL (3 files, zipped)** — one watertight STL per body, in mm, ready to import as parts.

## Running it

Plain static files, no build step. Serve the repo root with any static server:

```bash
python3 -m http.server 8000
```

then open <http://localhost:8000>. (ES modules and the CAD worker need `http://`, not `file://`.)
It publishes as-is with GitHub Pages (Settings → Pages → Deploy from a branch → `main` / root).

## Layout

```
index.html, style.css     the page
js/app.js                 UI and wiring
js/layout.js              text layout, curve flattening (opentype.js)
js/geometry.js            fit-to-size, outline/base offsets (Clipper), key hole placement
js/preview.js             three.js preview
js/exporters.js           binary STL, zip, download
js/step.js, step-worker.js  STEP export (OpenCascade via replicad) in a Web Worker
fonts/                    bundled fonts + fonts.json manifest
vendor/                   third-party libraries (see vendor/README.md)
```

## Adding a font

Drop the `.ttf` / `.otf` into `fonts/` and add a line to `fonts/fonts.json`:

```json
{ "name": "My Font", "file": "MyFont-Regular.ttf" }
```

Bundled: Carter One (SIL Open Font License), Lemon Milk (Bold, Medium), Potts Graffiti.

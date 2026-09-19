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

- **Text** — multi-line (Enter starts a new line), alignment, line spacing, and a sideways
  offset slider for each line.
- **Font** — the bundled fonts (see `fonts/fonts.json`), or **Upload font…** (TTF / OTF / WOFF)
  for the current session only.
- **Size** — width and height in inches or mm. *Keep font proportions* fits the text inside the
  box; *Stretch text to fill* fills it exactly. By default the size is the keychain body and the
  key hole tab sticks out beyond it; tick *Count the key hole tab in the size* to include it.
- **Layers** — color (preview and STEP), height, and how far the outline / base extend.
  *Base shape* is either *Follow the text* or a *Rectangle plate* that fills the whole width × height
  you set. *Solid base* fills the gaps between letters. *Blend inside corners* / *Round outside corners*
  put fillets on the base (default 1 mm blend where the key hole tab joins the body); the outline
  and text are never altered.
- **Key hole** — diameter, edge distance, and where it sits: quick Left / Top / Right / Bottom
  buttons, an *Around the edge* slider that slides it smoothly all the way around the keychain
  (180° = centered on the left), 20% / 50% / 80% height buttons, and *Sticks out* to pull it
  further from the text. *Nerd Shite* has
  the gap between the hole and the outline layer.
- **QR code on the back** — type a link or any text and a QR code is recessed into the back of the
  base (see below).
- **Preview** — live 3D view (Top / 3D / Back, drag to rotate, scroll to zoom).

## QR code on the back

A fourth body: a light QR plate (light modules plus a 2-module quiet zone) recessed flush into the
underside of the base. The dark modules are simply the base material, so it scans as dark-on-light —
keep the base color dark and the plate color light. Turn the keychain over like a page and it reads
correctly (the pattern is mirrored in the model).

- *Error correction* L / M / Q / H, *Size* (blank = the biggest square that fits), *Recess depth*
  (default 0.6 mm, so the plate is the first layers on the bed).
- The panel shows the module size. Under 0.8 mm won't print reliably on a 0.4 mm nozzle, and the app
  warns you: shorten the text, use lower error correction, make the keychain bigger, or use the
  *Rectangle plate* base, which leaves far more room than a base that follows the letters.
- Verified by decoding the rendered back view with an independent QR reader (URLs, Wi-Fi codes,
  accented and emoji text, at all four error-correction levels).

## Exports

- **STEP (3 or 4 bodies)** — bodies named *Base*, *Outline*, *Text* (and *QR*) with their colors. The letters are
  true curves and the key hole is an exact cylinder. The outline and base are polygons
  (0.015 mm tolerance), so files run a few MB. The export runs in a Web Worker and loads the CAD
  engine (23 MB raw, about 7 MB gzipped, then cached by the browser) only when you click Download.
- **STL (zipped)** — one watertight STL per body (3, or 4 with a QR code), in mm, ready to import as parts.

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
js/geometry.js            fit-to-size, outline/base offsets (Clipper), key hole placement, QR layout
js/qr.js                  QR encoding (qrcode-generator)
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

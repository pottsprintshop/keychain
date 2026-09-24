# Keychain Maker

A static, in-browser web app that generates a three-color keychain and exports it as
**STEP** (preferred) or **STL** for multi-color 3D printing. Nothing is uploaded — it all
runs in your browser.

Part of Potts Print Shop. Styled to the Potts Plays Games! style guide (`docs/STYLE_GUIDE.md` in that
repo): the blueprint theme, Lemon Milk for headings and emphasis, translucent bordered cards, and theme
colors only (no hardcoded colors below `:root` in `style.css`). Like the app's setup and score screens,
this is a screen you work in, so it uses minor grid lines only. Warnings use the theme's danger color.

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

- **Text** — multi-line (Enter starts a new line), alignment, line spacing, and a left/right and an
  up/down slider for each line, side by side. In the Top view you can also drag a line of text
  directly; the keychain re-fits to your size when you let go.
- **Font** — the bundled fonts (see `fonts/fonts.json`), or **Upload font…** (TTF / OTF / WOFF)
  for the current session only. Font, alignment and upload share a line. In *Potts Graffiti* two T's
  in a row (T and t are the same letter there) would run together into one long crossbar, so the
  second one drops a little and tucks left under the first, and the letters after it follow.
- **Size** (in the right column, under the preview) — width and height in inches or mm, **counting the
  key hole tab** by default, and **Text size**: the text as a share of the biggest that fits,
  independent of the other dimensions. On a plate shape the keychain keeps its width and height and the
  text gets more room around it; when the base follows the text, smaller text makes a smaller keychain.
  Under *Nerd Shite*: *Keep font proportions* fits the text inside the box and *Stretch text to fill*
  fills it exactly, and *Count the key hole tab in the size* can be turned off (the size is then the
  body, and the tab sticks out beyond it).
- **Layers** — color (preview and STEP), height, and how far each layer extends. Every layer has a
  red **minus** to take it away (the text, any outline, even the base; at least one stays) and a
  green **plus** adds an outline layer (up to three). A removed text or base row stays in the list,
  dimmed, with a plus to bring it back. Without a base there is nothing for the key hole, back or
  border to attach to, so those panels switch off. Under *Advanced*: *Blend inside corners* /
  *Round outside corners* put fillets on the base (default 1 mm blend where the key hole tab joins the
  body), and *Solid base* fills the gaps between letters; the outline and text are never altered.
- **Base shape** (above the preview) — *Follow the text* or a plate that fills the whole width × height
  you set: *Rectangle* (with a corner radius), *Round / oval* (a circle when width = height), *Hexagon*
  (points left and right, corners rounded by the same radius), *Dog bone* (a shaft with two knobs at
  each end; *Shaft thickness* sets how much room the text gets), *Sports tag* or *Name plate* (see
  below for both). On a plate the text is scaled to the biggest size that keeps the full outline + base
  margin inside the shape, and the key hole slides along the shape's edge. **Border** adds a raised rim
  of that width around the edge of the base (tab included), as tall as the layer above the base and
  colored like it; it is its own body in the exports. The dog bone starts with the key hole in the
  middle of its top edge, between the knobs, and a 0.8 mm border. Picking another shape moves these to
  that shape's usual values unless you've changed them yourself.
- **Sports tag** — a long, thin rectangle (4 × 0.75 in, key hole tab included) with a 0.8 mm border,
  meant for a last name and a sport icon: tennis racquet, baseball, football or soccer ball, drawn
  beside the text and as tall as it. An optional **Number** (a jersey number, up to six characters)
  goes after the name. The icons are
  built in (`js/icons.js`, made with Clipper cut-outs, nothing thinner than half a millimetre at 16 mm
  tall). The tag is set in **Impact**, which is bundled (`fonts/Impact.ttf`, supplied by the shop owner, who
  handles its license; see `fonts/README.md`). Picking the tag switches to it, and a Sports link that names
  no font uses it too.
- **Name plate** — a wide plate (8 × 2 in, no key ring by default — turn the hole back on under
  *Advanced* if you want one) set in **Kabel**, which is bundled (`fonts/Kabel.ttf`; see `fonts/README.md`).
  Text size starts at 75%, landing each line around 18 mm tall. Upload artwork (Artwork panel) and it
  becomes a logo pinned 12.7 mm (0.5 in) in from the right edge, at the **Size** slider's height (40 mm to
  start) — it shrinks on its own to clear the text and the plate's own edge if the slider or the logo's
  own shape would otherwise run it off the plate. **Drag the logo in the Top view** to move it anywhere
  (a *Reset position* button puts it back on the edge); a new upload starts back at the edge too. The text
  is also fitted a little narrower and shifted clear of the logo's side on its own, rather than sitting
  dead centre and fighting it for the same space (the per-line left/right sliders still nudge it further
  from there). The logo is unioned into the text layer (and so shares its color and the outline ring
  around it), the same way the Sports tag's icon does.
- **Key hole** — diameter, edge distance, gap to the outline, and quick Left / Top / Right / Bottom
  buttons. Under *Nerd Shite*: 20% / 50% / 80% height buttons, an *Around the edge* slider that slides
  it smoothly all the way around the keychain (180° = centered on the left), and *Sticks out* to pull
  it further from the text. Every slider's value is a box you can click and type into.
- **QR code on the back** — type a link or any text and a QR code is recessed into the back of the
  base (see below).
- **Preview** — live 3D view (Top / 3D / Back, drag to rotate, scroll to zoom).

## QR code on the back

A fourth body: just the code's modules, recessed flush into the underside of the base in a color that
contrasts with it — light on a dark base, dark on a light base (picked automatically from the base
color, or choose your own). No plate and no border: the base around the code is its quiet zone. Turn
the keychain over like a page and it reads correctly (the pattern is mirrored in the model).

- The code is as big as fits while staying *Edge margin* (default 1.2 mm) from the base's edge and
  the key hole, centered on the base body, so it grows and shrinks smoothly with the keychain.
- *Error correction* L / M / Q / H, *Size* (blank = the biggest that fits), *Recess depth*
  (default 0.6 mm, so the modules are the first layers on the bed).
- Light modules on a dark base are a negative image. iPhone Camera and most current Android scanners
  read that, but a few older apps don't. The *plate* option puts the code on a light plate with a
  border, so it reads the usual way.
- The panel shows the module size. Under 0.8 mm won't print reliably on a 0.4 mm nozzle, and the app
  warns you: shorten the text, use lower error correction, make the keychain bigger, or use the
  *Rectangle plate* base, which leaves far more room than a base that follows the letters (Round and
  Hexagon leave less; the dog bone leaves the least).
- Verified by decoding the rendered back view with an independent QR reader (URLs, Wi-Fi codes,
  accented and emoji text, at all four error-correction levels, plate and no plate).

## Artwork

Choose a PNG, JPG or SVG in the **Artwork** panel. It's flattened onto white, thresholded and traced
with ImageTracer (the same approach as img2cad), so holes are kept and curves stay curves. Threshold and
detail have a live thumbnail; under *Nerd Shite* are the options img2cad has: trace the light areas (invert),
**Sharpen corners** (on by default; keeps small squares square), **Smooth lines** (Chaikin corner-cutting, off
by default: it rounds jagged pixel edges into smooth lines, and rounds real corners too, so it is for
photo-ish or low-resolution pictures) and reduce noise. (This is its own copy of those ideas; img2cad and
this page don't share code.) On the front it goes above the text, below it,
or instead of it (with a height in lines of text and left/right and up/down nudges), and gets its outline
rings and base like text does. On the back use **Back → The artwork**. Artwork stays in your browser, so
it can't be part of a shared link.

## Outline rings and the back

**Outline rings** (1 to 3) stack outward from the text, each with its own width, height and color; the base
and the key hole clearance follow the outermost ring. **Back** puts nothing, a QR code, text, or the
artwork on the back — always mirrored, recessed flush, sized to fit, in a contrasting color.

## Shareable links

Every design setting is in the URL, so a link recreates the design and a reload restores it. **Copy link to
this design** copies it. Only values that differ from the defaults are included, keyed by the control's id,
so a hand- or machine-built link works too:

```
?text=Erich%0ADeutsch&font=Carter%20One&baseShape=plate&backKind=qr&qrText=https://example.com/erich
```

(`%0A` is a line break.) Any control id works as a parameter (`width`, `height`, `unit`, `rings`, `colorText`,
`holeAngle`, ...); ids that don't exist are ignored. Uploaded fonts and artwork stay in the browser, so they
aren't in a link.

## Batch

The **Batch** panel makes many keychains with the current design: one per line, `|` for a line break, and a
tab or comma then the QR (or back) text. Paste from a spreadsheet or load a CSV. You get one zip: a folder
of STL files per keychain (or one STEP / DXF / SVG file each) and a `summary.csv` with sizes, filament
grams, cost and any warnings. STEP takes about 10 seconds each, so it's limited to 30.

## Print check

Grams of filament per color and in total (density, cost per kg and a waste allowance are adjustable and
remembered in your browser), plus warnings: details thinner than the nozzle allows, gaps that will fill in,
tiny pieces, thin rings, a thin wall around the key hole, and heights that aren't layer multiples. **Show
thin spots** paints them red in the preview. Print time isn't estimated.

## Laser

**DXF (laser)** and **SVG (laser)** export every layer's outlines on their own layer/group, with the base
(and its key hole) as the cut line. The DXF follows img2cad's writer.

## Exports

- **STEP** — bodies named *Base*, *Outline* (each ring), *Text* (and the back) with their colors. The letters are
  true curves (even when lines of text overlap: each line is built alone and they are fused) and the key
  hole is an exact cylinder. The outline, base and back start as polygons (0.015 mm tolerance); runs of
  facets that sit on a circle are rebuilt as single arcs, and the file leaves out the redundant 2D
  surface-curve records, so a typical file is 2–5 MB instead of 10–25 MB. Every arc/exact build is checked
  (valid solid, volume within 1.5%) and falls back to plain polygons if it isn't. The export runs in a Web
  Worker and loads the CAD engine (23 MB raw, about 7 MB gzipped, then cached by the browser) only when you
  click Download.
- **STL (zipped)** — one watertight STL per body, in mm, ready to import as parts. With something recessed
  into the back, the base is one closed shell.

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
js/geometry.js            fit-to-size, outline rings/base (Clipper), key hole placement
js/clip.js                shared 2D helpers (Clipper unions, offsets, fillets)
js/back.js, js/qr.js      what goes on the back (QR / text / artwork)
js/art.js                 artwork tracing (ImageTracer) and placement
js/print.js               filament estimate and printability checks
js/state.js, js/batch.js  shareable links, batch runs
js/laser.js               DXF / SVG export
js/icons.js               built-in sports icons (Clipper cut-outs)
js/mesh.js                layer meshes and STL packaging
js/preview.js             three.js preview
js/exporters.js           binary STL, zip, download
js/step.js, step-worker.js  STEP export (OpenCascade via replicad) in a Web Worker
js/arcs.js                arc fitting for the STEP outlines (pure geometry, no CAD engine)
fonts/                    bundled fonts + fonts.json manifest
vendor/                   third-party libraries (see vendor/README.md)
```

## Self-test

Open `tests/index.html` (over http, e.g. `http://localhost:8000/tests/`) and press **Run all**. It builds
keychains and checks them: STL bodies watertight with the right volume across 36 configurations, the key hole
clearing the outline at every angle, the back content inside its margin and centered, QR codes that decode
(read from the rasterized back with an independent decoder), artwork tracing, shareable links, batch, laser
output, the print check, and STEP round trips read back through OpenCascade. Add `?run` to the URL to run on
load. Untick the STEP box to skip the slow ones.

## Adding a font

Drop the `.ttf` / `.otf` into `fonts/` and add a line to `fonts/fonts.json`:

```json
{ "name": "My Font", "file": "MyFont-Regular.ttf" }
```

Bundled: Carter One (SIL Open Font License), Lemon Milk (Bold, Medium), Potts Graffiti, Impact (see
`fonts/README.md`).

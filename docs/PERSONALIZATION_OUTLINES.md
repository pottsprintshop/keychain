# Numeric personalization outlines v1

This optional local CLI reuses `js/layout.js` and opentype.js. It does not load Replicad or change the browser coaster,
keychain, batch or export behavior. No fonts or layout source need to be copied to SpooderCAD.

Requires Node 18 or newer; no package installation or browser build is needed. The optional package manifest declares
the existing JavaScript ES modules for Node. Run `node scripts/personalization-outline.mjs` with one JSON object on stdin. Required fields:

```json
{
  "version": 1,
  "text": "SAMPLE HOUSE|GAME NIGHT",
  "font_id": "bangers",
  "font_sha256": "REPLACE_WITH_SHA256_OF_fonts/Bangers-Regular.ttf",
  "width_mm": 70,
  "height_mm": 30,
  "margin_mm": 2,
  "font_size_mm": 10,
  "minimum_font_size_mm": 2.5,
  "fit": "scale_to_fit_minimum",
  "align": "center",
  "vertical_align": "middle",
  "line_spacing": 1
}
```

Allowed IDs: `bangers`, `bungee`, `lilita-one`, `luckiest-guy`, `titan-one`. All reference files and original license
notices already checked into this repository. Do not silently add owner-supplied fonts to this registry. No font path,
URL or system font lookup is accepted. Expected SHA-256 must match actual font bytes.

`fixed` uses `font_size_mm` and rejects overflow. `scale_to_fit` chooses the largest uniform em; `scale_to_fit_minimum`
also enforces the minimum em. Minimum em is not literal glyph height or stroke width. Explicit newlines and pipes are
accepted, CRLF/lone CR normalized. Whitespace adjacent to pipes is trimmed as in batch input. Ordinary leading/trailing
spaces remain subject to existing advance-based line alignment; empty lines retain baseline indices. No word wrapping,
per-line overrides, clipping, stretching or truncation in this rectangular boundary. The existing shaped coaster fitter
and auto-wrap remain unchanged and are not replaced by this module.

Success: `{ok:true,result:{...}}`. Result includes local mm L/Q/C contours, implicit closure, line indices, exact Bézier
extrema bounds, effective em, nonzero fill rule, font/engine/outline SHA-256 and `manufacturing_validated:false`.
Region center is `(0,0)`, x right, y up. After original Keychain line layout, scale uniformly and anchor actual outlined
ink to the requested left/center/right and bottom/middle/top location inside symmetric margins. This adapts the existing
rectangular contour fit to explicit fixed/minimum policies and exact extrema; it is not shaped-coaster fit parity.

The engine digest covers layout.js, personalization.js, vendored opentype and the CLI. The outline digest hashes the
JSON.stringify result before adding `outline_sha256`. Pin engine digest in caller configuration. Neither hash signs an
approval or represents final native geometry. Receiver must bound output size, verify engine/font provenance and validate
native fit, solid validity, complementary material geometry and printability before manufacturing.

Failures: `{ok:false,error:CODE}`, exit 1, no text/path/exception echo. Maximum stdin 16 KiB, 512 Unicode codepoints,
8192 contours, 65536 segments. The line budget follows text/geometry complexity, not a fixed product line count.
Uncovered cmap characters fail instead of rendering .notdef. Supported Unicode is limited to each font's coverage and
the existing opentype shaper; complex-script typography is not newly guaranteed.

Tests: `node --test tests/personalization.test.mjs`. Existing browser suite: serve the repo and run `tests/` including STEP.
The CAD proposal and native receiver are tracked in `pottsprintshop/SpooderCAD/docs/PERSONALIZATION_REV_A.md`.
Saved Regions, native production validation, customer forms, acceptance, variant persistence and plate export are separate
increments. No production readiness is claimed by this outline interface.

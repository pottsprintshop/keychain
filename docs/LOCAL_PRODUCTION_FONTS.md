# Local production fonts and saved-provider compatibility

The optional `scripts/personalization-provider.mjs` gateway extends the existing
v2 personalization protocol. Node.js 18 or newer is required. Run:

```sh
node scripts/personalization-provider.mjs --catalog
node --test tests/personalization*.test.mjs
```

## LEMON MILK source, rights, and installation

LEMON MILK is MARSNEV's actual family, not a substitute or the separate LEMON MILK
Pro product. The inspected OTF name tables identify version 1.000, Regular and
Bold. The pinned identifiers, labels, filenames and SHA-256 values live in
`scripts/personalization-local-fonts.json`:

| Identifier | Label | SHA-256 |
| --- | --- | --- |
| `lemon-milk` | LEMON MILK | `de77a61b842958dc4efbefccb5532824f2d5efd738ff5fecc0d5d6eb6528896b` |
| `lemon-milk-bold` | LEMON MILK Bold | `07050370cce15356c771df836dc18e156b82209a3c6376ecd2ca846cf726c7be` |

Primary licensing sources checked October 29, 2026:

- [MARSNEV questions / commercial use and outline conversion](https://marsnev.com/questions/)
- [MARSNEV acquisition instructions](https://marsnev.com/buy-fonts/)
- [MARSNEV Donationware EULA, January 2025](https://marsnev.com/wp-content/uploads/2026/09/Marsnev-Donationware-EULA-%E2%80%94-2025.pdf)

The donationware EULA permits commercial installation/use after obtaining the
applicable rights, but prohibits redistributing or sublicensing font software.
The author's FAQ permits working with converted outlines. This implementation
therefore loads an operator's licensed local font, generates outlines locally,
and never serves or embeds the font binary in a variant or manufacturing package.
No font binaries are added by this change. Existing Bold/Medium assets in this
repository are not evidence of a redistribution grant and are not used as the
production gateway's default font source.

The operator must obtain appropriate rights directly with MARSNEV before
production use. The owner confirmed the required donation and personal local
application use during implementation. This does not grant redistribution rights
for the font software; the production gateway continues to load only local files.

Install the matching Regular OTF as `~/Library/Fonts/LEMONMILK-Regular.otf`.
Bold is optional and separately named `LEMONMILK-Bold.otf`. Operators may set
`KEYCHAIN_PERSONALIZATION_FONTS_DIR` to another private font directory. Requests
cannot specify font paths or directories. A newer/different font revision requires
an explicit registry update and new engine pin; do not rename another font.
Missing files and wrong hashes remain explicit catalog/request errors. No system
font discovery or silent substitutions occur. Binary size is bounded at 8 MiB.

## Why a gateway instead of changing the original provider

Existing saved CAD features pin the engine digest
`8f7929adfc8d671df8e770b67ea68fe4db48c424b42286ab531c29311c7ff6f9`.
That digest includes the original provider, package manifest, layout and geometry
modules. Changing those files merely to add a font would invalidate saved masters
and archived variants. They remain unchanged here.

The gateway delegates original-engine requests directly to the original CLI,
returning identical output bytes. Its own engine digest includes the legacy
engine, gateway bytes and local-font registry bytes. It does not depend on local
paths or which optional fonts are installed. New requests using existing fonts
still delegate layout to the original provider; requests using LEMON MILK call the
same `parseFont`, `layoutPersonalization`, CFF outlines and morphology helpers.
There is no second layout engine. The small printability orchestration is repeated
because refactoring the original hashed source would invalidate existing pins;
its stroke/gap/island thresholds and exact-curve output remain unchanged.

The catalog advertises supported engine digests per font: old fonts support both
engines; LEMON MILK supports the gateway engine only. Font identifiers and digests
remain pinned in each saved definition and variant. A consumer must check support
per font rather than comparing only the catalog's newest engine digest.

## Validation

On Node 26.9.0: `node --test tests/personalization*.test.mjs` — 17 passed,
zero skipped. Includes actual locally installed Regular CFF curves, multiline
newline/pipe parity, repeated hashes, missing glyphs, wrong/missing font bytes,
separate Bold, and byte-identical legacy output for all five existing fonts.
The Regular test skips on machines lacking the pinned local licensed font; CI
continues to exercise explicit unavailability and the existing font catalog.

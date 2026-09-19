// QR code encoding (qrcode-generator). Returns the module grid; geometry.js turns it into a body.

import qrcode from '../vendor/qrcode.mjs';

// Encode non-ASCII text (accents, emoji, other scripts) as UTF-8 so phones read it back correctly.
qrcode.stringToBytes = (text) => Array.from(new TextEncoder().encode(text));

// -> { n, isDark(row, col) }, or throws if the text doesn't fit in any QR version.
export function makeQr(text, ecc = 'M') {
  const qr = qrcode(0, ecc); // 0 = pick the smallest version that fits
  qr.addData(text, 'Byte');
  qr.make();
  return { n: qr.getModuleCount(), isDark: (r, c) => qr.isDark(r, c) };
}

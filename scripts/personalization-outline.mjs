// One bounded JSON request on stdin, one JSON response on stdout. No request paths.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseFont } from '../js/layout.js';
import { layoutPersonalization, validateLayoutRequest, PersonalizationError } from '../js/personalization.js';

const fonts = {
  bangers: ['Bangers-Regular.ttf', 'bangers-OFL.txt'],
  bungee: ['Bungee-Regular.ttf', 'bungee-OFL.txt'],
  'lilita-one': ['LilitaOne-Regular.ttf', 'lilitaone-OFL.txt'],
  'luckiest-guy': ['LuckiestGuy-Regular.ttf', 'luckiestguy-LICENSE.txt'],
  'titan-one': ['TitanOne-Regular.ttf', 'titanone-OFL.txt'],
};
const sha = (b) => createHash('sha256').update(b).digest('hex');
try {
  if (process.argv.length !== 2) throw new PersonalizationError('invalid_arguments');
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16384) throw new PersonalizationError('request_budget');
    chunks.push(chunk);
  }
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  validateLayoutRequest(request);
  const entry = fonts[request.font_id];
  if (!entry || !Object.hasOwn(fonts, request.font_id)) throw new PersonalizationError('font_unavailable');
  const data = await readFile(new URL(`../fonts/${entry[0]}`, import.meta.url));
  await readFile(new URL(`../fonts/${entry[1]}`, import.meta.url));
  if (sha(data) !== request.font_sha256) throw new PersonalizationError('font_revision_mismatch');
  const font = parseFont(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const result = layoutPersonalization(font, request);
  const sources = await Promise.all(['../js/layout.js', '../js/personalization.js', '../vendor/opentype.module.js', './personalization-outline.mjs']
    .map(async (p) => [p, sha(await readFile(new URL(p, import.meta.url)))]));
  result.engine_sha256 = sha(JSON.stringify(sources));
  result.outline_sha256 = sha(JSON.stringify(result));
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  // Never echo request text, arbitrary exception messages, or local paths.
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof PersonalizationError ? error.code : 'outline_generation_failed' }));
  process.exitCode = 1;
}

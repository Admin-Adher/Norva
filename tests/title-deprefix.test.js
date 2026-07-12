'use strict';

// Leading provider-prefix stripping for VOD titles. Providers lead their titles with a
// region/language/quality tag ("FR - ", "AR-SUBS - ", "DK ▎ ", and the digit-led quality
// prefixes the "Strng IPTV 8K" panel emits: "4K-AR - ", "4K-D+ - ", "8K - ", "8K-FR - ").
// The de-prefix regex lives byte-identical in 5 spots (3 in the edge projection
// vod-title-projection.ts, 2 here in mediaUtils.js); these assertions guard the frontend
// pair against drift. mediaUtils.js is a browser IIFE; load it with a shim.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'utils', 'mediaUtils.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const M = win.MediaUtils;

test('cleanReleaseName strips digit-led quality prefixes (Strng IPTV 8K)', () => {
  const cases = [
    ['4K-AR - La Bête', 'La Bête'],
    ['4K-D+ - The Muppet Show', 'The Muppet Show'], // "D+" (Disney+) needs '+' in the suffix class
    ['8K - Transformers One', 'Transformers One'],
    ['8K-FR - Inception', 'Inception'],
    ['4K-MULTI - Avatar', 'Avatar'],
    ['2160P-VF - Dune', 'Dune'],
    ['1440P-VF - Le Roi Lion', 'Le Roi Lion'],
    ['360P-AR - Old Film', 'Old Film'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(M.cleanReleaseName(input), expected, input);
  }
});

test('cleanReleaseName still strips alpha-led provider prefixes', () => {
  assert.strictEqual(M.cleanReleaseName('FR - Le Roi Lion'), 'Le Roi Lion');
  assert.strictEqual(M.cleanReleaseName('AR-SUBS - The Hunger Games'), 'The Hunger Games');
  assert.strictEqual(M.cleanReleaseName('DK ▎ A Hijacking'), 'A Hijacking');
});

test('cleanReleaseName never mangles a real digit/quality-looking title', () => {
  const keep = [
    '007 - Die Another Day',
    '1917 - La Révolution Russe',
    'X-Men',
    '8 Mile',                                   // "8 " has no K/P → not a quality token
    '4Kids - Show',                             // "4K" not followed by a separator
    'Fantastic 4 - Rise of the Silver Surfer',
    'WALL-E',
  ];
  for (const input of keep) {
    assert.strictEqual(M.cleanReleaseName(input), input, input);
  }
});

test('normalizeTitle collapses quality/region variants onto one dedup key', () => {
  const key = M.normalizeTitle('La Bête');
  assert.strictEqual(M.normalizeTitle('4K-AR - La Bête'), key);
  assert.strictEqual(M.normalizeTitle('8K-FR - La Bête'), key);
  assert.strictEqual(M.normalizeTitle('FR - La Bête'), key);
});

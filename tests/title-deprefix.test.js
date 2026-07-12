'use strict';

// Leading provider-prefix + trailing-year stripping for VOD titles. Providers lead their titles
// with a region/language/quality/collection tag ("FR - ", "AR-SUBS - ", "DK ▎ ", and the digit-led
// ones the "Strng IPTV 8K" panel emits: "4K-AR - ", "8K-FR - ", "3D-DE - " (whole 3D collection),
// "007 - " (James Bond)) and often append a "(YEAR)" that the card already shows separately. The
// de-prefix regex lives byte-identical in 5 spots (3 in the edge projection vod-title-projection.ts,
// 2 here in mediaUtils.js); these assertions guard the frontend pair against drift.
// mediaUtils.js is a browser IIFE; load it with a shim.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'utils', 'mediaUtils.js'), 'utf8');
const win = {};
// eslint-disable-next-line no-new-func
new Function('window', src)(win);
const M = win.MediaUtils;

test('cleanReleaseName strips digit-led quality/collection prefixes (Strng IPTV 8K)', () => {
  const cases = [
    ['4K-AR - La Bête', 'La Bête'],
    ['4K-D+ - The Muppet Show', 'The Muppet Show'], // "D+" (Disney+) needs '+' in the suffix class
    ['8K - Transformers One', 'Transformers One'],
    ['8K-FR - Inception', 'Inception'],
    ['2160P-VF - Dune', 'Dune'],
    ['1440P-VF - Le Roi Lion', 'Le Roi Lion'],
    ['3D-DE - Ant-Man', 'Ant-Man'],                 // 3D German collection
    ['3D-DE - Pacific Rim', 'Pacific Rim'],
    ['007 - Skyfall', 'Skyfall'],                   // James Bond collection
    ['007 - Thunderball', 'Thunderball'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(M.cleanReleaseName(input), expected, input);
  }
});

test('cleanReleaseName drops a redundant trailing (YEAR) but keeps numeric titles', () => {
  assert.strictEqual(M.cleanReleaseName('007 - Thunderball (1965)'), 'Thunderball');
  assert.strictEqual(M.cleanReleaseName('3D-DE - Piranha 2 (2012)'), 'Piranha 2');
  assert.strictEqual(M.cleanReleaseName('3D-DE - 300: Rise of an Empire (2014)'), '300: Rise of an Empire');
  assert.strictEqual(M.cleanReleaseName('1917 (2019)'), '1917');       // year in parens dropped, title kept
  assert.strictEqual(M.cleanReleaseName('2012 (2009)'), '2012');       // "2012" the film keeps its number
  assert.strictEqual(M.cleanReleaseName('Blade Runner 2049'), 'Blade Runner 2049'); // bare number never touched
});

test('cleanReleaseName still strips alpha-led provider prefixes', () => {
  assert.strictEqual(M.cleanReleaseName('FR - Le Roi Lion'), 'Le Roi Lion');
  assert.strictEqual(M.cleanReleaseName('AR-SUBS - The Hunger Games'), 'The Hunger Games');
  assert.strictEqual(M.cleanReleaseName('DK ▎ A Hijacking'), 'A Hijacking');
});

test('cleanReleaseName never mangles a real title', () => {
  const keep = [
    '1917 - La Révolution Russe',                   // leading "1917 -" is a real title, not a prefix
    'X-Men',
    '8 Mile',
    '4Kids - Show',
    'Fantastic 4 - Rise of the Silver Surfer',
    'WALL-E',
    'The Matrix',
  ];
  for (const input of keep) {
    assert.strictEqual(M.cleanReleaseName(input), input, input);
  }
});

test('normalizeTitle collapses quality/region/collection variants onto one dedup key', () => {
  const key = M.normalizeTitle('Skyfall');
  assert.strictEqual(M.normalizeTitle('007 - Skyfall'), key);
  assert.strictEqual(M.normalizeTitle('4K-AR - Skyfall'), key);
  assert.strictEqual(M.normalizeTitle('3D-DE - Skyfall'), key);
});

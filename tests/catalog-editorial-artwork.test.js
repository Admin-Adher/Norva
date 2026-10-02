const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = fs.readFileSync('supabase/functions/norva-catalog/index.ts', 'utf8');
const helpers = source.slice(source.indexOf('function tmdbImageUrl('), source.indexOf('function titleGenres('));
assert.ok(helpers.startsWith('function tmdbImageUrl(') && helpers.includes('function preferSecureImage('));
const moduleFixture = { exports: {} };
vm.runInNewContext(transformSync(helpers + '\nexport {tmdbImageUrl, preferSecureImage};',
  { loader: 'ts', format: 'cjs' }).code, {
  module: moduleFixture, exports: moduleFixture.exports,
  stringOrNull: value => typeof value === 'string' && value.trim() ? value.trim() : null,
});
const { tmdbImageUrl, preferSecureImage } = moduleFixture.exports;
const valid = 'https://image.tmdb.org/t/p/w500/real-poster.jpg';

test('malformed stored TMDB endpoint cannot hide a verified poster', () => {
  assert.equal(preferSecureImage('https://image.tmdb.org/t/p/w500', valid), valid);
  assert.equal(preferSecureImage('https://image.tmdb.org/t/p/w500/', valid), valid);
});
test('malformed TMDB URL without known artwork becomes a missing image', () => {
  assert.equal(preferSecureImage('https://image.tmdb.org/t/p/w500', null), null);
});
test('localized HTTPS provider artwork and valid TMDB artwork remain usable', () => {
  assert.equal(preferSecureImage('https://provider.example/pt/poster.jpg', valid), 'https://provider.example/pt/poster.jpg');
  assert.equal(preferSecureImage(valid, null), valid);
  const cropped = 'https://image.tmdb.org/t/p/w600_and_h900_bestv2/real-poster.jpg';
  assert.equal(preferSecureImage(cropped, null), cropped);
});
test('HTTP provider fallback is preserved when no verified replacement exists', () => {
  assert.equal(preferSecureImage('http://provider.example/poster.jpg', valid), valid);
  assert.equal(preferSecureImage('http://provider.example/poster.jpg', null), 'http://provider.example/poster.jpg');
});
test('TMDB paths must contain an image filename', () => {
  assert.equal(tmdbImageUrl('/real-poster.jpg', 'w500'), valid);
  assert.equal(tmdbImageUrl('', 'w500'), null);
  assert.equal(tmdbImageUrl('/', 'w500'), null);
  assert.equal(tmdbImageUrl('https://other.example/a.jpg', 'w500'), null);
});

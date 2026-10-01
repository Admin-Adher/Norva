'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
const fn = api.slice(api.indexOf('    function normalizeHomeRailVariant('), api.indexOf('    function normalizeHomeRailItem('));
const context = { window: {}, localSourceId: id => 'local-' + id, firstUsefulTitle: (...values) => values.find(Boolean) };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8'), context);
const normalize = vm.runInContext(fn + '\nnormalizeHomeRailVariant', context);
const input = { id: 'variant', source_id: 'source', external_id: 'series',
  audio_languages: ['es'], audio_languages_scope: 'series', audio_languages_observed: true,
  audio_language_validation_status: 'probed_union',
  subtitle_languages: ['en'], subtitle_languages_scope: 'series', subtitle_languages_observed: true };

test('Home preserves series language sets and their scope through its API adapter', () => {
  const variant = normalize(input, { type: 'series', title: 'Peaky Blinders' });
  assert.deepEqual(Array.from(variant.audioLanguages), ['es']);
  assert.equal(variant.audioLanguagesScope, 'series');
  assert.equal(variant.subtitleLanguagesScope, 'series');
  assert.equal(variant.audioTracks, null);
  assert.equal(variant.subtitleTracks, null);
  assert.equal(context.window.MediaUtils.versionLanguageBadge(variant), 'Spanish');
});

test('Home does not apply a series union to an episode or movie file', () => {
  for (const type of ['movie', 'episode']) {
    const variant = normalize(input, { type, title: 'Title' });
    assert.equal(variant.audioLanguages, null);
    assert.equal(variant.subtitleLanguages, null);
    assert.equal(variant.audioTracks, null);
  }
  const file = normalize({ ...input, audio_languages_scope: 'file' }, { type: 'movie', title: 'Title' });
  assert.deepEqual(Array.from(file.audioLanguages), ['es']);
  assert.equal(file.audioLanguagesScope, 'file');
});

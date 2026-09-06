'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const load = name => import(pathToFileURL(path.join(root, 'supabase/functions/_shared', name)));
const item = group => ({
  external_id: 'norva-selection:movie:' + 'a'.repeat(64),
  metadata: { selectionRevision: 'selection-vod-20260906-v1', discoveryFeed: 'babuperumana-vod', selectionVodGroup: group },
});

test('only explicit curated supplier language categories produce declarations', async () => {
  const { selectionProviderAudioLanguages: languages, providerAudioFacet } = await load('selection-provider-languages.mjs');
  for (const [name, code] of Object.entries({ Telugu: 'te', Tamil: 'ta', Malayalam: 'ml', Hindi: 'hi', Kannada: 'kn', English: 'en' })) {
    assert.deepEqual(languages(item(`Movies / ${name} / 2026`)), [code]);
    assert.equal(providerAudioFacet(`provider-${code}`), code);
  }
  for (const group of ['Comedy', 'Movies / Hindi subtitles / 2026', 'Movies / French / 2026', 'Hindi', '<script>Hindi</script>']) {
    assert.deepEqual(languages(item(group)), []);
  }
  assert.deepEqual(languages({ ...item('Movies / Hindi / 2026'), external_id: 'other-provider-file' }), []);
  assert.deepEqual(languages({ title: 'Hindi', metadata: { original_language: 'hi' } }), []);
  assert.equal(providerAudioFacet('provider-fr'), null);
  assert.equal(providerAudioFacet('hi'), null);
});

test('catalogue declarations survive repeated sanitization without becoming track evidence', async () => {
  const { sanitizeCatalogMediaItem } = await load('catalog-public-view.mjs');
  const once = sanitizeCatalogMediaItem({ ...item('Movies / Hindi / 2026'), metadata: { ...item('Movies / Hindi / 2026').metadata, password: 'private' } });
  const twice = sanitizeCatalogMediaItem(once);
  assert.deepEqual(twice.providerAudioLanguages, ['hi']);
  assert.equal(twice.providerAudioLanguageStatus, 'provider_declared');
  assert.equal(twice.audioTracks, undefined);
  assert.equal(twice.audioLanguages, undefined);
  assert.equal(twice.audioLanguageValidationStatus, undefined);
  assert.equal(twice.subtitleLanguages, undefined);
  assert.ok(!JSON.stringify(twice).includes('private'));
  assert.ok(!JSON.stringify(twice).includes('selectionVodGroup'));
});

test('provider badge is provisional and an observed language supersedes it', () => {
  const context = { window: {}, Intl, console };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8'), context);
  const media = context.window.MediaUtils;
  const film = { providerAudioLanguages: ['hi'], providerAudioLanguageStatus: 'provider_declared', audioLanguageValidationStatus: 'not_analyzed' };
  assert.equal(media.versionLanguageBadge(film), 'Hindi · provider');
  assert.equal(media.providerAudioStatusLabel(), 'Language announced by the provider');
  assert.equal(media.analyzeLanguageCompatibility(film, { preferredAudioLanguage: 'hi' }).audio.state, 'unknown');
  const observed = { ...film, audioTracksScope: 'file', audioLanguageValidationStatus: 'probed', audioTracks: [{ index: 1, lang: 'en' }] };
  assert.equal(media.providerAudioLanguages(observed).length, 0);
  assert.doesNotMatch(media.versionLanguageBadge(observed), /Hindi|provider/);
  assert.doesNotMatch(media.versionDescriptor(film).headline, /confirmed|verified/i);
  assert.match(media.versionDescriptor(film).meta, /Language announced by the provider/);
});

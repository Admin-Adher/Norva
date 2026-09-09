'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const root = path.join(__dirname, '..');
const load = name => import(pathToFileURL(path.join(root, 'supabase/functions/_shared', name)));
const url = name => 'https://media.example/bucket/' + encodeURIComponent(name);

test('explicit filename suffixes decode to declarations without guessing a title language', async () => {
  const {filenameAudioLanguage: parse} = await load('selection-filename-audio.mjs');
  for (const [name, language] of [
    ['Film Español.mp4', 'es'], ['Film Espanol_2.mp4', 'es'], ['Film Español Latino.mp4', 'es'],
    ['Film.2023.1080p.Latino.mp4', 'es'], ['Film [ES].mp4', 'es'], ['Film [PT-BR].mkv', 'pt'],
    ['Film Português.mp4', 'pt'], ['Film - French.mkv', 'fr'], ['Film.VF.mp4', 'fr'],
    ['Film [English].mkv', 'en'], ['Film [Hindi].mp4', 'hi'],
  ]) assert.equal(parse(url(name)), language, name);
  for (const name of ['Calabozos y Dragones.mp4', 'Johnny English.mp4', 'It.mp4',
    'Film Subtitulada Español.mp4', 'Film SUB FR.mp4', 'Film English subtitles.mp4',
    'Film VOSTFR.mp4', 'Film.Legendado.Portugues.mp4', 'Film.Multi.French.mp4',
    'Film [EN] [FR].mp4', 'Film.English.French.mp4', 'Film [FR].srt', 'Español.mp4']) {
    assert.equal(parse(url(name)), null, name);
  }
  assert.equal(parse('https://media.example/Español/film.mp4?audio=es'), null);
  assert.equal(parse('https://media.example/film%ZZ%20Español.mp4'), null);
  assert.equal(parse('https://user:secret@media.example/Film.Español.mp4'), null);
});

test('Calabozos uses its exact audited filename and survives public sanitization as a hint', async () => {
  const {SELECTION_QUALIFIED_VOD} = await load('selection-qualified-vod.mjs');
  const {selectionFilenameAudioDeclaration, storedFilenameAudioLanguage} = await load('selection-filename-audio.mjs');
  const {selectionVodIdentity, selectionVodExternalId} = await load('selection-vod.mjs');
  const {sanitizeCatalogMediaItem} = await load('catalog-public-view.mjs');
  const entry = SELECTION_QUALIFIED_VOD.find(e => e.title.startsWith('Calabozos y Dragones:'));
  const declaration = await selectionFilenameAudioDeclaration(entry);
  assert.equal(declaration.language, 'es');
  assert.equal(declaration.urlSha256, entry.validation.urlSha256);
  assert.equal(await selectionFilenameAudioDeclaration({...entry, url:entry.url + '?changed=1'}), null);
  assert.equal(await selectionFilenameAudioDeclaration({...entry, feedId:'unreviewed'}), null);
  const external_id = selectionVodExternalId(await selectionVodIdentity(entry.feedId, entry));
  const metadata = {selectionRevision:'selection-vod-20260906-v1', discoveryFeed:entry.feedId,
    selectionPlaybackValidation:entry.validation, selectionFilenameAudio:declaration};
  assert.equal(storedFilenameAudioLanguage(metadata, external_id), 'es');
  assert.equal(storedFilenameAudioLanguage({...metadata, selectionPlaybackValidation:{urlSha256:'b'.repeat(64)}}, external_id), null);
  assert.equal(storedFilenameAudioLanguage(metadata, 'arbitrary-file'), null);
  assert.equal(storedFilenameAudioLanguage(metadata, external_id.replace(':movie:', ':series:')), null);
  const once = sanitizeCatalogMediaItem({external_id, metadata});
  const twice = sanitizeCatalogMediaItem(once);
  assert.deepEqual(twice.providerAudioLanguages, ['es']);
  assert.equal(twice.providerAudioLanguageStatus, 'provider_declared');
  assert.equal(twice.audioTracks, undefined);
  assert.equal(twice.subtitleLanguages, undefined);
  assert.equal(twice.audioLanguageValidationStatus, undefined);
  assert.ok(!JSON.stringify(twice).includes('urlSha256'));
  assert.ok(!JSON.stringify(twice).includes('selectionFilenameAudio'));
});

test('filename hint renders before analysis but never invents an observed audio track', async () => {
  const context = {window:{}, Intl, console};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8'), context);
  const media = context.window.MediaUtils;
  const film = {providerAudioLanguages:['es'], providerAudioLanguageStatus:'provider_declared', audioLanguageValidationStatus:'not_analyzed'};
  for (const state of ['queued', 'running', 'retry_wait', 'completed', undefined]) {
    assert.equal(media.versionLanguageBadge({...film, audioLanguageValidationJobStatus:state}), 'Spanish');
  }
  assert.equal(media.analyzeLanguageCompatibility(film, {preferredAudioLanguage:'es'}).audio.state, 'unknown');
  const observed = {...film, audioLanguageValidationStatus:'probed', audioTracksScope:'file', audioTracks:[{index:1, lang:'en'}]};
  assert.equal(media.versionLanguageBadge(observed), 'English');
  assert.equal(media.providerAudioLanguages(observed).length, 0);
});

test('new imports preserve filename declarations separately from track metadata', async () => {
  const {fetchSelectionVod} = await load('selection-vod.mjs');
  const result = await fetchSelectionVod({fetchPlaylist:async () => ({response:{ok:false}})});
  const film = result.items.find(e => e.fields.title.startsWith('Calabozos y Dragones:')).fields;
  assert.equal(film.metadata.selectionFilenameAudio.language, 'es');
  assert.ok(!film.metadata.audioLanguages?.includes('es'));
  assert.ok(film.metadata.codecProfile.audioTracks.every(t => !t.language));
});

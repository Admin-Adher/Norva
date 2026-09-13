'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.join(__dirname, '..');
const load = name => import(pathToFileURL(path.join(root, 'supabase/functions/_shared', name)));
const mediaUrl = name => 'https://media.example/bucket/' + encodeURIComponent(name);

test('repackaged media preserves one explicit terminal filename declaration', async () => {
  const {filenameAudioLanguage: parse} = await load('selection-filename-audio.mjs');
  for (const [name, language] of [
    ['Cruella.2021.1080p.Latino.mkv.mp4 at Streamtape.com.mp4', 'es'],
    ['Film.Latino.mkv.mp4', 'es'],
    ['Film.Latino.mkv.mp4.mp4', 'es'],
    ['Film [ES].mkv.mp4', 'es'],
    ['Film - French.mkv.mp4', 'fr'],
    ['Film Português_2.mkv.mp4', 'pt'],
  ]) assert.equal(parse(mediaUrl(name)), language, name);
});

test('repackaging cannot promote mixed declarations, page labels or title words', async () => {
  const {filenameAudioLanguage: parse} = await load('selection-filename-audio.mjs');
  for (const name of [
    'Ver Film Online Castellano Latino Subtitulada HD - HDFull.mp4',
    'Ver Film Online Castellano Latino Subtitulada.Latino.mkv.mp4 at Streamtape.com.mp4',
    'Film.CastellanoLatinoSubtitulada.mkv.mp4 at Streamtape.com.mp4',
    'Film.CastellanoLatinoSubtitulada.Latino.mkv.mp4 at Streamtape.com.mp4',
    'Film.Latino.English.mkv.mp4', 'Film.Hindi.Latino.mkv.mp4',
    'Film.[ES].[EN].mkv.mp4', 'Film.Latino.Multi.mkv.mp4',
    'Film.Latino.SUB.mkv.mp4 at Streamtape.com.mp4',
    'Film.Latino.mkv.mp4.mp4.mp4',
    'Film.Latino at Streamtape.com.mp4',
    'Film.Latino.mkv at Unreviewed.example.mp4',
    'Film.Latino.mkv.mp4 at Streamtape.com.French.mp4',
    'Johnny English.mkv.mp4', 'It.mkv.mp4', 'Latino.mkv.mp4',
    'Film.Latino.srt.mp4', 'Film.Latino.mkv.mp4.txt',
  ]) assert.equal(parse(mediaUrl(name)), null, name);
});

test('only the decoded media basename may declare a language', async () => {
  const {filenameAudioLanguage: parse} = await load('selection-filename-audio.mjs');
  assert.equal(parse('https://media.example/Latino/Film.mkv.mp4?audio=es#French'), null);
  assert.equal(parse('https://media.example/Film.Latino.mkv.mp4%2Funtagged.mp4'), null);
  assert.equal(parse('https://media.example/folder%2FFilm.Latino.mkv.mp4'), 'es');
  assert.equal(parse('http://media.example/Film.Latino.mkv.mp4'), null);
  assert.equal(parse('https://user:password@media.example/Film.Latino.mkv.mp4'), null);
  assert.equal(parse('https://media.example/Film%ZZ.Latino.mkv.mp4'), null);
});

test('Cruella exact manifest URL produces only a hash-bound catalogue hint', async () => {
  const {SELECTION_QUALIFIED_VOD} = await load('selection-qualified-vod.mjs');
  const {selectionFilenameAudioDeclaration, storedFilenameAudioLanguage} = await load('selection-filename-audio.mjs');
  const {selectionVodIdentity, selectionVodExternalId} = await load('selection-vod.mjs');
  const {sanitizeCatalogMediaItem} = await load('catalog-public-view.mjs');
  const entry = SELECTION_QUALIFIED_VOD.find(item => item.title === 'Cruella (2021)');
  assert.ok(entry);
  const declaration = await selectionFilenameAudioDeclaration(entry);
  assert.equal(declaration?.language, 'es');
  assert.equal(declaration?.urlSha256, entry.validation.urlSha256);
  assert.equal(await selectionFilenameAudioDeclaration({...entry, url:entry.url + '?changed=1'}), null);
  assert.equal(await selectionFilenameAudioDeclaration({...entry, validation:{...entry.validation, urlSha256:'a'.repeat(64)}}), null);
  assert.equal(await selectionFilenameAudioDeclaration({...entry, feedId:'unreviewed'}), null);
  const external_id = selectionVodExternalId(await selectionVodIdentity(entry.feedId, entry));
  const metadata = {selectionRevision:'selection-vod-20260906-v1', discoveryFeed:entry.feedId,
    selectionPlaybackValidation:entry.validation, selectionFilenameAudio:declaration};
  assert.equal(storedFilenameAudioLanguage(metadata, external_id), 'es');
  assert.equal(storedFilenameAudioLanguage({...metadata, selectionRevision:'changed'}, external_id), null);
  assert.equal(storedFilenameAudioLanguage({...metadata, discoveryFeed:'unreviewed'}, external_id), null);
  assert.equal(storedFilenameAudioLanguage({...metadata, selectionPlaybackValidation:{urlSha256:'b'.repeat(64)}}, external_id), null);
  assert.equal(storedFilenameAudioLanguage(metadata, external_id.replace(':movie:', ':series:')), null);
  const once = sanitizeCatalogMediaItem({external_id, metadata});
  const twice = sanitizeCatalogMediaItem(once);
  assert.deepEqual(twice.providerAudioLanguages, ['es']);
  assert.equal(twice.providerAudioLanguageStatus, 'provider_declared');
  assert.equal(twice.audioTracks, undefined);
  assert.equal(twice.audioLanguageValidationStatus, undefined);
  assert.equal(twice.subtitleLanguages, undefined);
  assert.ok(!JSON.stringify(twice).includes('urlSha256'));
  assert.ok(!JSON.stringify(twice).includes('selectionFilenameAudio'));
});

test('audited page-title filenames stay unknown after the parser change', async () => {
  const {SELECTION_QUALIFIED_VOD} = await load('selection-qualified-vod.mjs');
  const {filenameAudioLanguage: parse} = await load('selection-filename-audio.mjs');
  const ambiguous = SELECTION_QUALIFIED_VOD.filter(entry => {
    const filename = decodeURIComponent(new URL(entry.url).pathname).split('/').pop();
    return /castellano.*latino.*subtit/i.test(filename);
  });
  assert.ok(ambiguous.length >= 31);
  for (const entry of ambiguous) assert.equal(parse(entry.url), null, entry.title);
});

test('new Selection imports preserve Cruella declaration without changing observed audio', async () => {
  const {fetchSelectionVod} = await load('selection-vod.mjs');
  const result = await fetchSelectionVod({fetchPlaylist:async () => ({response:{ok:false}})});
  const film = result.items.find(item => item.fields.title === 'Cruella (2021)')?.fields;
  assert.ok(film);
  assert.equal(film.metadata.selectionFilenameAudio.language, 'es');
  assert.ok(!film.metadata.audioLanguages?.includes('es'));
  assert.ok(film.metadata.codecProfile.audioTracks.every(track => !track.language && !track.lang));
});

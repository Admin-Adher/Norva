'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const load = name => import('../supabase/functions/_shared/' + name);
const v = (id = 'variant', source = 'source', owner = 'owner') => ({
  id, source_id: source, user_id: owner, item_type: 'movie', external_id: 'file', media_item_id: 'media',
});
const proof = (overrides = {}) => ({
  variant_id: 'variant', source_id: 'source', user_id: 'owner', item_type: 'movie',
  language: 'es', track_index: 1, method: 'owner-listening-v1', ...overrides,
});

test('listening testimony is owner/file/track scoped and stays separate from technical proof', async () => {
  const { attachOwnedHumanLanguageConfirmations: attach, humanAudioFields } = await load('owned-human-language-confirmations.mjs');
  const variants = [v(), v('foreign', 'source', 'other')];
  await attach({ rpc: async (name, args) => {
    assert.equal(name, 'cloud_catalog_owned_movie_human_audio_confirmations_batch');
    assert.deepEqual(args, { p_user_id: 'owner', p_source_id: 'source', p_variant_ids: ['variant'] });
    return { data: [proof(), proof({ variant_id: 'foreign' }), proof({ user_id: 'other', language: 'de' }),
      proof({ source_id: 'elsewhere', language: 'fr' }), proof({ item_type: 'series', language: 'pt' }),
      proof({ method: 'whisper-strict-consensus-v4', language: 'it' }), proof({ track_index: -1 }),
      proof({ track_index: '1' }), proof({ language: 'und' }), proof({ language: '<script>' })] };
  } }, variants, 'owner');
  const published = humanAudioFields(variants[0]);
  assert.deepEqual(published.humanAudioLanguages, ['es']);
  assert.deepEqual(published.humanAudioTrackLanguages, [{ index: 1, language: 'es' }]);
  assert.equal(published.humanAudioLanguageStatus, 'human_confirmed');
  assert.equal(published.humanAudioLanguageScope, 'file');
  assert.equal(variants[1].__owned_human_audio_tracks, undefined);
  assert.equal(variants[0].audio_languages, undefined);
  assert.equal(variants[0].provider_audio_languages, undefined);
  assert.equal(variants[0].audio_language_verified_at, undefined);
});

test('batching is bounded before the RPC and keeps sources apart', async () => {
  const { attachOwnedHumanLanguageConfirmations: attach } = await load('owned-human-language-confirmations.mjs');
  const variants = Array.from({ length: 201 }, (_, index) => v(String(index)));
  variants.push(v('second', 'source2'), { ...v('series'), item_type: 'series' });
  const calls = [];
  await attach({ rpc: async (_, args) => {
    calls.push([args.p_source_id, args.p_variant_ids.length]);
    return { data: args.p_variant_ids.map(id => proof({ variant_id: id, source_id: args.p_source_id })) };
  } }, variants, 'owner');
  assert.deepEqual(calls, [['source', 200], ['source', 1], ['source2', 1]]);
  assert.equal(variants.at(-1).__owned_human_audio_tracks, undefined);
});

test('partial RPC failure never publishes a partial confirmation set', async () => {
  const { attachOwnedHumanLanguageConfirmations: attach } = await load('owned-human-language-confirmations.mjs');
  const variants = [v(), v('second', 'source2')];
  await assert.rejects(() => attach({ rpc: async (_, args) => args.p_source_id === 'source'
    ? { data: [proof()] } : { error: { message: 'private database failure' } } }, variants, 'owner'),
  /Owned listening confirmations unavailable/);
  assert.ok(variants.every(row => !row.__owned_human_audio_tracks));
});

test('only canonical exact-track testimony survives public serialization; conflicting testimony is hidden', async () => {
  const { humanAudioFields } = await load('owned-human-language-confirmations.mjs');
  const { sanitizeCatalogVariant } = await load('catalog-public-view.mjs');
  assert.deepEqual(humanAudioFields({ humanAudioLanguages: ['en'] }), {});
  assert.deepEqual(humanAudioFields({ metadata: { __owned_human_audio_tracks: [{ index: 1, language: 'en' }] } }), {});
  const raw = { ...v(), __owned_human_audio_tracks: [
    { index: 1, language: 'es', transcript: 'private' }, { index: 4, language: 'en' },
    { index: 9, language: 'fr' }, { index: 9, language: 'de' }, { index: 9, language: 'fr' },
  ], provider_identity_id: 'private', profile_fingerprint: 'private',
  audio_tracks_scope: 'file', audio_tracks: [{ index: 1, lang: 'und' }, { index: 4, lang: 'en' }] };
  const published = sanitizeCatalogVariant(raw);
  assert.deepEqual(published.humanAudioTrackLanguages, [{ index: 1, language: 'es' }, { index: 4, language: 'en' }]);
  assert.deepEqual(published.humanAudioLanguages, ['en', 'es']);
  assert.equal(published.audio_tracks[0].lang, 'und', 'raw tags are preserved');
  assert.doesNotMatch(JSON.stringify(published), /private|__owned|transcript|profile_fingerprint|provider_identity_id/);
  assert.deepEqual(sanitizeCatalogVariant(published), published, 'repeated API serialization preserves explicit provenance');
});

test('history writes cannot invent testimony; history reads accept only the server-owned marker', async () => {
  const { humanAudioFields } = await load('owned-human-language-confirmations.mjs');
  const { sanitizeHistoryData, sanitizeWatchHistory } = await load('cloud-public-view.mjs');
  const data = { title: 'Film', ...humanAudioFields({ __owned_human_audio_tracks: [{ index: 1, language: 'es' }] }) };
  assert.equal(sanitizeHistoryData(data).humanAudioLanguages, undefined);
  assert.equal(sanitizeWatchHistory({ data }).data.humanAudioLanguages, undefined);
  assert.equal(sanitizeHistoryData({ ...data, __owned_human_audio_tracks: [{ index: 1, language: 'es' }] }).__owned_human_audio_tracks, undefined);
  const hydrated = sanitizeWatchHistory({ data: { title: 'Film', __owned_human_audio_tracks: [{ index: 1, language: 'es' }] } });
  assert.deepEqual(hydrated.data.humanAudioLanguages, ['es']);
  assert.doesNotMatch(JSON.stringify(hydrated), /__owned/);
});

test('Continue Watching hydration joins exact source and file and ignores other owners', async () => {
  const { attachOwnedHumanHistoryLanguages: attach } = await load('owned-human-language-confirmations.mjs');
  const rows = [{ source_id: 'source', item_type: 'movie', item_id: 'file', data: { title: 'A' } },
    { source_id: 'source', item_type: 'movie', item_id: 'other-file', data: { title: 'B' } },
    { source_id: 'source', item_type: 'series', item_id: 'file', data: { title: 'C' } }];
  const filters = [];
  const db = { from: table => {
    assert.equal(table, 'cloud_catalog_visible_title_variants');
    const q = { select() { return q; }, eq(k, value) { filters.push([k, value]); return q; },
      in: async () => ({ data: [v(), v('foreign', 'source', 'other')] }) };
    return q;
  }, rpc: async () => ({ data: [proof(), proof({ variant_id: 'foreign', user_id: 'other' })] }) };
  await attach(db, rows, 'owner');
  assert.deepEqual(filters, [['user_id', 'owner'], ['source_id', 'source'], ['item_type', 'movie']]);
  assert.deepEqual(rows[0].data.__owned_human_audio_tracks, [{ index: 1, language: 'es' }]);
  assert.equal(rows[1].data.__owned_human_audio_tracks, undefined);
  assert.equal(rows[2].data.__owned_human_audio_tracks, undefined);
});

test('version serialization projects human evidence separately without altering a sibling version', async () => {
  const { humanAudioFields } = await load('owned-human-language-confirmations.mjs');
  const { sanitizeCatalogVariant } = await load('catalog-public-view.mjs');
  const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-catalog/index.ts'), 'utf8');
  const section = source.slice(source.indexOf('function titleVariantItem('), source.indexOf('async function listRawMediaRail('));
  const context = vm.createContext({ humanAudioFields, sanitizeCatalogVariant,
    recordOrEmpty: value => value || {}, canonicalFileLanguages: value => value || [],
    audioJobFields: () => ({}), selectionSeriesLanguageFields: () => ({}) });
  vm.runInContext(stripTypeScriptTypes(section), context);
  const confirmed = { ...v(), __owned_human_audio_tracks: [{ index: 1, language: 'es' }],
    __file_audio_observed: true, __file_audio_languages: [], __file_audio_tracks: [{ index: 1, lang: 'und' }] };
  const card = context.titleVariantItem(confirmed);
  const sibling = context.titleVariantItem(v('sibling'));
  assert.deepEqual(card.humanAudioLanguages, ['es']);
  assert.equal(card.audioLanguageValidationStatus, 'pending');
  assert.equal(card.audio_tracks[0].lang, 'und');
  assert.equal(sibling.humanAudioLanguages, undefined);
  assert.match(source, /\.\.\.humanAudioFields\(defaultVariant\)/, 'grouped default uses only selected file');
});

test('fresh playback metadata replaces stale resume testimony, with no media request', async () => {
  const { attachOwnedHumanPlaybackLanguages: attach } = await load('owned-human-language-confirmations.mjs');
  const result = { session: { source_id: 'source', item_type: 'movie', item_id: 'file' },
    playback: { mode: 'transcode', humanAudioLanguages: ['de'], humanAudioLanguageStatus: 'human_confirmed' } };
  const db = { from: () => {
    const q = { select: () => q, eq: () => q, in: async () => ({ data: [v()] }) };
    return q;
  }, rpc: async () => ({ data: [proof()] }) };
  await attach(db, result, 'owner');
  assert.deepEqual(result.playback.humanAudioLanguages, ['es']);
  assert.deepEqual(result.playback.humanAudioTrackLanguages, [{ index: 1, language: 'es' }]);
  await attach({ from: () => { throw new Error('unavailable'); } }, result, 'owner');
  assert.deepEqual(result.playback.humanAudioLanguages, []);
  assert.equal(result.playback.humanAudioLanguageStatus, null);
  assert.equal(result.playback.humanAudioLanguageScope, null);
  assert.equal(result.playback.mode, 'transcode');
  const live = { session: { source_id: 'source', item_type: 'live', item_id: 'file' }, playback: {} };
  await attach({ from: () => { assert.fail('live must not query movie testimony'); } }, live, 'owner');
  assert.deepEqual(live.playback.humanAudioTrackLanguages, []);
});

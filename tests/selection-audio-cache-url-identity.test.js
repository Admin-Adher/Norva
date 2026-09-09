'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { transformSync } = require('esbuild');

const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-catalog/index.ts'), 'utf8');
const start = source.indexOf('async function attachSelectionAudioFileIdentity(');
const end = source.indexOf('async function listVariantsByTitleIds(', start);
assert.ok(start > 0 && end > start);
const helpers = transformSync(source.slice(start, end), { loader: 'ts', format: 'cjs', target: 'es2022' }).code;
const digest = value => createHash('sha256').update(value).digest('hex');
const owner = '11111111-1111-4111-a111-111111111111';
const oldUrl = 'https://example.com/old-audio-file.mp4';
const newUrl = 'https://example.com/replaced-audio-file.mp4';

async function fixture({ observationHash, cacheHash, sourceKind = 'selection', observationLanguage = 'es', cacheLanguage = 'es' } = {}) {
    const { isDiscoverySourceId, discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
    const sourceId = sourceKind === 'selection' ? await discoverySourceId(owner, 4) : '22222222-2222-4222-a222-222222222222';
    const variant = { id: 'variant-1', user_id: owner, source_id: sourceId, media_item_id: 'media-1', item_type: 'movie',
        external_id: 'norva-selection:movie:' + 'a'.repeat(64), playback_hint: { targetUrl: newUrl } };
    const verification = hash => hash ? { urlSha256: hash } : {};
    const observation = { variant_id: variant.id, file_external_id: variant.external_id,
        audio_observed: true, audio_languages: [observationLanguage], audio_verified_at: '2026-09-09T00:00:00Z',
        audio_verification: verification(observationHash), subtitle_observed: true, subtitle_languages: ['en'] };
    const caches = cacheHash === null ? [] : [{ server_host: 'source:' + sourceId, item_type: 'movie', external_id: variant.external_id,
        audio_probed_at: '2026-09-09T00:00:00Z', audio_lang_verified_at: '2026-09-09T00:00:00Z',
        audio_tracks: [{ index: 1, lang: cacheLanguage }], audio_lang_verification: verification(cacheHash),
        subtitle_probed_at: '2026-09-09T00:00:00Z', subtitle_tracks: [{ index: 2, lang: 'en' }] }];
    const db = { from(table) {
        const rows = table === 'catalog_file_tracks' ? caches : table === 'cloud_catalog_visible_title_variants' ? [variant] : [];
        const filters = [];
        const query = { select() { return query; }, in(key, values) { filters.push(row => values.includes(row[key])); return query; },
            eq(key, value) { filters.push(row => row[key] === value); return query; },
            then(resolve, reject) { return Promise.resolve({ data: rows.filter(row => filters.every(fn => fn(row))) }).then(resolve, reject); } };
        return query;
    } };
    const context = {
        db, console, isDiscoverySourceId, sha256Hex: async value => digest(value),
        stringOrNull: value => typeof value === 'string' && value.trim() ? value : null,
        recordOrEmpty: value => value && typeof value === 'object' ? value : {},
        canonicalFileLanguages: values => [...new Set((values || []).filter(value => value && value !== 'und'))],
        titleAudioLanguages: title => title.file_audio_languages || [],
        titleVerifiedAudioLanguages: title => title.file_audio_verified_languages || [],
        publicFileTrackLanguages: tracks => tracks.map(track => track.lang),
        attachSelectionSeriesLanguages: async () => {}, attachAudioJobStates: async () => {},
        audioJobFields: () => ({ audio_language_validation_job_status: null }),
        fileLanguageObservationsByVariant: async () => new Map([[variant.id, observation]]),
        sourceCatalogContextFor: async () => ({ exactKeysBySource: new Map([[sourceId, ['source:' + sourceId]]]) }),
    };
    vm.createContext(context);
    vm.runInContext(helpers + '\nthis.api = { attachSelectionAudioFileIdentity, attachExactFileTracks, attachFlatMediaFileLanguages, titleAudioLanguagesWithFileIdentity };', context);
    return { ...context.api, variant, observation, caches };
}

const plain = value => JSON.parse(JSON.stringify(value));
const oldTitle = { file_audio_languages: ['es'], file_audio_verified_languages: ['es'] };

test('a replaced Selection URL rejects both old cache tracks and its old tenant observation/title union', async () => {
    const f = await fixture({ observationHash: digest(oldUrl), cacheHash: digest(oldUrl) });
    await f.attachExactFileTracks(new Map([['title', [f.variant]]]), owner);
    assert.equal(f.variant.__selection_audio_evidence_rejected, true);
    assert.equal(f.variant.__file_audio_observed, undefined);
    assert.equal(f.variant.__file_audio_tracks, undefined);
    assert.equal(f.variant.__file_subtitle_tracks, undefined);
    assert.deepEqual(plain(f.titleAudioLanguagesWithFileIdentity(oldTitle, [f.variant])), { observedAudioLanguages: [], verifiedAudioLanguages: [] });
});

test('an explicitly current observation survives an old URL cache while its title union uses the current language only', async () => {
    const f = await fixture({ observationHash: digest(newUrl), cacheHash: digest(oldUrl), observationLanguage: 'pt' });
    await f.attachExactFileTracks(new Map([['title', [f.variant]]]), owner);
    assert.deepEqual(plain(f.variant.__file_audio_languages), ['pt']);
    assert.equal(f.variant.__file_audio_tracks, undefined);
    assert.deepEqual(plain(f.titleAudioLanguagesWithFileIdentity(oldTitle, [f.variant])), { observedAudioLanguages: ['pt'], verifiedAudioLanguages: ['pt'] });
});

test('an old URL cache also invalidates unbound observations previously hydrated from that cache', async () => {
    const f = await fixture({ cacheHash: digest(oldUrl) });
    await f.attachExactFileTracks(new Map([['title', [f.variant]]]), owner);
    assert.equal(f.variant.__file_audio_languages, undefined);
    assert.equal(f.variant.__file_audio_verified_at, undefined);
    assert.equal(f.variant.__file_subtitle_languages, undefined);
    assert.deepEqual(plain(f.titleAudioLanguagesWithFileIdentity(oldTitle, [f.variant])).observedAudioLanguages, []);
});

test('a current URL cache replaces a rejected old observation without borrowing the old title union', async () => {
    const f = await fixture({ observationHash: digest(oldUrl), cacheHash: digest(newUrl), cacheLanguage: 'pt' });
    await f.attachExactFileTracks(new Map([['title', [f.variant]]]), owner);
    assert.deepEqual(plain(f.variant.__file_audio_tracks), [{ index: 1, lang: 'pt' }]);
    assert.deepEqual(plain(f.titleAudioLanguagesWithFileIdentity(oldTitle, [f.variant])).observedAudioLanguages, ['pt']);
});

test('historical evidence without URL provenance and non-Selection providers keep their existing behavior', async () => {
    for (const args of [{}, { sourceKind: 'provider', observationHash: digest(oldUrl), cacheHash: digest(oldUrl) }]) {
        const f = await fixture(args);
        await f.attachExactFileTracks(new Map([['title', [f.variant]]]), owner);
        assert.equal(f.variant.__selection_audio_evidence_rejected, undefined);
        assert.deepEqual(plain(f.variant.__file_audio_languages), ['es']);
        assert.deepEqual(plain(f.titleAudioLanguagesWithFileIdentity(oldTitle, [f.variant])).observedAudioLanguages, ['es']);
    }
});

test('another owner cannot acquire an internal Selection URL proof', async () => {
    const f = await fixture();
    await f.attachSelectionAudioFileIdentity([f.variant], '33333333-3333-4333-a333-333333333333');
    assert.equal(f.variant.__selection_audio_url_sha256, undefined);
});

test('flat media clears pre-existing audio fields when the observed URL is explicitly obsolete', async () => {
    const f = await fixture({ observationHash: digest(oldUrl), cacheHash: null });
    const item = { id: 'media-1', source_id: f.variant.source_id, item_type: 'movie', external_id: f.variant.external_id,
        audio_languages: ['es'], audio_tracks: [{ index: 1, lang: 'es' }], audio_language_validation_status: 'verified',
        audio_verified_languages: ['es'], audio_probed_at: '2026-09-09T00:00:00Z',
        audio_language_verification: { status: 'verified' },
        audio_language_verified_at: '2026-09-09T00:00:00Z' };
    await f.attachFlatMediaFileLanguages([item], owner, 'movie');
    assert.deepEqual(plain(item.audio_languages), []);
    assert.deepEqual(plain(item.audio_tracks), []);
    assert.equal(item.audio_language_validation_status, 'not_analyzed');
    assert.equal(item.audio_language_verified_at, null);
    assert.deepEqual(plain(item.audio_verified_languages), []);
    assert.equal(item.audio_probed_at, null);
    assert.deepEqual(plain(item.audio_language_verification), {});
});

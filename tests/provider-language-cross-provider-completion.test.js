'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');

// Independent cases from the source-by-source audit. These are supplier
// declarations only: they cannot establish that any soundtrack was verified.
// Export the same bounded corpus for the separate PostgreSQL parity runner.
const cases = [
    ['Example (True FR)', '', 'fr'],
    ['(True FR) Example', '', 'fr'],
    ['Example [True FR]', '', 'fr'],
    ['Example (True FR) (2023)', '', 'fr'],
    ['Example (True FR)', 'FR | FILMS', 'fr'],
    ['Example (PL Blu-Ray)', '', 'pl'],
    ['(PL Blu-Ray) Example', '', 'pl'],
    ['Example [PL Blu-Ray]', '', 'pl'],
    ['Example (PL Blu-Ray) (2023)', '', 'pl'],
    ['Example (PL Blu-Ray)', 'PL | FILMS', 'pl'],
    ['MR-9: Do or Die (FR) FHD 2023', '', 'fr'],
    ['MR-9: Do or Die (FR) FHD 2023', 'FR | FILMS', 'fr'],
    ['Example (FR) FHD 2023', '', 'fr'],
    ['Example [FR] FHD 2023', '', 'fr'],
    ['Example [NL-BE]', '', 'nl'],
    ['[NL-BE] Example', '', 'nl'],
    ['Example [NL-BE] (2023)', '', 'nl'],
    ['Example [NL-BE]', 'NL | FILMS', 'nl'],
    ['Example [English Version]', '', 'en'],
    ['[English Version] Example', '', 'en'],
    ['Example [English Version] (2023)', '', 'en'],
    ['Example [English Version]', 'EN | FILMS', 'en'],

    // A new explicit declaration must participate in conflicts, not silently
    // lose to an older prefix/category or add an invented track count.
    ['Example (True FR)', 'EN', null],
    ['EN | Example (True FR)', '', null],
    ['Example (PL Blu-Ray)', 'FR', null],
    ['FR | Example (PL Blu-Ray)', '', null],
    ['MR-9: Do or Die (FR) FHD 2023', 'EN', null],
    ['Example [NL-BE]', 'FR', null],
    ['Example [English Version]', 'NL', null],
    ['NL | Example [English Version]', 'NL | FILMS', null],
    ['[English Version] Example', 'NL', null],

    // Release qualifiers are not a license to scan arbitrary prose.
    ['Example [EN COULEURS]', '', null],
    ['[EN COULEURS] Example', '', null],
    ['FR | Example [EN COULEURS]', 'FR', 'fr'],
    ['MR-9: Do or Die', '', null],
    ['MR-9: Do or Die 2023', '', null],
    ['MR-9: Do or Die FHD 2023', '', null],
    ['MR-9', '', null],
    ['True FR', '', null],
    ['PL Blu-Ray', '', null],
    ['NL-BE', '', null],
    ['English Version', '', null],
    ['Example [True FR Story]', '', null],
    ['Example [PL Blu-Ray Story]', '', null],
    ['Example [NL-BE Adventure]', '', null],
    ['Example [The English Version]', '', null],
    ['Example [English Version Extras]', '', null],
    ['Example (FR) FHD Behind the scenes', '', null],
    ['Example (FR) FHD 2023 Commentary', '', null],
    ['Game of Death II', '', null],
    ['Kisi Ka Bhai Kisi Ki Jaan', '', null],
    ['Band on the Run', '', null],
    ['Cha Cha Real Smooth', '', null],
    ['Bring Her Back', '', null],
    ['Stranger in a Cab', '', null],
    ['NO  TITLE', '', null],
    ['THE-ENGLISH-PATIENT: Behind the scenes', '', null],

    // Subtitle/MULTI gates remain stronger than any newly recognized label.
    ['Example (True FR SUBS)', '', null],
    ['Example (PL Blu-Ray SUBS)', '', null],
    ['Example [English Version SUBS]', '', null],
    ['Example [NL-BE SUBS]', '', null],
    ['Example (True FR)', 'FR SUBTITLES', null],
    ['Example (PL Blu-Ray)', 'PL SUBTITLES', null],
    ['Example (FR) FHD 2023', 'FR SUBTITLES', null],
    ['Example [NL-BE]', 'NL SUBTITLES', null],
    ['Example [English Version]', 'EN SUBTITLES', null],
    ['Example (True FR)', 'MULTI', null],
    ['Example (PL Blu-Ray)', 'MULTI', null],
    ['Example (FR) FHD 2023', 'MULTI', null],
    ['Example [NL-BE]', 'MULTI', null],
    ['Example [English Version]', 'MULTI', null],

    // Previously audited regional/market cases must retain their semantics.
    ['NL | Example', 'NL | HINDI', 'hi'],
    ['NL | Example [English Version]', 'NL | HINDI', null],
    ['NL | Example [NL-BE]', 'NL | HINDI', null],
    ['EXYU | Svadba', 'EXYU', 'exyu'],
    ['EXYU | Example [English Version]', 'EXYU', 'en'],
    ['EXYU | Example (True FR)', 'EXYU', 'fr'],
    ['EXYU | Example [MULTI]', 'EXYU', 'exyu'],
    ['EXYU-SUBS | Example', 'EXYU', 'exyu'],
    ['AR-AS  Castaway on the Moon (2009)', '', 'ar'],
    ['AR-IN-S - Hidimbha (2023)', '', 'ar'],
    ['AR-KD - مغامرات الفضاء (جريندايزر)', '', 'ar'],
    ['AR-KD | Example', '', 'ar'],
    ['AR-KD  Example', '', 'ar'],
    ['AR-KD - Example', 'EN', null],
    ['AR-KD-SUBS - Example', '', null],
    ['AR-KD - Example [MULTI]', '', null],
    ['[AR-KD] Example', '', null],
    ['Example [AR-KD]', '', null],
    ['KD | Example', '', null],
    ['Example', 'KD', null],
    ['KD', '', null],
    ['AR-KD Example', '', null],
    ['NF - Dutch', 'NETFLIX MOVIES', null],
    ['AR-SUBS - Land of Ashes', '', null],
];
module.exports = { cases };

function browser() {
    const context = { window: {}, Intl, console };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8'), context);
    return context.window.MediaUtils;
}
const M = browser();
const make = (raw_title, categoryName, extra = {}) => ({
    item_type: 'movie', raw_title, metadata: { categoryName },
    audio_language_validation_status: 'not_analyzed', ...extra,
});
const shared = () => Promise.all([
    import(pathToFileURL(path.join(root, 'supabase/functions/_shared/provider-catalog-language.mjs'))),
    import(pathToFileURL(path.join(root, 'supabase/functions/_shared/selection-provider-languages.mjs'))),
]);

test('cross-provider completion: browser, shared parser and filter agree on each audited format', async () => {
    const [{ providerCatalogLanguage }, { catalogProviderAudioLanguages, catalogVariantMatchesAudio }] = await shared();
    for (const item_type of ['movie', 'series']) {
        for (const [raw, category, expected] of cases) {
            const item = make(raw, category, { item_type });
            const context = `${item_type}: ${raw} / ${category}`;
            assert.equal(providerCatalogLanguage(item), expected, context);
            assert.deepEqual(catalogProviderAudioLanguages(item), expected ? [expected] : [], context);
            assert.equal(catalogVariantMatchesAudio(item, 'unidentified'), !expected, context);
            if (expected) assert.equal(catalogVariantMatchesAudio(item, `catalog-${expected}`), true, context);
            const descriptor = M.versionDescriptor(item, { providerLanguageHints: true });
            assert.equal(descriptor.headline, expected === 'exyu' ? 'Ex-Yugoslav'
                : expected ? M.languageDisplayFull(expected) : 'Language unidentified', context);
            assert.equal(M.catalogLanguageInfo(item).text, descriptor.headline, context);
            assert.equal(descriptor.audioSource === 'provider-label', Boolean(expected && expected !== 'exyu'), context);
            if (expected === 'exyu') {
                assert.equal(descriptor.kind, 'region', context);
                assert.equal(descriptor.audioSource, 'provider-region', context);
            }
        }
    }
});

test('cross-provider completion: accepted exact-file audio remains authoritative and immutable', async () => {
    const [, { catalogVariantMatchesAudio }] = await shared();
    for (const [raw, category] of cases.slice(0, 22)) {
        for (const code of ['de', 'nl', 'ta']) {
            const item = make(raw, category, {
                audio_language_validation_status: 'verified',
                audio_tracks_scope: 'file', audio_tracks: [{ index: 3, lang: code, channels: 6, codec: 'aac' }],
                audio_languages_scope: 'file', audio_languages_observed: true, audio_languages: [code],
                __file_audio_observed: true, __file_audio_languages: [code],
                codec_profile: { audioTracks: [{ index: 3, language: code, channels: 6, codec: 'aac' }] },
            });
            const before = JSON.stringify(item);
            const result = M.versionDescriptor(item, { providerLanguageHints: true });
            assert.equal(result.headline, M.languageDisplayFull(code), raw);
            assert.equal(result.audioSource, 'file', raw);
            assert.equal(result.languageStatus, '', raw);
            assert.equal(catalogVariantMatchesAudio(item, `catalog-${code}`), true, raw);
            assert.equal(catalogVariantMatchesAudio(item, 'catalog-hi'), false, raw);
            assert.equal(JSON.stringify(item), before, 'language, channels, index and evidence must remain untouched');
        }
    }
});

test('cross-provider completion: local and cloud raw-label adapters keep the same bounded declaration', async () => {
    const [{ providerCatalogLanguage }] = await shared();
    for (const [raw, , expected] of cases.slice(0, 22)) {
        for (const item of [
            { item_type: 'movie', rawTitle: raw, metadata: { category_name: 'FILMS' } },
            { item_type: 'movie', name: raw, categoryName: 'FILMS' },
            { item_type: 'series', name: raw, source_id: 'fixture-source-context' },
            { item_type: 'series', title: raw, sourceId: 'fixture-source-context' },
        ]) {
            const before = JSON.stringify(item);
            assert.equal(providerCatalogLanguage(item), expected, raw);
            assert.equal(M.catalogLanguageInfo(item).headline, M.languageDisplayFull(expected), raw);
            assert.equal(JSON.stringify(item), before, raw);
        }
        assert.equal(providerCatalogLanguage({ name: raw }), null, 'unscoped display title is not a supplier label');
        assert.equal(providerCatalogLanguage({ title: raw }), null, 'unscoped display title is not a supplier label');
    }
});

test('cross-provider completion: hints do not manufacture observed languages, scoring or public provenance', async () => {
    const [, { catalogProviderAudioLanguages }] = await shared();
    for (const [raw, category, expected] of cases.slice(0, 22)) {
        const item = make(raw, category);
        const before = JSON.stringify(item);
        const scoring = JSON.stringify(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: expected }));
        const result = M.versionDescriptor(item, { providerLanguageHints: true });
        assert.equal(result.languageStatus, 'Provider · Unverified', raw);
        assert.equal(M.versionDescriptor(item).headline, 'Language unidentified', raw);
        assert.equal(M.versionLanguageBadge(item), 'Language unidentified', raw);
        assert.equal(M.providerAudioLanguages(item).length, 0, raw);
        assert.deepEqual(catalogProviderAudioLanguages(item), [expected], raw);
        assert.equal(JSON.stringify(item), before, raw);
        assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: expected })), scoring, raw);
        assert.doesNotMatch([result.headline, result.accessibleHeadline, result.meta,
            M.languageBadgeHtml(M.catalogLanguageInfo(item), 'test')].join(' '), /Provider label|Unverified|to confirm/);
    }
});

test('cross-provider completion: inconclusive observations and a proven empty track map stay distinct', async () => {
    const [, { catalogVariantMatchesAudio }] = await shared();
    for (const [raw, category, expected] of cases.slice(0, 22)) {
        const inconclusive = make(raw, category, {
            __file_audio_observed: true, __file_audio_languages: [],
            audio_language_validation_status: 'pending', audio_tracks_scope: 'file',
            audio_tracks: [{ index: 1, codec: 'aac' }],
        });
        assert.equal(catalogVariantMatchesAudio(inconclusive, 'unidentified'), false, raw);
        assert.equal(catalogVariantMatchesAudio(inconclusive, `catalog-${expected}`), true, raw);
        assert.equal(M.versionDescriptor(inconclusive, { providerLanguageHints: true }).headline,
            M.languageDisplayFull(expected), raw);
        const empty = make(raw, category, {
            audio_language_validation_status: 'probed', audio_tracks_scope: 'file',
            audio_probed_at: '2026-09-13T00:00:00Z', audio_tracks: [],
            __file_audio_probed_at: '2026-09-13T00:00:00Z', __file_audio_tracks: [],
        });
        assert.equal(M.versionDescriptor(empty, { providerLanguageHints: true }).headline, 'Audio unavailable', raw);
        assert.equal(catalogVariantMatchesAudio(empty, `catalog-${expected}`), false, raw);
    }
});

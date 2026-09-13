'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

test('unidentified audio is the complement of accepted file audio and scoped provider hints', async () => {
    const { catalogVariantMatchesAudio: matches } = await import(pathToFileURL(path.join(root,
        'supabase/functions/_shared/selection-provider-languages.mjs')));
    const unknown = { raw_title: 'A movie', metadata: {} };
    assert.equal(matches(unknown, 'unidentified'), true);
    assert.equal(matches({ ...unknown, raw_title: 'EN | A movie' }, 'unidentified'), false);
    assert.equal(matches({ ...unknown, metadata: { categoryName: 'English Hindi Dubbed' } }, 'unidentified'), false);
    assert.equal(matches({ ...unknown, raw_title: 'Movie [VOSTFR]' }, 'unidentified'), true);
    assert.equal(matches({ ...unknown, __file_subtitle_languages: ['en'], __file_subtitle_observed: true }, 'unidentified'), true);
    assert.equal(matches({ ...unknown, __file_audio_languages: ['en'] }, 'unidentified'), true, 'an unaccepted/title-wide union is not evidence');
    assert.equal(matches({ ...unknown, __file_audio_observed: true, __file_audio_languages: ['hz'] }, 'unidentified'), false, 'accepted rare languages remain known');
    assert.equal(matches({ ...unknown, __file_audio_observed: true, __file_audio_languages: ['yue'] }, 'unidentified'), false);
    assert.equal(matches({ ...unknown, __file_audio_observed: true, __file_audio_languages: ['und'] }, 'unidentified'), true);
    assert.equal(matches({ ...unknown, raw_title: 'EN | A movie', __file_audio_observed: true, __file_audio_languages: [] }, 'unidentified'), false);
    assert.equal(matches({ ...unknown, raw_title: 'EN | A movie', codec_profile: { audioTracks: [{ lang: 'her' }] } }, 'unidentified'), false, 'pending raw tag does not hide provider English');
    assert.equal(matches({ ...unknown, raw_title: 'EN | A movie', metadata: { categoryName: 'FR | FILMS' } }, 'unidentified'), true, 'conflicting declarations stay unidentified');
    const versions = [{ ...unknown, raw_title: 'FR | Movie' }, unknown];
    versions.sort((a, b) => Number(matches(b, 'unidentified')) - Number(matches(a, 'unidentified')));
    assert.equal(versions[0], unknown, 'the unidentified sibling is promoted without discarding known versions');
});

for (const name of ['MoviesPage', 'SeriesPage']) {
    test(`${name} renders and persists the localized unidentified choice, including zero and refresh failure`, () => {
        const ctx = { window: {}, console, Intl, document: { documentElement: { lang: 'fr' } },
            NorvaI18n: { language: 'fr', t: (key, options) => key === 'ui_web_audio_language_unidentified' ? 'Langue non identifiée' : options?.defaultValue || key } };
        vm.runInNewContext(read('public/js/utils/mediaUtils.js'), ctx);
        ctx.MediaUtils = ctx.window.MediaUtils;
        vm.runInNewContext(read(`public/js/pages/${name}.js`), ctx);
        const page = Object.create(ctx.window[name].prototype);
        const select = { value: 'unidentified', options: [{ value: 'unidentified', text: 'old' }], innerHTML: '' };
        page.applyFacetOptions(select, 'Tous', [{ value: 'catalog-en', count: 100 }, { value: 'unidentified', count: 12, label: 'Language unidentified' }]);
        assert.match(select.innerHTML, /value="unidentified">Langue non identifiée · 12/);
        assert.equal(select.value, 'unidentified');
        page.applyFacetOptions(select, 'Tous', [{ value: 'unidentified', count: 0 }]);
        assert.match(select.innerHTML, /Langue non identifiée · 0/);
        assert.equal(select.value, 'unidentified');
        page.applyFacetOptions(select, 'Tous', [], 'unidentified', 'movies', true);
        assert.match(select.innerHTML, /Langue non identifiée · 0/);
        assert.equal(select.value, 'unidentified');
        assert.doesNotMatch(select.innerHTML, /Étiquette|confirmer|Language unidentified/);
        const params = require('../public/js/utils/CatalogQueryParams.js').build({ audio: select.value, source: 'source-a', subtitle: 'fr', search: 'movie' });
        assert.deepEqual(params, { source: 'source-a', audio: 'unidentified', subs: 'fr', q: 'movie' });
    });
}

test('server keeps unidentified audio in bounded SQL for every sort, never subtitle or preference ISO', () => {
    const edge = read('supabase/functions/norva-catalog/index.ts');
    assert.match(edge, /audioIso === 'unidentified' \|\|/);
    assert.match(edge, /const subIso = canonicalFileLanguage\(/);
    assert.match(edge, /const prefAudioIso = langSort \? canonicalFileLanguage\(/);
    assert.match(edge, /value\.audio\.push\(\{ value: 'unidentified', count: Math\.max\(0/);
    assert.match(edge, /requiredAudioIso === 'unidentified'\) return catalogVariantMatchesAudio/);
    const sql = read('supabase/migrations/20260913140000_catalog_unidentified_audio_filter.sql');
    assert.equal((sql.match(/from public\.cloud_catalog_unidentified_audio_variants\(/g) || []).length, 2, 'count and page share membership');
    assert.match(sql, /cloud_catalog_effective_audio_languages\(p_user_id,p_item_type,p_source_id\)/);
    assert.match(sql, /count\(distinct title_id\)/);
    assert.match(sql, /observation\.variant_id=unknown_audio\.variant_id/);
    assert.match(sql, /variant\.external_id=observation\.file_external_id/);
    assert.match(sql, /variant\.user_id=p_user_id and variant\.item_type=p_item_type/);
    assert.match(sql, /p_source_id is null or variant\.source_id=p_source_id/);
    assert.doesNotMatch(sql, /security definer|update public\.|delete from|insert into/i);
});

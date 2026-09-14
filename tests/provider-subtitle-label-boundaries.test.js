'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8');
const translations = { ...require('../i18n/web-dynamic.json'), ...require('../i18n/web-extra.json') };
const locales = require('../i18n/locales.json').map((locale) => locale.code);

function load(locale = 'fr') {
    const context = { window: {}, Intl, NorvaI18n: { language: locale, t(key, args = {}) {
        return (translations[key]?.[locale] || args.defaultValue || key)
            .replace(/\{\{(\w+)\}\}/g, (_, name) => args[name] ?? '');
    } } };
    vm.runInNewContext(code, context);
    return context.window.MediaUtils;
}

function row(fields = {}) {
    return {
        raw_title: 'PH - The Roast of Kevin Hart (2026)',
        metadata: { categoryName: 'PH - TAGALOG SUB MOVIES' },
        item_type: 'movie',
        audio_language_validation_status: 'not_analyzed',
        ...fields,
    };
}

test('the exact PH subtitle shelf uses the existing translation in every supported locale', () => {
    for (const locale of locales) {
        const media = load(locale);
        const item = row();
        const before = JSON.stringify(item);
        const descriptor = media.versionDescriptor(item, { providerLanguageHints: true });
        const expected = translations.ui_web_02fea12001f8[locale]
            .replace('{{p0}}', media.languageDisplayFull('fil'));
        assert.ok(descriptor.meta.includes(expected), locale);
        assert.equal(descriptor.headline, media.catalogLanguageInfo(row({ raw_title: 'NF - Example', metadata: {} })).headline, locale);
        assert.doesNotMatch(descriptor.meta, /burned-in|brûlé|incrust|queimado|quemado|yanmış|محترق|terbakar|nasunog/i);
        assert.equal(JSON.stringify(item), before, locale);
    }
});

test('PH subtitle declarations accept existing raw-title and category adapters without broadening the shelf', () => {
    const media = load();
    const expected = 'Sous-titres : ' + media.languageDisplayFull('fil') + ' · fournisseur';
    for (const title of ['PH - Example', 'PH ▎ Example', 'PH | Example', 'PH: Example', 'PH — Example']) {
        for (const titleKey of ['raw_title', 'rawTitle', 'name', 'title']) {
            for (const category of [
                { category_name: 'PH - TAGALOG SUB MOVIES' },
                { categoryName: 'PH - TAGALOG SUB MOVIES' },
                { metadata: { category_name: 'PH - TAGALOG SUB MOVIES' } },
                { metadata: { categoryName: 'PH - TAGALOG SUB MOVIES' } },
            ]) {
                const item = row({ raw_title: undefined, metadata: {}, [titleKey]: title, ...category });
                assert.ok(media.versionDescriptor(item).meta.includes(expected), JSON.stringify(item));
            }
        }
    }
    for (const title of ['PHANTOM - Example', 'PH', 'NF - Example', 'IN-PH - Example', 'PH-SUBS - Example']) {
        assert.doesNotMatch(media.versionDescriptor(row({ raw_title: title })).meta, /Sous-titres :/);
    }
    for (const categoryName of ['PH - PHILIPPINES FILM', 'PH - EVENTS', 'PH - TAGALOG DUB MOVIES', 'PH - TAGALOG SUB MOVIES OTHER', 'OTHER PH - TAGALOG SUB MOVIES']) {
        assert.doesNotMatch(media.versionDescriptor(row({ metadata: { categoryName } })).meta, /Sous-titres :/);
    }
});

test('a non-empty subtitle inventory wins, including untagged subtitle tracks', () => {
    const media = load();
    for (const fields of [
        { subtitle_tracks_scope: 'file', subtitle_tracks: [{ index: 3, lang: 'es' }] },
        { subtitle_tracks_scope: 'file', subtitle_tracks: [{ index: 3, lang: null }] },
        { subtitle_languages_scope: 'file', subtitle_languages: ['es'], subtitle_languages_observed: true },
        { subtitleLanguagesScope: 'file', subtitleLanguages: ['es'], subtitleLanguagesObserved: true },
    ]) {
        const item = row(fields);
        const before = JSON.stringify(item);
        assert.doesNotMatch(media.versionDescriptor(item).meta, /Sous-titres :|fournisseur/, JSON.stringify(fields));
        assert.equal(JSON.stringify(item), before);
    }
});

test('an empty selectable subtitle inventory does not disprove the separate provider declaration', () => {
    const media = load();
    for (const fields of [
        { subtitle_tracks_scope: 'file', subtitle_tracks: [] },
        { subtitle_tracks_scope: 'file', subtitle_tracks: [], subtitle_probed_at: '2026-09-14T06:00:00Z' },
        { subtitle_languages_scope: 'file', subtitle_languages: [], subtitle_languages_observed: true },
        { subtitleLanguagesScope: 'file', subtitleLanguages: [], subtitleLanguagesObserved: true },
    ]) {
        const item = row(fields);
        const before = JSON.stringify(item);
        const descriptor = media.versionDescriptor(item);
        assert.match(descriptor.meta, /Sous-titres :/);
        assert.match(descriptor.meta, /fournisseur/);
        assert.doesNotMatch(descriptor.meta, /burned-in|brûlé|incrust|ST (?:TL|FIL)/i);
        assert.equal(JSON.stringify(item), before);
    }
});

test('all six screenshot families preserve browser/server audio boundaries', async () => {
    const media = load();
    const { providerCatalogLanguage } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/provider-catalog-language.mjs')));
    for (const [raw_title, categoryName, expected] of [
        ['NF - Love in Slow Motion (2026)', 'NETFLIX MOVIES', null],
        ['PH - Young Blood (2026)', 'PH - PHILIPPINES FILM', null],
        ['PH - Past Is Past (2026)', 'PH - EVENTS', null],
        ['PH - The Roast of Kevin Hart (2026)', 'PH - TAGALOG SUB MOVIES', null],
        ['IR ▎ House of Paper', 'IRAN', null],
        ['IN-KD - Demon Hunters (2026)', 'IN - KOREAN HINDI DABBLING', 'hi'],
    ]) {
        const item = row({ raw_title, metadata: { categoryName } });
        const before = JSON.stringify(item);
        assert.equal(providerCatalogLanguage(item), expected, raw_title);
        assert.equal(media.catalogLanguageInfo(item).headline, expected ? media.languageDisplayFull(expected) : 'Langue non identifiée', raw_title);
        assert.equal(JSON.stringify(item), before);
    }
});

test('unverified audio conflicts never appear in public descriptor or badge copy in any locale', () => {
    for (const locale of locales) {
        const media = load(locale);
        const item = row({ raw_title: 'ES - Aída y vuelta (2026)', metadata: { categoryName: 'ES - PELÍCULAS 2026' },
            audio_language_validation_status: 'probed', audio_probed_at: '2026-08-31T20:35:11Z',
            audio_tracks_scope: 'file', audio_tracks: [{ index: 1, lang: 'en' }] });
        const before = JSON.stringify(item);
        const info = media.catalogLanguageInfo(item);
        const descriptor = media.versionDescriptor(item, { providerLanguageHints: true });
        assert.equal(info.internalAudioDiagnostic?.code, 'provider_file_language_conflict');
        assert.equal(info.headline, media.languageDisplayFull('en'));
        assert.equal(info.accessibleHeadline, info.headline);
        assert.equal(descriptor.accessibleHeadline, info.headline);
        assert.equal(descriptor.languageConfirmationStatus, '');
        assert.doesNotMatch(JSON.stringify(descriptor), /provider_file_language_conflict|internalAudioDiagnostic|Audio à vérifier|Audio needs verification/);
        assert.doesNotMatch(media.languageBadgeHtml(info), /provider_file_language_conflict|internalAudioDiagnostic|Audio à vérifier|Audio needs verification/);
        assert.equal(JSON.stringify(item), before);
    }
});

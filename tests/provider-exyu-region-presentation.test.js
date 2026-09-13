'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
function browser(language = 'en') {
    const context = { window: {}, Intl, console, NorvaI18n: { language, t(key, args = {}) {
        return key === 'ui_web_provider_ex_yugoslav' && language === 'fr' ? 'Ex-yougoslave' : args.defaultValue;
    } } };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8'), context);
    return context.window.MediaUtils;
}
const make = extra => ({ item_type: 'movie', raw_title: 'EXYU ▎ Example',
    metadata: { categoryName: 'EXYU' }, audio_language_validation_status: 'not_analyzed', ...extra });

test('EXYU uses a translated regional presentation, never audio-language provenance', () => {
    for (const [locale, label] of [['en', 'Ex-Yugoslav'], ['fr', 'Ex-yougoslave']]) {
        const M = browser(locale), item = make(), before = JSON.stringify(item);
        const scoring = JSON.stringify(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'sr' }));
        const result = M.versionDescriptor(item, { providerLanguageHints: true });
        assert.equal(result.headline, label); assert.equal(result.accessibleHeadline, label);
        assert.equal(result.audioSource, 'provider-region'); assert.equal(result.kind, 'region');
        assert.equal(result.languageStatus, ''); assert.equal(result.languageConfirmationStatus, '');
        assert.equal(M.catalogLanguageInfo(item).text, label);
        assert.equal(M.catalogLanguageInfo(item).kind, 'region');
        assert.equal(M.languageFacetName('catalog-exyu'), label);
        assert.equal(M.languageFacetName('provider-exyu'), label);
        assert.equal(M.languageFacetLabel({ value: 'catalog-exyu', count: 2 }), `${label} · 2`);
        assert.equal(M.versionLanguageBadge(item), 'Language unidentified');
        assert.equal(M.versionDescriptor(item).headline, 'Language unidentified');
        assert.equal(M.providerAudioLanguages(item).length, 0);
        assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'sr' })), scoring);
        assert.equal(JSON.stringify(item), before);
    }
});

test('serialized catalogue region fallback works without raw metadata and loses to explicit language', () => {
    const M = browser();
    const item = { provider_label_language: 'exyu', item_type: 'movie', audio_language_validation_status: 'not_analyzed' };
    assert.equal(M.catalogLanguageInfo(item).headline, 'Ex-Yugoslav');
    assert.equal(M.catalogLanguageInfo({ ...item, raw_title: 'EN ▎ Example' }).headline, 'English');
    assert.equal(M.catalogLanguageInfo({ ...item, raw_title: 'EXYU ▎ Example', metadata: { categoryName: 'Hindi' } }).headline, 'Hindi');
});

test('observed or declared audio and known-empty files outrank EXYU region fallback', () => {
    const M = browser();
    for (const lang of ['en', 'sr', 'hr', 'hi']) {
        const result = M.catalogLanguageInfo(make({ audio_language_validation_status: 'verified', audio_tracks_scope: 'file',
            audio_tracks: [{ index: 1, lang }] }));
        assert.equal(result.headline, M.languageDisplayFull(lang));
        assert.notEqual(result.audioSource, 'provider-region'); assert.notEqual(result.kind, 'region');
    }
    const declared = M.catalogLanguageInfo(make({ provider_audio_languages: ['en'], provider_audio_language_status: 'provider_declared' }));
    assert.equal(declared.headline, 'English'); assert.equal(declared.audioSource, 'provider-declared');
    const empty = M.catalogLanguageInfo(make({ audio_language_validation_status: 'probed', audio_tracks_scope: 'file',
        audio_tracks: [], audio_probed_at: '2026-09-13T00:00:00Z' }));
    assert.equal(empty.headline, 'Audio unavailable'); assert.notEqual(empty.kind, 'region');
});

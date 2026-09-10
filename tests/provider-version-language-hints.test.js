'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8');
const translations = require('../i18n/web-extra.json');
const locales = require('../i18n/locales.json');
function load(language = 'en') {
    const ctx = { window: {}, Intl, document: { documentElement: { lang: language } },
        NorvaI18n: { language, t(key, args = {}) {
            return (translations[key]?.[language] || args.defaultValue || key)
                .replace(/\{\{(\w+)\}\}/g, (_, k) => args[k] ?? '');
        } } };
    vm.runInNewContext(source, ctx);
    return ctx.window.MediaUtils;
}
const M = load();
const make = (raw, category, extra = {}) => ({ item_type: 'movie', raw_title: raw,
    metadata: { categoryName: category }, container_extension: 'mkv',
    audio_language_validation_status: 'not_analyzed', ...extra });
const hinted = (item, utility = M) => utility.versionDescriptor(item, { providerLanguageHints: true });
const seven = [
    ['ALB ▎ Example Film', 'AL | DISNEY+', 'Albanian'],
    ['FR ▎ Example Film', 'FR | DISNEY+', 'French'],
    ['GR ▎ Example Film', 'GREECE', 'Greek'],
    ['HU ▎ Example Film', 'NORDIC FILM NEW RELEASE', 'Nordic languages'],
    ['IN ▎ Example Film', 'ASIA| HINDI', 'Hindi'],
    ['NL ▎ Example Film', 'NL | DISNEY+', 'Dutch'],
    ['SO ▎ Example Film', '', 'Somali · to confirm']
];

test('the seven approved interpretations are qualified display hints, not audio evidence', () => {
    for (const [raw, category, expected] of seven) {
        const item = make(raw, category);
        const before = JSON.stringify(item);
        const result = hinted(item);
        assert.equal(result.headline, expected, raw);
        assert.equal(result.languageStatus, 'Provider · Unverified');
        assert.equal(result.audioSource, 'provider-label');
        assert.equal(JSON.stringify(item), before, 'display is pure');
        assert.equal(M.versionDescriptor(item).headline, 'Language unidentified', 'strict default unchanged');
        assert.equal(M.versionLanguageBadge(item), 'Language unidentified', 'root badges unchanged');
        assert.equal(M.providerAudioLanguages(item).length, 0, 'no provider declaration manufactured');
    }
});

test('all supported separators and camel/snake category fields work without source-specific rules', () => {
    for (const separator of ['|', '▎', '│', '┃', '｜', '-', '—', ':']) {
        assert.equal(hinted(make(`AL ${separator} Example`, '')).headline, 'Albanian');
    }
    assert.equal(hinted({ rawTitle: 'FR|Example', category_name: 'FR | DISNEY+' }).headline, 'French');
    assert.equal(hinted(make('', 'GREECE')).headline, 'Greek');
    assert.equal(hinted(make('AR ▎ Example', 'AR | FOREIGN')).headline, 'Arabic');
});

test('the AR-labelled file stays French once its actual French track is available', () => {
    for (const status of ['probed', 'verified', 'probed_union', 'verified_union']) {
        const item = make('AR ▎ Example Film', 'AR | FOREIGN', {
            audio_language_validation_status: status, audio_tracks_scope: 'file',
            audio_tracks: [{ index: 1, lang: 'fre', channels: 2 }]
        });
        const result = hinted(item);
        assert.equal(result.headline, 'French');
        assert.equal(result.languageStatus, '');
        assert.equal(result.audioSource, 'file');
        assert.equal(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'ar' }).audio.state, 'confirmed_absent');
    }
});

test('exact language observations and codec profiles also outrank a provider interpretation', () => {
    for (const fields of [
        { audio_languages_scope: 'file', audio_languages_observed: true, audio_languages: ['fr'] },
        { codec_profile: { audioTracks: [{ index: 1, language: 'fre' }] } }
    ]) {
        const result = hinted(make('AR ▎ Example', '', { audio_language_validation_status: 'probed', ...fields }));
        assert.equal(result.headline, 'French');
        assert.equal(result.languageStatus, '');
    }
});

test('a known-empty audio map is not resurrected as supplier audio', () => {
    const result = hinted(make('FR ▎ Example', 'FR', { audio_language_validation_status: 'probed',
        audio_tracks_scope: 'file', audio_probed_at: '2026-09-10T00:00:00Z', audio_tracks: [] }));
    assert.equal(result.headline, 'Audio unavailable');
    assert.equal(result.languageStatus, '');
});

test('unvalidated existing tracks cannot be replaced by a conflicting hint', () => {
    const result = hinted(make('AR ▎ Example', 'AR', { audio_language_validation_status: 'pending',
        audio_tracks_scope: 'file', audio_tracks: [{ index: 1, lang: 'fre' }] }));
    assert.equal(result.headline, 'Language unidentified');
    assert.equal(result.languageStatus, '');
});

test('subtitle-only declarations, including translated labels, never name the soundtrack', () => {
    for (const item of [
        make('AR-SUBS - Example', 'AR'), make('FR-ST - Example', 'FR'),
        make('IN ▎ Example', 'HINDI SUBTITLES'), make('HI ▎ Example', 'HINDI SUBTITLED'),
        make('FR ▎ Example', 'FR | VOSTFR'), make('FR ▎ Example', 'FR sous-titres'),
        make('AR ▎ Example', 'AR مترجم'), make('NL ▎ Example', 'NL SUBS')
    ]) assert.equal(hinted(item).headline, 'Language unidentified', JSON.stringify(item));
    assert.equal(hinted(make('AR-SUBS-DUB - Example', 'AR SUB DUB')).headline, 'Arabic');
});

test('country alone, platform, file format and ordinary title words remain unknown', () => {
    for (const item of [
        make('IN ▎ Example', 'INDIA'), make('HU ▎ Example', ''), make('NF ▎ Example', 'DISNEY+'),
        make('Example', '', { container_extension: 'mp4' }), make('So - Example', ''),
        make('Example: Hindi', ''), make('Hindi Medium', ''), make('TOP - HINDI: Example', ''),
        { name: 'FR - Not a raw provider title' }, make('', 'constructor __proto__ toString')
    ]) assert.equal(hinted(item).headline, 'Language unidentified', JSON.stringify(item));
});

test('conflicting and multi-language provider categories do not invent track counts', () => {
    for (const item of [make('FR ▎ Example', 'AR'), make('AL ▎ Example', 'NL'),
        make('Example', 'FR / AR'), make('Example', 'Nordic / Hindi')]) {
        assert.equal(hinted(item).headline, 'Language unidentified');
    }
});

test('active analysis remains visible alongside the unverified qualifier', () => {
    for (const [job, suffix] of [['running', 'Identifying audio'], ['queued', 'Audio pending'], ['retry_wait', 'Audio pending']]) {
        const result = hinted(make('FR ▎ Example', '', { audio_language_validation_job_status: job }));
        assert.equal(result.headline, 'French');
        assert.equal(result.languageStatus, `Provider · Unverified · ${suffix}`);
    }
});

test('reviewed structured provider declarations retain priority and get the same qualifier', () => {
    const result = hinted(make('FR ▎ Example', '', { provider_audio_language_status: 'provider_declared',
        provider_audio_languages: ['hi'] }));
    assert.equal(result.headline, 'Hindi');
    assert.equal(result.languageStatus, 'Provider · Unverified');
    assert.equal(result.audioSource, 'provider-declared');
});

test('the approved fallback does not change compatibility scoring, source IDs or track indices', () => {
    for (const [raw, category] of seven) {
        const item = make(raw, category, { sourceId: 'private-source', stream_id: 'private-stream' });
        const before = JSON.stringify(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'fr' }));
        const result = hinted(item);
        assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item, { preferredAudioLanguage: 'fr' })), before);
        assert.doesNotMatch(JSON.stringify(result), /private-source|private-stream/);
    }
});

test('qualifier, regional group and Somali uncertainty are localized for all ten UI languages', () => {
    for (const { code } of locales) {
        const utility = load(code);
        assert.equal(hinted(make('FR ▎ Example', ''), utility).languageStatus,
            translations.ui_web_provider_language_unverified[code]);
        assert.equal(hinted(make('HU ▎ Example', 'Nordic'), utility).headline,
            translations.ui_web_provider_nordic_languages[code]);
        const somali = utility.languageDisplayFull('so');
        assert.equal(hinted(make('SO ▎ Example', ''), utility).headline,
            translations.ui_web_provider_language_to_confirm[code].replace('{{language}}', somali));
    }
});

test('only Movie and Series version renderers opt in and keep the qualifier outside clamped metadata', () => {
    for (const file of ['MoviesPage.js', 'SeriesPage.js']) {
        const page = fs.readFileSync(path.join(root, 'public/js/pages', file), 'utf8');
        assert.equal((page.match(/providerLanguageHints: true/g) || []).length, 1);
        assert.match(page, /class="version-meta version-language-status">\$\{MediaUtils\.escapeHtml\(desc\.languageStatus\)\}/);
    }
    const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
    assert.match(css, /\.version-language-status\s*\{[^}]*display:\s*block;[^}]*-webkit-line-clamp:\s*unset;/);
});

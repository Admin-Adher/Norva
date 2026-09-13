'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/js/utils/mediaUtils.js'), 'utf8');
const translations = {...require('../i18n/web-dynamic.json'), ...require('../i18n/web-extra.json')};
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
    ['SO ▎ Example Film', '', 'Somali']
];

test('the seven approved interpretations retain internal provenance without creating audio evidence', () => {
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
    // Actual source categories, including older localized media responses that
    // did not yet preserve the raw-title prefix.
    assert.equal(hinted(make('Example Film', 'SCANDINAVIA')).headline, 'Nordic languages');
    assert.equal(hinted(make('Example Film', 'SOMALIA')).headline, 'Somali');
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

test('unaccepted tags retain the catalogue language and internal provenance without upgrading evidence', () => {
    for (const status of ['pending', 'not_analyzed', 'failed', 'rejected']) {
        for (const fields of [
            {audio_tracks_scope:'file', audio_tracks:[{index:1,lang:'fre'}]},
            {codec_profile:{audioTracks:[{index:1,language:'her',title:'Audio 1',codec:'aac',channels:6}]}},
            {audio_tracks_scope:'file',audio_tracks:[],audio_probed_at:null,
                codec_profile:{audioTracks:[{index:1,language:'her'}]}}
        ]) {
            const item = make('EN ▎ In Her Place', 'EN ▎CINEMA MOVIES', {
                audio_language_validation_status:status, ...fields});
            const before = JSON.stringify(item);
            const scoring = JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'en'}));
            const result = hinted(item);
            assert.equal(result.headline, 'English');
            assert.equal(result.internalProviderLabel, 'EN · Provider label');
            assert.equal(result.accessibleHeadline, result.headline);
            assert.equal(result.languageStatus, 'Provider · Unverified');
            assert.equal(result.audioSource, 'provider-label');
            assert.equal(M.catalogLanguageInfo(item).text, result.headline);
            assert.equal(M.versionDescriptor(item).headline, 'Language unidentified');
            assert.equal(M.versionLanguageBadge(item), 'Language unidentified');
            assert.equal(JSON.stringify(item), before);
            assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'en'})), scoring);
            assert.equal(M.providerAudioLanguages(item).length, 0);
        }
    }
});

test('supplier fallback still refuses subtitle tags, contradictions and title prose', () => {
    for (const [raw,category] of [['EN SUBS ▎ Example','EN SUBTITLES'],['EN ▎ Example','FR'],
        ['Johnny English',''],['EN ▎ Example','EN / FR'],['EXYU ▎ Example','']]) {
        const result = hinted(make(raw,category,{audio_language_validation_status:'pending',
            codec_profile:{audioTracks:[{index:1,language:'her'}]}}));
        assert.equal(result.headline, 'Language unidentified');
        assert.equal(result.languageStatus, '');
    }
    const empty = hinted(make('EN ▎ Example','EN',{audio_language_validation_status:'pending',
        audio_tracks_scope:'file',audio_tracks:[],audio_probed_at:'2026-09-13T00:00:00Z',
        codec_profile:{audioTracks:[{index:1,language:'her'}]}}));
    assert.equal(empty.headline, 'Language unidentified');
    assert.equal(empty.languageStatus, '');
});

test('an accepted file language, including a rare ISO language, stays ahead of a supplier tag', () => {
    for (const status of ['probed','verified']) {
        for (const lang of ['fr','hz','or','rn','ab','ch','na']) {
            const item = make('EN ▎ Example','EN',{audio_language_validation_status:status,
                audio_tracks_scope:'file', audio_tracks:[{index:1,lang}]});
            const result = hinted(item);
            assert.equal(result.headline, M.languageDisplayFull(lang));
            assert.equal(result.audioSource, 'file');
            assert.equal(result.languageStatus, '');
        }
    }
});

test('the six reported files use their supplier label after a fresh header replaces obsolete legacy tags', () => {
    const french = load('fr');
    const fixtures = [
        ['FRQ ▎ Stranger in a Cab', 'FR ▎QUEBEC FRENCH', 'Français'],
        ['NL ▎ Cha Cha Real Smooth', 'NL ▎PRIME VIDEO', 'Néerlandais'],
        ['NL ▎ Bring Her Back', 'NL ▎PRIME VIDEO', 'Néerlandais'],
        ['NL ▎ Man on the Run', 'NL ▎PRIME VIDEO', 'Néerlandais'],
        ['EN ▎ \u200e Band on the Run', 'EN ▎CINEMA MOVIES', 'Anglais'],
        ['NL ▎ \u200e Band on the Run', 'NL ▎BIOSCOOP', 'Néerlandais'],
    ];
    for (const [raw, category, expected] of fixtures) {
        // The 2026-09-13 header probe found an AAC track, but no language tag.
        // Provider display must not be confused with verified spoken audio.
        const item = make(raw, category, {
            audio_language_validation_status: 'pending',
            audio_tracks_scope: 'file', audio_probed_at: '2026-09-13T13:44:00Z',
            audio_tracks: [{index: 1, codec: 'aac', channels: 2, default: true}],
            audio_languages_scope: 'file', audio_languages_observed: true, audio_languages: [],
            codec_profile: {audioTracks: [{index: 1, codec: 'aac', channels: 2}]},
        });
        const result = hinted(item, french);
        assert.equal(result.headline, expected, raw);
        assert.equal(result.accessibleHeadline, expected);
        assert.equal(result.audioSource, 'provider-label');
        assert.equal(french.catalogLanguageInfo(item).text, expected);
        assert.doesNotMatch(result.headline, /à confirmer|Étiquette du fournisseur|RN|CH|HZ|NA/);
        assert.equal(french.versionDescriptor(item).headline, 'Langue non identifiée');
    }
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

test('active analysis remains in internal status alongside the unverified qualifier', () => {
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

test('provider qualifications and Somali uncertainty are internal in all ten UI languages', () => {
    for (const { code } of locales) {
        const utility = load(code);
        assert.equal(hinted(make('FR ▎ Example', ''), utility).languageStatus,
            translations.ui_web_provider_language_unverified[code]);
        assert.equal(hinted(make('HU ▎ Example', 'Nordic'), utility).headline,
            translations.ui_web_provider_nordic_languages[code]);
        const somali = utility.languageDisplayFull('so');
        const somaliView = hinted(make('SO ▎ Example', ''), utility);
        assert.equal(somaliView.headline, somali);
        assert.equal(somaliView.languageConfirmationStatus,
            translations.ui_web_provider_language_to_confirm[code].replace('{{language}}', somali));
        const pending = make('EN ▎ In Her Place','EN ▎CINEMA MOVIES', {
            audio_language_validation_status:'pending',codec_profile:{audioTracks:[{index:1,language:'her'}]}});
        const pendingView = hinted(pending,utility);
        assert.equal(pendingView.headline, utility.languageDisplayFull('en'));
        assert.equal(pendingView.internalProviderLabel,
            translations.ui_web_38fc9a457587[code].replace('{{p0}}','EN'));
        for (const item of [pending, make('SO ▎ Example','')]) {
            const view = hinted(item,utility);
            const publicText = [view.headline,view.accessibleHeadline,view.meta,
                utility.languageBadgeHtml(utility.catalogLanguageInfo(item),'test')].join(' ');
            for (const internal of [view.languageStatus,view.languageConfirmationStatus,view.internalProviderLabel]) {
                if (internal) assert.ok(!publicText.includes(internal), `${code}: internal mention leaked`);
            }
        }
    }
});

test('Movie and Series version renderers show interpreted languages but never render internal provenance', () => {
    for (const file of ['MoviesPage.js', 'SeriesPage.js']) {
        const page = fs.readFileSync(path.join(root, 'public/js/pages', file), 'utf8');
        assert.equal((page.match(/providerLanguageHints: true/g) || []).length, 1);
        assert.doesNotMatch(page, /version-language-status|desc\.languageStatus/);
    }
    const css = fs.readFileSync(path.join(root, 'public/css/main.css'), 'utf8');
    assert.doesNotMatch(css, /\.version-language-status/);
});

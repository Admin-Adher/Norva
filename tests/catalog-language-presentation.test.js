'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const translations = require('../i18n/web-extra.json');
const locales = require('../i18n/locales.json');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function load(language = 'en') {
    const ctx = { window: {}, Intl, console, document: { documentElement: { lang: language } },
        NorvaI18n: { language, t(key, args = {}) {
            return (translations[key]?.[language] || args.defaultValue || key)
                .replace(/\{\{(\w+)\}\}/g, (_, k) => args[k] ?? '');
        } } };
    vm.createContext(ctx);
    vm.runInContext(read('public/js/utils/mediaUtils.js'), ctx);
    vm.runInContext(read('public/js/pages/HomePage.js'), ctx);
    return ctx;
}
const ctx = load();
const M = ctx.window.MediaUtils;
const make = (raw, category = '', extra = {}) => ({ item_type: 'movie', raw_title: raw,
    category_name: category, audio_language_validation_status: 'not_analyzed', ...extra });
const info = item => M.catalogLanguageInfo(item);

test('actual Bandit and Malayalam categories work on a single item without a versions list', () => {
    for (const [raw, category, lang] of [['Bandit', 'AL ▎PRIME VIDEO', 'sq'],
        ['Japan Malayalam Dubbed 2023', 'ASIA ▎MALAYALAM DUBBED', 'ml']]) {
        const item = make(raw, category);
        const result = info(item);
        assert.equal(result.headline, M.languageDisplayFull(lang));
        assert.equal(result.languageStatus, 'Provider · Unverified');
        assert.equal(result.headline, M.versionDescriptor(item, { providerLanguageHints: true }).headline);
        assert.equal(M.versionLanguageBadge(item), 'Language unidentified', 'strict evidence API unchanged');
    }
});

test('explicit provider formats are shared by movie, series, Xtream, M3U and Selection shapes', () => {
    const cases = [['EN ▎ Example', '', 'en'], ['4K-DE - Example', '', 'de'],
        ['[ES] Example', '', 'es'], ['Example [PT] (2024)', '', 'pt'],
        ['Example - Tamil Dubbed 2023', '', 'ta'], ['Example Malayalam Dubbed 2023', '', 'ml'],
        ['Example - EN', '', 'en'], ['Example', 'ASIA | TELUGU', 'te'],
        ['Example', 'ASIA | KANNADA DUBBED', 'kn'], ['Example', 'BENGALI', 'bn'],
        ['Example', 'ASIA | ਪੰਜਾਬੀ', 'pa']];
    for (const type of ['movie', 'series']) for (const sourceType of ['xtream', 'm3u', 'selection']) {
        for (const [raw, category, lang] of cases) {
            const item = make(raw, category, { item_type: type, sourceType });
            assert.equal(info(item).headline, M.languageDisplayFull(lang), `${type}/${sourceType}/${raw}/${category}`);
            assert.equal(info(item).languageStatus, 'Provider · Unverified');
        }
    }
});

test('full language words cover regional catalogues without treating countries as soundtracks', () => {
    const names = { English:'en', French:'fr', German:'de', Spanish:'es', Portuguese:'pt', Italian:'it',
        Dutch:'nl', Arabic:'ar', Greek:'el', Albanian:'sq', Russian:'ru', Polish:'pl', Turkish:'tr',
        Hindi:'hi', Telugu:'te', Tamil:'ta', Malayalam:'ml', Kannada:'kn', Bengali:'bn',
        Marathi:'mr', Punjabi:'pa', Gujarati:'gu', Urdu:'ur', Sinhala:'si', Nepali:'ne', Odia:'or',
        Japanese:'ja', Korean:'ko', Chinese:'zh', Cantonese:'yue', Thai:'th', Vietnamese:'vi',
        Indonesian:'id', Malay:'ms', Filipino:'fil', Persian:'fa', Hebrew:'he', Kurdish:'ku',
        Swedish:'sv', Danish:'da', Norwegian:'no', Finnish:'fi', Icelandic:'is', Czech:'cs',
        Slovak:'sk', Slovenian:'sl', Romanian:'ro', Hungarian:'hu', Bulgarian:'bg', Croatian:'hr',
        Serbian:'sr', Bosnian:'bs', Ukrainian:'uk', Lithuanian:'lt', Latvian:'lv', Estonian:'et',
        Catalan:'ca', Basque:'eu', Galician:'gl', Armenian:'hy', Georgian:'ka', Afrikaans:'af',
        Swahili:'sw', Zulu:'zu', Yoruba:'yo', Amharic:'am' };
    for (const [name, lang] of Object.entries(names)) {
        assert.equal(info(make('Example', name + ' MOVIES')).headline, M.languageDisplayFull(lang), name);
    }
});

test('native-script category names remain readable through the same locale-aware resolver', () => {
    for (const [name, lang] of [['हिन्दी','hi'],['தமிழ்','ta'],['മലയാളം','ml'],['বাংলা','bn'],
        ['العربية','ar'],['日本語','ja'],['한국어','ko'],['中文','zh'],['فارسی','fa']]) {
        assert.equal(info(make('Example', name)).headline, M.languageDisplayFull(lang), name);
    }
});

test('source-backed local names and nested rail variants preserve hints without union leakage', () => {
    assert.equal(info({ name: 'EN | Example', sourceId: 'local', item_type: 'movie' }).headline, 'English');
    assert.equal(info({ name: 'EN | Example' }).headline, 'Language unidentified');
    assert.equal(info({ data: { rawTitle: 'FR | Example', categoryName: 'FR | CINEMA' } }).headline, 'French');
    const nested = { audioTracks: [{lang:'fr'}], audioTracksScope:'file',
        defaultVariant: make('NL | Example') };
    assert.equal(info(nested).headline, 'Dutch');
    assert.equal(info(nested).languageStatus, 'Provider · Unverified');
    const observedDefault = { default_variant: make('AR | Example', '', {
        audio_language_validation_status:'probed', audio_tracks_scope:'file', audio_tracks:[{index:1,lang:'fr'}] }) };
    assert.equal(info(observedDefault).headline, 'French');
    assert.equal(info(observedDefault).languageStatus, '');
});

test('observed tracks, verified results and known-empty audio always outrank supplier hints', () => {
    for (const status of ['probed','verified','probed_union','verified_union']) {
        const result = info(make('AR | Example', 'AR | FOREIGN', { audio_language_validation_status:status,
            audio_tracks_scope:'file', audio_tracks:[{index:1,lang:'fr'}] }));
        assert.equal(result.headline, 'French'); assert.equal(result.languageStatus, '');
    }
    const empty = info(make('FR | Example', '', { audio_language_validation_status:'probed',
        audio_tracks_scope:'file', audio_probed_at:'2026-09-10', audio_tracks:[] }));
    assert.equal(empty.headline, 'Audio unavailable'); assert.equal(empty.languageStatus, '');
    const invalidMovie = { item_type:'movie', audio_languages:['es'], audio_languages_scope:'series', audio_language_validation_status:'probed_union' };
    assert.equal(info(invalidMovie).headline, 'Language unidentified');
});

test('title unions stay aggregate while pending maps keep supplier provenance internal', () => {
    const union = info({ item_type:'movie', audioLanguages:['fr','en'], audioLanguageValidationStatus:'probed_union',
        defaultVariant:make('AR | Example') });
    assert.match(union.headline, /FR.*EN/); assert.equal(union.languageStatus, '');
    assert.equal(info(make('AR | Example', '', { audio_tracks_scope:'file', audio_tracks:[{lang:'fr'}],
        audio_language_validation_status:'pending' })).headline, 'Arabic');
});

test('ordinary title words, subtitle-only tags, conflicts and ambiguous territories stay unknown', () => {
    for (const item of [make('Hindi Medium'), make('Johnny English'), make('It'), make('So - Example'),
        make('Example: Hindi'), make('Example', 'FILMES DE AÇÃO'), make('Example', 'NO ADS'),
        make('IN | Example', 'INDIA'), make('AF | Example', 'AFRICAN MOVIES'), make('HU | Example'),
        make('Example [VOSTFR]'), make('AR-SUBS | Example'), make('Example', 'HINDI SUBTITLES'),
        make('FR | Example', 'AR'), make('Example [EN/FR]'), make('MULTI | Example', 'ENGLISH MULTI'),
        make('Example', 'constructor __proto__ toString')]) {
        assert.equal(info(item).headline, 'Language unidentified', JSON.stringify(item));
        assert.equal(info(item).languageStatus, '');
    }
});

test('provenance stays internal and localized without touching public labels, tracks or preferences', () => {
    for (const { code } of locales) {
        const utility = load(code).window.MediaUtils;
        const item = make('Example Malayalam Dubbed 2023');
        const before = JSON.stringify(item);
        const scores = JSON.stringify(utility.analyzeLanguageCompatibility(item, {preferredAudioLanguage:'fr'}));
        const presentation = utility.catalogLanguageInfo(item);
        assert.equal(presentation.headline, utility.languageDisplayFull('ml'));
        assert.equal(presentation.languageStatus, translations.ui_web_provider_language_unverified[code]);
        assert.equal(presentation.text, presentation.headline);
        const markup = utility.languageBadgeHtml(presentation, 'version-language-badge');
        assert.doesNotMatch(markup, /language-badge-status|provider-language-badge/);
        assert.ok(!markup.includes(presentation.languageStatus), 'no visible, tooltip or accessible provenance');
        assert.equal(JSON.stringify(item), before);
        assert.equal(JSON.stringify(utility.analyzeLanguageCompatibility(item, {preferredAudioLanguage:'fr'})), scores);
        assert.equal(utility.providerAudioLanguages(item).length, 0);
    }
    const html = M.languageBadgeHtml({headline:'<script>',text:'PRIVATE_STATUS',languageStatus:'" onmouseover="bad'}, 'x" onclick="bad');
    assert.doesNotMatch(html, /<script>| onmouseover="| onclick="/);
    assert.doesNotMatch(html, /PRIVATE_STATUS|onmouseover/);
});

test('home renders VOD hints without requiring preferences or contaminating a selected variant', () => {
    const home = Object.create(ctx.window.HomePage.prototype);
    home.contentPreferences = {};
    assert.equal(home.cardLanguageBadge(make('NL | Example')), 'Dutch');
    assert.equal(home.cardLanguageBadge({item_type:'channel',name:'FR | Example'}), '');
    const group = { item_type:'movie', audioTracks:[{lang:'fr'}], audioTracksScope:'file',
        audioLanguageValidationStatus:'probed_union', defaultVariant:make('EN | Example') };
    assert.equal(home.cardLanguageBadge(group), 'English');
});

test('every requested surface uses the common display helper, including early series error states', () => {
    for (const [file, minimum] of [['pages/MoviesPage.js',2],['pages/SeriesPage.js',4],['pages/HomePage.js',1],['utils/GenreRails.js',1]]) {
        const source = read('public/js/' + file);
        assert.ok((source.match(/MediaUtils\.catalogLanguageInfo\(/g) || []).length >= minimum, file);
        assert.doesNotMatch(source, /MediaUtils\.versionLanguageBadge\(/, file);
    }
    const series = read('public/js/pages/SeriesPage.js');
    assert.match(series, /const earlyMeta = \[[\s\S]*?MediaUtils\.catalogLanguageInfo\(series/);
    assert.doesNotMatch(read('public/css/main.css'), /\.provider-language-badge|\.version-language-status/);
});

test('opening a rail version never inherits another file category, default variant or audio proof', () => {
    const context=load('fr'); context.MediaUtils=context.window.MediaUtils;
    const home=Object.create(context.window.HomePage.prototype), utility=context.MediaUtils;
    const parent={sourceId:'source',item_type:'movie',title:'An Unexpected Valentine',category_name:'SCANDINAVIA',
        audio_tracks_scope:'file',audio_tracks:[{index:1,lang:'an'}],
        audio_languages:['an'],audio_languages_scope:'file',audio_languages_observed:true,
        audio_language_validation_status:'probed',audio_language_verified_at:'2026-07-18',
        audio_language_verification:{privateFixture:true},audio_language_validation_job_status:'running',
        audio_probed_at:'2026-07-18',metadata:{categoryName:'SCANDINAVIA'},
        codec_profile:{audioTracks:[{index:1,language:'an'}]},
        defaultVariant:{raw_title:'SCAN ▎ An Unexpected Valentine',audio_languages:['an'],
            audio_languages_scope:'file',audio_language_validation_status:'probed',metadata:{categoryName:'SCANDINAVIA'}}};
    parent.default_variant=parent.defaultVariant; parent.data={...parent};
    for (const [tag,category,expected] of [['EN','EN ▎CINEMA MOVIES','en'],['DE','DE ▎PRIME VIDEO','de'],
        ['IT','IT ▎CINEMA','it'],['PL','POLAND','pl'],['ALB','AL ▎PRIME VIDEO','sq'],['AR','AR ▎FOREIGN','ar']]) {
        const variant={sourceId:'source',item_id:tag,raw_title:`${tag} ▎ Example`,
            metadata:{categoryName:category},audio_tracks_scope:'file',audio_tracks:[{index:1,lang:null}],
            audio_language_validation_status:'pending'};
        const before=JSON.stringify({parent,variant});
        const item=home.homeVariantToMediaItem(variant,parent,'movie');
        assert.equal(item.category_name,category);
        assert.equal(utility.versionDescriptor(item,{providerLanguageHints:true}).headline,utility.languageDisplayFull(expected));
        assert.equal(utility.catalogLanguageInfo(item).headline,utility.languageDisplayFull(expected));
        assert.equal(item.audio_language_verified_at,null);
        assert.equal(item.audio_language_validation_job_status,null);
        assert.equal(item.defaultVariant,null); assert.equal(item.default_variant,null);
        assert.deepEqual(JSON.parse(JSON.stringify(item.codec_profile)),{});
        assert.equal(JSON.stringify({parent,variant}),before);
    }
    const sparse={sourceId:'source',item_id:'none',name:'Example'};
    const isolated=home.homeVariantToMediaItem(sparse,parent,'movie');
    assert.equal(utility.catalogLanguageInfo(isolated).headline,'Langue non identifiée');
    assert.equal(isolated.audio_language_validation_status,'not_analyzed');
    assert.equal(isolated.audio_language_verified_at,null);
});

test('rail conversion preserves a real four-language list when ordered tracks are unavailable', () => {
    const context=load('fr'); context.MediaUtils=context.window.MediaUtils;
    const home=Object.create(context.window.HomePage.prototype),utility=context.MediaUtils;
    const variant={sourceId:'source',item_id:'four',raw_title:'IN ▎ Blink Twice',metadata:{categoryName:'ASIA ▎HINDI'},
        audio_languages:['en','hi','ta','te'],audio_languages_scope:'file',audio_languages_observed:true,
        audio_language_validation_status:'probed'};
    const item=home.homeVariantToMediaItem(variant,{title:'Blink Twice',audio_languages:['fr'],
        audio_language_validation_status:'verified',metadata:{categoryName:'FR ▎CINEMA'}},'movie');
    assert.equal(utility.catalogLanguageInfo(item).headline,'EN / HI / TA / TE');
    assert.equal(utility.versionDescriptor(item,{providerLanguageHints:true}).headline,'EN / HI / TA / TE');
    assert.equal(item.audio_language_validation_status,'probed');
    assert.equal(item.audio_language_verified_at,null);
});

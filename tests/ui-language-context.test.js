'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const locales = require('../i18n/locales.json');
const glossary = require('../i18n/glossary.json');
const catalog = require('../scripts/i18n/catalog.cjs').load();
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function runtime() {
    const events = new Map();
    const context = {
        document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} },
        navigator: { languages: ['en'] }, localStorage: { getItem: () => null, setItem() {} },
        Intl, console, setTimeout, clearTimeout,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        addEventListener(type, fn) { events.set(type, fn); },
        removeEventListener(type) { events.delete(type); },
        dispatchEvent(event) { events.get(event.type)?.(event); },
    };
    context.window = context;
    vm.createContext(context);
    for (const file of ['i18n.js', 'utils/mediaUtils.js', 'utils/GenreTaxonomy.js', 'components/TitleRatingControl.js']) {
        vm.runInContext(read('public/js/' + file), context);
    }
    return context;
}

test('context-reviewed copy reaches every packaged locale without machine-draft overrides', () => {
    const r = runtime();
    let checked = 0;
    for (const [key, entry] of Object.entries(catalog)) {
        const expected = glossary[entry.source];
        if (!expected) continue;
        for (let index = 0; index < locales.length; index++) {
            const locale = locales[index].code;
            r.NorvaI18n.setPreference(locale);
            assert.equal(r.NorvaI18n.t(key), expected[index], `${key}/${locale}`);
            checked++;
        }
    }
    assert.ok(checked >= 900);
});

function button() {
    return { attributes: {}, classList: { toggle() {} }, addEventListener() {}, removeEventListener() {},
        setAttribute(key, value) { this.attributes[key] = value; } };
}

test('rating selected/unselected accessible actions survive translation and locale changes', () => {
    const r = runtime(), up = button(), down = button();
    const control = new r.TitleRatingControl({ upButton: up, downButton: down });
    for (const { code } of locales) {
        r.NorvaI18n.setPreference(code);
        for (const rating of [0, 1, -1, 0]) {
            control.desiredRating = rating;
            control.render();
            for (const [target, value] of [[up, 1], [down, -1]]) {
                assert.equal(target.attributes['aria-pressed'], String(rating === value));
                const key = target.attributes['data-i18n-aria-label'];
                assert.equal(target.attributes['aria-label'], r.NorvaI18n.t(key));
                assert.equal(target.title, r.NorvaI18n.t(target.attributes['data-i18n-title']));
            }
        }
    }
    control.desiredRating = 1;
    r.NorvaI18n.setPreference('fr');
    assert.equal(up.title, 'Retirer mon « J’aime »');
    assert.equal(down.title, 'Je n’aime pas');
    control.destroy();
});

test('catalogue audio names and counts follow all ten UI languages, preserving facet values', () => {
    const r = runtime();
    for (const { code } of locales) {
        r.NorvaI18n.setPreference(code);
        const names = new Intl.DisplayNames([code], { type: 'language' });
        for (const language of ['fr', 'es', 'pt', 'te', 'hi', 'ar']) {
            const full = names.of(language), expected = full.charAt(0).toLocaleUpperCase(code) + full.slice(1);
            for (const prefix of ['', 'provider-', 'catalog-']) {
                const facet = { value: prefix + language, label: 'English · 1,201 movies', count: 1201 };
                assert.equal(r.MediaUtils.languageFacetLabel(facet), `${expected} · ${new Intl.NumberFormat(code).format(1201)}`);
                assert.equal(facet.value, prefix + language);
            }
        }
        assert.equal(r.GenreTaxonomy.label('comedie'), r.NorvaI18n.t('ui_web_85f1c8c8e324'));
        assert.equal(r.GenreTaxonomy.label('private-provider-id', 'Provider category'), 'Provider category');
    }
    r.NorvaI18n.setPreference('fr');
    assert.equal(r.MediaUtils.languageFacetName('es', 'Spanish · 1 movies'), 'Espagnol');
    assert.equal(r.MediaUtils.languageFacetLabel({value:'catalog-hi',label:'Hindi · 12 movies'}), 'Hindi · 12');
    assert.equal(r.MediaUtils.languageFacetLabel({value:'fr',count:0}), 'Français · 0');
    assert.equal(r.MediaUtils.audioLanguageBadge(['es'], []), 'Espagnol');
});

test('French contextual meanings stay distinct from comparison, shopping and clock vocabulary', () => {
    const r = runtime(); r.NorvaI18n.setPreference('fr');
    for (const [key, expected] of Object.entries({
        ui_web_64f915cb8bfc: 'J’aime', ui_web_d81123b5e9a4: 'Je n’aime pas',
        ui_web_69371af8df88: 'État de visionnage', ui_web_90a92d7ef85b: 'Épisodes spéciaux',
        ui_web_150040557337: 'Distribution', ui_web_67f859b06127: 'Retour au direct',
        ui_web_07c0fe6b995f: 'Économiser les données', ui_catalog_section: 'Catalogue',
        ui_languages_section: 'Langues', ui_display_section: 'Affichage',
    })) assert.equal(r.NorvaI18n.t(key), expected);
});

test('DOM plural counts survive argument filtering without accepting language overrides', () => {
    const r = runtime(); r.NorvaI18n.setPreference('fr');
    for (const [count, expected] of [[1, '1 saison'], [2, '2 saisons']]) {
        const attrs = {'data-i18n':'ui_season_count','data-i18n-args':JSON.stringify({count,lng:'en',defaultValue:'wrong'})};
        const element = { nodeType:1, children:[], textContent:count+' seasons',
            closest:()=>null, matches:()=>true, querySelectorAll:()=>[],
            hasAttribute:key=>Object.hasOwn(attrs,key), getAttribute:key=>attrs[key]||null,
            setAttribute:(key,value)=>{attrs[key]=value;} };
        r.NorvaI18n.translate(element);
        assert.equal(element.textContent, expected);
    }
});

test('actual fiche back actions localize the default but retain search and provider context', () => {
    const r = runtime();
    for (const [page, key] of [['MoviesPage','ui_movies'], ['SeriesPage','ui_series']]) {
        const source = read(`public/js/pages/${page}.js`);
        const start = source.indexOf('        // Context-aware back label');
        const body = source.slice(start, source.indexOf('\n\n        //', start + 30));
        const label = { textContent:'' };
        r.backPage = {detailsPanel:{querySelector:()=>({querySelector:()=>label})}, searchInput:{value:''}};
        for (const {code} of locales) {
            r.NorvaI18n.setPreference(code);
            for (const [search, bucket, expected] of [
                ['', '', r.NorvaI18n.t(key)],
                ['query', '', r.NorvaI18n.t('ui_web_e978b00de465')],
                ['', 'Provider category', 'Provider category'],
            ]) {
                r.backPage.searchInput.value=search; r.backPage.activeBucket=Boolean(bucket); r.backPage.bucketLabel=bucket;
                vm.runInContext(`(function(){${body}}).call(backPage)`,r);
                assert.equal(label.textContent,expected,`${page}/${code}`);
            }
        }
    }
});

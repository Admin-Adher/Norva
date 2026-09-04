'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalize, resolve, locales } = require('../i18n/language.cjs');
const messages = require('../i18n/messages.json');

test('device matching uses supported language priority, variants and legacy aliases', () => {
    assert.equal(locales.length, 10);
    for (const [input, output] of Object.entries({ 'fr-CA': 'fr', 'pt-PT': 'pt-BR', 'PT_br': 'pt-BR',
        'en-IN': 'en', 'bn-BD': 'bn', 'ar-MA': 'ar', 'tl-PH': 'fil', in: 'id', 'hi-IN': 'hi', 'tr-TR': 'tr', 'es-MX': 'es' })) {
        assert.equal(normalize(input), output, input);
    }
    assert.equal(resolve('auto', ['de-DE', 'fr-CA', 'en']), 'fr');
    assert.equal(resolve('auto', ['de-DE']), 'en');
    assert.equal(resolve('fr', ['ar-MA']), 'fr');
    assert.equal(resolve('auto', []), 'en');
    assert.equal(normalize('<script>'), '');
    assert.equal(normalize('en;fr'), '');
});

function runtime({ stored = null, native, denied = false, languages = ['fr-FR'] } = {}) {
    const entries = new Map(stored ? [['norva-ui-language-v1', stored]] : []);
    const handlers = new Map();
    const document = {
        documentElement: {}, querySelectorAll: () => [],
        addEventListener() {},
    };
    const localStorage = {
        getItem(key) { if (denied) throw Error('denied'); return entries.get(key) ?? null; },
        setItem(key, value) { if (denied) throw Error('denied'); entries.set(key, value); },
    };
    const context = { document, localStorage, navigator: { languages }, console,
        setTimeout, clearTimeout, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        addEventListener(type, fn) { handlers.set(type, fn); }, dispatchEvent() {}, NorvaTVCloud: native };
    context.window = context;
    vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/i18n.js'), 'utf8'), context);
    return { api: context.NorvaI18n, entries, document, handlers };
}

test('web switch persists only the UI preference and updates direction immediately', () => {
    const { api, entries, document } = runtime();
    assert.equal(api.language, 'fr');
    assert.equal(api.setPreference('ar'), true);
    assert.equal(api.t('ui_settings'), 'الإعدادات');
    assert.equal(document.documentElement.dir, 'rtl');
    assert.deepEqual([...entries], [['norva-ui-language-v1', 'ar']]);
    assert.equal(api.setPreference('auto'), true);
    assert.equal(document.documentElement.dir, 'ltr');
    assert.equal(api.language, 'fr');
    assert.equal(api.setPreference('de'), false);
    assert.equal(api.language, 'fr');
});

test('Android is authoritative over browser languages and an old browser preference', () => {
    const calls = [];
    const { api, entries } = runtime({ stored: 'es', languages: ['fr'], native: {
        getUiLanguageState: () => JSON.stringify({ preference: 'auto', deviceLanguages: ['hi-IN'] }),
        setUiLanguage: value => { calls.push(value); return true; },
    } });
    assert.equal(api.language, 'hi');
    assert.equal(api.setPreference('bn'), true);
    assert.equal(api.language, 'bn');
    assert.deepEqual(calls, ['bn']);
    assert.equal(entries.get('norva-ui-language-v1'), 'es');
    assert.equal(api.setPreference('auto'), true);
    assert.equal(api.language, 'hi');
});

test('failed persistence does not announce or apply an unsaved preference', () => {
    const web = runtime({ denied: true });
    assert.equal(web.api.language, 'fr');
    assert.equal(web.api.setPreference('ar'), false);
    assert.equal(web.api.language, 'fr');
    const native = runtime({ native: {
        getUiLanguageState: () => JSON.stringify({ preference: 'en', deviceLanguages: ['ar'] }),
        setUiLanguage: () => false,
    } });
    assert.equal(native.api.setPreference('ar'), false);
    assert.equal(native.api.language, 'en');
});

test('all registered messages are genuinely present in every packaged locale', () => {
    for (const locale of locales) {
        const { api } = runtime({ languages: [locale.code] });
        for (const [key, translations] of Object.entries(messages)) {
            assert.equal(translations.length, locales.length, key);
            assert.equal(api.t(key), translations[locales.indexOf(locale)], `${locale.code}:${key}`);
        }
    }
});

test('external language preference changes are reflected without content-setting writes', () => {
    const { api, entries, handlers } = runtime();
    entries.set('norva-ui-language-v1', 'tr');
    handlers.get('storage')({ key: 'norva-ui-language-v1' });
    assert.equal(api.language, 'tr');
    entries.delete('norva-ui-language-v1');
    handlers.get('storage')({ key: null });
    assert.equal(api.language, 'fr');
});

test('offline locale caching accepts only exact public asset hashes and no extra parameters', () => {
    const source = fs.readFileSync(require.resolve('../public/sw.js'), 'utf8');
    const block = source.slice(source.indexOf('function canCacheRequest('), source.indexOf('// Anything that streams'));
    const context = { URL, self: { location: { origin: 'https://norva.tv' } } };
    vm.runInNewContext(block + '\nthis.check = canCacheRequest;', context);
    assert.equal(context.check({ url: 'https://norva.tv/js/i18n.js?v=abcdef1234' }), true);
    assert.equal(context.check({ url: 'https://norva.tv/css/i18n.css?v=abcdef1234' }), true);
    for (const url of ['https://norva.tv/js/i18n.js?v=abcdef1234&token=secret',
        'https://norva.tv/account.html?v=abcdef1234', 'https://other.test/js/i18n.js?v=abcdef1234',
        'https://norva.tv/partners-kyc-return?status=ok', 'https://norva.tv/js/i18n.js?v=latest']) {
        assert.equal(context.check({ url }), false, url);
    }
});

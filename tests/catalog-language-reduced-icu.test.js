'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/utils/mediaUtils.js'), 'utf8');
const names = {
    en: ['Kurdish', 'Maltese'], fr: ['Kurde', 'Maltais'], 'pt-BR': ['Curdo', 'Maltês'],
    es: ['Kurdo', 'Maltés'], hi: ['कुर्दिश', 'माल्टीज़'], tr: ['Kürtçe', 'Maltaca'],
    bn: ['কুর্দিশ', 'মল্টিজ'], ar: ['الكردية', 'المالطية'], id: ['Kurdi', 'Malta'], fil: ['Kurdish', 'Maltese']
};
for (const behavior of ['undefined', 'code', 'missing']) {
    test(`reduced WebView ICU (${behavior}) keeps localized Kurdish and Maltese labels and facets`, () => {
        for (const [locale, expected] of Object.entries(names)) {
            const ctx = { window: {}, console, NorvaI18n: { language: locale, t: (_, options) => options?.defaultValue },
                Intl: behavior === 'missing' ? {} : { DisplayNames: class {
                    of(code) { return behavior === 'code' ? code : undefined; }
                } } };
            vm.runInNewContext(source, ctx);
            const M = ctx.window.MediaUtils;
            assert.equal(M.languageDisplayFull('ku'), expected[0]);
            assert.equal(M.languageDisplayFull('mt'), expected[1]);
            assert.equal(M.languageFacetName('catalog-ku'), expected[0]);
            assert.equal(M.languageFacetName('catalog-mt'), expected[1]);
        }
    });
}
test('full ICU names remain preferred and unsupported code labels are not invented', () => {
    const ctx = { window: {}, console, Intl, NorvaI18n: { language: 'fr', t: (_, options) => options?.defaultValue } };
    vm.runInNewContext(source, ctx);
    assert.equal(ctx.window.MediaUtils.languageDisplayFull('ku'), 'Kurde');
    assert.equal(ctx.window.MediaUtils.languageDisplayFull('mt'), 'Maltais');
});

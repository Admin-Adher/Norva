'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const cases = require('./fixtures/provider-indian-language-tags');
const ctx = { window: {}, Intl, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(require.resolve('../public/js/utils/mediaUtils.js'), 'utf8'), ctx);
test('supplier shelf tags agree in browser and import parser without certifying tracks', async () => {
    const {providerCatalogLanguage} = await import('../supabase/functions/_shared/provider-catalog-language.mjs');
    for (const [raw, category, expected] of cases) {
        const item = {item_type:'movie', raw_title:raw, category_name:category,
            audio_language_validation_status:'not_analyzed'};
        assert.equal(providerCatalogLanguage(item), expected, raw + ' / ' + category);
        assert.equal(ctx.window.MediaUtils.catalogLanguageInfo(item).headline,
            expected ? ctx.window.MediaUtils.languageDisplayFull(expected) : 'Language unidentified');
        assert.equal(item.audio_language_validation_status, 'not_analyzed');
    }
});
test('exact file observations stay ahead of the advertised supplier language', () => {
    const item = {item_type:'movie',raw_title:'TG - Example',category_name:'VOD - INDIA',
        audio_language_validation_status:'probed',audio_tracks_scope:'file',
        audio_probed_at:'2026-10-03T10:00:00Z',audio_tracks:[{index:1,lang:'en'}]};
    assert.equal(ctx.window.MediaUtils.catalogLanguageInfo(item).headline, 'English');
    assert.equal(item.audio_tracks[0].lang, 'en');
});

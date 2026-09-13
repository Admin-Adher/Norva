'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const cases = require('./fixtures/provider-language-audit-remediation');
const root = path.join(__dirname, '..');
const context = { window: {}, Intl, console };
vm.runInNewContext(fs.readFileSync(path.join(root,'public/js/utils/mediaUtils.js'),'utf8'), context);
const M = context.window.MediaUtils;
const shared = () => Promise.all([
    import(pathToFileURL(path.join(root,'supabase/functions/_shared/provider-catalog-language.mjs'))),
    import(pathToFileURL(path.join(root,'supabase/functions/_shared/selection-provider-languages.mjs')))
]);
const itemFor = (raw,category,item_type='movie') => ({item_type,raw_title:raw,metadata:{categoryName:category},audio_language_validation_status:'not_analyzed'});

test('residual audit: exact declared-label families agree across browser, shared parser and filters', async () => {
    const [{providerCatalogLanguage}, {catalogProviderAudioLanguages,catalogVariantMatchesAudio}] = await shared();
    for(const kind of ['movie','series']) for(const [raw,category,expected] of cases) {
        const item=itemFor(raw,category,kind), label=`${kind}: ${raw} / ${category}`;
        assert.equal(providerCatalogLanguage(item),expected,label);
        assert.deepEqual(catalogProviderAudioLanguages(item),expected?[expected]:[],label);
        assert.equal(catalogVariantMatchesAudio(item,'unidentified'),!expected,label);
        const d=M.versionDescriptor(item,{providerLanguageHints:true});
        assert.equal(d.headline,expected==='exyu'?'Ex-Yugoslav':expected?M.languageDisplayFull(expected):'Language unidentified',label);
        if(expected) assert.equal(catalogVariantMatchesAudio(item,`catalog-${expected}`),true,label);
        if(expected==='exyu') {
            assert.equal(d.kind,'region',label);
            assert.equal(d.audioSource,'provider-region',label);
        }
    }
});

test('residual audit: reliable exact-file observations outrank every repaired supplier declaration', async () => {
    const [, {catalogVariantMatchesAudio}]=await shared();
    for(const [raw,category,expected] of cases.filter(c=>c[2])) for(const codes of [['de'],['nl'],['ta'],['de','nl']]) {
        const item={...itemFor(raw,category),audio_language_validation_status:'verified',audio_tracks_scope:'file',
            audio_tracks:codes.map((lang,index)=>({index:index+2,lang,channels:6,codec:'aac'})),
            audio_languages_scope:'file',audio_languages_observed:true,audio_languages:codes,
            __file_audio_observed:true,__file_audio_languages:codes};
        const before=JSON.stringify(item), d=M.versionDescriptor(item,{providerLanguageHints:true});
        assert.equal(d.audioSource,'file',raw);
        for(const code of codes) assert.equal(catalogVariantMatchesAudio(item,`catalog-${code}`),true,raw);
        if(!codes.includes(expected)) assert.equal(catalogVariantMatchesAudio(item,`catalog-${expected}`),false,raw);
        assert.equal(JSON.stringify(item),before,'never rewrite reliable file evidence');
    }
});

test('residual audit: declarations never fabricate observations, track counts or visible internal provenance', async () => {
    for(const [raw,category,expected] of cases.filter(c=>c[2])) {
        const item=itemFor(raw,category), before=JSON.stringify(item);
        const compatibility=JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:expected}));
        const d=M.versionDescriptor(item,{providerLanguageHints:true});
        assert.equal(M.providerAudioLanguages(item).length,0,raw);
        assert.equal(M.versionDescriptor(item).headline,'Language unidentified',raw);
        assert.equal(JSON.stringify(item),before,raw);
        assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:expected})),compatibility,raw);
        assert.doesNotMatch([d.headline,d.accessibleHeadline,d.meta].join(' '),/Provider label|Unverified|to confirm/);
    }
});

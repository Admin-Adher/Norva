'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const cases = require('./fixtures/provider-turkish-subtitle-roles');
const root = path.join(__dirname, '..');
const context = {window:{}, Intl, console};
vm.runInNewContext(fs.readFileSync(path.join(root,'public/js/utils/mediaUtils.js'),'utf8'), context);
const M = context.window.MediaUtils;
const modules = () => Promise.all([
    import(pathToFileURL(path.join(root,'supabase/functions/_shared/provider-catalog-language.mjs'))),
    import(pathToFileURL(path.join(root,'supabase/functions/_shared/selection-provider-languages.mjs')))
]);
const item = (raw,category,kind='series') => ({item_type:kind,raw_title:raw,metadata:{categoryName:category},audio_language_validation_status:'not_analyzed'});

test('audited Turkish shelves separate Arabic subtitles across browser and server filters', async () => {
    const [{providerCatalogLanguage},{catalogVariantMatchesAudio}] = await modules();
    for (const kind of ['movie','series']) for (const [raw,category,expected] of cases) {
        const value=item(raw,category,kind), label=`${kind}: ${raw} / ${category}`;
        const original=JSON.stringify(value);
        assert.equal(providerCatalogLanguage(value),expected,label);
        assert.equal(catalogVariantMatchesAudio(value,'unidentified'),!expected,label);
        assert.equal(catalogVariantMatchesAudio(value,'catalog-tr'),expected==='tr',label);
        assert.equal(catalogVariantMatchesAudio(value,'catalog-ar'),false,label);
        assert.equal(M.versionDescriptor(value,{providerLanguageHints:true}).headline,expected?'Turkish':'Language unidentified',label);
        assert.equal(JSON.stringify(value),original,label);
    }
});

test('exact file evidence outranks every subtitle shelf, including conflicts and multiple tracks', async () => {
    const [, {catalogVariantMatchesAudio}] = await modules();
    for (const [raw,category] of cases) for (const codes of [['ar'],['nl'],['en','hi']]) {
        const value={...item(raw,category),audio_language_validation_status:'verified',audio_tracks_scope:'file',
            audio_tracks:codes.map((lang,index)=>({index:index+2,lang,channels:2,codec:'aac'})),
            audio_languages_scope:'file',audio_languages_observed:true,audio_languages:codes,
            __file_audio_observed:true,__file_audio_languages:codes};
        const original=JSON.stringify(value), d=M.versionDescriptor(value,{providerLanguageHints:true});
        assert.equal(d.audioSource,'file',raw);
        assert.equal(catalogVariantMatchesAudio(value,'catalog-tr'),false,raw);
        for(const code of codes) assert.equal(catalogVariantMatchesAudio(value,`catalog-${code}`),true,raw);
        assert.equal(JSON.stringify(value),original,raw);
    }
});

test('provider subtitle role repair does not fabricate audio observations or playback preferences', () => {
    for (const [raw,category,expected] of cases.filter(c=>c[2])) {
        const value=item(raw,category), original=JSON.stringify(value);
        const compatibility=JSON.stringify(M.analyzeLanguageCompatibility(value,{preferredAudioLanguage:expected}));
        assert.equal(M.versionDescriptor(value).headline,'Language unidentified',raw);
        assert.equal(M.providerAudioLanguages(value).length,0,raw);
        M.versionDescriptor(value,{providerLanguageHints:true});
        assert.equal(JSON.stringify(value),original,raw);
        assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(value,{preferredAudioLanguage:expected})),compatibility,raw);
    }
});

test('forward migration preserves the previously published parser and all helper definitions', () => {
    const read=name=>fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8').replace(/\r\n/g,'\n');
    const prior=read('20260914001734_provider_language_structured_declarations.sql');
    const next=read('20260914045000_turkish_audio_arabic_subtitle_roles.sql');
    const marker="  -- Full provider shelf + prefix evidence; no country or generic AR/TR alias.";
    const start=next.indexOf(marker), end=next.indexOf("  if category_key in ('افلام تركية مدبلجة'",start);
    assert.ok(start>0 && end>start);
    const withoutRule=next.slice(0,start)+next.slice(end);
    assert.equal(withoutRule.replace('-- Exact Turkish-audio / Arabic-subtitle declarations from the ten-image audit.',
        '-- Structured supplier declarations confirmed by the September 14 residual audit.'),prior);
    assert.equal((next.match(/create or replace function/g)||[]).length,1);
    assert.doesNotMatch(next,/\b(?:insert into|update|delete from|create table|alter|drop|grant|revoke|truncate|copy|call)\b/i);
    assert.ok(createHash('sha256').update(prior).digest('hex').length===64);
});

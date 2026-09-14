'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {createHash}=require('node:crypto');
const cases=require('./fixtures/provider-autonomous-turkish-roles');
const root=path.join(__dirname,'..');
const context={window:{},Intl,console};
vm.runInNewContext(fs.readFileSync(path.join(root,'public/js/utils/mediaUtils.js'),'utf8'),context);
const M=context.window.MediaUtils;
const load=()=>Promise.all([
    import(pathToFileURL(path.join(root,'supabase/functions/_shared/provider-catalog-language.mjs'))),
    import(pathToFileURL(path.join(root,'supabase/functions/_shared/selection-provider-languages.mjs'))),
]);
const item=(raw,category,kind)=>({item_type:kind,raw_title:raw,metadata:{categoryName:category},audio_language_validation_status:'not_analyzed'});

test('autonomous exact-shelf rules agree across frontend declarations and catalogue filters',async()=>{
    const [{providerCatalogLanguage},{catalogVariantMatchesAudio}]=await load();
    for(const kind of ['movie','series']) for(const [raw,category,expected]of cases){
        const value=item(raw,category,kind),saved=JSON.stringify(value);
        assert.equal(providerCatalogLanguage(value),expected,raw);
        assert.equal(catalogVariantMatchesAudio(value,'unidentified'),!expected,raw);
        assert.equal(catalogVariantMatchesAudio(value,'catalog-tr'),expected==='tr',raw);
        assert.equal(catalogVariantMatchesAudio(value,'catalog-ar'),false,raw);
        const descriptor=M.versionDescriptor(value,{providerLanguageHints:true});
        assert.equal(descriptor.headline,expected?M.languageDisplayFull('tr'):'Language unidentified',raw);
        assert.doesNotMatch(descriptor.headline,/verify|vérifier/i);
        assert.equal(JSON.stringify(value),saved,raw);
    }
});

test('known file audio stays authoritative and provider fallback never fabricates tracks',async()=>{
    const [, {catalogVariantMatchesAudio}]=await load();
    for(const [raw,category]of cases.filter(c=>c[2])){
        const base=item(raw,category,'movie'),saved=JSON.stringify(base);
        assert.equal(M.providerAudioLanguages(base).length,0,raw);
        assert.equal(M.versionDescriptor(base).headline,'Language unidentified',raw);
        M.versionDescriptor(base,{providerLanguageHints:true});
        assert.equal(JSON.stringify(base),saved,raw);
        for(const audio of [['ar'],['en'],['fr','de']]){
            const value={...base,audio_language_validation_status:'verified',audio_tracks_scope:'file',
                audio_tracks:audio.map((lang,index)=>({index:index+2,lang,channels:2,codec:'aac'})),
                audio_languages_scope:'file',audio_languages_observed:true,audio_languages:audio,
                __file_audio_observed:true,__file_audio_languages:audio};
            const original=JSON.stringify(value);
            assert.equal(catalogVariantMatchesAudio(value,'catalog-tr'),false,raw);
            assert.equal(catalogVariantMatchesAudio(value,'unidentified'),false,raw);
            for(const code of audio)assert.equal(catalogVariantMatchesAudio(value,`catalog-${code}`),true,raw);
            assert.equal(M.versionDescriptor(value,{providerLanguageHints:true}).audioSource,'file',raw);
            assert.equal(JSON.stringify(value),original,raw);
        }
    }
});

test('autonomous SQL is a forward parser-only extension of the published market rules',()=>{
    const read=name=>fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8').replace(/\r\n/g,'\n');
    const prior=read('20260914061000_provider_market_audio_declarations.sql');
    const next=read('20260914120000_autonomous_turkish_subtitle_roles.sql');
    const start=next.indexOf('  -- Autonomous audit: exact Turkish movie/current-series subtitle shelves.');
    const end=next.indexOf("  if category_key in ('افلام تركية مدبلجة'",start);
    assert.ok(start>0 && end>start);
    const restored=(next.slice(0,start)+next.slice(end))
        .replace("raw := regexp_replace(raw,'\\s+\\[SUB\\]\\s*$','','i');",()=>"raw := regexp_replace(raw,'\\s+\\[SUB\\]\\s*$','');")
        .replace('-- Autonomous exact Turkish subtitle-role corrections; no generic aliases.',
            '-- Exact LA/IN and French-audio subtitle shelves from the five-image audit.');
    assert.equal(restored,prior);
    assert.equal((next.match(/create or replace function/g)||[]).length,1);
    assert.doesNotMatch(next,/\b(?:insert into|update|delete from|create table|alter|drop|grant|revoke|truncate|copy|call)\b/i);
    assert.equal(createHash('sha256').update(prior).digest('hex').length,64);
});

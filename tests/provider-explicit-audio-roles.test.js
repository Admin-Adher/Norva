'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const cases=require('./fixtures/provider-explicit-audio-roles');
const ctx={window:{},Intl};vm.runInNewContext(fs.readFileSync(require.resolve('../public/js/utils/mediaUtils.js'),'utf8'),ctx);
test('explicit audio roles agree in browser/import without inventing observed tracks',async()=>{
 const {providerCatalogLanguage}=await import('../supabase/functions/_shared/provider-catalog-language.mjs');
 for(const [raw,category,expected] of cases){
  const row={raw_title:raw,metadata:{categoryName:category},item_type:'movie',audio_language_validation_status:'not_analyzed'};
  const before=JSON.stringify(row);
  assert.equal(providerCatalogLanguage(row),expected,`${raw} / ${category}`);
  const info=ctx.window.MediaUtils.catalogLanguageInfo(row);
  assert.equal(info.audioSource,expected?'provider-label':'none',`${raw} / ${category}`);
  assert.equal(JSON.stringify(row),before);
 }
});
test('observed file languages override the matching market fallback',()=>{
 for(const [raw,category,expected] of cases.filter(x=>x[2]&&x[2]!=='en')){
  const row={raw_title:raw,category_name:category,item_type:'movie',audio_language_validation_status:'probed',
   audio_tracks_scope:'file',audio_tracks:[{index:1,lang:'en'}]};
  assert.equal(ctx.window.MediaUtils.catalogLanguageInfo(row).headline,'English',raw);
  assert.equal(row.audio_tracks[0].lang,'en');
 }
});


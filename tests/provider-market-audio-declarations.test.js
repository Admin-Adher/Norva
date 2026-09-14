'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const cases=require('./fixtures/provider-market-audio-declarations');
const translations={...require('../i18n/web-dynamic.json'),...require('../i18n/web-extra.json')};
const root=path.join(__dirname,'..');
const code=fs.readFileSync(path.join(root,'public/js/utils/mediaUtils.js'),'utf8');
function load(locale='fr') {
 const ctx={window:{},Intl,NorvaI18n:{language:locale,t(key,args={}) {
  return (translations[key]?.[locale] || args.defaultValue || key).replace(/\{\{(\w+)\}\}/g,(_,k)=>args[k]??'');
 }}};
 vm.runInNewContext(code,ctx);return ctx.window.MediaUtils;
}
const M=load();
const row=(raw,category)=>({raw_title:raw,metadata:{categoryName:category},item_type:'movie',audio_language_validation_status:'not_analyzed'});
test('five-image provider declarations remain bounded and identical across browser and server',async()=>{
 const {providerCatalogLanguage}=await import(pathToFileURL(path.join(root,'supabase/functions/_shared/provider-catalog-language.mjs')));
 for(const [raw,category,expected] of cases) {
  const item=row(raw,category),before=JSON.stringify(item);
  assert.equal(providerCatalogLanguage(item),expected,raw+'/'+category);
  assert.equal(M.catalogLanguageInfo(item).headline,expected?M.languageDisplayFull(expected):'Langue non identifiée',raw+'/'+category);
  assert.equal(JSON.stringify(item),before);
 }
});
test('With Love names all five languages in both ordered and language-only maps',()=>{
 const langs=['ta','hi','kn','ml','te'];
 for(const fields of [{audio_tracks_scope:'file',audio_tracks:langs.map((lang,index)=>({index:index+1,lang}))},
  {audio_languages_scope:'file',audio_languages:langs,audio_languages_observed:true}]) {
  const item={...row('NF - With Love (2026)','NETFLIX ASIA'),...fields,audio_language_validation_status:'probed'};
  const before=JSON.stringify(item),info=M.catalogLanguageInfo(item);
  assert.equal(info.headline,'TA / HI / KN / ML / TE');
  assert.equal(info.accessibleHeadline,langs.map(M.languageDisplayFull).join(' / '));
  assert.equal(M.versionDescriptor(item,{providerLanguageHints:true}).headline,info.headline);
  assert.equal(JSON.stringify(item),before);
 }
});
test('subtitle provider tags never claim burned-in proof or create audio',()=>{
 const item=row('AR-SUBS - Aida, the Movie (2026)','أفلام أجنبية 2026');
 const before=JSON.stringify(item),d=M.versionDescriptor(item,{providerLanguageHints:true});
 assert.equal(d.headline,'Langue non identifiée');
 assert.match(d.meta,/Sous-titres : Arabe · fournisseur/);
 assert.doesNotMatch(d.meta,/brûlé|burned|incrust/);
 assert.equal(JSON.stringify(item),before);
 for(const locale of require('../i18n/locales.json').map(l=>l.code)) {
  assert.doesNotMatch(load(locale).versionDescriptor(item).meta,/burned-in|brûlé|queimado|quemado|yanmış|محترق|terbakar|nasunog/);
 }
});
test('ES versus unverified EN cache is visible as a conflict without rewriting audio evidence',()=>{
 const item={...row('ES - Aída y vuelta (2026)','ES - PELÍCULAS 2026'),audio_language_validation_status:'probed',
  audio_probed_at:'2026-08-31T20:35:11Z',audio_tracks_scope:'file',audio_tracks:[{index:1,lang:'en'}]};
 const before=JSON.stringify(item),score=JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'es'}));
 const info=M.catalogLanguageInfo(item);
 assert.equal(info.headline,'Audio à vérifier');
 assert.match(info.accessibleHeadline,/Fournisseur : Espagnol.*fichier : Anglais/);
 assert.equal(info.audioSource,'file');assert.equal(info.languageConflict,true);
 assert.match(M.languageBadgeHtml(info,'badge'),/aria-label="Fournisseur : Espagnol/);
 assert.equal(JSON.stringify(item),before);
 assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'es'})),score);
 for(const verified of [{audio_language_validation_status:'verified'},{audio_language_verified_at:'2026-09-14T05:00:00Z'}]) {
  assert.equal(M.catalogLanguageInfo({...item,...verified}).headline,'Anglais');
 }
 assert.equal(M.catalogLanguageInfo({...item,audio_tracks:[{index:1,lang:'es'}]}).headline,'Espagnol');
 assert.equal(M.catalogLanguageInfo({...item,audio_tracks:[{index:1,lang:'es'},{index:2,lang:'en'}]}).headline,'ES / EN');
 assert.equal(M.catalogLanguageInfo({...item,raw_title:'AR-SUBS - Aida',metadata:{categoryName:''}}).headline,'Anglais');
});

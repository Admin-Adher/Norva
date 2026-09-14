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
test('PH Tagalog SUB is a subtitle declaration, not Filipino audio or a global PH alias',()=>{
 const item=row('PH - The Roast of Kevin Hart (2026)','PH - TAGALOG SUB MOVIES');
 const before=JSON.stringify(item),descriptor=M.versionDescriptor(item,{providerLanguageHints:true});
 assert.equal(descriptor.headline,'Langue non identifiée');
 assert.match(descriptor.meta,new RegExp('Sous-titres : '+M.languageDisplayFull('fil')));
 assert.doesNotMatch(descriptor.meta,/brûlé|burned|incrust/);
 assert.equal(JSON.stringify(item),before);
 for(const category of ['PH - PHILIPPINES FILM','PH - EVENTS','PH - TAGALOG DUB MOVIES','PH - TAGALOG SUB MOVIES OTHER']) {
  assert.doesNotMatch(M.versionDescriptor({...item,metadata:{categoryName:category}},{providerLanguageHints:true}).meta,/Sous-titres :/);
 }
 const observed={...item,audio_language_validation_status:'probed',audio_tracks_scope:'file',audio_tracks:[{index:1,lang:'en'}],
  subtitle_tracks_scope:'file',subtitle_tracks:[{index:2,lang:'es'}]};
 const known=M.versionDescriptor(observed,{providerLanguageHints:true});
 assert.equal(known.headline,'Anglais');assert.match(known.meta,/ST ES/);assert.doesNotMatch(known.meta,/fournisseur/);
});
test('new screenshots retain only independently supported audio declarations',()=>{
 for(const [raw,category,expected] of [
  ['NF - Love in Slow Motion (2026)','NETFLIX MOVIES',null],
  ['PH - Young Blood (2026)','PH - PHILIPPINES FILM',null],
  ['PH - Past Is Past (2026)','PH - EVENTS',null],
  ['PH - The Roast of Kevin Hart (2026)','PH - TAGALOG SUB MOVIES',null],
  ['IR ▎ House of Paper','IRAN',null],
  ['IN-KD - Demon Hunters (2026)','IN - KOREAN HINDI DABBLING','hi'],
 ]) {
  const item=row(raw,category);
  assert.equal(M.catalogLanguageInfo(item).headline,expected?M.languageDisplayFull(expected):'Langue non identifiée',raw);
 }
});
test('ES versus unverified EN cache stays an internal diagnostic without user-facing warnings or rewritten evidence',()=>{
 const item={...row('ES - Aída y vuelta (2026)','ES - PELÍCULAS 2026'),audio_language_validation_status:'probed',
  audio_probed_at:'2026-08-31T20:35:11Z',audio_tracks_scope:'file',audio_tracks:[{index:1,lang:'en'}]};
 const before=JSON.stringify(item),score=JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'es'}));
 const info=M.catalogLanguageInfo(item);
 assert.equal(info.headline,'Anglais');
 assert.equal(info.accessibleHeadline,'Anglais');
 assert.equal(info.audioSource,'file');assert.equal(info.languageConflict,true);
 assert.equal(JSON.stringify(info.internalAudioDiagnostic),JSON.stringify({code:'provider_file_language_conflict',providerLanguage:'es',fileLanguages:['en'],verificationRequired:true}));
 assert.equal(info.languageConfirmationStatus,'');
 assert.match(M.languageBadgeHtml(info,'badge'),/aria-label="Anglais"/);
 for(const locale of require('../i18n/locales.json').map(l=>l.code)) {
  const m=load(locale),publicInfo=m.catalogLanguageInfo(item),descriptor=m.versionDescriptor(item,{providerLanguageHints:true});
  assert.equal(publicInfo.headline,m.languageDisplayFull('en'));
  assert.equal(publicInfo.accessibleHeadline,publicInfo.headline);
  assert.equal(descriptor.headline,publicInfo.headline);
  assert.equal(descriptor.accessibleHeadline,publicInfo.headline);
  assert.equal(descriptor.languageConfirmationStatus,'');
  assert.doesNotMatch(m.languageBadgeHtml(publicInfo,'badge'),/verif|vérif|fichier|metadata|provider_file|Audio à vérifier/i);
 }
 assert.equal(JSON.stringify(item),before);
 assert.equal(JSON.stringify(M.analyzeLanguageCompatibility(item,{preferredAudioLanguage:'es'})),score);
 for(const verified of [{audio_language_validation_status:'verified'},{audio_language_verified_at:'2026-09-14T05:00:00Z'}]) {
  assert.equal(M.catalogLanguageInfo({...item,...verified}).headline,'Anglais');
 }
 assert.equal(M.catalogLanguageInfo({...item,audio_tracks:[{index:1,lang:'es'}]}).headline,'Espagnol');
 assert.equal(M.catalogLanguageInfo({...item,audio_tracks:[{index:1,lang:'es'},{index:2,lang:'en'}]}).headline,'ES / EN');
 assert.equal(M.catalogLanguageInfo({...item,raw_title:'AR-SUBS - Aida',metadata:{categoryName:''}}).headline,'Anglais');
});

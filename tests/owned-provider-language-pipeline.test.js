const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root,f),'utf8').replace(/\r\n/g,'\n');
const load = f => import(pathToFileURL(path.join(root,'supabase/functions/_shared',f)));

test('owned metadata projects declared languages without tracks, certification or diagnostic leakage',async()=>{
  const { attachOwnedProviderLanguageDeclarations: attach }=await load('owned-provider-language-declarations.mjs');
  const { catalogProviderAudioLanguages: languages,publicProviderAudioLanguages: publicLanguages }=await load('selection-provider-languages.mjs');
  const rows=[{variant_id:'v',source_id:'s',item_type:'movie',language:'es'},
    {variant_id:'v',source_id:'other',item_type:'movie',language:'fr'},
    {variant_id:'foreign',source_id:'s',item_type:'movie',language:'en'}];
  const calls=[];const query={select(){return this},eq(k,v){calls.push([k,v]);return this},in(k,v){calls.push([k,v]);return Promise.resolve({data:rows})}};
  const v={id:'v',user_id:'u',source_id:'s',item_type:'movie',raw_title:'EN | Example'};
  const foreign={id:'foreign',user_id:'other',source_id:'s',item_type:'movie'};
  await attach({rpc(t,args){assert.equal(t,'cloud_catalog_owned_movie_audio_declarations_batch');calls.push(['scope',args]);return Promise.resolve({data:rows})}},[v,foreign],'u');
  assert.deepEqual(languages(v),['es']); assert.deepEqual(publicLanguages(v),['es']);
  assert.equal(v.audio_languages,undefined);assert.equal(v.audio_verified_at,undefined);assert.equal(v.audio_tracks,undefined);
  assert.equal(foreign.provider_audio_languages,undefined);
  assert.deepEqual(calls,[['scope',{p_user_id:'u',p_source_id:'s',p_variant_ids:['v']}]]);
  const {sanitizeCatalogVariant}=await load('catalog-public-view.mjs');
  const published=sanitizeCatalogVariant(v);assert.deepEqual(published.provider_audio_languages,['es']);
  assert.doesNotMatch(JSON.stringify(published),/__owned|fingerprint|observed_at|Audio à vérifier/);
});

test('raw preserved metadata never grants declaration authority',async()=>{
  const {catalogProviderAudioLanguages: languages}=await load('selection-provider-languages.mjs');
  assert.deepEqual(languages({metadata:{__owned_provider_audio_languages:['en'],providerLanguageDeclarations:{audio:'en'}}}),[]);
});

test('declaration batches keep source and media type boundaries',async()=>{
  const {attachOwnedProviderLanguageDeclarations:attach}=await load('owned-provider-language-declarations.mjs');
  const variants=[
    {id:'a',user_id:'owner',source_id:'first',item_type:'movie'},
    {id:'b',user_id:'owner',source_id:'first',item_type:'series'},
    {id:'c',user_id:'owner',source_id:'second',item_type:'series'},
    {id:'foreign',user_id:'other',source_id:'second',item_type:'series'},
  ];
  const scopes=[];
  await attach({rpc(name,args){
    scopes.push([args.p_user_id,args.p_source_id,args.p_item_type || 'movie']);
    if(name==='cloud_catalog_owned_movie_audio_declarations_batch') return Promise.resolve({data:args.p_variant_ids.map(id=>({variant_id:id,source_id:args.p_source_id,item_type:'movie',language:'fr'}))});
    return {in:async(_,ids)=>({data:ids.map(id=>({variant_id:id,source_id:args.p_source_id,item_type:args.p_item_type,language:'fr'}))})};
  }},variants,'owner');
  assert.deepEqual(scopes,[['owner','first','movie'],['owner','first','series'],['owner','second','series']]);
  for(const variant of variants.slice(0,3))assert.deepEqual(variant.provider_audio_languages,['fr']);
  assert.equal(variants[3].provider_audio_languages,undefined);
});

test('owned canonical ISO languages are not restricted to known supplier tag spellings',async()=>{
  const {catalogProviderAudioLanguages: languages,publicProviderAudioLanguages: publicLanguages}=await load('selection-provider-languages.mjs');
  const item={__owned_provider_audio_languages:['gu','or','yue','xx','https://private.invalid']};
  assert.deepEqual(languages(item),['gu','or','yue']);
  assert.deepEqual(publicLanguages(item),['gu','or','yue']);
  assert.deepEqual(publicLanguages({provider_audio_language_status:'provider_declared',provider_audio_languages:['gu','or','yue']}),['gu','or','yue']);
});

test('fresh owned language wins over an uncertified cache, never over an audio certificate',async()=>{
  const {useCachedAudioLanguageEvidence: use}=await load('owned-provider-language-declarations.mjs');
  assert.equal(use({__owned_provider_audio_languages:['es']},{audio_probed_at:'date'}),false);
  assert.equal(use({__owned_provider_audio_languages:['es']},{audio_lang_verified_at:'date'}),true);
  assert.equal(use({},{audio_probed_at:'date'}),true);
  const catalog=read('supabase/functions/norva-catalog/index.ts');
  assert.match(catalog,/row.audio_probed_at && useCachedAudioLanguageEvidence\(variant, row\)/);
  assert.match(catalog,/await attachFlatOwnedProviderLanguages\(items, userId, itemType\)/);
});

test('flat movie and series paths copy only the matching owned declaration',async()=>{
  const {attachOwnedProviderLanguageDeclarations}=await load('owned-provider-language-declarations.mjs');
  const catalog=read('supabase/functions/norva-catalog/index.ts');
  const start=catalog.indexOf('async function attachFlatOwnedProviderLanguages(');
  const end=catalog.indexOf('async function attachFlatMediaFileLanguages(',start);
  for (const itemType of ['movie','series']) {
    const items=[{id:'m',source_id:'s',external_id:'file'}, {id:'other',source_id:'other',external_id:'file'}];
    const variants=[{id:'v',media_item_id:'m',source_id:'s',user_id:'u',external_id:'file',item_type:itemType}];
    const context=vm.createContext({attachOwnedProviderLanguageDeclarations,
      flatMediaVariantKey:v=>JSON.stringify([v.media_item_id||v.id,v.source_id,v.external_id]),
      db:{rpc(name,args){assert.equal(name,itemType==='movie'?'cloud_catalog_owned_movie_audio_declarations_batch':'cloud_catalog_owned_audio_declarations_scoped');assert.equal(args.p_user_id,'u');const response={data:[{variant_id:'v',source_id:'s',item_type:itemType,language:'es'}]};return itemType==='movie'?Promise.resolve(response):{in:async()=>response}},from(table){const q={select(){return q},eq(){return q},in(){return Promise.resolve({data:
        table==='cloud_catalog_visible_title_variants'?variants:[{variant_id:'v',source_id:'s',item_type:itemType,language:'es'}]})}};return q;}}
    });
    vm.runInContext(stripTypeScriptTypes(catalog.slice(start,end)),context);
    await context.attachFlatOwnedProviderLanguages(items,'u',itemType);
    assert.deepEqual(items[0].provider_audio_languages,['es']);
    assert.equal(items[1].provider_audio_languages,undefined);
    assert.equal(items[0].audio_languages,undefined);
    assert.doesNotMatch(JSON.stringify(items),/__owned|verified|tracks|fingerprint/);
  }
});

test('large movie rails bound the projection inside each RPC, not with an outer filter',async()=>{
  const {attachOwnedProviderLanguageDeclarations:attach}=await load('owned-provider-language-declarations.mjs');
  const variants=Array.from({length:201},(_,n)=>({id:`v${n}`,user_id:'u',source_id:'s',item_type:'movie'}));
  const batches=[];
  await attach({rpc(name,args){
    assert.equal(name,'cloud_catalog_owned_movie_audio_declarations_batch');
    batches.push(args.p_variant_ids.length);
    return Promise.resolve({data:args.p_variant_ids.map(variant_id=>({variant_id,source_id:'s',item_type:'movie',language:'en'}))});
  }},variants,'u');
  assert.deepEqual(batches,[200,1]);
  assert.ok(variants.every(v=>v.provider_audio_languages.join(',')==='en'));
});

test('upper-case technical tags retain their audio/subtitle role',async()=>{
  const {xtreamLanguageDeclarations:capture}=await load('xtream-language-declarations.mjs');
  const e=capture({info:{audio:{tags:{LANGUAGE:'spa'}},subtitles:[{tags:{LANG:'ara'}}]}});
  assert.deepEqual(e.declarations.map(r=>[r.role,r.values]),[['audio',['spa']],['subtitle',['ara']]]);
});

const playback=read('supabase/functions/norva-playback/index.ts');
async function metadataFixture(options={}) {
  const events=[];
  const db={rpc:async(name,args)=>{events.push({name,args});return {data:name==='catalog_owned_language_metadata_enabled_for_source'?options.enabled!==false:options.empty?0:1}},
    from:()=>{const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:options.prior?{}:null})};return q}};
  let checks=0;
  const context=vm.createContext({crypto:require('node:crypto').webcrypto,PLAYBACK_SESSION_UUID_PATTERN:/^identity$/,
    recordOrEmpty:v=>v||{},stringOr:(v,f)=>typeof v==='string'?v:f,stringOrNull:v=>v||null,isRecord:v=>v&&typeof v==='object',
    HttpError:class extends Error{constructor(status,message,details){super(message);this.details=details}},
    readActiveCatalogGenerationSnapshot:async()=>({generationId:'g',configRevision:'1',sourceVisibilityEpoch:'1'}),
    catalogGenerationRpcFence:()=>({p_generation_id:'g',p_config_revision:'1'}),
    loadSourceConfig:async()=>({serverUrl:'https://provider.invalid',username:'private',password:'private'}),
    getRuntimeConfig:async()=>({mediaGatewayUrl:'https://gateway.invalid',mediaGatewayToken:'secret'}),
    resolvePlaybackTarget:async()=>({targetUrl:'https://provider.invalid/movie/private/private/12.mkv'}),
    providerAccountHashFromUrl:async()=> 'hash',codecProfileBackgroundBlockReason:async()=>options.busy?'provider-account-busy':null,
    assertProviderCircuitClosed:async()=>{},assertProviderProbeCircuitClosedStrict:async()=>{},
    claimProviderFileProbeStrict:async()=>{events.push({claim:true});return !options.leaseBusy},
    releaseProviderFileProbe:async()=>{events.push({release:true})},
    assertActiveCatalogGenerationCurrent:async()=>{if(options.changed&&++checks===2)throw new Error('changed')},
    requireAutomaticLanguageEnrichmentAccess:async()=>{},loadLanguageValidationIdentity:async()=> 'identity',
    sanitizedProviderErrorCode:v=>v||null,providerProbeTerminalCode:()=>options.providerBusy?'provider_busy':null,
    openProviderPlaybackCircuit:async()=>{events.push({circuit:true})},
    fetchBoundedProviderJson:async(url,args)=>{events.push({fetch:url,args});if(options.timeout)throw new Error('timeout');return {
      response:{ok:!options.httpError,status:options.httpError||200},value:{info:{audio:{tags:{language:options.empty?'und':'spa'}}}}
    }},
  });
  const start=playback.indexOf('async function ownedMetadataProviderBlockReason(');
  const end=playback.indexOf('async function exactFileProbeAdmissionEnabled(',start);
  vm.runInContext(stripTypeScriptTypes(playback.slice(start,end)),context);
  let result,error;try{result=await context.runOwnedMovieLanguageMetadata(db,'u','s','v','12','identity')}catch(e){error=e}
  return {result,error,events};
}
test('cheap provider metadata is fresh, bounded and only writes the fenced declaration RPC',async()=>{
  const h=await metadataFixture();assert.equal(h.error,undefined);assert.equal(h.result.persisted,1);
  assert.equal(h.events[0].name,'catalog_owned_language_metadata_enabled_for_source');
  assert.equal(h.events[0].args.p_user,'u');assert.equal(h.events[0].args.p_source,'s');
  const fetch=h.events.find(e=>e.fetch);assert.match(fetch.fetch,/\/xtream\/metadata$/);
  assert.equal(fetch.args.maxBytes,1048576);assert.equal(fetch.args.timeoutMs,55000);
  assert.equal(JSON.parse(fetch.args.body).action,'get_vod_info');
  const write=h.events.find(e=>e.name==='record_owned_movie_language_declaration');
  assert.equal(write.args.p_external_id,'12');assert.equal(write.args.p_generation_id,'g');
  assert.equal(h.events.filter(e=>e.release).length,1);
  assert.ok(!h.events.some(e=>e.name==='merge_cloud_title_file_languages'));
});
for(const flag of ['enabled','prior','busy','leaseBusy'])test(`metadata admission skips network: ${flag}`,async()=>{
  const h=await metadataFixture({[flag]:flag==='enabled'?false:true});assert.ok(!h.events.some(e=>e.fetch));
});
test('empty metadata defers to a future exact probe, without inventing a language',async()=>{
  const h=await metadataFixture({empty:true});assert.equal(h.result.stopped,'metadata-no-language');assert.equal(h.result.persisted,undefined);
});
test('timeout retains distributed exclusion; ownership drift prevents writes',async()=>{
  const h=await metadataFixture({timeout:true});assert.ok(h.error);assert.ok(!h.events.some(e=>e.release));
  const changed=await metadataFixture({changed:true});assert.ok(changed.error);assert.ok(!changed.events.some(e=>e.name==='record_owned_movie_language_declaration'));
});
test('provider errors preserve exclusion and provider busy opens the existing circuit',async()=>{
  const h=await metadataFixture({httpError:458,providerBusy:true});assert.ok(h.events.some(e=>e.circuit));
  assert.ok(!h.events.some(e=>e.release));assert.equal(h.result.persisted,undefined);
});

test('priority migration retains retry/quarantine/admission guards and independent cursors',()=>{
  const sql=read('supabase/migrations/20260914133000_unknown_first_language_intake.sql');
  for(const fragment of ['unknown_after_variant_id','mod(v_cursor.priority_ticks,10)','j.quarantined_at is not null',
    'catalog_language_execution_available()','catalog_language_queue_available(v_identity)',"interval '20 minutes'",'attempts<3',
    'catalog_movie_audio_identified(p_user,p_source,v.id) is distinct from v_unknown'])assert.ok(sql.includes(fragment),fragment);
  assert.doesNotMatch(sql,/cron\.schedule|truncate|delete from/i);
});

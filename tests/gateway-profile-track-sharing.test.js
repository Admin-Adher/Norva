'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const { createHash } = require('node:crypto');
const edge = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const from = edge.indexOf('function observedGatewayFileProfile(');
const to = edge.indexOf('\nfunction mergePlaybackHints(', from);
assert.ok(from > 0 && to > from);
const fpFrom=edge.indexOf('async function languageValidationProfileFingerprint(');
const fpTo=edge.indexOf('\nasync function runLanguageValidationRetryWorker(',fpFrom);
const containerFrom=edge.indexOf('function canonicalVodContainer(');
const containerTo=edge.indexOf('\nfunction containerEvidenceKind(',containerFrom);
assert.ok(containerFrom>0 && containerTo>containerFrom);
const snippet = stripTypeScriptTypes(edge.slice(containerFrom,containerTo)+'\n'+edge.slice(fpFrom,fpTo)+'\n'+edge.slice(from, to));
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function harness(overrides = {}) {
  const shares = [], filters = [];
  const context = {
    recordOrEmpty:record, Date,
    stringOr:(v,fallback) => typeof v === 'string' ? v : fallback,
    stringOrNull:v => typeof v === 'string' && v ? v : null,
    normalizeCodecToken:v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    compactRecord:v => Object.fromEntries(Object.entries(v).filter(([,x]) => x != null)),
    boundedNullableInt:v => v == null ? null : Number(v),
    booleanOrNull:v => typeof v === 'boolean' ? v : null,
    normalizeIsoLang:v => ({fre:'fr',mal:'ml',pan:'pa',pol:'pl'})[v] || v || null,
    LANGUAGE_VALIDATION_PROTOCOL:2,
    sha256Hex:async value => createHash('sha256').update(value).digest('hex'),
    // This suite checks Edge routing/arguments. Exact SQL/profile integrity is
    // exercised separately against the full restored schema, not this fixture.
    normalizeCodecProfile:profile => profile,
    readActiveCatalogGenerationSnapshot:async () => ({generationId:'generation-current'}),
    resolveSourceIdentity:async () => ({key:'server-verified-identity'}),
    shareFileTracks:async () => {throw Error('unversioned fallback is forbidden');},
    ...overrides,
  };
  const query = {
    select:()=>query,
    eq:(key,value) => {filters.push([key,value]);return query;},
    limit:async () => ({data:[{id:'owned-variant',codec_profile:{probedAt:'2026-09-10T10:00:00Z'}}],error:null}),
  };
  const db = {from:table => {assert.equal(table,'cloud_catalog_visible_title_variants');return query;},
    rpc:async (name,args) => {assert.equal(name,'observe_catalog_file_profile');shares.push(args);return {data:{accepted:true},error:null};}};
  const api = vm.runInNewContext(snippet + '; ({shareObservedGatewayProfileTracks,shareObservedGatewayFile});', context);
  return {run:options => api.shareObservedGatewayProfileTracks(db,options),
    commit:options => api.shareObservedGatewayFile(db,options),db,shares, filters, query,context};
}
const options = () => ({userId:'owner',sourceId:'source',itemId:'exact-file',codecProfileSource:'request+gateway_probe',
  codecProfile:{probeSource:'gateway_probe',probedAt:'2026-09-10T10:00:00Z',metadataComplete:false,
    container:'matroska',durationSeconds:600,fileSizeBytes:40000000,audioCodec:'aac',videoCodec:'h264',
    audioTracks:[{index:1,language:'fre',codec:'aac'}],subtitles:[{index:3,language:'pol',codec:'srt'}]}});

test('fresh server-origin probe submits a version-bound map through one atomic RPC', async () => {
  const h = harness();
  assert.equal(await h.run(options()),true);
  assert.equal(h.shares.length,1);
  const args=JSON.parse(JSON.stringify(h.shares[0]));
  assert.equal(args.p_user_id,'owner');assert.equal(args.p_source_id,'source');
  assert.equal(args.p_variant_id,'owned-variant');assert.equal(args.p_item_type,'movie');
  assert.equal(args.p_external_id,'exact-file');assert.match(args.p_profile_fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(args.p_audio_tracks,[{index:1,lang:'fr',codec:'aac',default:false}]);
  assert.deepEqual(args.p_subtitle_tracks,[{index:3,lang:'pl',codec:'srt'}]);
  assert.deepEqual(args.p_profile,options().codecProfile);
  assert.equal(args.p_server_host,undefined,'SQL derives identity from the owned source');
  for (const filter of [['user_id','owner'],['source_id','source'],['generation_id','generation-current'],['item_type','movie'],['external_id','exact-file']]) {
    assert.ok(h.filters.some(row => row[0]===filter[0] && row[1]===filter[1]));
  }
});

test('stale or failed atomic observation never falls back to a raw cache write', async () => {
  for (const result of [{data:{accepted:false,reason:'stale_observation'},error:null},
                        {data:null,error:{code:'PGRST202'}}, {data:null,error:null}]) {
    const h=harness();h.db.rpc=async () => result;
    assert.equal(await h.run(options()),false);assert.equal(h.shares.length,0);
  }
});

test('real FFprobe demuxer families are accepted without accepting arbitrary mixed formats', async () => {
  for (const container of ['matroska,webm','mov,mp4,m4a,3gp,3g2,mj2','mpegts']) {
    const h=harness();const value=options();value.codecProfile.container=container;
    assert.equal(await h.run(value),true,container);
    assert.equal(h.shares.length,1);
  }
  for (const container of ['matroska,unknown','unknown,mp4','wav','unknown']) {
    const h=harness();const value=options();value.codecProfile.container=container;
    assert.equal(await h.run(value),false,container);
    assert.equal(h.shares.length,0);
  }
});

test('incomplete facets are sent as unknown without discarding the version observation', async () => {
  for (const flags of [{audioProbeComplete:false,subtitleProbeComplete:true},
                       {audioProbeComplete:true,subtitleProbeComplete:false}]) {
    const h=harness();
    assert.equal(await h.commit({userId:'owner',sourceId:'source',variantId:'variant',itemId:'ep-7',
      itemType:'episode',profile:options().codecProfile,...flags}),true);
    assert.equal(h.shares.length,1);
    const args=h.shares[0];
    assert.equal(args.p_audio_probe_complete,flags.audioProbeComplete);
    assert.equal(args.p_subtitle_probe_complete,flags.subtitleProbeComplete);
    if(!flags.audioProbeComplete) assert.equal(args.p_audio_tracks.length,0);
    if(!flags.subtitleProbeComplete) assert.equal(args.p_subtitle_tracks.length,0);
  }
});

test('a valid new profile with zero audio may invalidate old evidence but never claim complete audio', async () => {
  const h=harness(), profile={...options().codecProfile,audioTracks:[]};
  assert.equal(await h.commit({userId:'owner',sourceId:'source',variantId:'v',itemId:'ep-7',itemType:'episode',
    profile,audioProbeComplete:false,subtitleProbeComplete:true}),true);
  assert.equal(h.shares[0].p_audio_tracks.length,0);
  assert.equal(h.shares[0].p_audio_probe_complete,false);
  assert.equal(await h.commit({userId:'owner',sourceId:'source',variantId:'v',itemId:'ep-7',itemType:'episode',
    profile,audioProbeComplete:true,subtitleProbeComplete:true}),false);
  assert.equal(h.shares.length,1);
});

test('request-only echoes and incomplete in-band maps never become cross-account evidence', async () => {
  for (const change of [
    {codecProfileSource:'request'}, {codecProfileSource:null},
    {codecProfileSource:'complete_hls_cache'},
    {codecProfile:{...options().codecProfile,probeSource:'browser'}},
    {codecProfile:{...options().codecProfile,probeSource:'gateway_inband',metadataComplete:false}},
    {codecProfile:{...options().codecProfile,audioTracks:[{index:1},{index:1}]}},
    {codecProfile:{...options().codecProfile,audioTracks:[{index:'1'}]}},
    {codecProfile:{...options().codecProfile,subtitles:undefined}},
    {codecProfile:{...options().codecProfile,probedAt:'invalid'}},
  ]) {
    const h = harness();assert.equal(await h.run({...options(),...change}),false);
    assert.equal(h.shares.length,0);
  }
  const h = harness();
  assert.equal(await h.run({...options(),codecProfileSource:'request+gateway_inband',
    codecProfile:{...options().codecProfile,probeSource:'gateway_inband',metadataComplete:true}}),true);
});

test('source-local identities, changed generations/profiles and database failures defer safely', async () => {
  const local = harness({resolveSourceIdentity:async () => ({key:'source:unverified'})});
  assert.equal(await local.run(options()),false);assert.equal(local.shares.length,0);
  const stale = harness(); stale.query.limit = async () => ({data:[{codec_profile:{probedAt:'older'}}],error:null});
  assert.equal(await stale.run(options()),false);assert.equal(stale.shares.length,0);
  const error = harness({readActiveCatalogGenerationSnapshot:async () => {throw Error('superseded');}});
  assert.equal(await error.run(options()),false);assert.equal(error.shares.length,0);
});

test('sharing is background-only after successful movie persistence and preserves canonical speech evidence', () => {
  const responseStart=edge.indexOf('  if (sourceId && gateway.codecProfile && !deferGatewayProfilePersistenceForMkvFastStart)');
  const responseEnd=edge.indexOf('  const responseCodecProfile',responseStart);
  assert.ok(responseStart>0 && responseEnd>responseStart);
  const response=edge.slice(responseStart,responseEnd);
  assert.match(response,/runBackground\(\(async \(\) => \{[\s\S]*await persistObservedCodecProfile[\s\S]*if \(profilePersisted && itemType === "movie"\)[\s\S]*await shareObservedGatewayProfileTracks/);
  assert.match(edge,/codecProfileSource: stringOrNull\(gatewayBody\.codecProfileSource\)/);
  const share = edge.slice(edge.indexOf('async function shareFileTracks('),edge.indexOf('// Distributed crawler lease:'));
  assert.match(share,/canonicalArgs = \{[\s\S]*p_audio_tracks: Array\.isArray\(row\.audio_tracks\)/);
  assert.match(share,/norva_fanout_file_tracks_to_users_fenced/);
  assert.doesNotMatch(snippet,/fetch\(|probeEngineTracks|tmdb|providerAudio|raw_title/);
});

test('all three final Gateway paths opt into sharing without weakening the original media CAS', () => {
  const ranges = [
    ['async function expirePlaybackSession(', '\nasync function recordPlaybackSessionFailure('],
    ['async function closeOpenGatewaySessionsForUser(', '\nasync function prepareEdgeSessionCoordinator('],
    ['async function runCompleteHlsCacheCallback(', '\n// Best-effort account-activity'],
  ];
  for (const [begin,end] of ranges) {
    const from=edge.indexOf(begin), to=edge.indexOf(end,from);
    assert.ok(from>=0 && to>from);
    const source=edge.slice(from,to);
    assert.match(source,/persistObservedCodecProfile\(db, \{[\s\S]*requireItemCas: true,[\s\S]*expectedItemCas: mkvH264FastStartItemCasFromPlaybackSession[\s\S]*shareFinalGatewayObservation: true/);
  }
  assert.equal((edge.match(/shareFinalGatewayObservation: true/g)||[]).length,3,
    'client telemetry, relay and request-echo paths must not opt in implicitly');
});

test('final observation sharing requires successful media CAS and exactly one current variant write', async () => {
  const from=edge.indexOf('async function persistObservedCodecProfile(');
  const to=edge.indexOf('\nfunction observedGatewayFileProfile(',from);
  assert.ok(from>=0 && to>from);
  const persistSnippet=stripTypeScriptTypes(edge.slice(from,to));
  const sourceProfile={...options().codecProfile,mkvH264FastStartProof:'private-fast-proof',
    mkvCompleteHlsCacheProof:'private-cache-proof'};
  const cases=[
    {name:'success',want:1},
    {name:'cas-read-changed',itemAt:'newer',want:0},
    {name:'cas-write-lost',updatedItems:[],want:0},
    {name:'generation-superseded',itemSuperseded:true,want:0},
    {name:'variant-write-failed',variantError:Error('db failure'),want:0},
    {name:'variant-no-longer-visible',updatedVariants:[],want:0},
    {name:'ambiguous-variant-write',updatedVariants:[{id:'a'},{id:'b'}],want:0},
    {name:'no-server-opt-in',optIn:false,want:0},
    {name:'no-original-cas',requireCas:false,want:0},
    {name:'item-only',itemOnly:true,want:0},
  ];
  for(const sample of cases) {
    const events=[], shares=[], background=[];
    const item={id:'owned-item',updated_at:sample.itemAt || 'original',metadata:{},playback_hint:{}};
    const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:item,error:null})};
    const db={from:()=>query};
    const api=vm.runInNewContext(persistSnippet+';persistObservedCodecProfile;',{
      Date,recordOrEmpty:record,stringOrNull:v=>typeof v==='string' && v ? v:null,
      normalizeCodecProfile:v=>v,
      stripMkvH264FastStartProof:v=>Object.fromEntries(Object.entries(v).filter(([key])=>!key.endsWith('Proof'))),
      hasUsefulCodecProfile:()=>true,readActiveCatalogGenerationSnapshot:async()=>({generationId:'current'}),
      firstUsefulCodecProfile:()=>({}),mergeCodecProfileAnnotations:(_old,fresh)=>fresh,
      mergePlaybackHints:(old,fresh)=>({...old,...fresh}),compactRecord:v=>v,
      patchActiveCatalogMediaItems:async()=>{events.push('media-cas');return{
        data:sample.updatedItems || [{id:'owned-item'}],error:null,superseded:sample.itemSuperseded || false};},
      patchActiveCatalogTitleVariants:async()=>{events.push('variant-write');return{
        data:sample.updatedVariants || [{id:'owned-variant'}],error:sample.variantError || null,superseded:false};},
      compatibilityTierForCodecProfile:()=> 'gateway',playbackCostScoreForObservation:()=>1,
      isCatalogGenerationSuperseded:()=>false,isProjectionMissing:()=>false,
      console:{warn:()=>{}},
      shareObservedGatewayProfileTracks:async(_db,shared)=>{events.push('share');shares.push(shared);return true;},
      runBackground:promise=>background.push(promise),
    });
    await api(db,{userId:'owner',sourceId:'source',itemType:'movie',itemId:'file',
      codecProfile:sourceProfile,startupMs:null,audioMode:null,
      requireItemCas:sample.requireCas!==false,expectedItemCas:{id:'owned-item',updatedAt:'original',targetUrlHash:'hash'},
      allowProofReplacement:true,shareFinalGatewayObservation:sample.optIn!==false,itemOnly:sample.itemOnly || false});
    await Promise.all(background);
    assert.equal(shares.length,sample.want,sample.name);
    if(sample.want) {
      assert.deepEqual(events,['media-cas','variant-write','share']);
      assert.equal(shares[0].codecProfile.mkvH264FastStartProof,undefined);
      assert.equal(shares[0].codecProfile.mkvCompleteHlsCacheProof,undefined);
      assert.equal(shares[0].codecProfileSource,'gateway_probe');
      assert.equal(shares[0].itemId,'file');
    }
  }
});

test('internal sharing diagnostics identify the actual stop without changing acceptance', async () => {
  const cases = [
    {reason:'shared'},
    {reason:'origin-untrusted',change:{codecProfileSource:'request'}},
    {reason:'profile-incomplete',change:{codecProfile:{...options().codecProfile,subtitles:null}}},
    {reason:'variant-read-failed',query:{data:null,error:{code:'57014'}}},
    {reason:'variant-profile-changed',query:{data:[{codec_profile:{probedAt:'older'}}],error:null}},
    {reason:'identity-unverified',identity:{key:'source:tenant-only'}},
    {reason:'profile-lookup-exception',generationError:true},
    {reason:'observation-rpc-failed',rpc:{data:null,error:{code:'PGRST202'}}},
    {reason:'observation-refused',rpc:{data:{accepted:false,reason:'untrusted response text'},error:null}},
  ];
  for(const sample of cases) {
    const h=harness(sample.identity ? {resolveSourceIdentity:async()=>sample.identity} :
      sample.generationError ? {readActiveCatalogGenerationSnapshot:async()=>{throw {code:'40001'};}} : {});
    if(sample.query)h.query.limit=async()=>sample.query;
    if(sample.rpc)h.db.rpc=async()=>sample.rpc;
    const seen=[];
    assert.equal(await h.run({...options(),...sample.change,onDiagnostic:(reason,error)=>seen.push({reason,code:error?.code})}),sample.reason==='shared');
    assert.equal(seen.at(-1)?.reason,sample.reason);
    assert.equal(await h.run({...options(),...sample.change,onDiagnostic:()=>{throw Error('logging unavailable');}}),sample.reason==='shared');
  }
});

test('final diagnostic records only fixed reasons and bounded database codes', () => {
  const start=edge.indexOf('function recordFinalGatewayProfileShareDiagnostic('),end=edge.indexOf('\nfunction observedGatewayFileProfile(',start);
  const logs=[];
  const run=vm.runInNewContext(stripTypeScriptTypes(edge.slice(start,end))+';recordFinalGatewayProfileShareDiagnostic;',
    {recordOrEmpty:record,console:{info:s=>logs.push(JSON.parse(s))}});
  const secret='https://provider.invalid/private-credential';
  run('observation-rpc-failed',{code:'PGRST202',message:secret,details:secret,userId:secret});
  run('shared',{code:secret});run(secret,{code:'40001'});
  assert.deepEqual(logs,[{event:'final_gateway_profile_share',reason:'observation-rpc-failed',databaseCode:'PGRST202'},
    {event:'final_gateway_profile_share',reason:'shared'}]);
  assert.equal(JSON.stringify(logs).includes(secret),false);
  assert.doesNotThrow(()=>run('observation-exception',{get code(){throw Error('hostile error property');}}));
});

test('real final persistence and sharing compose for a complete untagged in-band profile', async () => {
  const extract=(start,end)=>{
    const a=edge.indexOf(start),b=edge.indexOf(end,a);assert.ok(a>=0&&b>a);return edge.slice(a,b);
  };
  const code=stripTypeScriptTypes(extract('async function persistObservedCodecProfile(','\nfunction observedGatewayFileProfile(')+
    extract('function normalizeCodecProfile(','\nfunction normalizeGatewayAudioRenditions(')+
    extract('function normalizeCodecProfileTracks(','\nfunction hasUsefulCodecProfile('));
  const h=harness(),events=[],background=[],logs=[];
  const profile={...options().codecProfile,probeSource:'gateway_inband',metadataComplete:true,container:'matroska,webm',
    audioTracks:[{index:1,order:0,codec:'aac',channels:2,default:true,title:'Audio 1'}],subtitles:[]};
  const item={id:'owned-media',updated_at:'original',metadata:{},playback_hint:{}};
  const media={select:()=>media,eq:()=>media,maybeSingle:async()=>({data:item,error:null})};
  const from=h.db.from;h.db.from=table=>table==='cloud_catalog_visible_media_items'?media:from(table);
  const api=vm.runInNewContext(snippet+'\n'+code+';persistObservedCodecProfile;',{
    ...h.context,console:{info:s=>logs.push(JSON.parse(s)),warn:()=>{}},
    normalizeMkvH264FastStartProof:()=>null,exactPositiveSafeInteger:v=>Number(v),boundedNullableNumber:v=>v==null?null:Number(v),
    hasUsefulCodecProfile:()=>true,stripMkvH264FastStartProof:v=>({...v}),firstUsefulCodecProfile:()=>({}),
    mergeCodecProfileAnnotations:(_old,v)=>v,mergePlaybackHints:(old,v)=>({...old,...v}),
    patchActiveCatalogMediaItems:async()=>{events.push('media');return {data:[{id:item.id}],error:null,superseded:false};},
    patchActiveCatalogTitleVariants:async()=>{events.push('variant');return {data:[{id:'owned-variant'}],error:null,superseded:false};},
    compatibilityTierForCodecProfile:()=> 'gateway',playbackCostScoreForObservation:()=>1,isProjectionMissing:()=>false,
    runBackground:task=>background.push(task),
  });
  assert.equal(await api(h.db,{userId:'owner',sourceId:'source',itemType:'movie',itemId:'exact-file',codecProfile:profile,
    startupMs:null,audioMode:null,requireItemCas:true,expectedItemCas:{id:item.id,updatedAt:'original',targetUrlHash:'hash'},
    shareFinalGatewayObservation:true}),true);
  await Promise.all(background);
  assert.deepEqual(events,['media','variant']);assert.equal(h.shares.length,1);
  assert.deepEqual(logs.map(r=>r.reason),['share-started','shared']);
  assert.equal(h.shares[0].p_audio_tracks[0].lang,undefined);
  assert.equal(h.shares[0].p_audio_tracks[0].index,1);
  assert.equal(h.shares[0].p_profile.probeSource,'gateway_inband');
  assert.deepEqual(Array.from(h.shares[0].p_subtitle_tracks),[]);
});

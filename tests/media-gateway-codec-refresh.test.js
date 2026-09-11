'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const gateway=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
const edge=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
const begin=gateway.indexOf('async function probeCodecProfile(');
const end=gateway.indexOf('\nasync function probeCodecProfileUncached(',begin);
assert.ok(begin>0 && end>begin);
const url='https://synthetic.invalid/movie/account/password/101.mkv';
const old={audioTracks:[{index:1,codec:'aac'}]};
const fresh={audioTracks:[{index:1,codec:'ac3'}]};
function harness(){
  const memory=new Map([[url,{profile:old,expiresAt:Date.now()+3600000}]]);
  const header=new Map([[url,Buffer.from('old-header')]]);
  const calls=[];
  const context={Date,CODEC_PROFILE_CACHE_TTL_MS:3600000,codecProfileCache:memory,
    headerByteCache:header,INBAND_HEADER_PARSE:true,BOUNDED_MKV_HEADER_PARSE:true,
    probeStats:{cacheHits:0,inbandHits:0},
    probeFromHeaderBytes:async()=>{calls.push('header');return old;},
    hasUsefulCodecProfile:p=>Array.isArray(p?.audioTracks)&&p.audioTracks.length>0,
    cacheCodecProfile:(key,p)=>{if(p?.audioTracks?.length)memory.set(key,{profile:p,expiresAt:Date.now()+3600000});},
    probeCodecProfileUncached:async(key,ua,options)=>{calls.push({key,ua,options});return fresh;}};
  const run=vm.runInNewContext(gateway.slice(begin,end)+';probeCodecProfile;',context);
  return {run,context,calls,memory,header};
}
test('ordinary reads keep the current one-hour cache without provider work',async()=>{
  const h=harness();assert.equal(await h.run(url,'test'),old);assert.equal(h.calls.length,0);
});
test('explicit refresh replaces cached and in-band observations with exactly one provider probe',async()=>{
  const h=harness();const drain={};
  assert.equal(await h.run(url,'test',{forceProviderProbe:true,background:true,providerDrainState:drain}),fresh);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].options.providerDrainState,drain);
  assert.equal(h.calls[0].options.background,true);
  assert.equal(h.header.has(url),false);assert.equal(h.memory.get(url).profile,fresh);
});
test('failed refresh neither returns nor retains the old profile or header',async()=>{
  const h=harness();h.context.probeCodecProfileUncached=async()=>{throw new Error('provider unavailable');};
  await assert.rejects(h.run(url,'test',{forceProviderProbe:true}),/provider unavailable/);
  assert.equal(h.memory.has(url),false);assert.equal(h.header.has(url),false);
});
test('non-boolean flags cannot force a network read and local-only remains local-only',async()=>{
  for(const forceProviderProbe of [undefined,false,1,'true',{}]){
    const h=harness();assert.equal(await h.run(url,'test',{forceProviderProbe}),old);
    assert.equal(h.calls.length,0);
  }
  const h=harness();assert.equal(await h.run(url,'test',{forceProviderProbe:true,localOnly:true}),old);
  assert.equal(h.calls.length,0);
});
test('a refresh skips old header-only cache and does not cache an empty result',async()=>{
  const h=harness();h.memory.clear();h.context.probeCodecProfileUncached=async()=>({});
  assert.deepEqual(await h.run(url,'test',{forceProviderProbe:true}),{});
  assert.equal(h.memory.size,0);assert.equal(h.header.size,0);assert.equal(h.calls.length,0);
});
test('background refresh requires a versioned Gateway attestation before persisting',()=>{
  const start=edge.indexOf('async function runCodecProfileBackfill(');
  const stop=edge.indexOf('\nasync function runLidBenchmarkEndpoint',start);
  const route=edge.slice(start,stop);
  assert.match(route,/refreshCodecProfile: true/);
  const a=route.indexOf('if (info.codecProfileRefreshProtocol !== 1');
  const b=route.indexOf('\n      const observedProfile',a);
  assert.ok(a>route.indexOf('providerProbeResponseAllowsLeaseRelease('));
  assert.ok(b>a && a<route.indexOf('await persistObservedCodecProfile'));
  class HttpError extends Error{constructor(status,message,details){super(message);Object.assign(this,{status,details});}}
  const guard=stripTypeScriptTypes(route.slice(a,b));
  for(const info of [{},{codecProfileRefreshProtocol:1},{codecProfileRefreshProtocol:2,codecProfileRefreshed:true},
    {codecProfileRefreshProtocol:1,codecProfileRefreshed:'true'}]){
    assert.throws(()=>vm.runInNewContext(guard,{info,HttpError}),e=>e.status===502 && e.details.code==='codec_profile_refresh_unattested');
  }
  assert.doesNotThrow(()=>vm.runInNewContext(guard,{info:{codecProfileRefreshProtocol:1,codecProfileRefreshed:true},HttpError}));
  const handler=gateway.slice(gateway.indexOf('async function handleProbeAudioRequest('),gateway.indexOf("app.post('/probe-audio'"));
  assert.match(handler,/forceProviderProbe: refreshCodecProfile === true/);
  assert.match(handler,/codecProfileRefreshProtocol: 1,[\s\S]*codecProfileRefreshed: refreshCodecProfile === true/);
});

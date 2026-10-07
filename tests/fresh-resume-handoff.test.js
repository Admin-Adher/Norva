'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createFreshResumeHandoff:create,consumeFreshResumeHandoff:consume}=require('../services/media-gateway/src/fresh-resume-handoff');
const {createRecentResumeOwnerGate:gate,privateResumeBinding}=require('../services/media-gateway/src/private-resume-binding');
const {PrivateResumeHlsCache}=require('../services/media-gateway/src/private-resume-hls-cache');
const scope={id:'same-playback'},sourceUrl='https://fixture.invalid/private',userAgent='fixture',fileSizeBytes=655360;
const input={scope,sourceUrl,userAgent,fileSizeBytes,targetUrl:'https://fixture.invalid/current-token',
 effectiveUrlSha256:'a'.repeat(64),effectiveUrlIdentitySha256:'b'.repeat(64),payload:Buffer.alloc(65536,4),now:100};
const request={scope,sourceUrl,userAgent,fileSizeBytes,now:101};
test('fresh handoff is opaque, one-use, detached and scoped to this playback',()=>{
 const token=create(input);assert.equal(JSON.stringify(token),'{}');input.payload.fill(8);
 const result=consume(token,request);assert.equal(result.payload[0],4);assert.equal(result.prefix.captureOwner,scope.id);
 assert.equal(consume(token,request),null);
 for(const change of [{scope:{id:scope.id}},{sourceUrl:sourceUrl+'/other'},{userAgent:'other'},{fileSizeBytes:fileSizeBytes+1},{now:99},{now:10101}]){
  const token=create(input);assert.equal(consume(token,{...request,...change}),null);assert.equal(consume(token,request),null);
 }
 assert.equal(consume({},request),null);
 for(const change of [{payload:Buffer.alloc(65535)},{targetUrl:'file:///private'},{scope:null},{effectiveUrlIdentitySha256:'invalid'}])assert.equal(create({...input,...change}),null);
});
test('recent rollout requires explicit all-owner opt-in and preserves disabled and malformed-owner fences',()=>{
 const a='a'.repeat(64),b='b'.repeat(64);
 for(const ownerHashes of [undefined,'','invalid'])assert.equal(gate({enabled:true,ownerHashes})(a),false);
 assert.equal(gate({enabled:true,ownerHashes:a})(a),true);assert.equal(gate({enabled:true,ownerHashes:a})(b),false);
 const all=gate({enabled:true,ownerHashes:a,allAuthenticatedOwners:true});
 assert.equal(all(a),true);assert.equal(all(b),true);assert.equal(all('untrusted'),false);
 assert.equal(gate({allAuthenticatedOwners:true})(a),false);
});
test('global admission keeps retained media private and the aggregate byte budget fixed across owners',async()=>{
 const N=65536,target='b'.repeat(64),cache=new PrivateResumeHlsCache({recentRevalidation:true,maxBytes:8*N,perFileBytes:4*N});
 const make=i=>privateResumeBinding({ownerKey:i.toString(16).padStart(64,'0'),sourceUrl,sourceId:'same-source',sourceRevision:'1',fileSizeBytes,profile:'same'});
 const observed={fileSizeBytes,effectiveUrlIdentitySha256:target,samples:[0,2*N,4*N,6*N].map(start=>({start,payload:Buffer.alloc(N,3)}))};
 for(let i=1;i<=24;i++){
  assert.equal(await cache.captureInput({binding:make(i),observed,inputWindows:[{start:0,payload:Buffer.alloc(N,3)}]}),true);
  assert.ok(cache.publicStatus().bytes+cache.publicStatus().reservedBytes<=8*N);
 }
 assert.equal(cache.acquireInput(make(25),observed),null);
 const lease=cache.acquireInput(make(24),observed);assert.ok(lease);assert.equal(lease.inputSnapshot().windows[0].payload[0],3);
 cache.revokeOwner(make(23).ownerKey);assert.equal(lease.inputSnapshot().windows[0].payload[0],3);
 cache.revokeOwner(make(24).ownerKey);assert.throws(()=>lease.inputSnapshot(),/REVOKED/);lease.release();
});

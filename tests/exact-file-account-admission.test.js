'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
const start=source.indexOf('async function exactFileProbeAdmissionEnabled(');
const end=source.indexOf('\nasync function runAutomaticVodLanguageMetadataBatch',start);
assert.ok(start>=0&&end>start);
class HttpError extends Error {constructor(status,message,details){super(message);this.status=status;this.details=details;}}
const functions=vm.runInNewContext(`(()=>{${stripTypeScriptTypes(source.slice(start,end))};return{enabled:exactFileProbeAdmissionEnabled,claim:claimExactMetadataProbe,release:releaseExactProviderFileProbe};})()`,{HttpError});

test('exact-file mode requires an explicit boolean database flag, never request metadata or an unavailable gate',async()=>{
  for(const data of [true,false]) assert.equal(await functions.enabled({rpc:async()=>({data})}),data);
  for(const response of [{data:null},{data:'true'},{data:true,error:{code:'test'}}]) {
    await assert.rejects(functions.enabled({rpc:async()=>response}),e=>e.status===503);
  }
});
test('metadata claims the mono account before the exact file and keeps both only after confirmed admission',async()=>{
  const calls=[];const db={rpc:async(name,args)=>{calls.push({name,args});return{data:true};}};
  assert.equal(await functions.claim(db,'catalogue','unique-owner','file-1','a'.repeat(64)),true);
  assert.deepEqual(calls.map(c=>c.name),['claim_provider_account_language_validation','claim_provider_exact_file_probe']);
  assert.equal(calls[1].args.p_external_id,'file-1');assert.equal(calls[1].args.p_provider_account_hash,'a'.repeat(64));
  assert.equal(calls[0].args.p_lease_owner,calls[1].args.p_lease_owner);
});
test('failed no-I/O file admission releases only its own new account lease; occupied accounts are untouched',async()=>{
  for(const failed of [1,2]) {
    const calls=[];const db={rpc:async(name,args)=>{calls.push({name,args});return{data:calls.length!==failed};}};
    assert.equal(await functions.claim(db,'catalogue','unique-owner','file-1','a'.repeat(64)),false);
    assert.equal(calls.length,failed===1?1:3);
    if(failed===2) {assert.equal(calls[2].name,'release_provider_account_language_validation');assert.equal(calls[2].args.p_lease_owner,'unique-owner');}
  }
  const calls=[];const db={rpc:async(name,args)=>{calls.push({name,args});if(calls.length===2) throw Error('lost response');return{data:true};}};
  assert.equal(await functions.claim(db,'catalogue','unique-owner','file-1','a'.repeat(64)),false);
  assert.equal(calls.at(-1).name,'release_provider_account_language_validation');
});
test('exact release is file + owner CAS, and metadata/ASR retain existing drain and circuit fences',async()=>{
  const calls=[];await functions.release({rpc:async(name,args)=>{calls.push({name,args});}},'catalogue','unique-owner',{itemType:'movie',externalId:'file-1'});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{name:'release_provider_exact_file_probe',args:{p_identity_key:'catalogue',p_item_type:'movie',p_external_id:'file-1',p_lease_owner:'unique-owner'}}]);
  const worker=source.slice(source.indexOf('async function processOneLanguageValidationTrack('),source.indexOf('type LanguageCaptureWindowOptions'));
  assert.match(worker,/useCapturePipeline && await exactFileProbeAdmissionEnabled\(db\)/);
  assert.ok(worker.indexOf('claim_provider_account_language_validation')<worker.indexOf('claim_provider_exact_file_probe'));
  assert.ok(worker.indexOf('await assertProviderCircuitClosed')<worker.indexOf('claim_provider_exact_file_probe'));
  assert.match(worker,/providerAccountLeaseReleaseSafe[\s\S]*releaseExactProviderFileProbe/);
  const metadata=source.slice(source.indexOf('async function runCodecProfileBackfill('),source.indexOf('async function runLidBenchmarkEndpoint('));
  assert.match(metadata,/if \(providerTransportMayBeActive\) releaseLeaseOnExit = false/);
  assert.match(metadata,/finally \{\s*if \(releaseLeaseOnExit\) \{\s*if \(useExactLease\)/);
});

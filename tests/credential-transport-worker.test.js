'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../supabase/functions/norva-provider-access/index.ts'),'utf8');
function block(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))).trim();}
class WorkerFault extends Error {constructor(queueCode,retryable){super(queueCode);this.queueCode=queueCode;this.retryable=retryable;}}
const config={serverUrl:'https://old.invalid',username:'fixture',password:'fixture-password'};
const job={jobId:'job',userId:'owner',transitionId:'transition',sourceId:'source',leaseSequence:4};

function harness(overrides={}){
 const calls=[];
 const context={WorkerFault,isRecord:v=>v&&typeof v==='object'&&!Array.isArray(v),
   decryptSourceConfig:async()=>config,readTransitionSecret:async()=>'',uuidValue:v=>v,
   boundedGatewayRetryAfter:v=>v,
   gatewayMetadataPage:async(...args)=>{calls.push(['gateway',args[4]]);return {pending:true,retryAfterSeconds:2};},
   workerRpc:async(name,args)=>{calls.push([name,args]);return name==='norva_begin_credential_transport_check'
     ? {state:'CHECKING',generationId:'generation',parts:{}} : {state:'CHECKING'};},...overrides};
 const functions=vm.runInNewContext(`(()=>{${block('function isCredentialTransportOnly(', 'async function failCredentialValidation(')};return {isCredentialTransportOnly,tryCredentialTransportCheck};})()`,context);
 return {...functions,calls};
}

test('only a server change with identical credential bytes qualifies',()=>{
 const {isCredentialTransportOnly:same}=harness();
 assert.equal(same(config,{...config,serverUrl:'https://new.invalid'}),true);
 for(const patch of [{username:'other'},{password:'other'},{username:'fixture '},{token:'new'}])
   assert.equal(same(config,{...config,...patch}),false);
 assert.equal(same({...config,unknown:true},config),false);
});

test('pending spool checkpoints without treating the first page as complete or building a generation',async()=>{
 const h=harness();
 assert.equal(await h.tryCredentialTransportCheck(job,'worker',{},config),true);
 assert.equal(h.calls[1][1].includeTransportManifest,true);
 assert.equal(h.calls[1][1].maxItems,250);
 assert.equal(h.calls[2][1].p_manifest,null);
 assert.equal(h.calls.some(([name])=>/build|upsert|complete/.test(name)),false);
});

test('completed movie proof advances to series and passes the complete signed-spool manifest',async()=>{
 const manifest={version:2,itemType:'series',eligible:true,count:64,sums:['0','0','0','0'],xors:['0','0','0','0']};
 let request,checkpoint;
 const h=harness({workerRpc:async(name,args)=>{
   if(name==='norva_begin_credential_transport_check')return {state:'CHECKING',generationId:'generation',parts:{movie:{}}};
   checkpoint=args;return {state:'CHECKING'};
 },gatewayMetadataPage:async(...args)=>{request=args[4];return {items:[{series_id:1}],transportManifest:manifest};}});
 await h.tryCredentialTransportCheck(job,'worker',{},config);
 assert.equal(request.action,'get_series');assert.equal(checkpoint.p_manifest,manifest);
});

test('old Gateways and mismatched catalogues return to the existing guarded import',async()=>{
 const h=harness({gatewayMetadataPage:async()=>({items:[{stream_id:1}],done:true}),
   workerRpc:async(name,args)=>{
     if(name==='norva_begin_credential_transport_check')return {state:'CHECKING',generationId:'generation',parts:{}};
     assert.equal(args.p_manifest.eligible,false);return {state:'NOT_MATCHING'};
   }});
 assert.equal(await h.tryCredentialTransportCheck(job,'worker',{},config),false);
});

test('credential changes and provider replacements never enter transport reuse',async()=>{
 const h=harness();
 assert.equal(await h.tryCredentialTransportCheck(job,'worker',{}, {...config,password:'new'}),false);
 assert.equal(await h.tryCredentialTransportCheck({...job,transitionKind:'replacement'},'worker',{},config),false);
 assert.equal(h.calls.length,0);
});

test('post-switch provider pressure cannot restore the previous address',async()=>{
 const calls=[];
 const verify=vm.runInNewContext('('+block('async function verifyCredentialTransportSwitch(', '// The post-switch lane')+')',{
   assertProviderReadAllowed:async()=>{},gatewayAccountInfo:async()=>{throw new WorkerFault('rate_limited',true);},
   normalizeWorkerFault:e=>e,assertAuthenticatedAccount:()=>{},readTransitionSecret:async()=>{calls.push('secret');},
   workerRpc:async()=>calls.push('write'),
 });
 await assert.rejects(verify(job,'worker',{},config),e=>e.queueCode==='rate_limited');
 assert.deepEqual(calls,[]);
});

test('post-switch auth failure restores only after the previous account authenticates',async()=>{
 for(const previousWorks of [true,false]){
   const calls=[];let requests=0;
   const verify=vm.runInNewContext('('+block('async function verifyCredentialTransportSwitch(', '// The post-switch lane')+')',{
     assertProviderReadAllowed:async()=>{},gatewayAccountInfo:async()=>{
       if(++requests===1||!previousWorks)throw new WorkerFault('auth_rejected',false);return {auth:1};},
     normalizeWorkerFault:e=>e,assertAuthenticatedAccount:()=>{},readTransitionSecret:async()=>'',
     decryptSourceConfig:async()=>config,workerRpc:async(name,args)=>calls.push([name,args]),
   });
   if(previousWorks){await verify(job,'worker',{},config);assert.equal(calls[0][1].p_restore_previous,true);}
   else{await verify(job,'worker',{},config);assert.equal(calls[0][1].p_restore_previous,false);assert.equal(calls[0][1].p_failure_code,'rollback_unavailable');}
 }
});

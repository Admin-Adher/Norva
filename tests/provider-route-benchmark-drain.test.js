'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Agent}=require('undici');
const {runLeasedProviderRouteBenchmark,measureProviderRoute}=require('../services/media-gateway/src/providerRouteBenchmark');
const {createProviderMetadataTransport,finishProviderMetadataTransport,createProviderMetadataPriorityFence,isUndrainedProviderMetadata}=require('../services/media-gateway/src/provider-metadata-transport');
const gateway=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
const affinity='a'.repeat(64);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function section(start,end){const a=gateway.indexOf(start),b=gateway.indexOf(end,a);assert.ok(a>=0&&b>a);return gateway.slice(a,b);}
function harness(dispatcher){
 const entries=new Map(),calls=[];
 const context={createProviderMetadataTransport,finishProviderMetadataTransport,runLeasedProviderRouteBenchmark,measureProviderRoute,
   providerRouteBenchmarkDispatcher:dispatcher,providerRouteBenchmarkInstanceFingerprint:'instance',
   ACCOUNT_ACTIVITY_KIND_GATEWAY:'gateway',accountExtractions:entries,sessions:new Map(),rawPumps:new Set(),strictLidBrokers:new Map(),
   isUndrainedProviderMetadata,providerMetadataPriorityFence:createProviderMetadataPriorityFence(),
   providerAffinityHashForGatewayKey:()=>affinity,proxyKeyFromUrl:()=>'',isSessionBlockingProviderSlot:()=>false,viewerPlaybackActiveLocally:()=>false,
   abortRawPumps:()=>0,stopSession:async()=>{},stopChildProcess:async()=>{throw Error('HTTP adapter cannot use subprocess stop');},
   PROVIDER_SLOT_RELEASE_DELAY_MS:0,
   registerAccountExtraction(key,child,activityKind){const entry={child,activityKind,preempted:false,release(){entries.delete(key);}};entries.set(key,new Set([entry]));return entry;},
   providerAdaptiveRouteControl:{candidates:[{id:'1:http',nodeTransport:'http',slot:1}],requestBenchmark:async action=>{
     calls.push(action);if(action==='claim')return {granted:true,leaseToken:'local-lease'};
     if(action==='pulse')return {active:true};return {accepted:true};}},
 };
 vm.runInNewContext(section('function accountKeyBusyLocally(','\nfunction accountSlotBusyLocally(')+'\n'
   +section('async function runProviderRouteBenchmarkJob(','\nfunction armProviderRouteBenchmarkDrain(')+'\n'
   +section('async function stopProviderAffinities(','\nasync function stopConflictingSourceSessions(')+'\nthis.api={run:runProviderRouteBenchmarkJob,stop:stopProviderAffinities,busy:accountKeyBusyLocally};',context);
 return{...context,entries,calls};
}

for(const closeFailure of [false,true])test(`route benchmark ${closeFailure?'failed close never attests drain':'aborts and awaits actual dispatcher close'} through the real measurement/lease implementation`,{timeout:10000},async()=>{
 const opened=deferred(),closeGate=deferred(),closeReached=deferred(),gone=deferred();
 const sockets=new Set();
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'video/mp2t'});res.write(Buffer.alloc(4096));opened.resolve();});
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);gone.resolve();});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const h=harness(()=>{const dispatcher=new Agent();const close=dispatcher.close.bind(dispatcher);
   dispatcher.close=(...args)=>{if(args.length)return close(...args);return close().then(async()=>{closeReached.resolve();await closeGate.promise;if(closeFailure)throw Error('close-result-uncertain');});};return dispatcher;});
 const controller=new AbortController();
 const job={affinityKey:'fixture-account',accountFingerprint:'account',hostFingerprint:'host',sourceUrl:`http://127.0.0.1:${server.address().port}/movie`,userAgent:'fixture'};
 const running=h.api.run(job,controller);
 try{
   await opened.promise;
   const stopping=h.api.stop([affinity]);let settled=false;stopping.then(()=>{settled=true;});
   await closeReached.promise;await new Promise(resolve=>setImmediate(resolve));
   assert.equal(controller.signal.aborted,true);assert.equal(settled,false);assert.equal(h.entries.size,1);
   closeGate.resolve();const drained=await stopping;const outcome=await running;await gone.promise;
   assert.equal(drained.providerDrained,!closeFailure);assert.equal(outcome.status,'preempted');
   assert.equal(h.calls.filter(x=>x==='release').length,1);assert.equal(sockets.size,0);
   assert.equal(h.entries.size,closeFailure?1:0);
   if(closeFailure)assert.equal(h.api.busy(job.affinityKey),true);
 }finally{
   controller.abort();closeGate.resolve();for(const socket of sockets)socket.destroy();
   await running.catch(()=>{});await new Promise(resolve=>server.close(resolve));
 }
});

test('a benchmark whose lease arrives after the provider drain cannot start a new video probe',async()=>{
 let opens=0;
 const h=harness(()=>{opens++;throw Error('late benchmark reached provider');});
 assert.equal((await h.api.stop([affinity])).providerDrained,true);
 const outcome=await h.api.run({affinityKey:'fixture-account',accountFingerprint:'account',hostFingerprint:'host'},new AbortController());
 assert.equal(outcome.status,'preempted');assert.equal(opens,0);assert.equal(h.entries.size,0);
 assert.equal(h.calls.filter(x=>x==='release').length,1);
});

test('failed close after a normal sample blocks every following probe without requiring a viewer abort',{timeout:10000},async()=>{
 let opens=0;
 const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'video/mp2t'});res.end(Buffer.alloc(1024*1024));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const h=harness(()=>{opens++;const dispatcher=new Agent(),close=dispatcher.close.bind(dispatcher);
   dispatcher.close=(...args)=>args.length?close(...args):close().then(()=>{throw Error('normal-sample-close-uncertain');});return dispatcher;});
 try{
   const controller=new AbortController();
   const outcome=await h.api.run({affinityKey:'fixture-account',accountFingerprint:'account',hostFingerprint:'host',sourceUrl:`http://127.0.0.1:${server.address().port}/movie`},controller);
   assert.equal(controller.signal.aborted,false);
   assert.equal(opens,1);assert.equal(outcome.status,'preempted');assert.equal(h.entries.size,1);
   assert.equal(h.api.busy('fixture-account'),true);
   assert.equal(h.calls.filter(x=>x==='release').length,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises;
const os=require('node:os'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {PrivateResumeHlsCache}=require('../services/media-gateway/src/private-resume-hls-cache');
const {PrivateResumePersistence}=require('../services/media-gateway/src/private-resume-persistence');
const {StartupCacheDiskStore}=require('../services/media-gateway/src/startup-cache-disk-store');
const {privateResumeBinding}=require('../services/media-gateway/src/private-resume-binding');
const {createNativeMp4Sessions}=require('../services/media-gateway/src/native-mp4-sessions');
const N=65536,bytes=Buffer.alloc(8*N,7),samples=[0,N,2*N,3*N].map(start=>({start,payload:bytes.subarray(start,start+N)}));
const binding=privateResumeBinding({ownerKey:'a'.repeat(64),sourceUrl:'https://source.invalid/film.mp4',
 sourceId:'source',sourceRevision:'1',fileSizeBytes:bytes.length,profile:'native-browser-mp4-input-v1'});
const observed={fileSizeBytes:bytes.length,effectiveUrlIdentitySha256:'b'.repeat(64),samples,validator:{kind:'etag',value:'"v1"'}};
function cache(now=Date.now){return new PrivateResumeHlsCache({maxBytes:4*1024**2,perFileBytes:1024**2,recentRevalidation:true,now});}
function capture(c,position=110,evidence=observed){return c.captureInput({binding,observed:evidence,inputWindows:[{start:0,payload:bytes}],
 nativeResume:{position,duration:1000}});}
test('small native B replaces A within the unchanged aggregate reservation bound',()=>{
 const c=new PrivateResumeHlsCache({maxBytes:2*1024**2,perFileBytes:1024**2,recentRevalidation:true});
 assert.equal(capture(c,110),true);
 assert.equal(capture(c,140),true,'configured maximum must not reject the smaller actual window');
 assert.equal(c.inputCandidate(binding).resumePosition,140);
 assert.equal(c.bytes,bytes.length);assert.equal(c.reservedBytes,0);
 const lease=c.acquireInput(binding,observed);assert.ok(lease);
 assert.equal(capture(c,160),false,'an in-use entry still refuses replacement');lease.release();
 const small=new PrivateResumeHlsCache({maxBytes:bytes.length,perFileBytes:bytes.length,recentRevalidation:true});
 assert.equal(capture(small),false,'actual copy reservation remains enforced');
 assert.equal(small.publicStatus().lastCaptureRejection,'reservation-budget');
 assert.equal(small.bytes,0);assert.equal(small.reservedBytes,0);
});
async function disk(t,now=Date.now){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'norva-native-resume-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const config={root,purpose:'resume',maxBytes:8*1024**2,perOwnerBytes:2*1024**2,perFileBytes:1024**2,reserveFreeBytes:1,retentionMs:7*86400_000,now};
 const store=new StartupCacheDiskStore(config);await store.initialize();return {store,config};
}

test('native MP4 archive is lossless, survives disk restart, and cannot be mistaken for a first-minute HLS prefix',async t=>{
 const {store,config}=await disk(t),c=cache();assert.equal(capture(c),true);
 const entry=c.inputCandidate(binding);assert.equal(await store.put(entry,'d'.repeat(64)),true);
 assert.equal(store.metadata(binding).storage.codec,'gzip');assert.equal(store.metadata(binding).assets.length,0);
 const restarted=new StartupCacheDiskStore(config);await restarted.initialize();const restored=await restarted.get(binding);
 assert.ok(restored);assert.equal(restored.resumePosition,110);assert.equal(restored.durationSeconds,1000);
 assert.deepEqual(restored.inputWindows[0].payload,bytes);
 const next=cache();assert.equal(await next.restoreWindow(binding,0,()=>restored,'resume',true),true);
 assert.equal(next.acquireInput(binding,{...observed,validator:{kind:'etag',value:'"changed"'}}),null);
 const wrong=new StartupCacheDiskStore({...config,purpose:'startup'});assert.equal(wrong.validManifest(store.metadata(binding)),false);
 for(const patch of [{resumePosition:900},{inputOnly:false},{durationSeconds:null},{format:'unknown'},
  {assets:[{name:'resume-0.ts'}]},{recentProof:null}])assert.equal(store.validManifest({...store.metadata(binding),...patch}),false);
});

test('aged native archive requires both a current strong identity and all four matching samples; weak proof expires',async t=>{
 let now=Date.now();const h=await disk(t,()=>now),c=cache(()=>now);
 for(const validator of [observed.validator,null]) {
  const b={...binding,profileHash:(validator?'c':'e').repeat(64)};
  assert.equal(c.captureInput({binding:b,observed:{...observed,validator},inputWindows:[{start:0,payload:bytes}],nativeResume:{position:110,duration:1000}}),true);
  assert.equal(await h.store.put(c.inputCandidate(b),'d'.repeat(64)),true);
 }
 now+=2*86400_000;
 const strong={...binding,profileHash:'c'.repeat(64)},weak={...binding,profileHash:'e'.repeat(64)};
 assert.equal(await h.store.get(weak),null);const entry=await h.store.get(strong);assert.ok(entry?.archived);
 const next=cache(()=>now);assert.equal(await next.restoreWindow(strong,0,()=>entry,'resume',true),true);
 assert.equal(next.acquireInput(strong,{...observed,validator:null}),null);
 const fresh=cache(()=>now);await fresh.restoreWindow(strong,0,()=>h.store.get(strong),'resume',true);
 const lease=fresh.acquireInput(strong,observed);assert.ok(lease);assert.deepEqual(lease.inputSnapshot().windows[0].payload,bytes);lease.release();
});

test('native hydration is bounded and rejects changed duration, ownership, retirement and cancellation',async()=>{
 const c=cache();capture(c);const saved=c.inputCandidate(binding);c.drop([...c.entries.keys()][0],saved);
 const store={disk:{purpose:'resume'},get:async()=>({...saved,live:true,inputWindows:[{start:0,payload:bytes}]}),current:async()=>true,
  retire:async()=>{},status:()=>({})};
 const p=new PrivateResumePersistence({cache:c,store,allowsOwner:o=>o===binding.ownerKey});
 assert.equal(await p.restoreInput(binding,999),false);assert.equal(await p.restoreInput({...binding,ownerKey:'e'.repeat(64)},1000),false);
 let release;store.get=()=>new Promise(r=>release=r);const pending=p.restoreInput(binding,1000);
 p.retire(binding);release({...saved,live:true});assert.equal(await pending,false);await p.drained();assert.equal(c.bytes,0);assert.equal(c.reservedBytes,0);
});

test('a native archive already in RAM also requires the current signed duration',async()=>{
 const c=cache();capture(c);let retired=0;
 const p=new PrivateResumePersistence({cache:c,allowsOwner:()=>true,store:{disk:{purpose:'resume'},
  retire:async()=>{retired++;},get:async()=>null,current:async()=>true,status:()=>({})}});
 assert.equal(await p.restoreInput(binding,999),false);await p.drained();
 assert.equal(c.inputCandidate(binding),null);assert.equal(retired,1);
});

test('native upload is asynchronous and end/unknown/zero positions never create a new archive',async()=>{
 const c=cache(),calls=[];let release;const wait=new Promise(r=>release=r);
 const store={disk:{purpose:'resume'},retire:async()=>{},put:async(e,k,current)=>{await wait;calls.push(e.resumePosition);return current();},status:()=>({})};
 const p=new PrivateResumePersistence({cache:c,store,allowsOwner:()=>true});capture(c);
 assert.equal(p.queueInput(binding,110,1000),true);assert.equal(c.reservedBytes,bytes.length);
 await new Promise(r=>setImmediate(r));p.progress(binding,111,110,1000);release();await p.drained();assert.equal(p.status().stored,0);assert.equal(c.reservedBytes,0);
 for(const position of [0,900,950,1000])assert.equal(capture(c,position),false);
 assert.equal(p.queueInput(binding,110,null),false);assert.equal(p.queueInput(binding,111,1000),false);
 assert.equal(c.captureInput({binding,observed,inputWindows:[{start:0,payload:bytes}]}),true);
 assert.equal(p.queueInput(binding,110,1000),false,'legacy input bytes are not a durable resume window');
});

test('native authenticated position reports neither open media nor extend expired/foreign grants; stop position precedes capture',async()=>{
 let now=Date.now(),opens=0;const seen=[];
 const sessions=createNativeMp4Sessions({now:()=>now,allows:()=>true,open:async entry=>{opens++;return {
  reportPosition:p=>seen.push(['progress',p]),prepareClose:()=>seen.push(['prepare',entry.renderedPosition]),close:async()=>{seen.push(['close']);}};}});
 const sid='12345678-1234-4234-a234-123456789013',uid='12345678-1234-4234-a234-123456789014';
 const entry=sessions.grant({v:1,scope:'native-browser-mp4',sid,uid,url:'https://source.invalid/a.mp4',fileSizeBytes:bytes.length,exp:Math.floor(now/1000)+600});
 assert.throws(()=>sessions.reportPosition(sid,'wrong',12),{status:404});assert.equal(opens,0);
 for(const p of [null,NaN,-1,86400,'12'])assert.equal(sessions.reportPosition(sid,entry.ownerHash,p),false);
 assert.equal(sessions.reportPosition(sid,entry.ownerHash,110),true);assert.equal(opens,0);
 await sessions.resource(entry);sessions.reportPosition(sid,entry.ownerHash,111);
 await sessions.revoke(entry.ownerHash,sid,false,900);
 assert.deepEqual(seen,[['progress',111],['progress',900],['prepare',900],['close']]);
 assert.throws(()=>sessions.reportPosition(sid,entry.ownerHash,12),{status:410});
});

test('WatchPage heartbeat sends only the actual clock of its current native MP4, excluding prefetch/old media/seeks',async()=>{
 const source=fs.readFileSync(require.resolve('../public/js/pages/WatchPage.js'),'utf8');
 const a=source.indexOf('    nativeResumeRenderedPosition('),b=source.indexOf('    startCloudPlaybackHeartbeat(',a);
 const context={window:{location:{href:'https://norva.tv/app'}},URL};vm.createContext(context);
 vm.runInContext('class Page {'+source.slice(a,b)+'};globalThis.Page=Page;',context);
 const p=new context.Page(),sid='current';p.video={readyState:2,seeking:false,currentTime:110,currentSrc:`https://media.invalid/sessions/${sid}/native.mp4?token=opaque`};
 assert.equal(p.nativeResumeRenderedPosition(sid),110);
 for(const change of [{readyState:1},{seeking:true},{currentTime:NaN},{currentSrc:'https://media.invalid/sessions/old/native.mp4'},
  {currentSrc:'https://media.invalid/sessions/current/playlist.m3u8'}]) {
  const prior=p.video;p.video={...prior,...change};assert.equal(p.nativeResumeRenderedPosition(sid),undefined);p.video=prior;
 }
 // A paused/ended clock is still usable to retire the final ten percent.
 p.video.currentTime=900;p.video.paused=true;assert.equal(p.nativeResumeRenderedPosition(sid),900);
});

test('both Cloud APIs send finite progress optionally while old heartbeat-only callers keep a null body',async()=>{
 for(const file of ['../public/js/cloudApi.js','../clients/mobile-pwa/cloudApi.js']) {
  const source=fs.readFileSync(require.resolve(file),'utf8'),a=source.indexOf('    function playbackHeartbeatRequest('),b=source.indexOf('\n    }',a)+6;
  const calls=[],context={requestToBase:(...args)=>calls.push(args),playbackBase:()=>'/playback'};vm.createContext(context);
  vm.runInContext(source.slice(a,b),context);context.playbackHeartbeatRequest('test',{},123.5);
  assert.equal(calls[0][3].renderedPosition,123.5);
  for(const value of [undefined,null,'123',NaN,Infinity,-1,86400])context.playbackHeartbeatRequest('test',{},value);
  assert.ok(calls.slice(1).every(c=>c[3]===null));
 }
});

test('WatchPage uses the current Windows native clock instead of a stale DOM video clock',()=>{
 const source=fs.readFileSync(require.resolve('../public/js/pages/WatchPage.js'),'utf8');
 const a=source.indexOf('    nativeResumeRenderedPosition('),b=source.indexOf('    startCloudPlaybackHeartbeat(',a);
 let position=123.5,seen;
 const context={window:{NorvaDesktop:{nativePlayer:{protocol:1}},__norvaNative:{renderedPosition:id=>{seen=id;return position;}}},URL};vm.createContext(context);
 vm.runInContext('class Page {'+source.slice(a,b)+'};globalThis.Page=Page;',context);
 const p=new context.Page();p.video={readyState:2,currentTime:12,currentSrc:'https://media.invalid/sessions/old/native.mp4'};
 assert.equal(p.nativeResumeRenderedPosition('owned'),123.5);assert.equal(seen,'owned');
 for(const value of [undefined,NaN,-1,86400,'123']) { position=value;assert.equal(p.nativeResumeRenderedPosition('owned'),undefined); }
});

test('Edge forwards native progress only after owned active-session authorization and forwards the stop position',()=>{
 const source=fs.readFileSync(require.resolve('../supabase/functions/norva-playback/index.ts'),'utf8');
 const a=source.indexOf('async function heartbeatPlaybackSession('),b=source.indexOf('async function requestDemandDrivenMediaCacheContinuation(',a),body=source.slice(a,b);
 assert.ok(body.indexOf('.eq("user_id", userId)')<body.indexOf('/native-sessions/'));
 assert.ok(body.indexOf('!policy.accepted')<body.indexOf('/native-sessions/'));
 assert.match(body,/renderedPosition!==null \? \{renderedPosition\}/);
 assert.match(source,/rawUrl\.searchParams\.set\('resumePosition',String\(resumePosition\)\)/);
});

for(const [scope,durable] of [['native-browser-mp4',true],['native-vod-recovery',true],['native-vod-recovery',false]])
for(const [stopPosition,revocation] of [[210,null],[900,null],[210,'other'],[210,'owner']])
test(`the actual ${scope} Gateway close drains without waiting for storage, enabled ${durable}, stop ${stopPosition}, revoke ${revocation}`,async()=>{
 const gateway=fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'),'utf8');
 const sid='12345678-1234-4234-a234-123456789013',uid='12345678-1234-4234-a234-123456789014';
 const owner=crypto.createHash('sha256').update(uid).digest('hex');let now=Date.now(),released=false,putFinished=false,snapshots=0;
 const b=privateResumeBinding({ownerKey:owner,sourceUrl:'https://source.invalid/film.mp4',sourceId:'source',sourceRevision:'1',
  fileSizeBytes:bytes.length,profile:scope==='native-browser-mp4' ? 'native-browser-mp4-input-v1' : 'native-vod-recovery-input-v1'}),c=cache(()=>now);
 assert.equal(c.captureInput({binding:b,observed,inputWindows:[{start:0,payload:bytes}],nativeResume:{position:110,duration:1000,
  format:scope==='native-browser-mp4' ? 'native-mp4-input-v1' : 'native-file-input-v1'}}),true);
 let finish;const wait=new Promise(r=>finish=r),stored=[];
 const p=new PrivateResumePersistence({cache:c,allowsOwner:o=>durable && o===owner,store:{disk:{purpose:'resume'},get:async()=>null,current:async()=>true,
  retire:async()=>{},put:async e=>{stored.push(e.resumePosition);await wait;putFinished=true;return true;},status:()=>({})}});
 const broker={inputUrl:'http://127.0.0.1:9999/private',seedRecentInput:()=>bytes.length,close:async()=>{},terminalError:null,
  snapshotRecentSamples:()=>samples,snapshotNativeMp4Input:()=>{snapshots++;return [{start:0,payload:bytes}];},
  snapshotRecentInput:maximum=>{assert.equal(maximum,32*1024*1024);snapshots++;return [{start:0,payload:bytes}];},
  retainDeliveryTarget:()=>null,cachedMp4Coverage:()=>null,windowTrace:[]};
 const context={createNativeMp4Sessions,allowsNativeMp4Capability:()=>true,process:{env:{}},PUBLIC_BASE_URL:'https://media.invalid',
  proxyKeyFromUrl:()=>'',providerSlotKeyFromUrl:()=>'',providerSessionBlocksRawOpening:()=>false,
  registerRawPump:()=>({}),releaseRawPump:()=>{released=true;},abortRawPumps:()=>0,preemptAccountExtractions:()=>0,
  preemptAccountBackgroundWhispers:()=>{},preemptBackgroundWorkGlobally:()=>{},canUseStartupCache:()=>true,
  canUseRecentResumeSamples:()=>true,canUsePrivateResumeCache:()=>false,privateResumeBinding,privateResumeHlsCache:c,
  privateResumePersistence:p,PROVIDER_SLOT_RELEASE_DELAY_MS:0,providerAdaptiveRouteControl:{resolveForPlayback:async()=>null},
  providerNodeRouteForSession:()=>({}),pinnedProxyAgentFactoryForRoute:()=>()=>{},isPublicDirectRoute:()=>true,
  observeProviderProxySelection:()=>{},sharedPlaybackRanges:{begin:()=>null},hybridPlaybackRanges:()=>null,
  revalidateNativeRecentInput:async()=>{assert.equal(durable,true);const lease=c.acquireInput(b,observed);return {lease,snapshot:lease.inputSnapshot()};},
  createStrictLidBroker:async options=>{assert.equal(options.captureRecentSamples,durable);options.onProviderIdentity(observed);return broker;},resumeWindowDisposition:require('../services/media-gateway/src/private-resume-persistence').resumeWindowDisposition,
  console:{info:()=>{}},setImmediate};
 vm.createContext(context);vm.runInContext(gateway.slice(gateway.indexOf('const nativeMp4Sessions = createNativeMp4Sessions('),
  gateway.indexOf('setInterval(() => { void nativeMp4Sessions.sweep()'))+'\nglobalThis.native=nativeMp4Sessions;',context);
 const entry=context.native.grant({v:1,scope,sid,uid,url:'https://source.invalid/film.mp4',
  fileSizeBytes:bytes.length,resumeSourceId:'source',resumeSourceRevision:'1',durationSeconds:1000,exp:Math.floor(Date.now()/1000)+600});
 await context.native.resource(entry);context.native.reportPosition(sid,owner,111);now++;
 if(revocation)c.revokeOwner(revocation==='owner'?owner:'e'.repeat(64));
 await context.native.revoke(owner,sid,false,stopPosition);assert.equal(released,true);assert.equal(putFinished,false);
 assert.equal(snapshots,durable && stopPosition<900?1:0);
 const eligible=durable && stopPosition<900 && revocation!=='owner';
 await new Promise(r=>setImmediate(r));assert.deepEqual(stored,eligible?[210]:[]);
 finish();await p.drained();assert.equal(p.status().stored,eligible?1:0);
 assert.equal(c.reservedBytes,0);if(durable && stopPosition>=900)assert.equal(c.bytes,0);
});

test('the bounded owner revocation stamp isolates accounts and safely fences all stamps on capacity overflow',()=>{
 const c=cache(),stamp=c.ownerRevocationStamp(binding.ownerKey);
 c.revokeOwner('e'.repeat(64));assert.equal(c.ownerRevocationStamp(binding.ownerKey),stamp);
 c.retire(binding);assert.equal(c.ownerRevocationStamp(binding.ownerKey),stamp);
 c.revokeOwner(binding.ownerKey);assert.notEqual(c.ownerRevocationStamp(binding.ownerKey),stamp);
 const current=c.ownerRevocationStamp(binding.ownerKey);
 for(let i=0;i<8192;i++)c.revokeOwner(crypto.createHash('sha256').update('bounded-'+i).digest('hex'));
 assert.ok(c.ownerRevocationEpochs.size<=8192);assert.notEqual(c.ownerRevocationStamp(binding.ownerKey),current);
});

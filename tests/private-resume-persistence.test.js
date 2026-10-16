'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PrivateResumePersistence,resumeWindowDisposition}=require('../services/media-gateway/src/private-resume-persistence');
const {PrivateResumeHlsCache}=require('../services/media-gateway/src/private-resume-hls-cache');
const {privateResumeBinding}=require('../services/media-gateway/src/private-resume-binding');
const binding=privateResumeBinding({ownerKey:'a'.repeat(64),sourceUrl:'https://source.invalid/private/film.mkv',
 sourceId:'source',sourceRevision:'1',fileSizeBytes:10_000_000,profile:'aac'});
const observed={fileSizeBytes:binding.fileSizeBytes,validator:{kind:'etag',value:'"v1"'},effectiveUrlIdentitySha256:'b'.repeat(64)};
const playlist='#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n'+Array.from({length:20},(_,i)=>`#EXTINF:4,\nsegment-${i}.ts\n`).join('');
const capture=(cache,position=110,offset=100)=>cache.capture({binding,observed,position,actualStartOffset:offset,playlist,readAsset:async()=>Buffer.alloc(188,0x47)});
const fs=require('node:fs'),vm=require('node:vm');
const gateway=fs.readFileSync(require.resolve('../services/media-gateway/src/index.js'),'utf8');
function setup(overrides={}) {
 let now=Date.now();const cache=new PrivateResumeHlsCache({now:()=>now,maxBytes:65536,perFileBytes:8192});
 const calls=[];const store={disk:{purpose:'resume'},get:async()=>null,current:async()=>true,retire:async(b,at)=>{calls.push(['retire',b,at]);},
  put:async(e,k,isCurrent)=>{calls.push(['put',e,k]);return isCurrent();},revokeOwner:async()=>{},status:()=>({}),...overrides};
 const p=new PrivateResumePersistence({cache,store,allowsOwner:o=>o===binding.ownerKey});
 return {cache,p,store,calls,advance:()=>now++};
}
test('only a valid position strictly below 90 percent is durable; unknown duration is never guessed',()=>{
 for(const x of [NaN,-1,0])assert.equal(resumeWindowDisposition(x,100),'no-position');
 for(const d of [null,NaN,0,-1])assert.equal(resumeWindowDisposition(50,d),'unknown-duration');
 assert.equal(resumeWindowDisposition(89.999,100),'resume');
 for(const x of [90,95,100,101])assert.equal(resumeWindowDisposition(x,100),'finished');
});
test('advancing retires A for future resumes, without breaking the active local lease',async()=>{
 const h=setup();assert.equal(await capture(h.cache),true);const lease=h.p.acquire(binding,110,observed);assert.ok(lease);
 assert.equal(h.p.progress(binding,110,110,1000),false);assert.equal(h.p.progress(binding,111,110,1000),true);
 assert.ok(lease.asset('resume-0.ts'));assert.equal(h.p.acquire(binding,111,observed),null);
 lease.release();assert.equal(h.cache.publicStatus().entries,0);await h.p.drained();assert.equal(h.calls[0][0],'retire');
});
test('upload is independent of foreground closing and pins only a bounded, accounted snapshot',async()=>{
 let release;const wait=new Promise(r=>release=r);const h=setup({put:async(e,k,current)=>{await wait;return current();}});
 assert.equal(await capture(h.cache),true);const bytes=h.cache.bytes;
 assert.equal(h.p.queueWindow(binding,110,1000),true);assert.equal(h.p.queueWindow(binding,110,1000),false);
 assert.equal(h.cache.reservedBytes,bytes);await new Promise(r=>setImmediate(r));
 h.p.progress(binding,111,110,1000);assert.equal(h.cache.bytes,0);assert.equal(h.cache.reservedBytes,bytes);
 release();await h.p.drained();assert.equal(h.cache.reservedBytes,0);assert.equal(h.p.status().stored,0);
 h.advance();assert.equal(await capture(h.cache,210,200),true);assert.equal(h.p.queueWindow(binding,210,1000),true);
 await h.p.drained();assert.equal(h.p.status().stored,1);
});
test('no upload for the ending, input-only cache, unowned source or disabled storage',async()=>{
 const h=setup();assert.equal(await capture(h.cache,910,900),true);assert.equal(h.p.queueWindow(binding,910,1000),false);
 assert.equal(h.p.queueWindow(binding,910,null),false);
 const off=new PrivateResumePersistence({cache:h.cache});assert.equal(off.queueWindow(binding,910,2000),false);
 assert.equal(off.progress(binding,990,910,1000),false);
 const other={...binding,ownerKey:'c'.repeat(64)};assert.equal(h.p.progress(other,950,900,1000),false);
 h.p.progress(binding,900,110,1000);await h.p.drained();assert.equal(h.cache.publicStatus().entries,0);
});
test('revocation during remote hydration prevents insertion; changed identity schedules removal',async()=>{
 const h=setup();assert.equal(await capture(h.cache),true);const entry=h.cache.candidate(binding,110);
 h.cache.entries.clear();h.cache.bytes=0;let release;const wait=new Promise(r=>release=r);
 h.store.get=async()=>{await wait;return entry;};const restoring=h.p.restore(binding,110,1000);
 h.p.retire(binding);release();assert.equal(await restoring,false);await h.p.drained();
 h.advance();assert.equal(await capture(h.cache),true);
 assert.equal(h.p.acquire(binding,110,{...observed,validator:{kind:'etag',value:'"changed"'}}),null);
 await h.p.drained();assert.equal(h.cache.publicStatus().entries,0);
});
test('a slow or failed durable deletion prevents that job from publishing B',async()=>{
 const h=setup({retire:async()=>{throw Error('unconfirmed');}});assert.equal(await capture(h.cache),true);
 assert.equal(h.p.queueWindow(binding,110,1000),true);await h.p.drained();
 assert.equal(h.p.status().stored,0);assert.equal(h.p.status().failures,1);assert.equal(h.cache.reservedBytes,0);
});
test('authenticated rendered progress retires the right absolute position; downloads and other viewers cannot retire it',async()=>{
 for(const invalid of ['none','token','attachment','expired','timestamps']) {
  const h=setup();await capture(h.cache);const session={codecProfile:{durationSeconds:1000},seekOffset:110,actualStartOffset:100,
   accessToken:'exact',primaryViewerAttached:true,expiresAt:new Date(Date.now()+60000)};
  const req={query:{renderedPosition:'15'},playbackToken:'exact'};
  if(invalid==='token')req.playbackToken='wrong';if(invalid==='attachment')req.playbackAttachmentId='secondary';
  if(invalid==='expired')session.expiresAt=new Date(0);if(invalid==='timestamps')session.sourceTimestamps=true;
  const context={privateResumePersistence:h.p,resumeWindowDisposition,privateResumeHlsBindingForSession:()=>binding,
   asRecord:x=>x || {},retainedSubtitleClock:()=>false,timingSafeEqual:(a,b)=>a===b};
  vm.createContext(context);vm.runInContext(gateway.slice(gateway.indexOf('function privateResumeDuration('),gateway.indexOf('async function tryStartPrivateStartupBeforePreopen('))
   +gateway.slice(gateway.indexOf('function reportRetainedPlaybackPosition('),gateway.indexOf("app.get('/sessions/:id/playlist.m3u8'")),context);
  context.reportRetainedPlaybackPosition(req,session);await h.p.drained();
  assert.equal(h.p.status().retired,invalid==='none'?1:0);
  if(invalid==='none')assert.equal(session.privateResumeCacheRetired,true);
 }
});
test('the real stop capture creates B after drain and refuses capture at exactly 90 percent',async()=>{
 const h=setup(),context={privateResumePersistence:h.p,privateResumeHlsCache:h.cache,resumeWindowDisposition,
  privateResumeHlsBindingForSession:()=>binding,privateResumeRetainedInputBinding:()=>null,
  privateResumeObservedIdentity:()=>observed,asRecord:x=>x || {},fsp:{readFile:async()=>playlist},
  exactSubtitleHlsEnabled:()=>false,exactSubtitleRenditionsForSession:()=>[],retainedSubtitleClock:()=>false,
  readPrivateResumeAsset:async()=>Buffer.alloc(188,0x47)};
 vm.createContext(context);vm.runInContext(gateway.slice(gateway.indexOf('async function capturePrivateResumeWindow('),gateway.indexOf('async function tryStartPrivateStartupBeforePreopen(')),context);
 const session={privateResumeStopPosition:110,actualStartOffset:100,codecProfile:{durationSeconds:1000}};
 assert.equal(await context.capturePrivateResumeWindow(session),true);await h.p.drained();assert.equal(h.p.status().stored,1);
 session.privateResumeStopPosition=900;assert.equal(await context.capturePrivateResumeWindow(session),false);
 await h.p.drained();assert.equal(h.cache.publicStatus().entries,0);assert.equal(h.p.status().stored,1);
});

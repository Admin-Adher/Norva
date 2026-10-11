'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
let Miniflare;try{({Miniflare}=require('miniflare'));}catch(error){if(process.env.NORVA_REQUIRE_STARTUP_R2==='1')throw error;}
const {StartupCacheDiskStore}=require('../services/media-gateway/src/startup-cache-disk-store');
const {StartupCacheR2Store}=require('../services/media-gateway/src/startup-cache-r2-store');
const {PrivateResumeHlsCache}=require('../services/media-gateway/src/private-resume-hls-cache');
const {createPrivateStartupCache,startupBinding}=require('../services/media-gateway/src/private-startup-cache');
const {privateResumeBinding}=require('../services/media-gateway/src/private-resume-binding');
const {PrivateResumePersistence,resumeWindowDisposition}=require('../services/media-gateway/src/private-resume-persistence');
const owner='a'.repeat(64),token='local-test-'.repeat(4),hmac='d'.repeat(64);
const body={ownerKey:owner,sourceUrl:'https://source.invalid/movie/private/1.mkv',playbackIdentity:{sourceId:'test-source'}};
const binding=privateResumeBinding({...body,sourceId:'test-source',sourceRevision:'1',fileSizeBytes:1e7,profile:'aac'});
const observed={fileSizeBytes:1e7,validator:{kind:'etag',value:'"v1"'},effectiveUrlIdentitySha256:'b'.repeat(64)};
const playlist='#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA-SEQUENCE:0\n'+Array.from({length:16},(_,i)=>`#EXTINF:4,\nsegment-${i}.ts\n`).join('');
async function fixture(t,overrides={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'norva-r2-local-'));let clock=Date.now(),mf;
 const config={modules:true,scriptPath:path.join(__dirname,'../workers/startup-cache/src/index.mjs'),compatibilityDate:'2026-06-01',
  durableObjects:{STARTUP_PREFIX_LEDGER:{className:'StartupPrefixLedger',useSQLite:true}},r2Buckets:['STARTUP_PREFIX_BUCKET'],
  durableObjectsPersist:path.join(root,'ledger'),r2Persist:path.join(root,'bucket'),
  bindings:{STARTUP_PREFIX_R2_ENABLED:'true',STARTUP_PREFIX_R2_ACTIVATION_APPROVED:'true',STARTUP_PREFIX_SERVICE_TOKEN:token,
   STARTUP_PREFIX_MANIFEST_HMAC_KEY:hmac,STARTUP_PREFIX_MAX_BYTES:'1048576',STARTUP_PREFIX_OWNER_MAX_BYTES:'131072',
   STARTUP_PREFIX_MAX_OBJECTS:'20',...overrides}};
 const start=()=>{mf=new Miniflare(config);};start();
 t.after(async()=>{await mf.dispose();await fs.rm(root,{recursive:true,force:true});});
 await mf.ready;
 const fetchImpl=(url,options)=>mf.dispatchFetch('https://cache.invalid'+new URL(url).pathname,options);
 const diskConfig={root:path.join(root,'staging'),maxBytes:1048576,perOwnerBytes:131072,perFileBytes:65536,reserveFreeBytes:1,retentionMs:7*86400_000,now:()=>clock};
 const makeDisk=async(directory='staging')=>{const d=new StartupCacheDiskStore({...diskConfig,root:path.join(root,directory)});await d.initialize();return d;};
 const makeStore=disk=>new StartupCacheR2Store({disk,baseUrl:'https://cache.invalid',serviceToken:token,manifestHmacKey:hmac,fetchImpl});
 const makeCache=()=>new PrivateResumeHlsCache({maxBytes:262144,perFileBytes:65536,ttlMs:10000,now:()=>clock});
 const disk=await makeDisk(),store=makeStore(disk),cache=makeCache(),startup=createPrivateStartupCache(cache,store);
 const capture=(options={})=>startup.capture({binding,observed,actualStartOffset:0,playlist,preparationBody:body,readAsset:async()=>Buffer.alloc(256,7),...options});
 return {config,root,disk,store,cache,startup,capture,makeDisk,makeStore,makeCache,fetchImpl,
  setNow:n=>{clock=n;},get now(){return clock;},get mf(){return mf;},restart:async()=>{await mf.dispose();start();await mf.ready;}};
}
test('private R2 protocol against local Worker, SQLite Durable Object and R2 runtime',{skip:!Miniflare},async t=>{
 const h=await fixture(t);
 await t.test('disabled activation and wrong token perform no storage writes',async()=>{
  const r=await h.mf.dispatchFetch('https://cache.invalid/internal/prefix/lookup',{method:'POST',body:'{}'});assert.equal(r.status,401);
  const disabled=await fixture(t,{STARTUP_PREFIX_R2_ACTIVATION_APPROVED:'false'});
  const out=await disabled.fetchImpl('https://cache.invalid/internal/prefix/reserve',{method:'POST',headers:{authorization:'Bearer '+token},body:'{}'});
  assert.equal(out.status,503);assert.equal((await (await disabled.mf.getR2Bucket('STARTUP_PREFIX_BUCKET')).list()).objects.length,0);
 });
 await t.test('publishes manifest last, removes staging, and survives a runtime restart',async()=>{
  assert.equal(await h.capture(),true);assert.equal(h.disk.status().entries,0);
  const objects=await(await h.mf.getR2Bucket('STARTUP_PREFIX_BUCKET')).list();assert.equal(objects.objects.length,2);
  await h.restart();const next=h.makeStore(await h.makeDisk());
  const fresh=createPrivateStartupCache(h.makeCache(),next);assert.equal(await fresh.restore(binding),true);
  const lease=fresh.acquire(binding,0,observed);assert.ok(lease);assert.deepEqual(lease.asset('resume-0.ts'),Buffer.alloc(256,7));lease.release();
 });
 await t.test('two-day archive requires a fresh matching strong identity and rejects a changed file',async()=>{
  h.setNow(h.now+2*86400_000);const fresh=createPrivateStartupCache(h.makeCache(),h.makeStore(await h.makeDisk()));
  assert.equal(await fresh.restore(binding),true);assert.equal(fresh.acquire(binding,0,{fileSizeBytes:1e7}),null);
  assert.equal(await fresh.restore(binding),true);
  const lease=fresh.acquire(binding,0,observed);assert.ok(lease);lease.release();
  assert.equal(fresh.acquire(binding,0,{...observed,validator:{kind:'etag',value:'"changed"'}}),null);
  await new Promise(r=>setTimeout(r,50));assert.equal(await fresh.restore(binding),false);
 });
});
test('aged sampled identity, corrupted objects and revocation during hydration are refused',{skip:!Miniflare},async t=>{
 const weak=await fixture(t);weak.cache.recentRevalidation=true;
 const samples=Array.from({length:4},(_,i)=>({start:i*65536,payload:Buffer.alloc(65536,i)}));
 assert.equal(await weak.capture({observed:{fileSizeBytes:1e7,effectiveUrlIdentitySha256:'b'.repeat(64),samples}}),true);
 weak.setNow(weak.now+86400_000);
 assert.equal(await weak.makeStore(await weak.makeDisk()).get(startupBinding(binding)),null);
 assert.equal((await(await weak.mf.getR2Bucket('STARTUP_PREFIX_BUCKET')).list()).objects.length,2);
 const h=await fixture(t);assert.equal(await h.capture(),true);const record=[...h.store.index.values()][0];
 let bucket=await h.mf.getR2Bucket('STARTUP_PREFIX_BUCKET');
 const original=Buffer.from(await(await bucket.get(record.mediaKey)).arrayBuffer());
 await bucket.put(record.mediaKey,Buffer.alloc(original.length,9));
 assert.equal(await h.makeStore(await h.makeDisk()).get(startupBinding(binding)),null);
 await bucket.put(record.mediaKey,original,{sha256:crypto.createHash('sha256').update(original).digest()});
 const next=h.makeStore(await h.makeDisk()),normal=next.fetchImpl;
 next.fetchImpl=async(url,options)=>{const response=await normal(url,options);
  if(options.method==='GET' && new URL(url).pathname.endsWith('/payload'))await h.store.revokeOwner(owner);
  return response;};
 assert.equal(await next.get(startupBinding(binding)),null);
});
test('uncertain object write retains quota until an explicit drain is confirmed',{skip:!Miniflare},async t=>{
 const h=await fixture(t,{STARTUP_PREFIX_MAX_OBJECTS:'2'});
 let reserved;
 const original=h.store.request.bind(h.store);
 h.store.request=async(op,...args)=>{
  if(op.endsWith('/payload'))throw Error('simulated interrupted request');
  const result=await original(op,...args);if(op==='reserve')reserved=result.record;return result;};
 assert.equal(await h.capture(),false);assert.ok(reserved);
 const ns=await h.mf.getDurableObjectNamespace('STARTUP_PREFIX_LEDGER');
 const stub=ns.get(ns.idFromName('private-startup-quota-v1'));
 const action=async(op,body)=>{const r=await stub.fetch('https://ledger/'+op,{method:'POST',
  headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});return r.json();};
 const started=await action('begin',{id:reserved.id});assert.ok(started.record.io);
 await original('discard',{id:reserved.id});assert.equal((await original('cleanup',{cursor:''})).deleted,0);
 h.store.request=original;h.store.blockedUntil=0;
 assert.equal(await h.capture({binding:{...binding,sourceUrlHash:'e'.repeat(64)}}),false);
 await action('finish',{id:reserved.id,io:started.record.io});
 assert.equal((await original('cleanup',{cursor:''})).deleted,1);
});
test('shared R2 quotas, private scope and revocation',{skip:!Miniflare},async t=>{
 const h=await fixture(t,{STARTUP_PREFIX_MAX_OBJECTS:'2'});
 const entryOptions={binding:{...binding,sourceUrlHash:'c'.repeat(64)}};
 await t.test('concurrent Gateways cannot exceed the shared two-object quota',async()=>{
  const other=createPrivateStartupCache(h.makeCache(),h.makeStore(await h.makeDisk('staging-other')));
  const results=await Promise.all([h.capture(),other.capture({binding:entryOptions.binding,observed,actualStartOffset:0,
   playlist,preparationBody:body,readAsset:async()=>Buffer.alloc(256,7)})]);assert.equal(results.filter(Boolean).length,1);
  assert.equal((await(await h.mf.getR2Bucket('STARTUP_PREFIX_BUCKET')).list()).objects.length,2);
 });
 await t.test('another account cannot read the prepared entry',async()=>{
  assert.equal(await h.store.get({...startupBinding(binding),ownerKey:'e'.repeat(64)}),null);
 });
 await t.test('revocation fences remote lookups and local staging fallback, then confirmed cleanup releases quota',async()=>{
  await h.store.revokeOwner(owner);
  const next=h.makeStore(await h.makeDisk());assert.equal(await next.get(startupBinding(binding)),null);
  const out=await next.cleanup();assert.equal(out.deleted,1);
  assert.equal((await(await h.mf.getR2Bucket('STARTUP_PREFIX_BUCKET')).list()).objects.length,0);
  // The old snapshot cannot be reserved anew after deletion of its record.
  h.store.blockedUntil=0;assert.equal(await h.capture(),false);
 });
});
test('response bounds and uncertain owner revocation fail closed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'norva-r2-bounds-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const disk=new StartupCacheDiskStore({root,reserveFreeBytes:1,retentionMs:86400_000});await disk.initialize();
 const store=new StartupCacheR2Store({disk,baseUrl:'https://cache.invalid',serviceToken:token,manifestHmacKey:hmac,fetchImpl:async()=>{throw Error('uncertain');}});
 for(const [header,body] of [['-1',''],['99','xx'],['1','xx'],['2','xxx']])
  await assert.rejects(store.read(new Response(body,{headers:{'content-length':header}}),10,1000),/BODY_INVALID/);
 await assert.rejects(store.revokeOwner(owner));assert.equal(store.status().preparationBlocked,true);assert.equal(await store.get(startupBinding(binding)),null);
});

test('compressed resume windows retain position and subtitles through R2, separately from startup prefixes',{skip:!Miniflare},async t=>{
 const h=await fixture(t);const disk=new StartupCacheDiskStore({root:path.join(h.root,'resume-staging'),purpose:'resume',
  maxBytes:1048576,perOwnerBytes:131072,perFileBytes:65536,reserveFreeBytes:1,retentionMs:7*86400_000,now:()=>h.now});await disk.initialize();
 const store=h.makeStore(disk),cache=h.makeCache();
 const ts=(seconds)=>{const p=Buffer.alloc(188,255),pts=Math.round(seconds*90000);
  p.set([0x47,0x41,0,0x10,0,0,1,0xe0,0,0,0x80,0x80,5]);
  p.set([0x21|(Math.floor(pts/2**30)<<1),Math.floor(pts/2**22)&255,
   ((Math.floor(pts/2**15)&127)<<1)|1,Math.floor(pts/128)&255,((pts&127)<<1)|1],13);return p;};
 const vtt=Buffer.from('WEBVTT\n\n1\n00:00:07.000 --> 00:00:13.000\nCrossing\n\n2\n00:00:22.000 --> 00:00:25.000\nFuture\n');
 assert.equal(await cache.capture({binding,observed,position:610,actualStartOffset:600,playlist,
  subtitleRenditions:[{playlistName:'subtitle_0.m3u8',streamIndex:2}],readAsset:async name=>name.endsWith('.m3u8')
   ?Buffer.from('#EXTM3U\n#EXTINF:80,\nsubtitle_0-00000.vtt\n'):name.endsWith('.vtt')?vtt:ts(Number(/segment-(\d+)/.exec(name)[1])*4+1.4)}),true);
 const entry=cache.candidate(binding,610);assert.ok(entry);assert.ok(entry.start>=600);const before=[...entry.assets].map(([n,b])=>[n,Buffer.from(b)]);
 const key=crypto.createHash('sha256').update('resume-window-v1:'+JSON.stringify(binding)).digest('hex');
 assert.equal(await store.put(entry,key),true);const remote=[...store.index.values()][0];assert.equal(remote.envelope.manifest.purpose,'resume');
 assert.ok(remote.envelope.payloadBytes<remote.envelope.manifest.bytes);
 await h.restart();const restored=await h.makeStore(disk).get(binding);assert.ok(restored);assert.equal(restored.capturePurpose,'resume');
 assert.equal(restored.start,entry.start);assert.equal(restored.end,entry.end);assert.deepEqual([...restored.assets],before);
 const source=cache.candidate(binding,610);cache.drop([...cache.entries.keys()][0],source);
 const persistence=new PrivateResumePersistence({cache,store:h.makeStore(disk),allowsOwner:()=>true});
 assert.equal(await persistence.restore(binding,610,1000),true);
 const lease=cache.acquire(binding,610,observed);assert.ok(lease);assert.equal(lease.start,restored.start);
 const subtitles=[...restored.assets].filter(([n])=>n.endsWith('.vtt')).map(([,b])=>b.toString()).join('\n');
 assert.match(subtitles,/Crossing/);assert.match(subtitles,/Future/);lease.release();
 assert.equal(await h.makeStore(h.disk).get(binding),null);
 const wrong=new StartupCacheDiskStore({...disk,root:path.join(h.root,'wrong-purpose'),purpose:'startup'});await wrong.initialize();
 assert.equal(await h.makeStore(wrong).get(binding),null);
});

test('resume A is physically removed after progress, replaced by B, and absent in the final ten percent',{skip:!Miniflare},async t=>{
 const h=await fixture(t);assert.equal(await h.capture(),true);
 const disk=new StartupCacheDiskStore({root:path.join(h.root,'resume-lifecycle'),purpose:'resume',maxBytes:1048576,
  perOwnerBytes:131072,perFileBytes:65536,reserveFreeBytes:1,retentionMs:7*86400_000,now:()=>h.now});await disk.initialize();
 const cache=h.makeCache(),store=h.makeStore(disk),p=new PrivateResumePersistence({cache,store,allowsOwner:o=>o===owner});
 const capture=(b,position,offset)=>cache.capture({binding:b,observed,position,actualStartOffset:offset,playlist,readAsset:async()=>Buffer.alloc(256,7)});
 let bucket=await h.mf.getR2Bucket('STARTUP_PREFIX_BUCKET');
 assert.equal(await capture(binding,610,600),true);const a=cache.candidate(binding,610);
 const snapshot={...a,assets:new Map(a.assets),inputWindows:[],subtitlePlaylists:new Map(a.subtitlePlaylists),live:true};
 assert.equal(p.queueWindow(binding,610,1000),true);await p.drained();assert.equal(p.status().stored,1);
 assert.equal((await bucket.list()).objects.length,4);
 const secondCache=h.makeCache(),second=new PrivateResumePersistence({cache:secondCache,store:h.makeStore(disk),allowsOwner:()=>true});
 assert.equal(await second.restore(binding,610,1000),true);
 const lease=p.acquire(binding,610,observed);assert.ok(lease);
 assert.equal(p.progress(binding,610,610,1000),false);assert.equal(p.progress(binding,615,610,1000),true);
 assert.ok(lease.asset('resume-0.ts'));await p.drained();assert.equal((await bucket.list()).objects.length,2);
 assert.equal(await second.restore(binding,610,1000),false);assert.equal(secondCache.publicStatus().entries,0);
 assert.equal(await h.makeStore(disk).get(binding),null);lease.release();
 h.setNow(h.now+1);assert.equal(await capture(binding,710,700),true);
 assert.equal(p.queueWindow(binding,710,1000),true);await p.drained();assert.equal(p.status().stored,2);
 await h.restart();bucket=await h.mf.getR2Bucket('STARTUP_PREFIX_BUCKET');
 const b=await h.makeStore(disk).get(binding);assert.ok(b);assert.ok(b.start>=700);
 // A track change replaces the same file's window rather than retaining an
 // inaccessible older track variant. Startup storage stays independent.
 const alternate={...binding,profileHash:'e'.repeat(64)};h.setNow(h.now+1);
 assert.equal(await capture(alternate,710,700),true);assert.equal(p.queueWindow(alternate,710,1000),true);await p.drained();
 assert.equal(await h.makeStore(disk).get(binding),null);assert.ok(await h.makeStore(disk).get(alternate));
 const active=p.acquire(alternate,710,observed);assert.ok(active);
 assert.equal(resumeWindowDisposition(900,1000),'finished');p.progress(alternate,900,710,1000);await p.drained();
 assert.ok(active.asset('resume-0.ts'));active.release();assert.equal((await bucket.list()).objects.length,2);
 assert.equal(await h.makeStore(disk).get(alternate),null);
 assert.equal(await store.put(snapshot,crypto.createHash('sha256').update('old-A').digest('hex')),false);
 assert.equal(await h.makeStore(h.disk).get(startupBinding(binding))!==null,true);
 assert.equal(p.queueWindow(alternate,950,1000),false);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {StartupCacheDiskStore}=require('../services/media-gateway/src/startup-cache-disk-store');
const {PrivateResumeHlsCache}=require('../services/media-gateway/src/private-resume-hls-cache');
const {createPrivateStartupCache,startupBinding}=require('../services/media-gateway/src/private-startup-cache');
const {privateResumeBinding}=require('../services/media-gateway/src/private-resume-binding');
const owner='a'.repeat(64),target='b'.repeat(64);
const binding=privateResumeBinding({ownerKey:owner,sourceUrl:'https://private.invalid/movie/secret/1.mkv',sourceId:'source',sourceRevision:'1',fileSizeBytes:1e7,profile:'aac'});
const observed={fileSizeBytes:1e7,validator:{kind:'etag',value:'"v1"'},effectiveUrlIdentitySha256:target};
const body={ownerKey:owner,sourceUrl:'https://private.invalid/movie/secret/1.mkv',playbackIdentity:{sourceId:'source'}};
const playlist='#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA-SEQUENCE:0\n'+Array.from({length:16},(_,i)=>`#EXTINF:4,\nsegment-${i}.ts\n`).join('');
async function harness(t,options={}) {
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'norva-startup-disk-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 let now=1000;
 const config={root,maxBytes:1024**2,perOwnerBytes:128*1024,perFileBytes:64*1024,reserveFreeBytes:1,now:()=>now,...options};
 const disk=new StartupCacheDiskStore(config);await disk.initialize();
 const makeCache=()=>new PrivateResumeHlsCache({maxBytes:256*1024,perFileBytes:64*1024,ttlMs:10000,now:()=>now});
 const cache=makeCache(),startup=createPrivateStartupCache(cache,disk);
 const capture=()=>startup.capture({binding,observed,actualStartOffset:0,playlist,preparationBody:body,readAsset:async()=>Buffer.alloc(256,7)});
 return {root,disk,cache,startup,config,makeCache,capture,setNow:n=>{now=n;}};
}

test('seven-day retention restores an aged strong candidate only after a fresh matching identity',async t=>{
 const h=await harness(t,{retentionMs:7*86400_000});assert.equal(await h.capture(),true);h.setNow(2*86400_000);
 const next=new StartupCacheDiskStore(h.config);await next.initialize();assert.equal(next.status().entries,1);
 const startup=createPrivateStartupCache(h.makeCache(),next);assert.equal(await startup.restore(binding),true);
 const lease=startup.acquire(binding,0,observed);assert.ok(lease);lease.release();
 h.setNow(8*86400_000);const expired=new StartupCacheDiskStore(h.config);await expired.initialize();assert.equal(expired.status().entries,0);
});

test('seven-day storage never renews the short sampled-file proof',async t=>{
 const h=await harness(t,{retentionMs:7*86400_000});h.cache.recentRevalidation=true;
 const samples=Array.from({length:4},(_,i)=>({start:i*65536,payload:Buffer.alloc(65536,i)}));
 assert.equal(await h.startup.capture({binding,observed:{fileSizeBytes:1e7,effectiveUrlIdentitySha256:target,samples},
  actualStartOffset:0,playlist,preparationBody:body,readAsset:async()=>Buffer.alloc(256,7)}),true);
 h.setNow(86400_000);const next=new StartupCacheDiskStore(h.config);await next.initialize();
 assert.equal(next.status().entries,1);assert.equal(await next.get(startupBinding(binding)),null);
});
test('disk prefix survives a new cache and store instance but still needs fresh identity checks',async t=>{
 const h=await harness(t);assert.equal(await h.capture(),true);
 const next=new StartupCacheDiskStore(h.config);await next.initialize();
 const cache=h.makeCache(),startup=createPrivateStartupCache(cache,next);
 assert.equal(startup.hasCandidate(binding,0),false);assert.equal(await startup.restore(binding),true);
 const lease=startup.acquire(binding,0,observed);assert.equal(lease.aheadSeconds,60);assert.equal(lease.asset('resume-0.ts').length,256);lease.release();
 const text=(await fsp.readFile(path.join(h.root,(await fsp.readdir(h.root))[0],'manifest.json'),'utf8'));
 assert.doesNotMatch(text,/private\.invalid|secret|targetUrl|sourceUrl"/);
});
test('fresh file mismatch invalidates both tiers instead of restoring old media again',async t=>{
 const h=await harness(t);await h.capture();
 assert.equal(h.startup.acquire(binding,0,{...observed,validator:{kind:'etag',value:'"changed"'}}),null);
 assert.equal(h.disk.status().entries,0);assert.equal(await h.startup.restore(binding),false);
 await h.disk.pending;
});
test('an incomplete fresh check does not delete the durable candidate or authorize its use',async t=>{
 const h=await harness(t);await h.capture();
 assert.equal(h.startup.acquire(binding,0,{fileSizeBytes:1e7}),null);
 assert.equal(h.disk.status().entries,1);assert.equal(await h.startup.restore(binding),true);
 const lease=h.startup.acquire(binding,0,observed);assert.ok(lease);lease.release();
});
test('lossless storage compression preserves every byte and caps decompression',async t=>{
 const h=await harness(t);await h.capture();
 const name=(await fsp.readdir(h.root))[0], manifest=JSON.parse(await fsp.readFile(path.join(h.root,name,'manifest.json'),'utf8'));
 assert.equal(manifest.storage.codec,'gzip');assert.ok(manifest.storage.bytes<manifest.bytes);
 const decoded=await h.disk.get(startupBinding(binding));
 assert.deepEqual(decoded.assets.get('resume-0.ts'),Buffer.alloc(256,7));
 manifest.bytes=1;await fsp.writeFile(path.join(h.root,name,'manifest.json'),JSON.stringify(manifest));
 const next=new StartupCacheDiskStore(h.config);await next.initialize();assert.equal(next.status().entries,0);
});
test('malformed subtitle descriptors or revocation records fail closed on reboot',async t=>{
 const h=await harness(t);await h.capture();
 const name=(await fsp.readdir(h.root))[0], file=path.join(h.root,name,'manifest.json');
 const manifest=JSON.parse(await fsp.readFile(file,'utf8'));manifest.subtitlePlaylists=[null];
 await fsp.writeFile(file,JSON.stringify(manifest));
 const next=new StartupCacheDiskStore(h.config);await next.initialize();assert.equal(next.status().entries,0);
 await fsp.writeFile(path.join(h.root,'revoked.json'),JSON.stringify([['not-an-owner',2000]]));
 await assert.rejects(new StartupCacheDiskStore(h.config).initialize(),/REVOCATION_INVALID/);
});
test('original expiration is not renewed by reboot or reading the disk tier',async t=>{
 const h=await harness(t);await h.capture();h.setNow(11001);
 const next=new StartupCacheDiskStore(h.config);await next.initialize();
 assert.equal(next.status().entries,0);assert.equal(await createPrivateStartupCache(h.makeCache(),next).restore(binding),false);
});
test('corrupt or truncated media cannot be restored',async t=>{
 const h=await harness(t);await h.capture();const dir=(await fsp.readdir(h.root))[0];
 await fsp.writeFile(path.join(h.root,dir,'payload.bin'),Buffer.alloc(4096,8));
 assert.equal(await createPrivateStartupCache(h.makeCache(),h.disk).restore(binding),false);
 assert.equal(h.disk.status().entries,0);
});
test('incomplete writes without a committed manifest are removed on restart',async t=>{
 const h=await harness(t);const name='c'.repeat(64)+'-'+'d'.repeat(16);
 await fsp.mkdir(path.join(h.root,name));await fsp.writeFile(path.join(h.root,name,'payload.bin'),'incomplete');
 const next=new StartupCacheDiskStore(h.config);await next.initialize();assert.equal(next.status().entries,0);
 assert.equal((await fsp.readdir(h.root)).length,0);
});
test('different owner/source revision/profile cannot hydrate a private prefix',async t=>{
 const h=await harness(t);await h.capture();const cache=createPrivateStartupCache(h.makeCache(),h.disk);
 for(const b of [{...binding,ownerKey:'e'.repeat(64)},{...binding,profileHash:'e'.repeat(64)},{...binding,sourceUrlHash:'e'.repeat(64)}])
  assert.equal(await cache.restore(b),false);
});
test('global revocation survives reboot and does not prohibit a new authorized capture forever',async t=>{
 const h=await harness(t);await h.capture();h.setNow(2000);await h.startup.revokeOwner(owner);
 const next=new StartupCacheDiskStore(h.config);await next.initialize();assert.equal(next.status().entries,0);
 h.setNow(2001);assert.equal(await createPrivateStartupCache(h.makeCache(),next).capture({binding,observed,actualStartOffset:0,playlist,preparationBody:body,readAsset:async()=>Buffer.alloc(256,7)}),true);
});
test('disk restore never evicts a viewer resume or exceeds the memory reservation',async t=>{
 const h=await harness(t);await h.capture();
 const cache=h.makeCache();cache.reservedBytes=cache.maxBytes;
 assert.equal(await createPrivateStartupCache(cache,h.disk).restore(binding),false);
 assert.equal(cache.reservedBytes,cache.maxBytes);assert.equal(cache.bytes,0);
});
test('disk records preserve sixty-second coverage and reject a partial prefix',async t=>{
 const h=await harness(t);assert.equal(await h.startup.capture({binding,observed,actualStartOffset:0,playlist:playlist.replace(/#EXTINF:4,\nsegment-15.ts\n/,''),preparationBody:body,readAsset:async()=>Buffer.alloc(256)}),true);
 assert.equal(await h.startup.capture({binding,observed,actualStartOffset:0,playlist:playlist.replace(/#EXTINF:4,\nsegment-1[45].ts\n/g,''),preparationBody:body,readAsset:async()=>Buffer.alloc(256)}),false);
 assert.equal(h.disk.status().entries,1);
});
test('memory eviction keeps durable data available for later hydration',async t=>{
 const h=await harness(t);await h.capture();const scoped=startupBinding(binding),key=[...h.cache.entries.keys()][0];
 h.cache.drop(key,h.cache.entries.get(key));assert.equal(h.cache.hasCandidate(scoped,0),false);
 assert.equal(await h.startup.restore(binding),true);
});

test('reboot enforces a reduced per-owner disk quota including manifests',async t=>{
 const h=await harness(t,{perFileBytes:4096,perOwnerBytes:32*1024,maxEntries:8});
 for(let i=0;i<4;i++) {
  h.setNow(1000+i);
  const b={...binding,profileHash:String(i).repeat(64)};
  assert.equal(await h.startup.capture({binding:b,observed,actualStartOffset:0,playlist,
   preparationBody:{...body,audioStreamIndex:i},readAsset:async()=>Buffer.alloc(256,7)}),true);
 }
 const next=new StartupCacheDiskStore({...h.config,perOwnerBytes:8192});await next.initialize();
 assert.ok(next.status().entries<4);assert.ok(next.status().bytes<=8192);
 let actual=0;
 for(const name of await fsp.readdir(h.root)) if(/^[a-f0-9]{64}-/.test(name))
  for(const file of ['manifest.json','payload.bin']) actual+=(await fsp.stat(path.join(h.root,name,file))).size;
 assert.equal(next.status().bytes,actual);
});

test('disk space reservation rejects a preparation without publishing a partial prefix',async t=>{
 const h=await harness(t,{reserveFreeBytes:Number.MAX_SAFE_INTEGER});
 assert.equal(await h.capture(),false);assert.equal(h.disk.status().entries,0);
 assert.equal(h.cache.bytes,0);assert.equal((await fsp.readdir(h.root)).length,0);
});

test('sampled identity is rechecked after reboot and mismatch revokes both tiers',async t=>{
 const h=await harness(t);
 const samples=Array.from({length:4},(_,i)=>({start:i*65536,payload:Buffer.alloc(65536,i)}));
 const observation={fileSizeBytes:1e7,effectiveUrlIdentitySha256:target,samples};
 h.cache.recentRevalidation=true;
 assert.equal(await h.startup.capture({binding,observed:observation,actualStartOffset:0,playlist,
  preparationBody:body,readAsset:async()=>Buffer.alloc(256,7)}),true);
 const next=new StartupCacheDiskStore(h.config);await next.initialize();
 const memory=h.makeCache();memory.recentRevalidation=true;
 const startup=createPrivateStartupCache(memory,next);assert.equal(await startup.restore(binding),true);
 const lease=startup.acquire(binding,0,observation);assert.ok(lease);lease.release();
 assert.equal(startup.acquire(binding,0,{...observation,samples:samples.map((s,i)=>i===2?{...s,payload:Buffer.alloc(65536,9)}:s)}),null);
 assert.equal(next.status().entries,0);await next.pending;
});

test('revocation during the final disk flush cannot publish the old preparation',async t=>{
 const h=await harness(t);
 let entered,release;
 const started=new Promise(resolve=>{entered=resolve;});
 const paused=new Promise(resolve=>{release=resolve;});
 const sync=h.disk.syncDirectory.bind(h.disk);let first=true;
 h.disk.syncDirectory=async directory=>{
  if(first){first=false;entered();await paused;}await sync(directory);
 };
 const capture=h.capture();await started;
 h.setNow(2000);h.cache.revokeOwner(owner);
 const revoke=h.startup.revokeOwner(owner);release();
 assert.equal(await capture,false);await revoke;
 assert.equal(h.disk.status().entries,0);
 const next=new StartupCacheDiskStore(h.config);await next.initialize();assert.equal(next.status().entries,0);
});

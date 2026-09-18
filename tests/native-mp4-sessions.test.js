'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { createNativeMp4Sessions, pipeNativeMp4 } = require('../services/media-gateway/src/native-mp4-sessions');
const brokerHarness = require('./fixtures/finite-ts-index-broker');
const { FinitePlaybackRangeReuse } = require('../services/media-gateway/src/finitePlaybackRangeReuse');
const sid = '11111111-2222-3333-4444-555555555555';
const uid = '21111111-2222-3333-4444-555555555555';
const owner = crypto.createHash('sha256').update(uid).digest('hex');
const claims = (now, extra = {}) => ({ v:1, sid, uid, url:'http://provider.invalid/movie/user/password/1.mp4',
  exp:Math.floor(now/1000)+3600, scope:'native-browser-mp4', fileSizeBytes:8*1024, ...extra });

test('Gateway native admission extends only to explicitly configured pilot owners', () => {
  const source=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8').replace(/\r\n/g,'\n');
  const start=source.indexOf('    allows: (claims) => {',source.indexOf('const nativeMp4Sessions ='));
  const expression=source.slice(start+'    allows: '.length,source.indexOf(',\n    open:',start));
  const permit=(owners,provider=false)=>vm.runInNewContext('('+expression+')',{
    URL,crypto,process:{env:{NATIVE_MP4_PILOT_OWNER_HASHES:owners}},PUBLIC_BASE_URL:'https://media.example.test/pilot',
    proxyKeyFromUrl:()=>'',providerHttpForwardAccounts:[],useProviderHttpForward:()=>provider,
  })(claims(Date.now()));
  assert.equal(permit(owner),true);
  assert.equal(permit(''),false);
  assert.equal(permit('b'.repeat(64)),false);
  assert.equal(permit(owner+',bad'),false);
  assert.equal(permit('',true),true);
});

test('native MP4 initialization spans a large moov in one provider range without warmup', async t => {
  const code=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
  const lane=code.slice(code.indexOf('const nativeMp4Sessions ='),code.indexOf("app.post('/native-sessions'"));
  assert.match(lane,/finiteWarmupWindowBytes: \(resumeRanges\?\.hasPriorRanges \|\| resumeRanges\?\.requiresValidation\) \? 64 \* 1024 : 0,/);
  assert.match(lane,/finiteWindowBytes: 8 \* 1024 \* 1024,/);
  const moovEnd=6_334_288, bytes=Buffer.alloc(9*1024*1024,37), ranges=[];
  const origin=http.createServer((req,res)=>{
    const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
    assert.ok(m); const start=Number(m[1]),end=Number(m[2]); ranges.push([start,end]);
    res.writeHead(206,{'content-range':`bytes ${start}-${end}/${bytes.length}`,'content-length':end-start+1});
    res.end(bytes.subarray(start,end+1));
  }).listen(0,'127.0.0.1'); await once(origin,'listening');
  const broker=await brokerHarness().createStrictLidBroker({
    sourceUrl:`http://127.0.0.1:${origin.address().port}/fixture.mp4`,fileSizeBytes:bytes.length,
    dispatcher:null,pathPrefix:'finite-mkv-seek',finiteWindowBytes:8*1024*1024,
    finiteWarmupWindowBytes:0,releaseDelayMs:0,
  });
  t.after(async()=>{await broker.close();await new Promise(r=>origin.close(r));});
  const response=await fetch(broker.inputUrl,{headers:{range:`bytes=0-${moovEnd}`}});
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes.subarray(0,moovEnd+1));
  assert.deepEqual(ranges,[[0,moovEnd]]);
});

test('opaque grants are exact, idempotent, bounded, and never perform provider I/O', async () => {
  let opens=0, now=100000;
  const store=createNativeMp4Sessions({allows:c=>c.url.endsWith('.mp4'),open:()=>{opens++;},now:()=>now,maxEntries:2,maxActive:1});
  const c=claims(now), entry=store.grant(c);
  assert.match(entry.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.grant(c),entry); assert.equal(opens,0);
  for(const mutation of [{scope:'audio'}, {sid:'job-id'}, {uid:'x'}, {fileSizeBytes:0},
    {exp:99}, {exp:now/1000+86401}, {url:'http://p/x.ts'}]) assert.throws(()=>store.grant({...c,...mutation}));
  assert.throws(()=>store.grant({...c,url:'http://provider.invalid/other.mp4'}),/CONFLICT/);
  assert.throws(()=>store.grant({...c,sid:uid}),/CAPACITY/);
  for(const [id,token] of [[uid,entry.token],[sid,'x'],[sid,'A'.repeat(43)],[sid,[entry.token]]])
    assert.throws(()=>store.authorize(id,token),/DENIED/);
  assert.equal(store.authorize(sid,entry.token),entry); assert.equal(opens,0);
});

test('repeat MP4 initialization reuses a 6.3 MB index after only a current 64 KiB provider proof', async t => {
  const moovEnd = 6_334_288, bytes = Buffer.alloc(9 * 1024 * 1024, 37), requests = [];
  const origin = http.createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = Number(m[1]), end = Number(m[2]); requests.push([start, end]);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1,
      etag: '"unchanged-large-index"' });
    res.end(bytes.subarray(start, end + 1));
  }).listen(0, '127.0.0.1');
  await once(origin, 'listening'); t.after(() => new Promise(resolve => origin.close(resolve)));
  const cache = new FinitePlaybackRangeReuse({ perFileBytes: 32 * 1024 * 1024, maxRetainedWindowBytes: 8 * 1024 * 1024 });
  const sourceUrl = `http://127.0.0.1:${origin.address().port}/fixture.mp4`;
  for (const visit of [0, 1]) {
    const ranges = cache.begin({ ownerKey: owner, sourceUrl, fileSizeBytes: bytes.length,
      sourceId: 'current-owned-source', sourceRevision: '7' });
    const broker = await brokerHarness().createStrictLidBroker({ sourceUrl, fileSizeBytes: bytes.length,
      dispatcher: null, pathPrefix: 'finite-mkv-seek', finiteWindowBytes: 8 * 1024 * 1024,
      finiteWarmupWindowBytes: ranges.hasPriorRanges ? 65536 : 0, finiteResumeRanges: ranges, releaseDelayMs: 0 });
    t.after(() => broker.close()); const before = requests.length;
    const response = await fetch(broker.inputUrl, { headers: { range: `bytes=0-${moovEnd}` } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, moovEnd + 1));
    await broker.close();
    assert.deepEqual(requests.slice(before), visit === 0 ? [[0, moovEnd]] : [[0, 65535]]);
    if (visit === 1) assert.equal(ranges.reusedBytes, moovEnd + 1 - 65536);
  }
});

test('heartbeat and expiry cannot resurrect revoked, abandoned, or hard-expired grants', async () => {
  let now=100000, closed=0, opens=0;
  const store=createNativeMp4Sessions({allows:()=>true,now:()=>now,leaseMs:1000,
    open:async()=>{opens++;return{close:async()=>{closed++;}};}});
  const c=claims(now),e=store.grant(c);
  const [a,b]=await Promise.all([store.resource(e),store.resource(e)]);
  assert.equal(a,b); assert.equal(opens,1);
  assert.throws(()=>store.heartbeat(sid,'bad'),/UNAVAILABLE/);
  now+=900;store.heartbeat(sid,owner);now+=900;store.authorize(sid,e.token);
  await store.revoke(owner,sid); assert.equal(closed,1);
  assert.throws(()=>store.authorize(sid,e.token),/EXPIRED/);
  assert.throws(()=>store.heartbeat(sid,owner),/EXPIRED/);
  assert.throws(()=>store.grant(c),/EXPIRED/);
  await store.revoke(owner,sid); assert.equal(closed,1);
  const e2=store.grant({...c,sid:uid}); now+=1001;await store.sweep();
  assert.throws(()=>store.authorize(uid,e2.token),/EXPIRED/);
  assert.throws(()=>store.heartbeat(uid,owner),/EXPIRED/);
});

test('revoke waits for a racing broker open and closes it once', async () => {
  let release,closed=0;
  const store=createNativeMp4Sessions({allows:()=>true,open:()=>new Promise(resolve=>{
    release=()=>resolve({close:async()=>{closed++;}});
  })});
  const e=store.grant(claims(Date.now()));
  const opening=store.resource(e); await Promise.resolve();
  const closing=store.revoke(owner,sid);release();
  await assert.rejects(opening,/EXPIRED/);await closing;assert.equal(closed,1);
});

test('native HTTP serves exact ranges through one serialized provider broker, then denies replay', async t => {
  const data=Buffer.alloc(8192); for(let i=0;i<data.length;i++)data[i]=i%251;
  let current=0,max=0,requests=0;
  const origin=http.createServer((req,res)=>{
    requests++;current++;max=Math.max(max,current);
    const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');assert.ok(m);
    const start=Number(m[1]),end=Number(m[2]);
    res.writeHead(206,{'content-range':`bytes ${start}-${end}/${data.length}`,'content-length':end-start+1,'etag':'"fixture"'});
    setTimeout(()=>{current--;res.end(data.subarray(start,end+1));},10);
  }).listen(0,'127.0.0.1'); await once(origin,'listening');
  t.after(()=>new Promise(resolve=>origin.close(resolve)));
  const source=`http://127.0.0.1:${origin.address().port}/movie/u/p/1.mp4`;
  const store=createNativeMp4Sessions({allows:()=>true,open:async e=>{
    const broker=await brokerHarness().createStrictLidBroker({sourceUrl:source,fileSizeBytes:data.length,
      dispatcher:null,pathPrefix:'finite-mkv-seek',finiteWindowBytes:1024,finiteCacheBytes:4096,
      releaseDelayMs:0,abortSignal:e.ac.signal});
    return {inputUrl:broker.inputUrl,close:reason=>broker.close(reason)};
  }});
  const e=store.grant(claims(Date.now(),{url:source}));
  const web=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://local');
      const ent=store.authorize(url.pathname.slice(1),url.searchParams.get('token'));
      await pipeNativeMp4(req,res,ent,await store.resource(ent));
    }catch(error){res.writeHead(error.status||500);res.end();}
  }).listen(0,'127.0.0.1');await once(web,'listening');
  t.after(async()=>{await store.revoke(owner,sid);await new Promise(resolve=>web.close(resolve));});
  const base=`http://127.0.0.1:${web.address().port}/${sid}`;
  assert.equal((await fetch(base+'?token=bad')).status,401);assert.equal(requests,0);
  const access=base+'?token='+e.token;
  const head=await fetch(access,{method:'HEAD'});assert.equal(head.status,200);assert.equal(requests,0);
  assert.equal(Number(head.headers.get('content-length')),data.length);
  await Promise.all([[0,1023],[7168,8191],[2048,3071]].map(async([start,end])=>{
    const res=await fetch(access,{headers:{range:`bytes=${start}-${end}`}});
    assert.equal(res.status,206);assert.equal(res.headers.get('content-type'),'video/mp4');
    assert.equal(res.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()),data.subarray(start,end+1));
  }));
  assert.equal(max,1);
  await store.revoke(owner,sid);const before=requests;
  assert.equal((await fetch(access)).status,410);assert.equal(requests,before);
});

test('native proof uses a current owned H264/AAC profile, not a client codec claim', async () => {
  const {browserNativeMp4Proof:proof}=await import('../supabase/functions/_shared/native-mp4-gateway-policy.mjs');
  const now=Date.now(),profile={probeSource:'gateway_probe',probedAt:new Date(now-1000).toISOString(),
    container:'mov,mp4,m4a,3gp,3g2,mj2',videoCodec:'h264',videoPixelFormat:'yuv420p',fileSizeBytes:8192,
    audioTracks:[{index:1,codec:'aac',profile:'LC',channels:2,default:true}],subtitles:[],metadataComplete:false};
  assert.equal(proof({codecProfile:profile},{},now).fileSizeBytes,8192);
  assert.equal(proof({}, {codecProfile:profile},now),null);
  for(const mutation of [{videoCodec:'hevc'}, {probeSource:'client'}, {fileSizeBytes:0}, {subtitles:null},
    {probedAt:new Date(now-15*86400_000).toISOString()}, {audioTracks:[{index:1,codec:'ac3',default:true}]},
    {audioTracks:[...profile.audioTracks,{index:2,codec:'aac',profile:'LC',channels:2,default:true}]}])
    assert.equal(proof({codecProfile:{...profile,...mutation}},{},now),null);
  assert.equal(proof({codecProfile:profile},{audioStreamIndex:2},now),null);
  assert.equal(proof({codecProfile:profile},{audioStreamIndex:1},now).fileSizeBytes,8192);
});

test('native grant accepts the configured pilot prefix and rejects other routes', async () => {
  const { validNativeMp4Grant: valid } = await import('../supabase/functions/_shared/native-mp4-gateway-policy.mjs');
  const base = 'https://media.example.test/pilot';
  const url = `${base}/sessions/${sid}/native.mp4?token=${'a'.repeat(43)}`;
  assert.equal(valid({protocol:1,url},sid,base),true);
  assert.equal(valid({protocol:1,url},sid),false);
  assert.equal(valid({protocol:1,url:url.replace('/pilot','')},sid),true);
  for (const bad of [url.replace('/pilot','/other'),url.replace('media.example.test','evil.example'),
    url.replace(sid,uid),url.replace('https:','http:'),url+'&token='+ 'b'.repeat(43),url+'#fragment']) {
    assert.equal(valid({protocol:1,url:bad},sid,base),false);
  }
  assert.equal(valid({protocol:1,url},sid,base+'?unexpected=1'),false);
  assert.equal(valid({protocol:1,url:'invalid'},sid,base),false);
});

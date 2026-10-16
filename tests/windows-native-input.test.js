const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{once}=require('node:events');
const {createNativeInput}=require('../desktop/native-input');
const bytes=Buffer.from(Array.from({length:32768},(_,i)=>i%251));
async function fixture(t,kind='normal',options={}){
 let active=0,maximum=0,requests=0,changed=false;
 const server=http.createServer((q,r)=>{
  active++;requests++;maximum=Math.max(maximum,active);let done=false;const end=()=>{if(!done){done=true;active--;}};r.on('close',end);r.on('finish',end);
  if(q.url==='/redirect'){r.writeHead(302,{Location:'/file'}).end();return;}
  const m=/bytes=(\d+)-(\d+)/.exec(q.headers.range||'');if(!m){r.writeHead(400).end();return;}
  let start=+m[1],last=Math.min(+m[2],bytes.length-1);
  if(kind==='hang')return;
  if(kind==='ignore'){r.writeHead(200,{'Content-Length':bytes.length}).end(bytes);return;}
  if(kind==='short')last--;
  const payload=bytes.subarray(start,last+1);
  r.writeHead(206,{'Content-Range':`bytes ${start}-${last}/${bytes.length}`,'Content-Length':payload.length,ETag:changed?'"two"':'"one"'});
  if(kind==='abort'){r.write(payload.subarray(0,16));setTimeout(()=>r.destroy(),10);return;}
  if((kind==='slow-grown'||kind==='abort-grown') && payload.length>1024){
   r.write(payload.subarray(0,2048));setTimeout(()=>kind==='abort-grown'?r.destroy():r.end(payload.subarray(2048)),150);return;
  }
  setTimeout(()=>r.end(payload),5);
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const input=await createNativeInput(`http://127.0.0.1:${server.address().port}/${kind==='redirect'?'redirect':'file'}`,{windowBytes:1024,timeoutMs:200,...options});
 t.after(async()=>{await input.stop();server.closeAllConnections();await new Promise(r=>server.close(r));});
 return{input,stats:()=>({active,maximum,requests}),change:()=>{changed=true;}};
}
async function get(url,start,end){const r=await fetch(url,{headers:{Range:`bytes=${start}-${end}`}});return{status:r.status,body:Buffer.from(await r.arrayBuffer())};}

test('sequential acquisition grows only after complete adjacent reads and resets at a distant seek',async t=>{
 const f=await fixture(t,'normal',{maxSequentialWindowBytes:4096,cacheWindows:8});
 assert.deepEqual((await get(f.input.url,0,11263)).body,bytes.subarray(0,11264));
 const ranges=f.input.counters.ranges;
 assert.deepEqual(ranges.slice(0,4).map(r=>r.end-r.start+1),[1024,1024,1024,4096]);
 assert.ok(f.input.counters.maximumCachedBytes<=8192);
 assert.equal(f.stats().maximum,1);
 assert.deepEqual((await get(f.input.url,24576,25087)).body,bytes.subarray(24576,25088));
 assert.equal(f.input.counters.ranges.at(-1).end-f.input.counters.ranges.at(-1).start+1,1024);
 const count=f.stats().requests;
 assert.deepEqual((await get(f.input.url,24576,25087)).body,bytes.subarray(24576,25088));
 assert.equal(f.stats().requests,count);
 f.change();assert.equal((await get(f.input.url,28672,29183)).status,502);
 assert.equal((await get(f.input.url,24576,25087)).status,502);
});

test('growing reads preserve exact concurrent header/index responses within one provider connection',async t=>{
 const f=await fixture(t,'normal',{maxSequentialWindowBytes:4096,cacheWindows:8,streamSequentialWindows:true});
 const spans=[[0,12287],[24576,32767],[4096,20479]];
 const results=await Promise.all(spans.map(([start,end])=>get(f.input.url,start,end)));
 results.forEach((r,i)=>{assert.equal(r.status,206);assert.deepEqual(r.body,bytes.subarray(spans[i][0],spans[i][1]+1));});
 assert.equal(f.stats().maximum,1);assert.ok(f.input.counters.maximumCachedBytes<=8192);
});

test('a growing body reaches the player before completion but enters cache only after complete validation',async t=>{
 const f=await fixture(t,'slow-grown',{maxSequentialWindowBytes:4096,cacheWindows:8,streamSequentialWindows:true,timeoutMs:1000});
 const response=await fetch(f.input.url,{headers:{Range:'bytes=0-7167'}}),reader=response.body.getReader(),chunks=[];
 let received=0;
 while(received<5120){const {value,done}=await reader.read();assert.equal(done,false);chunks.push(Buffer.from(value));received+=value.length;}
 assert.ok(f.input.counters.completedBytes<7168,'the growing provider body is still arriving');
 assert.equal(f.input.counters.cachedBytes,3072,'partial data is not cacheable');
 for(;;){const {value,done}=await reader.read();if(done)break;chunks.push(Buffer.from(value));}
 assert.deepEqual(Buffer.concat(chunks),bytes.subarray(0,7168));
 const before=f.stats().requests;assert.deepEqual((await get(f.input.url,3072,7167)).body,bytes.subarray(3072,7168));
 assert.equal(f.stats().requests,before);assert.equal(f.stats().maximum,1);
});

test('interrupted progressive data closes the local response and is never cached',async t=>{
 const f=await fixture(t,'abort-grown',{maxSequentialWindowBytes:4096,cacheWindows:8,streamSequentialWindows:true,timeoutMs:1000});
 await assert.rejects(get(f.input.url,0,7167));
 assert.equal(f.input.counters.cachedBytes,3072);assert.equal(f.input.counters.completedBytes,3072);
 await f.input.stop();assert.equal(f.input.counters.activeSourceRequests,0);
});
test('parallel native header/index reads are byte exact with a single provider GET at a time',async t=>{
 const f=await fixture(t);const spans=[[0,5000],[16000,24000],[31000,32767]];
 const results=await Promise.all(spans.map(([s,e])=>get(f.input.url,s,e)));
 results.forEach((r,i)=>{assert.equal(r.status,206);assert.deepEqual(r.body,bytes.subarray(spans[i][0],spans[i][1]+1));});
 assert.equal(f.stats().maximum,1);assert.equal(f.input.counters.maximumConcurrentSourceRequests,1);
 await f.input.stop();assert.equal(f.stats().active,0);await assert.rejects(fetch(f.input.url));
});
test('redirect response drains before next GET',async t=>{
 const f=await fixture(t,'redirect');assert.deepEqual((await get(f.input.url,0,2047)).body,bytes.subarray(0,2048));
 assert.equal(f.stats().maximum,1);assert.equal(f.input.counters.maximumConcurrentSourceRequests,1);
});
for(const kind of ['ignore','short','abort','hang'])test(`fail closed for ${kind} with no partial window reused`,async t=>{
 const f=await fixture(t,kind);const results=await Promise.all([get(f.input.url,0,511),get(f.input.url,16000,16511)]);
 for(const r of results)assert.equal(r.status,502);
 assert.equal(f.input.counters.maximumConcurrentSourceRequests,1);await f.input.stop();assert.equal(f.input.counters.activeSourceRequests,0);
});
test('file validator change cannot splice bytes into the original session',async t=>{
 const f=await fixture(t);assert.equal((await get(f.input.url,0,511)).status,206);f.change();
 assert.equal((await get(f.input.url,16000,16511)).status,502);
 assert.equal((await get(f.input.url,0,511)).status,502,'a known change also revokes previously cached headers');
});

test('header and index interleaving reuses complete session windows without another provider read',async t=>{
 const f=await fixture(t);
 for(const start of [0,1024,2048,30720,31744,0,1024,2048]) {
  const r=await get(f.input.url,start,start+511);assert.equal(r.status,206);assert.deepEqual(r.body,bytes.subarray(start,start+512));
 }
 assert.equal(f.stats().requests,5);assert.equal(f.input.counters.maximumConcurrentSourceRequests,1);
 assert.ok(f.input.counters.cacheHits>=3);assert.equal(f.input.counters.maximumCachedBytes,5*1024);
 await f.input.stop();assert.equal(f.input.counters.cachedBytes,0);
 const next=await fixture(t);await get(next.input.url,0,511);assert.equal(next.stats().requests,1,'another session owns a new empty cache');
});

test('session cache evicts least recently used complete windows at its memory bound',async t=>{
 const f=await fixture(t,'normal',{cacheWindows:2});
 for(const start of [0,1024,0,2048,0,1024])assert.equal((await get(f.input.url,start,start+511)).status,206);
 assert.equal(f.stats().requests,4);assert.equal(f.input.counters.maximumCachedBytes,2048);
});
test('invalid token and multi-range do not touch the provider; close aborts pending response',async t=>{
 const f=await fixture(t,'hang');assert.equal((await fetch(f.input.url+'bad')).status,404);
 assert.equal((await fetch(f.input.url,{headers:{Range:'bytes=1-2,4-5'}})).status,416);assert.equal(f.stats().requests,0);
 const waiting=get(f.input.url,0,511).catch(()=>null);await new Promise(r=>setTimeout(r,30));await f.input.stop();await waiting;
 assert.equal(f.input.counters.activeSourceRequests,0);assert.equal(f.stats().maximum,1);
});

test('default native ranges limit header overfetch and preserve sixteen MiB of complete windows',async t=>{
 const payload=Buffer.alloc(17*1024*1024,83),ranges=[];
 const server=http.createServer((q,r)=>{
  const m=/bytes=(\d+)-(\d+)/.exec(q.headers.range),start=Number(m[1]),end=Math.min(Number(m[2]),payload.length-1);
  ranges.push([start,end]);
  r.writeHead(206,{'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${payload.length}`});
  r.end(payload.subarray(start,end+1));
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const input=await createNativeInput(`http://127.0.0.1:${server.address().port}/file`);
 t.after(async()=>{await input.stop();server.closeAllConnections();await new Promise(r=>server.close(r));});
 for(let i=0;i<64;i++) {
  const result=await get(input.url,i*256*1024,i*256*1024+127);
  assert.equal(result.status,206);assert.deepEqual(result.body,Buffer.alloc(128,83));
 }
 assert.equal(ranges.length,64);assert.deepEqual(ranges[0],[0,256*1024-1]);
 assert.equal(input.counters.maximumCachedBytes,16*1024*1024);
 await get(input.url,0,127);assert.equal(ranges.length,64,'header survives the larger entry count');
 await get(input.url,16*1024*1024,16*1024*1024+127);
 await get(input.url,256*1024,256*1024+127);
 assert.equal(ranges.length,66,'least recently used window is evicted at the byte bound');
 assert.equal(input.counters.maximumCachedBytes,16*1024*1024);
 assert.equal(input.counters.maximumConcurrentSourceRequests,1);
 await input.stop();assert.equal(input.counters.cachedBytes,0);assert.equal(input.counters.activeSourceRequests,0);
});

test('native input rejects cache configurations exceeding its entry or byte budgets',async()=>{
 await assert.rejects(createNativeInput('http://127.0.0.1/file',{windowBytes:2*1024*1024,cacheWindows:9}),/CACHE_BOUND/);
 await assert.rejects(createNativeInput('http://127.0.0.1/file',{windowBytes:256*1024,cacheWindows:65}),/CACHE_BOUND/);
});

const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const {once}=require('node:events');
const {finished}=require('node:stream/promises');
const src=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
function block(a,b){const start=src.indexOf(a),end=src.indexOf(b,start);assert.ok(start>=0&&end>start);return src.slice(start,end);}
function helpers(){
 const ctx=vm.createContext({require,Buffer,Promise,AbortController,Date,setTimeout,clearTimeout,console,RAW_FIRST_BYTE_TIMEOUT_MS:1000,RAW_PREFIX_SNIFF_BYTES:1024,redactCreds:x=>x});
 vm.runInContext(block('function rawStartupRemainingMs(', '\nfunction waitForRawBackoff(')
  +block('function readRawPrefixChunk(', '\n// Container magics')
  +block('function readableFromSniffedBody(', '\nfunction rememberRawFailure(')
  +'\nthis.tracker=createPreparedRawBodyDisposals;this.make=readableFromSniffedBody;this.guard=createRawAttemptGuard;this.sniff=sniffLeadingBytes;',ctx);
 return ctx;
}
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('bounded loopback wait')),2000))]);}finally{clearTimeout(timer);}}
async function serverFixture(t){
 let active=0,requests=0,closeResolve;let closed=new Promise(r=>closeResolve=r);
 const server=http.createServer((req,res)=>{
  active++;requests++;res.writeHead(200,{'Content-Type':'video/mp2t'});
  let timer;
  res.on('close',()=>{clearInterval(timer);active--;closeResolve();});
  if(req.method==='HEAD'){res.end();return;}
  if(req.url==='/headers-only'){res.flushHeaders();return;}
  const bytes=Buffer.alloc(188*8,0x47);
  if(req.url==='/eof'){res.end(bytes);return;}
  res.write(bytes);timer=setInterval(()=>res.write(bytes),5);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 return {url:'http://127.0.0.1:'+server.address().port,active:()=>active,requests:()=>requests,closed:()=>closed};
}
for(const ending of ['client-close','parent-abort','attempt-deadline','eof']){
 test('actual Undici body has one confirmed disposal on '+ending,async t=>{
  const f=await serverFixture(t),h=helpers(),tracker=h.tracker(),ac=new AbortController();
  ac.signal.addEventListener('abort',()=>tracker.cancelAll(),{once:true});
  const guard=h.guard(ac.signal,Date.now()+2000);let body=null;
  guard.signal.addEventListener('abort',()=>tracker.dispose(body),{once:true});
  const response=await fetch(f.url+(ending==='eof'?'/eof':'/stream'),{signal:guard.signal});body=response.body;tracker.track(body);
  let readerCancels=0,bodyCancels=0;const originalBodyCancel=body.cancel.bind(body);body.cancel=(...args)=>{bodyCancels++;return originalBodyCancel(...args);};
  const sniff=await h.sniff(body,guard.signal,1000,()=> 'media',reader=>{
   const original=reader.cancel.bind(reader);reader.cancel=(...args)=>{readerCancels++;return original(...args);};tracker.ownReader(body,reader);
  });
  guard.completeStartup();
  const stream=h.make(sniff,p=>tracker.record(body,p),reader=>tracker.dispose(reader));stream.on('error',()=>{});stream.resume();
  const done=finished(stream,{cleanup:true}).catch(()=>{});
  if(ending==='client-close'){stream.destroy();ac.abort();}
  if(ending==='parent-abort'){ac.abort();stream.destroy();}
  if(ending==='attempt-deadline'){guard.abort('fixture-deadline');stream.destroy();}
  await bounded(done);tracker.cancelAll();ac.abort();guard.dispose();
  assert.equal(await bounded(tracker.drained()),true);
  await bounded(f.closed());assert.equal(f.active(),0);assert.equal(f.requests(),1);
  assert.equal(bodyCancels,0,'reader ownership prevents a second body.cancel');
  assert.equal(readerCancels,ending==='eof'?0:1,'same reader is cancelled at most once');
 });
}
for(const mode of ['parent','attempt']) {
 test('actual abort during prefix sniff before the first byte drains: '+mode,async t=>{
  const f=await serverFixture(t),h=helpers(),tracker=h.tracker(),ac=new AbortController();
  ac.signal.addEventListener('abort',()=>tracker.cancelAll(),{once:true});
  const guard=h.guard(ac.signal,Date.now()+2000);let body=null;
  guard.signal.addEventListener('abort',()=>tracker.dispose(body),{once:true});
  const response=await fetch(f.url+'/headers-only',{signal:guard.signal});body=response.body;tracker.track(body);
  let acquired=false;const sniff=h.sniff(body,guard.signal,1000,()=> 'need-more',reader=>{acquired=true;tracker.ownReader(body,reader);});
  assert.equal(acquired,true);
  if(mode==='parent')ac.abort();else guard.abort('fixture-deadline');
  await bounded(sniff);assert.equal(await bounded(tracker.drained()),true);guard.dispose();
  await bounded(f.closed());assert.equal(f.active(),0);assert.equal(f.requests(),1);
 });
}
test('actual HEAD with no response body drains without a fictitious disposal',async t=>{
 const f=await serverFixture(t),h=helpers(),tracker=h.tracker();const response=await fetch(f.url+'/head',{method:'HEAD'});
 assert.equal(response.body,null);tracker.track(response.body);assert.equal(await tracker.drained(),true);
 await bounded(f.closed());assert.equal(f.active(),0);
});
test('rejected, throwing, or pending true disposal is never replaced by a later positive EOF',async()=>{
 for(const cancel of [()=>Promise.reject(new Error('still active')),()=>{throw new Error('still active')}]){
  const h=helpers(),tracker=h.tracker(),body={},reader={cancel,releaseLock(){}};
  tracker.track(body);tracker.ownReader(body,reader);assert.equal(await tracker.dispose(reader),false);
  tracker.record(body,Promise.resolve(true));assert.equal(await tracker.drained(),false);
 }
 const h=helpers(),tracker=h.tracker();let settle;
 const body={},reader={cancel:()=>new Promise(r=>settle=r),releaseLock(){}};tracker.track(body);tracker.ownReader(body,reader);
 let done=false;const pending=tracker.drained().then(x=>{done=true;return x});await new Promise(r=>setImmediate(r));assert.equal(done,false);
 tracker.record(body,Promise.resolve(true));assert.equal(done,false);settle();assert.equal(await pending,true);
});
test('each retry body retains its own obligation; one failed body prevents drainage',async()=>{
 const h=helpers(),tracker=h.tracker();let failedCalls=0,goodCalls=0;
 const failed={cancel:()=>{failedCalls++;return Promise.reject(new Error('not drained'))}},good={cancel:()=>{goodCalls++;return Promise.resolve()}};
 tracker.track(failed);tracker.track(good);tracker.dispose(failed);tracker.dispose(good);
 assert.equal(await tracker.drained(),false);assert.equal(failedCalls,1);assert.equal(goodCalls,1);
});

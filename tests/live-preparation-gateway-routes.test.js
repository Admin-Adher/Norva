const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {createPlaybackPreparationCancellation}=require('../services/media-gateway/src/playback-preparation-cancel');
const src=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
const owner='a'.repeat(64),id='00000000-0000-4000-8000-000000000001';
function block(start,end){const a=src.indexOf(start),b=src.indexOf(end,a);assert.ok(a>=0&&b>a);return src.slice(a,b);}
function response(){const r=new EventEmitter();r.statusCode=200;r.status=n=>{r.statusCode=n;return r};r.json=x=>{r.body=x;r.writableEnded=true;return r};return r;}
function routes(){const handlers={};let admissions=0;
const context=vm.createContext({require,AbortController,Date,Set,Map,setTimeout,clearTimeout,Promise,console,
  app:{post:(route,auth,fn)=>handlers[route]=fn,get:(route,auth,fn)=>handlers[route]=fn},requireGatewayAuth:()=>{},
  playbackPreparationGeneration:'new-process',playbackPreparationCancellation:createPlaybackPreparationCancellation({drainTimeoutMs:20}),
  playbackPreparationRawWork:new Map(),playbackPreparationUnconfirmedStops:new Map(),sessions:new Map(),
  sessionStartupStats:{attempts:0},isHttpUrl:()=>true,normalizeSourceContainerAuthority:()=>null,
  normalizeSessionKey:x=>x,proxyKeyFromUrl:()=> 'proxy',providerSlotKeyFromUrl:()=> 'provider',isLiveSession:()=>true,
  viewerStartupQueue:{acquire:async()=>{admissions++;throw new Error('unexpected admission')}},
  releaseViewerSessionStartupAdmission:()=>{},releaseViewerStartup:()=>{},
});
vm.runInContext(block("app.get('/playback-preparations/generation'",'function gatewayCreatedSessionPayload'),context);
return {context,handlers,admissions:()=>admissions};}
test('real POST handler rejects old process generations and cancel-before-create before any admission',async()=>{
const h=routes();for(const generation of ['old-process','new-process']){
  if(generation==='new-process')await h.context.playbackPreparationCancellation.cancel(owner,id,async()=>{});
  const req=new EventEmitter();req.body={sourceUrl:'http://fixture.invalid/live/1.ts',ownerKey:owner,playbackSessionId:id,preparationProtocol:1,preparationGatewayGeneration:generation,preparationExpiresAt:new Date(Date.now()+180000).toISOString()};
  const res=response();await h.handlers['/sessions'](req,res);assert.ok([400,409].includes(res.statusCode));assert.equal(h.admissions(),0);
}
});
test('real cancellation route waits for raw body disposal, keeps exact owner scope and generation',async()=>{
const h=routes();let release,aborted=false;
const done=new Promise(resolve=>release=resolve);
h.context.playbackPreparationRawWork.set(`${owner}:${id}`,new Set([{abort:()=>aborted=true,done}]));
const other={abort:()=>{throw new Error('other owner touched')},done:Promise.resolve()};h.context.playbackPreparationRawWork.set(`other:${id}`,new Set([other]));
let res=response();await h.handlers['/playback-preparations/cancel']({body:{ownerKey:owner,playbackSessionId:id,generation:'new-process'}},res);
assert.equal(aborted,true);assert.equal(res.statusCode,202);assert.equal(res.body.drained,false);
release(true);res=response();await h.handlers['/playback-preparations/cancel']({body:{ownerKey:owner,playbackSessionId:id,generation:'new-process'}},res);
assert.equal(res.body.drained,true);assert.equal(res.statusCode,200);
res=response();await h.handlers['/playback-preparations/cancel']({body:{ownerKey:owner,playbackSessionId:id,generation:'old-process'}},res);
assert.equal(res.statusCode,202);
});
test('raw stream destroy exposes the real underlying cancellation completion',async()=>{
let finish;const disposal=new Promise(resolve=>finish=resolve);const captures=[];
const context=vm.createContext({require,Buffer,Promise});
vm.runInContext(block('function cancelRawBodyBestEffort(', '\nfunction waitForRawBackoff(')+ '\n'+block('function readableFromSniffedBody(', '\nfunction rememberRawFailure(')+'\nthis.make=readableFromSniffedBody;',context);
const reader={read:async()=>({done:false,value:Buffer.alloc(1)}),cancel:()=>disposal,releaseLock:()=>{}};
const stream=context.make({chunk:Buffer.from([1]),reader},p=>captures.push(p));stream.destroy();
assert.equal(captures.length,1);let settled=false;captures[0].then(()=>settled=true);await new Promise(r=>setImmediate(r));assert.equal(settled,false);finish();await captures[0];assert.equal(settled,true);
});
test('prepared initial codec probe propagates abort; raw late-open uses the same cancellation fence',()=>{
const post=block("app.post('/sessions',",'function gatewayCreatedSessionPayload');
assert.match(post,/probeCodecProfile\([\s\S]*releasePreparationStartup \? \{ signal: sessionRequestAbortController.signal \}/);
const raw=block("app.get('/raw/:token'",'// Tee the leading bytes');
assert.ok(raw.indexOf('playbackPreparationCancellation.assertOpen')<raw.indexOf('await providerAdaptiveRouteControl'));
assert.match(raw,/await Promise.all\(preparedDisposals\)/);
assert.match(raw,/await require\('stream\/promises'\).finished/);
});

test('real signed prepared capability is rejected by every auxiliary caller of verifyRawToken',()=>{
  const crypto=require('node:crypto');const secret='isolated-fixture';
  const payload=JSON.stringify({v:1,url:'http://fixture.invalid/live.ts',exp:Date.now()/1000+60,preparationProtocol:1});
  const token=Buffer.from(payload).toString('base64url')+'.'+crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  const context=vm.createContext({crypto,Buffer,isHttpUrl:()=>true,timingSafeEqual:(a,b)=>a===b});
  vm.runInContext(block('function verifyRawToken(', '// `sid` is part')+'\nthis.verify=verifyRawToken;',context);
  assert.equal(context.verify(token,secret),null);
  assert.equal(context.verify(token,secret,true).preparationProtocol,1);
  const calls=src.match(/verifyRawToken\([^;\n]*,\s*true\)/g)||[];
  assert.deepEqual(calls,['verifyRawToken(req.params.token, GATEWAY_TOKEN, true)']);
});

test('rejected reader disposal is non-final and its raw work stays traceable',async()=>{
  const context=vm.createContext({require,Buffer,Promise});
  vm.runInContext(block('function cancelRawBodyBestEffort(', '\nfunction waitForRawBackoff(')+'\nthis.cancel=cancelRawBodyBestEffort;',context);
  const rejected=await context.cancel({cancel:()=>Promise.reject(new Error('still open')),releaseLock:()=>{}});
  assert.equal(rejected,false);
  const h=routes();h.context.playbackPreparationRawWork.set(`${owner}:${id}`,new Set([{abort:()=>{},done:Promise.resolve(rejected)}]));
  for(let i=0;i<2;i++) {const res=response();await h.handlers['/playback-preparations/cancel']({body:{ownerKey:owner,playbackSessionId:id,generation:'new-process'}},res);assert.equal(res.statusCode,202);assert.equal(res.body.drained,false);}
  assert.equal(h.context.playbackPreparationRawWork.get(`${owner}:${id}`).size,1);
});

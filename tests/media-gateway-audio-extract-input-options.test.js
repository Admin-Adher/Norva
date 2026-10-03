const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const {codecProbeInputOptions}=require('../services/media-gateway/src/codec-probe-input-options');
const text=fs.readFileSync(path.join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
const start=text.indexOf('function extractAudioWav('),end=text.indexOf('// V2 chunked pipeline',start);
assert.ok(start>0&&end>start);
function harness(viewer=false){
 const calls=[];let releases=0;
 const sandbox={path,os:{tmpdir:()=>'/private'},crypto:{randomUUID:()=> 'test'},Date,setTimeout,clearTimeout,
  FFMPEG_PATH:'ffmpeg',STRICT_LID_CHECKPOINT_FFMPEG_RW_TIMEOUT_US:1000,STRICT_LID_FFMPEG_RW_TIMEOUT_US:2000,ACCOUNT_ACTIVITY_KIND_LANGUAGE_VALIDATION:'language',
  codecProbeInputOptions,viewerPlaybackActiveLocally:()=>viewer,proxyKeyFromUrl:()=> 'account',isHttpUrl:v=>/^https?:/.test(v),
  proxyEnvFor:()=>({PROXY:'ordinary'}),loopbackOnlyEnv:()=>({PROXY:'loopback'}),redactCreds:v=>v,redactStrictLidLoopback:v=>v,
  fsp:{stat:async()=>({size:64000}),unlink:async()=>{}},console:{warn:()=>{}},registerAccountExtraction:()=>({release:()=>releases++}),
  spawn(command,args,options){const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};calls.push({command,args,options});setImmediate(()=>child.emit('close',0,null));return child;}};
 vm.createContext(sandbox);vm.runInContext(text.slice(start,end),sandbox);
 return {calls,sandbox,releases:()=>releases};
}
test('ordinary audio extraction accepts extensionless remote HLS and forbids local protocols',async()=>{
 const h=harness();assert.equal((await h.sandbox.extractAudioWav('https://provider.example/proxy','qa',1,10,20)).ok,true);
 const args=h.calls[0].args;assert.equal(args[args.indexOf('-extension_picky')+1],'0');
 const allowed=args[args.indexOf('-protocol_whitelist')+1].split(',');for(const unsafe of ['file','data','pipe','concat'])assert.ok(!allowed.includes(unsafe));
 assert.ok(args.indexOf('-protocol_whitelist')<args.indexOf('-i'));assert.equal(h.releases(),1);
});
test('strict capture retains its loopback input handling and viewer priority',async()=>{
 const h=harness();const r=await h.sandbox.extractAudioWav('http://127.0.0.1:99/source','qa',1,10,20,1000,'owner',true,null,true,{strictLoopback:true,providerSourceUrl:'https://provider.example/film.mp4'});
 assert.equal(r.ok,true);assert.ok(!h.calls[0].args.includes('-extension_picky'));assert.equal(h.calls[0].options.env.PROXY,'loopback');
 const busy=harness(true);assert.equal((await busy.sandbox.extractAudioWav('https://provider.example/hls','qa',1,10,20)).preempted,true);assert.equal(busy.calls.length,0);
});

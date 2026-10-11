const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/js/pages/WatchPage.js'),'utf8');
function fixture(container){
 const calls=[];const context={window:{},console,clearTimeout,MediaUtils:{playbackHintFromItem:()=>({container})},API:{proxy:{xtream:{getStreamUrl:async(...args)=>{calls.push(['create',args[4]]);return {url:'https://gateway.test/playlist.m3u8',sessionId:'new'};}}}}};
 vm.runInNewContext(source,context);const p=Object.create(context.window.WatchPage.prototype);
 Object.assign(p,{_playbackAttemptId:1,_gatewaySeekRequestId:0,content:{},video:{paused:false,pause(){this.paused=true;},removeAttribute(){},load(){}},
 captureVodPlaybackIdentity:()=>({sourceId:'s',itemId:'f',itemType:'movie',container,playbackItem:{}}),playbackResolveSignalForAttempt:()=>null,isStalePlaybackAttempt:()=>false,
 normalizePlaybackPreferences:x=>x,savePlaybackPreferences:x=>x,getMergedPlaybackPreferences:()=>({}),getCurrentAudioPlaybackOptions:()=>({}),
 showLoading(){},hidePlaybackError(){},trackPlaybackPosition(){},saveResumeSnapshotThrottled(){},updateDurationState(){},
 releasePlaybackPipelineForRetry:async()=>{calls.push(['release']);},waitForProviderSlotRelease:async()=>{},beginPlaybackTelemetry(){},
 applyPlaybackPreferencesToHint:x=>x,playbackMetadataFromResult:(a,b={})=>({...a,...b}),
 loadVideo:async(u,o)=>{calls.push(['load',o]);},handlePlaybackFailure:async()=>assert.fail('unexpected failure')});return {p,calls,context};
}
for(const [container,start,local] of [['mkv',15,15],['mp4',30,0],['',30,0]])test('seek preserves exact viewing position for '+(container||'unknown'),async()=>{
 const {p,calls}=fixture(container);await p.restartCloudGatewayStreamAt(30);
 assert.equal(calls[0][0],'release');const create=calls.find(x=>x[0]==='create')[1],load=calls.find(x=>x[0]==='load')[1];
 assert.equal(create.seekOffset,start);assert.equal(load.actualStartOffset,start);assert.equal(load.requestedSeekOffset,30);assert.equal(load.localSeekTarget,local);assert.equal(load.autoplay,true);
 assert.equal(calls.filter(x=>x[0]==='create').length,1);
});
test('explicit retry and opt-out retain their requested preroll',async()=>{
 for(const preRollSeconds of [0,75]){const {p,calls}=fixture('mkv');await p.restartCloudGatewayStreamAt(120,{preRollSeconds});assert.equal(calls.find(x=>x[0]==='create')[1].seekOffset,120-preRollSeconds);}
});

test('confirmed cloud expiry avoids a second cooldown; legacy cleanup keeps it',async()=>{
 for(const confirmed of [true,false]){
  const {p,calls}=fixture('ts');
  p.releasePlaybackPipelineForRetry=async options=>{
   assert.equal(options.strict,true);
   calls.push(['release']);
   return confirmed?{confirmedCloudClose:true,closedCloudSessions:1}:undefined;
  };
  p.waitForProviderSlotRelease=async delay=>calls.push(['cooldown',delay]);
  await p.restartCloudGatewayStreamAt(60);
  assert.equal(calls.filter(x=>x[0]==='cooldown').length,confirmed?0:1);
  assert.equal(calls.filter(x=>x[0]==='create').length,1);
 }
});

function useRealClosure(f,expireSession){
 const prototype=f.context.window.WatchPage.prototype;
 f.context.window.NorvaCloud={token:'fixture',playback:{expireSession}};
 Object.assign(f.p,{activeCloudPlaybackSessionIds:new Set(['old']),currentCloudPlaybackSessionId:'old',
  stopCloudPlaybackHeartbeat(){},cancelPendingHlsAudioSwitch(){},stopTranscodeSession:async()=>{},
  stopCloudPlaybackSessions:prototype.stopCloudPlaybackSessions,
  releasePlaybackPipelineForRetry:prototype.releasePlaybackPipelineForRetry});
}

test('successive seeks join in-flight expiry even after the local ID is cleared',async()=>{
 const f=fixture('ts');let finish;const pending=new Promise(r=>{finish=r;});let closeCalls=0;
 useRealClosure(f,async id=>{closeCalls++;await pending;return {session:{id,status:'expired'},gatewayErrors:0};});
 const first=f.p.restartCloudGatewayStreamAt(60);
 assert.equal(f.p.currentCloudPlaybackSessionId,null);
 const second=f.p.restartCloudGatewayStreamAt(120);
 await new Promise(r=>setImmediate(r));
 assert.equal(f.calls.some(x=>x[0]==='create'),false,'expiry must finish before either resolver');
 finish();await Promise.all([first,second]);
 assert.equal(closeCalls,1);
 assert.equal(f.calls.filter(x=>x[0]==='create').length,1);
 assert.equal(f.calls.find(x=>x[0]==='create')[1].seekOffset,120);
 assert.equal(f.calls.find(x=>x[0]==='load')[1].autoplay,true);
 assert.equal(f.p._playbackPipelineReleasePromise,null);
});

test('failed or unconfirmed expiry cannot create a replacement, including concurrent seeks',async()=>{
 for(const reply of [null,{session:{id:'old',status:'expired'},gatewayErrors:1}]){
  const f=fixture('ts');let finish;const pending=new Promise(r=>{finish=r;});
  useRealClosure(f,async()=>{await pending;return reply;});
  const results=Promise.allSettled([f.p.restartCloudGatewayStreamAt(60),f.p.restartCloudGatewayStreamAt(120)]);
  finish();assert.deepEqual((await results).map(x=>x.status),['rejected','rejected']);
  assert.equal(f.calls.some(x=>x[0]==='create'),false);
  assert.deepEqual([...f.p._unclosedCloudPlaybackSessionIds],['old']);
  assert.equal(f.p._playbackPipelineReleasePromise,null);
 }
});

test('committed scrub targets coalesce for 200 ms without opening intermediate sessions',async()=>{
 const f=fixture('ts'),timers=new Map();let id=0;const sought=[];
 f.context.setTimeout=(fn,delay)=>{timers.set(++id,{fn,delay});return id;};
 f.context.clearTimeout=id=>timers.delete(id);
 Object.assign(f.p,{currentPlaybackMode:'gateway-session',setProgressValue(){},seekToTime:async target=>sought.push(target)});
 f.p.scheduleProcessedSeek(60,180);f.p.scheduleProcessedSeek(120,180);
 assert.equal(timers.size,1);const timer=[...timers.values()][0];assert.equal(timer.delay,200);
 timer.fn();await new Promise(r=>setImmediate(r));assert.deepEqual(sought,[120]);
 assert.equal(f.calls.some(x=>x[0]==='create'),false);
});


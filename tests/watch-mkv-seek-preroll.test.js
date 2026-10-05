const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../public/js/pages/WatchPage.js'),'utf8');
function fixture(container){
 const calls=[];const context={window:{},console,MediaUtils:{playbackHintFromItem:()=>({container})},API:{proxy:{xtream:{getStreamUrl:async(...args)=>{calls.push(['create',args[4]]);return {url:'https://gateway.test/playlist.m3u8',sessionId:'new'};}}}}};
 vm.runInNewContext(source,context);const p=Object.create(context.window.WatchPage.prototype);
 Object.assign(p,{_playbackAttemptId:1,_gatewaySeekRequestId:0,content:{},video:{paused:false,pause(){this.paused=true;},removeAttribute(){},load(){}},
 captureVodPlaybackIdentity:()=>({sourceId:'s',itemId:'f',itemType:'movie',container,playbackItem:{}}),playbackResolveSignalForAttempt:()=>null,isStalePlaybackAttempt:()=>false,
 normalizePlaybackPreferences:x=>x,savePlaybackPreferences:x=>x,getMergedPlaybackPreferences:()=>({}),getCurrentAudioPlaybackOptions:()=>({}),
 showLoading(){},hidePlaybackError(){},trackPlaybackPosition(){},saveResumeSnapshotThrottled(){},updateDurationState(){},
 releasePlaybackPipelineForRetry:async()=>{calls.push(['release']);},waitForProviderSlotRelease:async()=>{},beginPlaybackTelemetry(){},
 applyPlaybackPreferencesToHint:x=>x,playbackMetadataFromResult:(a,b={})=>({...a,...b}),
 loadVideo:async(u,o)=>{calls.push(['load',o]);},handlePlaybackFailure:async()=>assert.fail('unexpected failure')});return {p,calls};
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


const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('native telemetry is sampled for cloud history and final position flushes before exact close',()=>{
 let receive,now=20000;const calls=[];
 const window={NorvaDesktop:{nativePlayer:{protocol:1,onEvent:fn=>receive=fn}},addEventListener(){},__norvaNative:{
  onProgress:(...args)=>calls.push(['progress',args[3]]),onPlaybackClosed:id=>calls.push(['closed',id]),onTrackPreferences:()=>calls.push(['preferences'])
 }};
 vm.runInNewContext(fs.readFileSync('public/js/utils/desktopNative.js','utf8'),{window,Date:{now:()=>now}});
 const event={type:'progress',sessionId:'owned',sourceId:'source',itemId:'movie',itemType:'movie',durationSeconds:300,positionSeconds:20,savedAtMs:now};
 receive(event);now+=1000;receive({...event,positionSeconds:21});assert.deepEqual(calls,[['progress',20]]);
 now+=15000;receive({...event,positionSeconds:36});assert.deepEqual(calls.at(-1),['progress',36]);
 receive({...event,type:'preferences',preferences:{subtitle:{disabled:true}}});now+=1000;receive({...event,positionSeconds:37});assert.deepEqual(calls.at(-1),['progress',37]);
 now+=1000;receive({...event,positionSeconds:38});receive({type:'closed',sessionId:'owned'});
 assert.deepEqual(calls.slice(-2),[['progress',38],['closed','owned']]);
 receive({type:'closed',sessionId:'owned'});assert.equal(calls.filter(c=>c[0]==='progress').length,4);
});
test('cloud history preserves bounded native track identity and explicit subtitle off',async()=>{
 const {sanitizeHistoryData,sanitizeWatchHistory}=await import('../supabase/functions/_shared/cloud-public-view.mjs');
 const preferences={audio:{stableId:'vlc-v1:1:1630826605:fr',language:'fr',role:'main'},subtitle:{disabled:true}};
 const data=sanitizeHistoryData({playbackPreferences:preferences});
 assert.deepEqual(data.playbackPreferences,preferences);
 assert.deepEqual(sanitizeWatchHistory({data}).data.playbackPreferences,preferences);
 const bad=sanitizeHistoryData({playbackPreferences:{audio:{stableId:'https://private.example/file',role:'secret',url:'private'},subtitle:{disabled:'true',token:'secret'}}});
 assert.equal(bad.playbackPreferences,undefined);
});

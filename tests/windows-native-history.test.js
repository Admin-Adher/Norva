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

test('native resume uses only fresh decoded progress from the exact finite session and flushes it on close',()=>{
 let receive,now=20000;const calls=[];
 const window={NorvaDesktop:{nativePlayer:{protocol:1,onEvent:fn=>receive=fn}},addEventListener(){},__norvaNative:{
  onPlaybackClosed:(...args)=>calls.push(args)
 }};
 vm.runInNewContext(fs.readFileSync('public/js/utils/desktopNative.js','utf8'),{window,Date:{now:()=>now}});
 const event={type:'progress',sessionId:'owned',itemType:'episode',durationSeconds:1000,positionSeconds:123.5,savedAtMs:now,decodedVideo:1};
 receive(event);assert.equal(window.__norvaNative.renderedPosition('owned'),123.5);
 assert.equal(window.__norvaNative.renderedPosition('other'),undefined);
 for(const patch of [{decodedVideo:0},{itemType:'channel'},{positionSeconds:NaN},{savedAtMs:now+1},{savedAtMs:now-10001}]) {
  receive({...event,...patch});assert.equal(window.__norvaNative.renderedPosition('owned'),undefined);
 }
 receive(event);receive({type:'closed',sessionId:'owned',reason:'closed'});
 assert.deepEqual(calls,[['owned','closed',123.5]]);
 assert.equal(window.__norvaNative.renderedPosition('owned'),undefined);
});

test('a Windows renderer reload replays the captured native stop position and still accepts legacy close IDs',async()=>{
 const listeners={},calls=[],window={NorvaDesktop:{nativePlayer:{protocol:1,onEvent(){},
  pendingPlaybackCloses:async()=>{assert.fail('The new bridge has an explicit details method');},
  pendingPlaybackCloseDetails:async()=>[{sessionId:'owned',resumePosition:82.125},'legacy',{sessionId:'invalid',resumePosition:Infinity}]}},
  __norvaNative:{onPlaybackClosed:(...args)=>calls.push(args)},addEventListener:(name,fn)=>listeners[name]=fn};
 vm.runInNewContext(fs.readFileSync('public/js/utils/desktopNative.js','utf8'),{window,Date});
 listeners.load();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,[['owned','player_exited',82.125],['legacy','player_exited',undefined],['invalid','player_exited',undefined]]);
});

test('the new Windows renderer still acknowledges protocol 1 UUID-only pending closes',async()=>{
 const listeners={},calls=[],window={NorvaDesktop:{nativePlayer:{protocol:1,onEvent(){},pendingPlaybackCloses:async()=>['legacy']}},
  __norvaNative:{onPlaybackClosed:(...args)=>calls.push(args)},addEventListener:(name,fn)=>listeners[name]=fn};
 vm.runInNewContext(fs.readFileSync('public/js/utils/desktopNative.js','utf8'),{window,Date});
 listeners.load();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,[['legacy','player_exited',undefined]]);
});

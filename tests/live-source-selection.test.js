const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function fixture(){
 const select={value:'m3u:2'}, context=vm.createContext({document:{getElementById:()=>select},window:{app:{}},console});
 vm.runInContext(fs.readFileSync('public/js/components/LiveGuideFusion.js','utf8')+';globalThis.Guide=LiveGuideFusion;',context);
 vm.runInContext(fs.readFileSync('public/js/components/ChannelList.js','utf8')+';globalThis.List=ChannelList;',context);
 return {select,context,guide:Object.create(context.Guide.prototype)};
}
test('source scope prevents stale asynchronous playback, including colliding source IDs',()=>{
 const {select,guide}=fixture(),played=[];
 guide.app={channelList:{selectChannel:c=>played.push(c)}};
 guide.playChannel({id:1,sourceId:1,sourceType:'m3u'});
 guide.playChannel({id:1,sourceId:2,sourceType:'xtream'});
 assert.equal(played.length,0);
 guide.playChannel({id:1,sourceId:2,sourceType:'m3u'});
 assert.equal(played.length,1);
 select.value='';guide.playChannel({id:1,sourceId:1,sourceType:'m3u'});
 assert.equal(played.length,2);
});
test('a source change during loading is replayed with the latest selection',async()=>{
 const {select,context}=fixture(),loaded=[];
 const list=Object.create(context.List.prototype);
 Object.assign(list,{sourceSelect:select,container:{setAttribute(){},removeAttribute(){}},liveHydrationRunId:0,
 isLiveLoadCurrent:id=>id===list.liveHydrationRunId,render(){},loadLiveDecorationsAndRefresh(){},maybeSyncRecentsFromCloud(){},
 loadM3uChannels:async id=>{loaded.push(id);if(id===2){select.value='m3u:3';await list.loadChannels();}return true;}});
 await list.loadChannels();assert.deepEqual(loaded,[2,3]);assert.equal(list.isLoading,false);
});

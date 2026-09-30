const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const edge=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
const block=edge.slice(edge.indexOf('type LivePlaybackPreparationContext ='),edge.indexOf('async function createPlaybackSession(',edge.indexOf('type LivePlaybackPreparationContext =')));
class HttpError extends Error {constructor(status,message,details){super(message);this.status=status;this.details=details;}}
function fixture({started=false,settled=false,generation='g1',routes=['g1'],gatewayDrained=true}={}) {
  const row={id:'preparation',user_id:'owner',playback_session_id:'session',gateway_generations:{hash:'g1'},state:'creating',expires_at:new Date(Date.now()+180000).toISOString(),started_at:started?'started':null,settled_at:settled?'settled':null};
  const effects=[];let cloud=true;
  const db={rpc:async(name,args)=>{
    effects.push(name);
    if(name==='norva_cancel_live_preparation')row.state='cancel_requested';
    return {data:{...row},error:null};
  },from:table=>{
    let action=null,update;
    const q={select(){return q},eq(){return q},update(value){action='update';update=value;return q},maybeSingle:async()=>({data:table==='live_playback_preparations'?{...row}:cloud?{id:'session'}:null,error:null}),then(resolve,reject){if(action==='update'){effects.push(update);Object.assign(row,update)}return Promise.resolve({error:null}).then(resolve,reject)}};return q;
  }};
  const context=vm.createContext({HttpError,db,AbortController,AbortSignal,setTimeout,clearTimeout,Date,
    recordOrEmpty:x=>x&&typeof x==='object'?x:{},stringOrNull:x=>typeof x==='string'&&x?x:null,stringOr:(x,f)=>typeof x==='string'?x:f,
    readJson:r=>r.json(),playbackRequestAbortError:()=>Object.assign(new Error('aborted'),{name:'AbortError'}),
    getRuntimeConfig:async()=>({}),mediaGatewayRoutesForProviderPreemption:()=>routes.map(url=>({url,token:'fixture'})),sha256Hex:async()=> 'hash',
    fetch:async(url,options)=>{effects.push({url,body:JSON.parse(options.body)});return {status:200,json:async()=>({drained:gatewayDrained,ownerKey:'hash',playbackSessionId:'session',generation})}},
    expirePlaybackSession:async(id,user)=>{assert.equal(id,'session');assert.equal(user,'owner');effects.push('expire-exact');cloud=false;return {gatewayErrors:0,mediaCacheErrors:0}},
  });
  vm.runInContext(stripTypeScriptTypes(block)+'\nthis.cancel=cancelLivePlaybackPreparation;this.begin=beginLivePlaybackPreparation;this.device=livePreparationDevice;',context);
  return {row,effects,context,db,cancel:()=>context.cancel({json:async()=>({deviceId:'device'})},'preparation','owner',db,null)};
}
test('Edge cancels durably before Gateway; ACK requires exact route generation and completed Edge POST',async()=>{
  const h=fixture({started:true});let result=await h.cancel();assert.equal(result.status,202);assert.equal(result.body.drained,false);
  assert.equal(h.effects[0],'norva_cancel_live_preparation');assert.ok(h.effects.includes('expire-exact'));
  h.row.settled_at='settled';result=await h.cancel();assert.equal(result.status,200);assert.equal(result.body.drained,true);assert.equal(h.row.state,'cancelled');
});
test('Edge never acknowledges changed process generation, unknown routes or failed drainage',async()=>{
  for(const option of [{generation:'g2'},{routes:[]},{gatewayDrained:false}]){
    const h=fixture(option);assert.equal((await h.cancel()).status,202);assert.notEqual(h.row.state,'cancelled');
  }
});
test('cancel before creation is final without inventing a cloud session',async()=>{
  const h=fixture();const result=await h.cancel();assert.equal(result.status,200);
});
test('device authentication cannot be substituted by another owned device',()=>{
  const h=fixture();assert.equal(h.context.device({},'authenticated'),'authenticated');
  assert.throws(()=>h.context.device({deviceId:'different'},'authenticated'),{status:403});
});
test('real Edge watcher aborts its request only after reading the exact durable cancellation',async()=>{
  const h=fixture();const req=new Request('http://fixture.invalid',{method:'POST',body:JSON.stringify({preparationId:'preparation',sourceId:'source',itemType:'live',itemId:'985192'})});
  const preparation=await h.context.begin(req,'owner',h.db,null);
  assert.equal(preparation.signal.aborted,false);h.row.state='cancel_requested';
  await assert.rejects(preparation.assertCurrent(),{name:'AbortError'});assert.equal(preparation.signal.aborted,true);
  await preparation.finish();assert.ok(h.row.settled_at);
});

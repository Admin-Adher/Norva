const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const path=require('node:path');
const deployed=process.env.NORVA_PLAYBACK_RECEIPT_TEST_SOURCE || path.join(__dirname,'../supabase/functions/norva-playback/index.ts');
const source=fs.readFileSync(deployed,'utf8');
const start=source.indexOf('  const receiptOwnedItemId =');
const markedEnd=source.indexOf('  markStartup("readyResponseMs");',start);
const end=markedEnd<0?source.indexOf('  return {',start):markedEnd;
assert.ok(start>0&&end>start,'real receipt source guard must be present');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const names=['resolved','recordOrEmpty','stringOrNull','itemType','episodeCoordinates','bindCompletedPlaybackReceipt','req','catalogVisibilityEpochHeaders','bindCatalogVisibilityEpochShared','userId','db','HttpError','adoptActiveCatalogUserVisibilityEpoch','sourceId','playbackGeneration','assertSourceCatalogVisible','deviceId','assertOwnedDevice','itemId','resolvePlaybackTarget','requestedPlaybackHint','sha256Hex','targetUrlHash','assertActiveCatalogGenerationCurrent','expirePlaybackSession','session','gateway'];
const execute=new AsyncFunction(...names,source.slice(start,end));
async function run(overrides={}) {
  const {bindCompletedPlaybackReceipt,finalizePlaybackReceiptResponse}=await import('../supabase/functions/_shared/playback-receipt-visibility.mjs');
  const order=[];let refreshed=false;let cleanups=0; const req=new Request('https://test.invalid');
  const db={from:()=>({select(){return this;},eq(){return this;},async maybeSingle(){order.push('owned-item');return overrides.missingItem?{data:null}:{data:{id:'owned-file'}};}})};
  const values={resolved:{itemCas:{id:'owned-file'}},recordOrEmpty:x=>x||{},stringOrNull:x=>x||null,itemType:'movie',episodeCoordinates:null,bindCompletedPlaybackReceipt,req,
    catalogVisibilityEpochHeaders:()=>({'X-Norva-Global-Visibility-Epoch':refreshed&&overrides.globalChanged?'11':'10'}),
    bindCatalogVisibilityEpochShared:async()=>{refreshed=true;order.push('epoch');},userId:'owner',db,HttpError:Error,
    adoptActiveCatalogUserVisibilityEpoch:async()=>{order.push('generation');if(overrides.changedGeneration)throw new Error('changed generation');},sourceId:'source',playbackGeneration:{},
    assertSourceCatalogVisible:async()=>{order.push('visible');if(overrides.hidden)throw new Error('hidden source');},deviceId:'device',
    assertOwnedDevice:async()=>{order.push('device');if(overrides.revokedDevice)throw new Error('revoked device');},itemId:'item',
    resolvePlaybackTarget:async()=>{order.push('target');return {targetUrl:overrides.changedTarget?'different':'same'};},requestedPlaybackHint:{},sha256Hex:async x=>x,targetUrlHash:'same',
    assertActiveCatalogGenerationCurrent:async()=>{order.push('final-generation');if(overrides.finalDrift)throw new Error('final drift');},
    expirePlaybackSession:async()=>{cleanups++;},session:{id:'session'},gateway:{}};
  let error=null;try{await execute(...names.map(n=>values[n]));}catch(e){error=e;}
  await finalizePlaybackReceiptResponse(req,async()=>new Response(null,{status:201}));
  return {order,cleanups,error};
}
test('real receipt path revalidates generation, visible file, target, device and final snapshot',async()=>{
  const result=await run();assert.equal(result.error,null);assert.equal(result.cleanups,0);
  assert.deepEqual(result.order,['epoch','generation','visible','device','owned-item','target','final-generation']);
});
for(const scenario of ['globalChanged','changedGeneration','hidden','revokedDevice','missingItem','changedTarget','finalDrift']) {
  test(`real receipt path rejects ${scenario} and releases only its prepared session`,async()=>{
    const result=await run({[scenario]:true});assert.ok(result.error);assert.equal(result.cleanups,1);
  });
}

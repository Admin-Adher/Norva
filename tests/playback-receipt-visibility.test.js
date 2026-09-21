const test = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../supabase/functions/_shared/playback-receipt-visibility.mjs');
const visibilityPromise = import('../supabase/functions/_shared/catalog-visibility-response.mjs');

async function harness() {
  const receipt = await modulePromise;
  const visibility = await visibilityPromise;
  const controller = new AbortController();
  const req = new Request('https://test.invalid/playback/session', {method:'POST',signal:controller.signal});
  let epoch = '1'; let cleanups = 0; const order = [];
  const db = {rpc:async()=>({data:{contract:'catalog-cache-epoch-v2',globalEpoch:'10',userEpoch:epoch,cacheEpoch:`v2.10.${epoch}`},error:null})};
  await visibility.bindCatalogVisibilityEpoch(req,'owner',db);
  const bind = (assertSourceCurrent = async()=>{order.push('source');}) => receipt.bindCompletedPlaybackReceipt(req,{
    refreshEpoch:async()=>{order.push('epoch');await visibility.bindCatalogVisibilityEpoch(req,'owner',db);},
    assertSourceCurrent,
    cleanup:async()=>{cleanups++;},
  });
  const finish = () => receipt.finalizePlaybackReceiptResponse(req,()=>visibility.finalizeCatalogVisibilityResponse(req,new Response('{}',{status:201}),db));
  return {receipt,req,controller,bind,finish,order,setEpoch:value=>{epoch=value;},cleanups:()=>cleanups};
}

test('prepared playback joins a newer cache epoch only before a fresh source authority check',async()=>{
  const h=await harness(); h.setEpoch('2'); await h.bind();
  const result=await h.finish(); assert.equal(result.status,201);
  assert.equal(result.headers.get('X-Norva-Visibility-Epoch'),'v2.10.2');
  assert.deepEqual(h.order,['epoch','source']); assert.equal(h.cleanups(),0);
});
test('a revoked or changed source cleans the prepared lane and rejects the receipt',async()=>{
  const h=await harness(); h.setEpoch('2');
  await assert.rejects(h.bind(async()=>{throw new Error('source changed');}),/source changed/);
  assert.equal(h.cleanups(),1);
});
test('a later cache cutover still returns the real 409 and cleans the undelivered lane',async()=>{
  const h=await harness(); await h.bind(); h.setEpoch('3');
  const result=await h.finish(); assert.equal(result.status,409);
  assert.equal((await result.json()).details.code,'CATALOG_VISIBILITY_MUTATION_OUTCOME_UNKNOWN');
  assert.equal(h.cleanups(),1);
  await h.finish(); assert.equal(h.cleanups(),1);
});
test('abort during final source verification releases the prepared lane',async()=>{
  const h=await harness();
  await assert.rejects(h.bind(async()=>h.controller.abort()),{name:'AbortError'});
  assert.equal(h.cleanups(),1);
});
test('finalizer failure releases the lane without hiding the original failure',async()=>{
  const h=await harness(); await h.bind();
  await assert.rejects(h.receipt.finalizePlaybackReceiptResponse(h.req,async()=>{throw new Error('unavailable');}),/unavailable/);
  assert.equal(h.cleanups(),1);
});
test('unregistered responses retain the ordinary cache fence',async()=>{
  const h=await harness(); h.setEpoch('2');
  assert.equal((await h.finish()).status,409); assert.equal(h.cleanups(),0);
});

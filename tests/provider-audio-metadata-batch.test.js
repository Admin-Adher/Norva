const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../supabase/functions/_shared/provider-audio-metadata-batch.mjs');

async function fixture(results, options = {}) {
  const {runProviderAudioMetadataBatch} = await load();
  const events = []; let clock = 0; let next = 0;
  const total = await runProviderAudioMetadataBatch({
    now: () => clock,
    pause: async ms => { clock += ms; events.push(['pause', ms]); },
    claim: async () => next < results.length ? {variantId: String(next++), scanned: 1} : {hasMore:false},
    read: async item => {
      events.push(['read', item.variantId]);
      const result = results[Number(item.variantId)];
      if (result instanceof Error) throw result;
      clock += options.readMs || 0;
      return result;
    },
    finish: async (item, result) => { events.push(['finish', item.variantId, result]); if(options.ackError) throw new Error('ack'); },
    ...options,
  });
  return {total, events, clock};
}
test('inconclusive metadata advances to the next file and never appends a probe', async () => {
  const x = await fixture([{stopped:'metadata-no-language',attempted:1,transportCompleted:true},{persisted:1,attempted:1}]);
  assert.equal(x.total.processed,2); assert.equal(x.total.inconclusive,1); assert.equal(x.total.identified,1);
  assert.equal(x.total.hasMore,false); assert.equal(x.clock,2000);
  assert.deepEqual(x.events.filter(e=>e[0]==='read').map(e=>e[1]),['0','1']);
});
for(const code of ['live-session','background_busy','provider-footprint-capped','provider_probe_circuit_open']) {
  test(`stops on ${code} without consuming more provider requests`,async()=>{
    const x=await fixture([{stopped:code,attempted:0},{persisted:1}]);
    assert.equal(x.total.processed,1);assert.equal(x.total.deferred,1);
    assert.equal(x.total.skipped,code); assert.equal(x.events[1][2].uncertain,false);
  });
}
test('timeout retains uncertainty and stops; failed ACK never launches another request',async()=>{
  const x=await fixture([new Error('timeout'),{persisted:1}]);
  assert.equal(x.total.processed,1);assert.equal(x.total.failed,1);assert.equal(x.events[1][2].uncertain,true);
  await assert.rejects(fixture([{persisted:1},{persisted:1}],{ackError:true}),/ack/);
});
test('batch observes request pacing, maximum and wall clock bounds',async()=>{
  const rows=Array.from({length:100},()=>({persisted:1,attempted:1}));
  assert.equal((await fixture(rows)).total.processed,32);
  assert.equal((await fixture(rows,{readMs:12_000})).total.processed,3);
  await assert.rejects(fixture(rows,{maximum:33}),/budget/);
});
test('capacity rejection performs no read and does not manufacture completion',async()=>{
  const x=await fixture([],{claim:async()=>({skipped:'metadata-capacity',hasMore:true})});
  assert.equal(x.total.processed,0);assert.equal(x.total.hasMore,true);assert.equal(x.total.skipped,'metadata-capacity');
});
test('all legacy lanes receive a turn; cheap metadata cannot starve speech or series',async()=>{
  const {providerMetadataFleetTurn}=await load();
  const turns=Array.from({length:48},(_,i)=>providerMetadataFleetTurn(i));
  assert.equal(turns.filter(x=>x.metadata).length,24);
  assert.deepEqual(turns.filter(x=>!x.metadata).map(x=>x.lane),Array.from({length:24},(_,i)=>i%12));
});

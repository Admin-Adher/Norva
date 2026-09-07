const test = require('node:test');
const assert = require('node:assert/strict');

test('Selection series hydration is owned, generation-fenced, bounded and contains no ordered track maps', async () => {
  const { discoverySourceId } = await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const { hydrateSelectionSnapshotSeriesTracks: hydrate } = await import('../supabase/functions/_shared/selection-snapshot-tracks.mjs');
  const sourceId = await discoverySourceId('owner');
  const rows = Array.from({length:120}, (_,i) => ({ item_type:'series',
    external_id:'norva-selection:series:'+i.toString(16).padStart(64,'0'),
    metadata:{seriesDelivery:'selection'} }));
  const generationFence = {p_generation_id:'current-generation',p_head_revision:4,
    p_config_revision:2,p_source_visibility_epoch:1,p_user_visibility_epoch:3};
  const calls=[];let checks=0;
  const db={async rpc(name,args){calls.push({name,args});return {data:args.p_parent_series_ids.length,error:null};}};
  const args={db,userId:'owner',sourceId,rows,generationFence,assertSourceCurrent:async()=>{checks++;}};
  assert.deepEqual(await hydrate({...args,sourceId:'foreign'}),{seeded:0});
  assert.deepEqual(await hydrate({...args,rows:[{...rows[0],item_type:'movie'},{...rows[0],metadata:{}}]}),{seeded:0});
  assert.equal(calls.length,0);
  await assert.rejects(hydrate({...args,generationFence:null}),/requires a catalogue generation/);
  assert.deepEqual(await hydrate({...args,rows:[...rows,rows[0]]}),{seeded:120});
  assert.equal(calls.length,3);assert.equal(checks,6);
  for(const call of calls){
    assert.equal(call.name,'hydrate_selection_episode_file_languages');
    assert.equal(call.args.p_source_id,sourceId);assert.equal(call.args.p_user_id,'owner');
    assert.equal(call.args.p_generation_id,'current-generation');
    assert.ok(call.args.p_parent_series_ids.length<=50);
    assert.ok(!JSON.stringify(call.args).includes('audioTracks'));
  }
  db.rpc=async()=>({error:new Error('stale generation')});
  await assert.rejects(hydrate(args),/stale generation/);
  calls.length=0;
  await assert.rejects(hydrate({...args,assertSourceCurrent:async()=>{throw Error('source removed');}}),/source removed/);
  assert.equal(calls.length,0);
});

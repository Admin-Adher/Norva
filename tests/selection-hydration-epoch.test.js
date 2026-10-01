const {test}=require('node:test');
const assert=require('node:assert/strict');

test('all Selection hydration batches join their own writes without relaxing source authority',async()=>{
  const {discoverySourceId}=await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const {fetchSelectionVod}=await import('../supabase/functions/_shared/selection-vod.mjs');
  const tracks=await import('../supabase/functions/_shared/selection-snapshot-tracks.mjs');
  const {hydrateSelectionAudioResults}=await import('../supabase/functions/_shared/selection-audio-results.mjs');
  const sourceId=await discoverySourceId('owner');
  const publicRows=(await fetchSelectionVod({fetchPlaylist:async()=>{throw Error('offline test')}})).items.map(x=>x.fields);
  const eligible=new Set((await tracks.selectionSnapshotMovieManifests(publicRows)).slice(0,120).map(x=>x.externalId));
  const cases=[
    [tracks.hydrateSelectionSnapshotMovieTracks,publicRows.filter(r=>eligible.has(r.external_id))],
    [hydrateSelectionAudioResults,Array.from({length:120},(_,i)=>({item_type:'movie',external_id:'movie:'+i}))],
    [tracks.hydrateSelectionSnapshotSeriesTracks,Array.from({length:120},(_,i)=>({item_type:'series',
      external_id:'norva-selection:series:'+i.toString(16).padStart(64,'0'),metadata:{seriesDelivery:'selection'}}))],
  ];
  for(const [hydrate,rows] of cases){
    let dbEpoch=3,snapshotEpoch=3,calls=0,sourceChanged=false;
    const fence=()=>({p_generation_id:'same-generation',p_head_revision:4,p_config_revision:2,
      p_source_visibility_epoch:1,p_user_visibility_epoch:snapshotEpoch});
    const db={async rpc(_name,args){
      assert.equal(args.p_generation_id,'same-generation');assert.equal(args.p_config_revision,2);
      if(args.p_user_visibility_epoch!==dbEpoch)return {error:Object.assign(Error('stale epoch'),{code:'PT409'})};
      calls++;dbEpoch++;return {data:1};
    }};
    const input={db,userId:'owner',sourceId,rows,generationFence:fence(),
      assertSourceCurrent:async()=>{if(sourceChanged)throw Error('source changed');snapshotEpoch=dbEpoch;}};
    // Reproduce the old defect: the first successful chunk invalidates the
    // originally captured fence, making the second chunk fail closed.
    await assert.rejects(hydrate(input),/stale epoch/);
    assert.equal(calls,1);
    calls=0;dbEpoch=3;snapshotEpoch=3;
    await hydrate({...input,getGenerationFence:fence});assert.equal(calls,3);
    calls=0;sourceChanged=true;
    await assert.rejects(hydrate({...input,getGenerationFence:fence}),/source changed/);
    assert.equal(calls,0,'authority changes must still stop before writes');
  }
});

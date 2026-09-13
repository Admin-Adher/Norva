const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('offline movie repair manifests fail closed, preserve exact fences and never export URLs',async()=>{
  const {buildSelectionMovieHydrationManifest}=await import('../scripts/build-selection-movie-hydration-manifest.mjs');
  const {fetchSelectionVod}=await import('../supabase/functions/_shared/selection-vod.mjs');
  const {discoverySourceId}=await import('../supabase/functions/_shared/discovery-catalog.mjs');
  const userId='10000000-0000-0000-0000-000000000001',sourceId=await discoverySourceId(userId);
  const rows=(await fetchSelectionVod({fetchPlaylist:async()=>{throw Error('offline')}})).items.map(e=>e.fields);
  const row={...rows.find(r=>r.title==='White Chicks (2004)'),id:'20000000-0000-0000-0000-000000000001'};
  const generationFence={p_generation_id:'30000000-0000-0000-0000-000000000001',p_head_revision:'4',p_config_revision:'2',p_source_visibility_epoch:'1',p_user_visibility_epoch:'3'};
  const source={userId,sourceId,generationFence,rows:[row]}, input={sources:[source]};
  const result=await buildSelectionMovieHydrationManifest(input);
  assert.equal(result.dryRun,true);assert.deepEqual(result.summary,{sources:1,variants:1,files:1,batches:1});
  assert.ok(!JSON.stringify(result).includes('https://'));
  assert.equal(result.batches[0].args.p_head_revision,'4');
  assert.deepEqual(result.batches[0].variantIds,[row.id]);
  await assert.rejects(buildSelectionMovieHydrationManifest({sources:[{...source,sourceId:userId}]}),/ownership/);
  await assert.rejects(buildSelectionMovieHydrationManifest({sources:[source,source]}),/duplicated/);
  await assert.rejects(buildSelectionMovieHydrationManifest({sources:[{...source,generationFence:{p_generation_id:generationFence.p_generation_id}}]}),/five current/);
  await assert.rejects(buildSelectionMovieHydrationManifest({sources:[{...source,rows:[row,row]}]}),/uniqueness/);
  await assert.rejects(buildSelectionMovieHydrationManifest({sources:[{...source,rows:[{...row,user_id:'40000000-0000-0000-0000-000000000001'}]}]}),/ownership/);
  await assert.rejects(buildSelectionMovieHydrationManifest({sources:[{...source,rows:[{...row,playback_hint:{targetUrl:'https://wrong.invalid/a.mp4'}}]}]}),/exact URL/);
});

test('movie seed SQL is narrow, insert-only, exact-file and does not create audio certificates',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260913210130_selection_snapshot_movie_hydration_repair.sql'),'utf8');
  assert.match(sql,/norva_credential_require_service_role\(\)/);
  assert.match(sql,/security definer set search_path = ''/);
  assert.match(sql,/norva_selection_source_identity_valid\(p_source_id,p_user_id\)/);
  assert.match(sql,/jsonb_array_length\(p_files\)>50/);
  assert.match(sql,/media\.external_id=variant\.external_id and media\.available/);
  assert.match(sql,/media\.playback_hint->>'targetUrl'=variant\.playback_hint->>'targetUrl'/);
  for(const field of ['generationId','headRevision','configRevision','sourceVisibilityEpoch','userVisibilityEpoch','isCatalogVisible'])
    assert.ok(sql.includes("v_snapshot->>'"+field+"'"));
  assert.match(sql,/on conflict \(server_host,item_type,external_id\) do nothing/);
  assert.match(sql,/on conflict \(user_id,variant_id,file_external_id\) do nothing/);
  assert.doesNotMatch(sql,/\bupdate public\.|\bdelete from\b|disable trigger|p_audio_verified/i);
  assert.match(sql,/v_cache\.audio_lang_verification->>'urlSha256' is distinct from v_file\.url_sha256/);
  assert.match(sql,/v_cache_map is distinct from v_snapshot_map/);
  assert.match(sql,/from public,anon,authenticated/);
  assert.match(sql,/to service_role/);
});

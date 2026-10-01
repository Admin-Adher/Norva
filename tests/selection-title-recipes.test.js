const {test}=require('node:test');
const assert=require('node:assert/strict');
const modulePromise=import('../supabase/functions/_shared/selection-title-recipes.mjs');
const identity=import('../supabase/functions/_shared/discovery-catalog.mjs');
const raw={id:'owned-item',source_id:'owned-source',user_id:'owner',generation_id:'generation',
  item_type:'movie',external_id:'public-film',title:'Film',available:true,metadata:{year:2020},
  playback_hint:{targetUrl:'https://public.example/film.mp4'}};
const title={id:'private-title',user_id:'owner',item_type:'movie',identity_key:'tmdb:12',
  identity_source:'provider_tmdb',title:'Film',metadata:{tmdb:{id:12}},last_observed_ttff_ms:1234};
const variant={id:'private-variant',user_id:'owner',source_id:'source',title_id:'private-title',media_item_id:'owned-item',
  item_type:'movie',external_id:'public-film',metadata:{identityKey:'tmdb:12'},observed_success_rate:0.5};

test('public preparation excludes every owner binding and personal playback measurement',async()=>{
  const {selectionTitleRecipes}=await modulePromise;
  const [recipe]=selectionTitleRecipes([raw],[title],[variant]);
  for(const part of [recipe.raw,recipe.title,recipe.variant])
    for(const key of ['id','user_id','source_id','generation_id','title_id','media_item_id','last_observed_ttff_ms','observed_success_rate'])
      assert.equal(Object.hasOwn(part,key),false,key);
  assert.equal(recipe.title.identity_key,'tmdb:12');
  assert.equal(recipe.raw.external_id,'public-film');
});

test('ordinary provider sources never enter the shared Selection path',async()=>{
  const {applySelectionTitleRecipes,saveSelectionTitleRecipes}=await modulePromise;
  const db={rpc(){throw Error('must not use shared catalogue')}};
  assert.equal(await applySelectionTitleRecipes({db,userId:'owner',sourceId:'ordinary',rows:[raw]}),null);
  await saveSelectionTitleRecipes({db,userId:'owner',sourceId:'ordinary',rows:[raw],titles:[title],variants:[variant]});
});

test('cache bindings carry current owner and full generation fence',async()=>{
  const {applySelectionTitleRecipes}=await modulePromise;
  const userId='00000000-0000-4000-8000-000000000001';
  const sourceId=await (await identity).discoverySourceId(userId);
  const fence={p_generation_id:'new-generation',p_head_revision:'3',p_config_revision:'4',p_source_visibility_epoch:'5',p_user_visibility_epoch:'6'};
  const db={async rpc(name,args){
    assert.equal(name,'norva_apply_selection_title_recipes');
    assert.equal(args.p_source_id,sourceId);assert.equal(args.p_user_id,userId);
    for(const [key,value] of Object.entries(fence))assert.equal(args[key],value);
    assert.deepEqual(args.p_item_ids,['owned-item']);
    return {data:{reused:true,titles:1,variants:1,itemIds:['owned-item']}};
  }};
  assert.equal((await applySelectionTitleRecipes({db,sourceId,userId,rows:[raw],generationFence:fence})).variants,1);
});

test('foreign, duplicate and false partial receipts fail closed',async()=>{
  const {applySelectionTitleRecipes}=await modulePromise;
  const userId='00000000-0000-4000-8000-000000000001';
  const sourceId=await (await identity).discoverySourceId(userId);
  for(const itemIds of [['foreign'],['owned-item','owned-item'],[]]){
    const db={async rpc(){return {data:{reused:true,variants:1,itemIds}}}};
    await assert.rejects(applySelectionTitleRecipes({db,sourceId,userId,rows:[raw],generationFence:{}}),/Invalid Selection/);
  }
});

test('only absent rolling RPC is a safe fallback; stale ownership is propagated',async()=>{
  const {applySelectionTitleRecipes}=await modulePromise;
  const userId='00000000-0000-4000-8000-000000000001';
  const sourceId=await (await identity).discoverySourceId(userId);
  for(const code of ['PGRST202','PT409','42501']){
    const call=applySelectionTitleRecipes({db:{async rpc(){return {error:{code}}}},sourceId,userId,rows:[raw],generationFence:{}});
    if(code==='PGRST202')assert.equal(await call,null);else await assert.rejects(call,error=>error.code===code);
  }
});

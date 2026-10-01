const { test } = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../supabase/functions/_shared/selection-prepared-catalog.mjs');
function store(payload = null, error = null) {
  let saved;
  const db = { from(name) {
    assert.equal(name,'selection_prepared_catalogs');
    return { select() { return this; }, eq() { return this; }, gt(column, value) {
      assert.equal(column,'expires_at'); assert.ok(Date.parse(value)); return this;
    }, async maybeSingle() { return {data:payload ? {payload} : null,error}; },
    async upsert(value) { saved=value; return {error:null}; } };
  } };
  return { db, saved:()=>saved };
}
const row = {user_id:'old-owner',source_id:'old-source',generation_id:'old-generation',id:'old-item',
  item_type:'movie',external_id:'public-id',title:'Public film',metadata:{providerTmdbId:12},
  playback_hint:{targetUrl:'https://public.invalid/film.mp4'},available:true};
test('prepared cache never retains owner/source/generation bindings', async () => {
  const {preparedSelectionCatalog}=await modulePromise;
  const db=store();
  const result=await preparedSelectionCatalog({db:db.db,key:'revision',build:async()=>({rows:[row],sources:[{status:'loaded'}]})});
  assert.equal(result.reused,false);
  for(const name of ['user_id','source_id','generation_id','id']) assert.equal(name in db.saved().payload.rows[0],false);
  assert.equal(result.rows[0].external_id,'public-id');
});
test('fresh prepared catalogue bypasses rebuilding and checks current ownership', async () => {
  const {preparedSelectionCatalog}=await modulePromise;
  let guards=0;
  const db=store({version:1,rows:[row],sources:[]});
  const result=await preparedSelectionCatalog({db:db.db,key:'revision',
    build:async()=>{throw Error('must not rebuild');},assertCurrent:async()=>{guards++;}});
  assert.equal(result.reused,true); assert.equal(guards,2);
  assert.equal(result.rows[0].user_id,undefined);
});
test('unavailable schema falls back, but incomplete feeds never become shared templates', async () => {
  const {preparedSelectionCatalog}=await modulePromise;
  const db=store(null,{code:'42P01'});
  const result=await preparedSelectionCatalog({db:db.db,key:'revision',build:async()=>({rows:[row],sources:[{status:'unavailable'}]})});
  assert.equal(result.reused,false); assert.equal(db.saved(),undefined);
});
test('stale ownership aborts before either cache access or build', async () => {
  const {preparedSelectionCatalog}=await modulePromise;
  await assert.rejects(preparedSelectionCatalog({db:{},key:'revision',build:async()=>{throw Error('wrong');},
    assertCurrent:async()=>{throw Error('superseded');}}),/superseded/);
});

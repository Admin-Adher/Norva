'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync('supabase/functions/norva-catalog/index.ts', 'utf8');
const body = source.slice(source.indexOf('async function listVariantsByTitleIds('), source.indexOf('// User display language for localized titles'));
const required = { titleId: 'title-a', sourceId: 'selected-source', externalId: 'selected-file' };
const row = (n, extra = {}) => ({ user_id: 'owner', title_id: 'title-a', source_id: 'source', external_id: String(n), rank: n, ...extra });
const selected = row(27, { source_id: required.sourceId, external_id: required.externalId, audio: 'fr' });
const rows = [...Array.from({ length: 26 }, (_, n) => row(n)), selected];
async function run({ data = rows, anchor = required, disabled = [], errored = [], audio = null } = {}) {
  const filters = {}, module = { exports: {} }, attached = [];
  let titles = [];
  const query = { select(){return this;}, in(_, ids){titles=ids;return this;}, order(){return this;},
    eq(key,value){filters[key]=value;return this;},
    then(resolve){resolve({data:data.filter(r=>titles.includes(r.title_id)&&Object.entries(filters).every(([k,v])=>r[k]===v)),error:null});} };
  vm.runInNewContext(transformSync(body + '\nexport { listVariantsByTitleIds };', {loader:'ts',format:'cjs'}).code, {
    module, exports:module.exports, HOME_RAIL_VARIANT_LIMIT:10, TITLE_VARIANT_QUERY_CHUNK:40,
    db:{from(table){assert.equal(table,'cloud_catalog_visible_title_variants');return query;}},
    sourceHealthFor:async owner=>{assert.equal(owner,'owner');return {disabled:new Set(disabled),errored:new Set(errored)};},
    compareTitleVariants:(a,b)=>a.rank-b.rank,
    attachExactFileTracks:async map=>{for(const [key,values] of map) attached.push([key,values.map(r=>r.external_id)]);},
    canonicalFileLanguage:v=>v, providerAudioFacet:()=>null, catalogVariantMatchesAudio:()=>false,
  });
  const result = await module.exports.listVariantsByTitleIds(['title-a','title-b'],'owner',10,audio,null,anchor);
  return {result,attached,filters};
}
test('exact recovery keeps rank 27 inside the existing ten-version bound and attaches its own facts',async()=>{
  const {result,attached,filters}=await run();
  const files=result.get('title-a');
  assert.equal(filters.user_id,'owner'); assert.equal(files.length,10);
  assert.deepEqual(Array.from(files.slice(0,9),r=>r.external_id),rows.slice(0,9).map(r=>r.external_id));
  assert.equal(files[9],selected); assert.equal(files[9].audio,'fr');
  assert.ok(attached[0][1].includes('selected-file'));
});
test('ordinary rails keep their ten ranked versions without pinning',async()=>{
  const {result}=await run({anchor:null});
  assert.deepEqual(Array.from(result.get('title-a'),r=>r.external_id),rows.slice(0,10).map(r=>r.external_id));
});
test('missing, disabled, foreign-owner and source-colliding files are never fabricated',async()=>{
  for(const options of [
    {data:rows.slice(0,26)}, {disabled:['selected-source']},
    {data:[...rows.slice(0,26),{...selected,user_id:'other-owner'}]},
    {data:[...rows.slice(0,26),{...selected,source_id:'other-source'}]},
  ]) {
    const {result}=await run(options);
    assert.equal(result.get('title-a').some(r=>r.source_id===required.sourceId&&r.external_id===required.externalId),false);
  }
});
test('pinning never changes sibling title selections or duplicates an already selected file',async()=>{
  const sibling=Array.from({length:12},(_,n)=>row(n,{title_id:'title-b'}));
  const {result}=await run({data:[...rows,sibling[0],...sibling.slice(1)]});
  assert.deepEqual(Array.from(result.get('title-b'),r=>r.external_id),sibling.slice(0,10).map(r=>r.external_id));
  const early={...selected,rank:-1};
  const second=await run({data:[...rows.slice(0,26),early]});
  assert.equal(second.result.get('title-a')[0],early);
  assert.equal(second.result.get('title-a').filter(r=>r.external_id==='selected-file').length,1);
});
test('an errored source remains selectable explicitly without replacing the healthy default',async()=>{
  const {result}=await run({errored:['selected-source']});
  assert.equal(result.get('title-a')[0],rows[0]);
  assert.equal(result.get('title-a')[9],selected);
});


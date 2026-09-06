'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { importTypescriptModule } = require('./helpers/import-typescript-module');
const loading = importTypescriptModule('supabase/functions/_shared/live-catalog.ts');
const source = fs.readFileSync('supabase/functions/norva-catalog/index.ts', 'utf8');
const start = source.indexOf('async function listLiveLogicalChannels(');
const end = source.indexOf('async function listLiveChannelVariants(', start);
assert.ok(start >= 0 && end > start);
const code = transformSync(source.slice(start, end), { loader:'ts', target:'node18' }).code;

async function fixture(rows, materialized = null) {
  const { buildLiveCatalog } = await loading;
  const reads=[];
  const context = {
    URL, LIVE_PAGE_SIZE:1000, LIVE_MAX_ROWS:80000,
    boundedInt:(value, fallback, min, max) => {
      const parsed=Number.parseInt(value,10);
      return Number.isFinite(parsed) ? Math.max(min,Math.min(max,parsed)) : fallback;
    },
    boolParam:value => value === '1',
    stringOrNull:value => typeof value === 'string' && value.trim() ? value.trim() : null,
    stringFrom:value => value == null ? '' : String(value),
    normalizeSearchText:value => value.toLowerCase(),
    liveGroupsFromChannels:channels => [...new Set(channels.map(c=>c.category_id))],
    listMaterializedLiveLogicalChannels:async()=>materialized,
    listLiveRows:async(userId,sourceId,maxRows)=>{
      reads.push({userId,sourceId,maxRows});
      return rows.filter(r=>!sourceId || r.source_id === sourceId);
    },
    buildLiveCatalog,
  };
  vm.createContext(context);
  vm.runInContext(code,context);
  return {read:q=>context.listLiveLogicalChannels(new URL('https://norva.test/live?'+q),'owner'), reads, buildLiveCatalog};
}
const rows=Array.from({length:2403},(_,i)=>({
  source_id:'selection', item_type:'live', external_id:'stream-'+i,
  title:'Station '+String(i).padStart(5,'0'), subtitle:'World', available:true,
  playback_hint:{sourceType:'m3u',targetUrl:'https://example.test/'+i+'/live.m3u8'},
}));

test('a non-materialized worldwide guide pages every channel exactly once',async()=>{
  const f=await fixture(rows);
  const collected=[];
  for(let offset=0;offset<rows.length;offset+=400){
    const page=await f.read('sourceId=selection&country=US&limit=400&offset='+offset);
    assert.equal(page.materialized,false);
    assert.equal(page.country,'US');
    assert.equal(page.total,rows.length);
    assert.equal(page.count,Math.min(400,rows.length-offset));
    assert.equal(page.hasMore,offset+page.count<page.total);
    collected.push(...page.channels.map(c=>c.id));
  }
  const expected=f.buildLiveCatalog(rows,{country:'US',sourceId:'selection',includeVariants:false});
  assert.deepEqual(collected,expected.channels.map(c=>c.id));
  assert.equal(new Set(collected).size,rows.length);
  assert.ok(f.reads.every(r=>r.userId==='owner' && r.sourceId==='selection'));
});

test('fallback defaults and oversized requests stay bounded; an exhausted page stays empty',async()=>{
  const f=await fixture(rows);
  for(const query of ['country=US','country=US&limit=999999']){
    const page=await f.read(query);
    assert.equal(page.limit,1000);
    assert.equal(page.count,1000);
    assert.equal(page.total,2403);
    assert.equal(page.hasMore,true);
  }
  const end=await f.read('country=US&limit=400&offset=999999');
  assert.equal(end.count,0);
  assert.equal(end.total,2403);
  assert.equal(end.hasMore,false);
});

test('search and country grouping happen before slicing; variants keep their identities',async()=>{
  const f=await fixture(rows);
  const page=await f.read('country=US&q=Station%20002&limit=17&offset=17&includeVariants=1');
  const all=f.buildLiveCatalog(rows,{country:'US',includeVariants:true}).channels
    .filter(c=>c.title.toLowerCase().includes('station 002'));
  assert.equal(page.total,all.length);
  assert.deepEqual(page.channels.map(c=>c.id),all.slice(17,34).map(c=>c.id));
  assert.ok(page.channels.every(c=>c.variants.length===1));
});

test('existing materialized responses keep their current contract and avoid raw rows',async()=>{
  const materialized={channels:[{id:'cached'}],materialized:true,hasMore:false};
  const f=await fixture(rows,materialized);
  assert.equal(await f.read('country=FR&limit=12'),materialized);
  assert.equal(f.reads.length,0);
});

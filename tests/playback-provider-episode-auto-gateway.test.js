'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
function extract(start, end) {
  const a=source.indexOf(start), b=source.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a);
  return stripTypeScriptTypes(source.slice(a,b), {mode:'strip'});
}
const recordOrEmpty = v => v && typeof v==='object' && !Array.isArray(v) ? v : {};
const route = vm.runInNewContext(`(() => {${extract('function shouldUseOwnedEpisodeBrowserGateway(', '\nfunction choosePlaybackMode(')};return shouldUseOwnedEpisodeBrowserGateway;})()`, {recordOrEmpty});

test('owned provider episodes use automatic input inspection before browser playback, including false MP4 labels', () => {
  for(const marker of ['ownedXtreamEpisode','ownedM3uEpisode']) {
    const target = {[marker]:true,playbackHint:{container:'mp4'}};
    assert.equal(route(target,'series','relay',{}),true);
    assert.equal(route(target,'series','transcode',{gatewayAutoMode:true}),true);
    assert.equal(route(target,'series','direct',{}),false);
    assert.equal(route(target,'series','transcode',{}),false);
    assert.equal(route(target,'series','relay',{enginePipe:true}),false);
    assert.equal(route(target,'series','relay',{engine_pipe:true}),false);
    assert.equal(route(target,'movie','relay',{}),false);
  }
  for(const marker of [undefined,false,'true',1]) {
    assert.equal(route({ownedXtreamEpisode:marker},'series','relay',{ownedXtreamEpisode:true}),false);
  }
});

test('a TS observation never changes the exact provider .mp4 resource or owner coordinates', async () => {
  const calls=[];
  const resolve=vm.runInNewContext(`(() => {${extract('async function resolveExactEpisodePlaybackTarget(', '\nasync function resolvePlaybackTarget(')};return resolveExactEpisodePlaybackTarget;})()`, {
    recordOrEmpty,
    stringOr:(v,f)=>typeof v==='string'&&v.length?v:f,
    resolveObservedVodContainer:async (...args)=>{calls.push(['observation',...args]);return {container:'ts'};},
    loadSourceConfig:async (...args)=>{calls.push(['source',...args]);return {serverUrl:'https://provider.example',username:'synthetic-user',password:'synthetic-password'};},
    xtreamStreamUrl:c=>`${c.serverUrl}/series/${c.streamId}.${c.container}`,
    mergePlaybackHints:(a,b)=>({...a,...b}), HttpError:class extends Error {},
  });
  const db={};
  const result=await resolve('owned-source','owner',{episode_id:'123',container_extension:'mp4',parent_series_id:'456'}, {container:'ts',targetUrl:'https://attacker.invalid/other.ts'},db);
  assert.equal(result.targetUrl,'https://provider.example/series/123.mp4');
  assert.equal(result.containerObservation.container,'ts');
  assert.equal(result.ownedXtreamEpisode,true);
  assert.equal(result.playbackHint.audioSeriesId,'456');
  assert.equal(route(result,'series','relay',{}),true);
  assert.deepEqual(calls.map(c=>c.slice(0,3)),[['observation','owned-source','owner'],['source','owned-source','owner']]);
  assert.equal(calls[0][3],'series');
  assert.equal(calls[0][4],'123');
  assert.equal(calls[0][5],db);
});

test('legacy cached and uncached episode resolution preserves the provider resource despite a TS observation', async () => {
  for (const cached of [false, true]) {
    const queries=[];
    const row=cached ? {playback_hint:{sourceType:'xtream',streamType:'series',streamId:'123',container:'mp4'}} : null;
    const db={from(table) {
      const query={table,filters:[]}; queries.push(query);
      const chain={select(){return chain;},eq(k,v){query.filters.push([k,v]);return chain;},async maybeSingle(){return {data:row,error:null};}};
      return chain;
    }};
    const strings={stringOr:(v,f)=>typeof v==='string'&&v.length?v:f,stringOrNull:v=>typeof v==='string'&&v.length?v:null};
    const resolve=vm.runInNewContext(`(() => {${extract('function xtreamPlaybackContainer(', '\nfunction mergeCodecProfileAnnotations(')};${extract('async function resolvePlaybackTarget(', '\n// Series have no directly-playable')};return resolvePlaybackTarget;})()`, {
      ...strings,recordOrEmpty,
      isM3uEpisodeId:()=>false,mediaReadFromCatalog:()=>false,
      resolveObservedVodContainer:async()=>({container:'ts'}),
      resolveOwnedSelectionEpisode:async()=>null,isDiscoverySourceId:async()=>false,
      loadSourceConfig:async(source,owner)=>{assert.equal(source,'source');assert.equal(owner,'owner');return {serverUrl:'https://provider.example',username:'synthetic',password:'synthetic'};},
      xtreamStreamUrl:c=>`${c.serverUrl}/${c.streamType}/${c.streamId}.${c.container}`,
      mergePlaybackHints:(a,b)=>({...a,...b}),compactRecord:v=>v,
      firstUsefulCodecProfile:()=>({}),normalizeMkvH264FastStartProof:()=>null,
      hasReliableVodCodecProfile:()=>false,hasUsefulCodecProfile:()=>false,
      playbackHintForObservedContainer:(v,container)=>({...v,container}),
      HttpError:class extends Error {},
    });
    const result=await resolve('source','series','123','owner',db,{container:'mp4'});
    assert.equal(result.targetUrl,'https://provider.example/series/123.mp4');
    assert.equal(result.containerObservation.container,'ts');
    assert.equal(route(result,'series','relay',{}),true);
    assert.equal(queries.length,1);
    assert.equal(queries[0].table,'cloud_catalog_visible_media_items');
    assert.deepEqual(queries[0].filters,[['source_id','source'],['user_id','owner'],['item_type','series'],['external_id','123']]);
  }
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const esbuild=require('esbuild');
const access=fs.readFileSync(require.resolve('../supabase/functions/norva-provider-access/index.ts'),'utf8');
const projection=fs.readFileSync(require.resolve('../supabase/functions/_shared/vod-title-projection.ts'),'utf8');
const shared=projection.slice(projection.indexOf('export function compatibilitySeed('),projection.indexOf('\nfunction variantLabel(')).replaceAll('export function','function');
const active=access.slice(access.indexOf('function activeTitleVariants('),access.indexOf('\nfunction activeTitleConfirmations('));
const code=esbuild.transformSync(`${shared}\n${active}\nglobalThis.build=activeTitleVariants`,{loader:'ts',format:'iife'}).code;
function build(container,title,metadata={}){
 const context={recordOrEmpty:v=>v&&typeof v==='object'?v:{},rpcObject:v=>v||{},
  activeMediaIdMap:()=>new Map([['movie:1','media']]),arrayRecordField:(v,k)=>v[k],nullableString:v=>v?String(v):null,
  normalizedTitleIdentity:()=> 'fixture',activeVersionInfo:()=>({}),compactActiveRecord:v=>v,WorkerFault:Error};
 vm.runInNewContext(code,context);
 return context.build([{item_type:'movie',external_id:'1',title,metadata,playback_hint:{container}}],{},
 {titles:[{identityKey:'norm:fixture',titleId:'title'}]})[0];
}
test('credential refresh uses the ordinary import ranking for MP4, MKV and HEVC',()=>{
 for(const [container,title,tier,cost] of [['mp4','Film','direct',100],['mkv','Film','remux',250],['mkv','Film HEVC','video_transcode',650],['ts','Film','unknown',500]]){
  const row=build(container,title);assert.equal(row.compatibility_tier,tier);assert.equal(row.playback_cost_score,cost);
 }
});
test('fresh supplied codec evidence outranks the container hint',()=>{
 const row=build('mp4','Film',{codecProfile:{videoCodec:'hevc',audioCodec:'aac'}});
 assert.equal(row.compatibility_tier,'video_transcode');assert.equal(row.codec_profile.videoCodec,'hevc');
});
test('observed startup score is retained only when present in the refreshed data',()=>{
 const row=build('mp4','Film',{lastObservedTtffMs:2500});
 assert.equal(row.last_observed_ttff_ms,2500);assert.equal(row.playback_cost_score,250);
 assert.equal(build('mp4','Film').last_observed_ttff_ms,null);
});

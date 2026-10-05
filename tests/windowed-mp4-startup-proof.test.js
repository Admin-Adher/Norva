'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { retainedVodStartupPolicy } = require('../services/media-gateway/src/finite-vod-startup');
const source = fs.readFileSync(require('node:path').join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
const start = source.indexOf('        if (!session.retainedVodStartupFormat && (windowedMp4Transport');
const end = source.indexOf('        applyVaapiVodStartupReadiness(session);',start);
assert.ok(start>0 && end>start);
async function prepare({ admitted=true, format='mp4', mode='copy', multi=false, subs=false, failure=false }={}) {
 const session={};let calls=0;
 const run=vm.runInNewContext(`async()=>{${source.slice(start,end)}}`,{
  session,windowedMp4Transport:admitted,privateResumeHlsBindingForSession:()=>false,
  privateResumeFormat:()=>format,sessionRequestAbortController:new AbortController(),
  prepareFiniteMkvSeekBroker:async()=>{calls++;if(failure)throw Error('identity changed');},
  videoModeForSession:()=>mode,multiAudioHlsEnabled:()=>multi,exactSubtitleHlsEnabled:()=>subs,
 });
 try{await run();}catch(error){assert.equal(error.message,'identity changed');}
 return {session,calls};
}
test('the actual admitted windowed MP4 path opts into output verification only after its broker is prepared',async()=>{
 const r=await prepare();assert.equal(r.calls,1);assert.equal(r.session.finiteVodOutputStartupFormat,'mp4');
 for(const options of [{admitted:false},{format:'mkv'},{mode:'encode'},{multi:true},{subs:true},{failure:true}]) {
  assert.equal((await prepare(options)).session.finiteVodOutputStartupFormat,undefined);
 }
});
test('MP4 admission alone never grants a shorter buffer; exact decoded segments and sustained rate remain necessary',async()=>{
 const {session}=await prepare();
 assert.equal(retainedVodStartupPolicy(session,'audio-transcode').eligible,false);
 session.startupTimings={playlistBufferSeconds:21,playlistPostFirstBufferSeconds:10,sustainedMediaProductionRateX:2.5};
 assert.equal(retainedVodStartupPolicy(session,'audio-transcode').eligible,false);
 session.finiteTsStartupEvidence={verified:true,segmentCount:2,maxSegmentSeconds:10.5};
 const p=retainedVodStartupPolicy(session,'audio-transcode');assert.equal(p.eligible,true);assert.equal(p.targetBufferSeconds,12);
 for(const proof of [{verified:false,segmentCount:2,maxSegmentSeconds:10.5},{verified:true,segmentCount:1,maxSegmentSeconds:10.5},{verified:true,segmentCount:2,maxSegmentSeconds:13}]) {
  assert.equal(retainedVodStartupPolicy({...session,finiteTsStartupEvidence:proof},'audio-transcode').eligible,false);
 }
 assert.equal(retainedVodStartupPolicy({...session,startupTimings:{...session.startupTimings,sustainedMediaProductionRateX:1}},'audio-transcode').eligible,false);
});

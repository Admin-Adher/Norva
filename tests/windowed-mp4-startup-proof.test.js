'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { retainedVodStartupPolicy } = require('../services/media-gateway/src/finite-vod-startup');
const source = fs.readFileSync(require('node:path').join(__dirname,'../services/media-gateway/src/index.js'),'utf8');
const bitstreamStart=source.indexOf('function finiteMp4CopyVideoBitstreamArgs(session) {');
const bitstreamEnd=source.indexOf('function videoModeForSession(session) {',bitstreamStart);
const bitstreamArgs=vm.runInNewContext(`(${source.slice(bitstreamStart,bitstreamEnd)})`,{
 asRecord:value=>value||{},normalizeCodecToken:value=>String(value||'').toLowerCase(),
 videoModeForSession:session=>session.videoMode||'copy',
});
test('only admitted finite H264 MP4 copy receives demuxer headers before TS packet payloads',()=>{
 const session={finiteMp4SeekBroker:true,codecProfile:{videoCodec:'h264'}};
 assert.deepEqual(Array.from(bitstreamArgs(session)),['-bsf:v','h264_mp4toannexb,dump_extra=freq=all']);
 for(const change of [{finiteMp4SeekBroker:false},{videoMode:'encode'},{codecProfile:{videoCodec:'hevc'}},{codecProfile:{}}])
  assert.deepEqual(Array.from(bitstreamArgs({...session,...change})),[]);
 assert.match(source,/'-c:v', 'copy',\s*\.\.\.finiteMp4CopyVideoBitstreamArgs\(session\)/);
});
const start = source.indexOf('        if (!session.retainedVodStartupFormat && (windowedMp4Transport');
const end = source.indexOf('        applyVaapiVodStartupReadiness(session);',start);
assert.ok(start>0 && end>start);
async function prepare({ admitted=true, format='mp4', mode='copy', multi=false, subs=false, failure=false }={}) {
 const session={};let calls=0;
 const run=vm.runInNewContext(`async()=>{${source.slice(start,end)}}`,{
  applyFiniteMp4AccurateResume:()=>false,session,windowedMp4Transport:admitted,privateResumeHlsBindingForSession:()=>false,
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

const alignmentStart=source.indexOf('function applyFiniteMp4AccurateResume(session) {');
const alignmentEnd=source.indexOf('function applyVaapiVodStartupReadiness(session) {',alignmentStart);
function align(session, {known=true, format='mp4', multi=false, subs=false, ready=true, backend='vaapi'}={}) {
 return vm.runInNewContext(`(${source.slice(alignmentStart,alignmentEnd)})`,{
  asRecord:v=>v||{},knownVodInputProbeEligible:()=>known,privateResumeFormat:()=>format,
  multiAudioHlsEnabled:()=>multi,exactSubtitleHlsEnabled:()=>subs,
  VIDEO_ENCODER_CONFIG:{backend},VIDEO_ENCODER_PREFLIGHT:{ready},
 })(session);
}
test('indexed MP4 resumes encode both streams at the exact requested boundary under existing encoder admission',()=>{
 const base={finiteMp4SeekBroker:true,seekOffset:60.143,codecProfile:{videoWidth:720,videoHeight:480}};
 const session=structuredClone(base);assert.equal(align(session),true);
 assert.equal(session.videoMode,'encode');assert.equal(session.finiteMp4ResumeAligned,true);
 assert.equal(session.seekOffset,60.143);
 for(const options of [{known:false},{format:'mkv'},{multi:true},{subs:true},{ready:false},{backend:'software'}]) {
  const rejected=structuredClone(base);assert.equal(align(rejected,options),false);assert.equal(rejected.videoMode,undefined);
 }
 for(const change of [{seekOffset:0},{finiteMp4SeekBroker:false},{codecProfile:{videoWidth:3840,videoHeight:2160}}])
  assert.equal(align({...base,...change}),false);
 const seekStart=source.indexOf('function seekArgsForSession('),seekEnd=source.indexOf('\nfunction ',seekStart+1);
 const seek=vm.runInNewContext(`(${source.slice(seekStart,seekEnd)})`,{
  isFiniteMkvVodSession:()=>false,usesFiniteMkvSeekBroker:()=>true,exactSubtitleHlsEnabled:()=>false,
 });
 assert.deepEqual(JSON.parse(JSON.stringify(seek(session,true))),{preInputSeek:['-ss','60.143'],postInputSeek:[]});
 const audioStart=source.indexOf('function shouldCopyAudio(session) {'),audioEnd=source.indexOf('\nfunction ',audioStart+1);
 const audio=vm.runInNewContext(`(${source.slice(audioStart,audioEnd)})`,{});
 assert.equal(audio(session),false);
});

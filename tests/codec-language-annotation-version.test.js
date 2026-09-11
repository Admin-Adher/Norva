'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const {createHash}=require('node:crypto');
const edge=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
function slice(a,b){const start=edge.indexOf(a),end=edge.indexOf(b,start+1);assert.ok(start>=0&&end>start);return edge.slice(start,end);}
const code=stripTypeScriptTypes(slice('async function languageValidationProfileFingerprint(','\nasync function runLanguageValidationRetryWorker(')
 +'\n'+slice('function mergeCodecProfileAnnotations(','\nfunction normalizeMkvH264FastStartProof(')
 +'\n'+slice('function hasUsefulCodecProfile(','\nfunction hasReliableVodCodecProfile('));
const context={LANGUAGE_VALIDATION_PROTOCOL:2,Date,
  recordOrEmpty:v=>v&&typeof v==='object'?v:{}, normalizeCodecProfile:v=>v,
  normalizeCodecToken:v=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,''),
  stringOr:(v,f)=>typeof v==='string'?v:f,stringOrNull:v=>typeof v==='string'&&v?v:null,
  boundedNullableInt:v=>v==null?null:Number(v),compactRecord:v=>Object.fromEntries(Object.entries(v).filter(([,x])=>x!=null)),
  normalizeMkvH264FastStartProof:v=>v||null,
  sha256Hex:async value=>createHash('sha256').update(value).digest('hex')};
const api=vm.runInNewContext(code+';({mergeCodecProfileAnnotations,languageValidationProfileFingerprint});',context);
const profile=()=>({metadataComplete:true,probeSource:'gateway_probe',probedAt:'2026-09-10T20:00:00Z',
  container:'matroska',durationSeconds:600,fileSizeBytes:40000000,audioTracks:[{index:1,codec:'aac',channels:2,default:true}],
  subtitles:[{index:3,codec:'subrip'}],videoCodec:'h264',audioCodec:'aac'});
test('subtitle inference stays available for the very same file observation',()=>{
  const old=profile();old.subtitles[0].inferredLanguage='fr';
  assert.equal(api.mergeCodecProfileAnnotations(old,profile()).subtitles[0].inferredLanguage,'fr');
});
test('same subtitle index cannot carry an old inferred language across a changed file',()=>{
  for(const delta of [{probedAt:'2026-09-10T21:00:00Z'},{fileSizeBytes:41000000},{durationSeconds:601},
    {audioTracks:[{index:1,codec:'ac3',channels:6,default:true}]},{container:'mp4'}]){
    const old=profile();old.subtitles[0].inferredLanguage='fr';
    const next={...profile(),...delta};
    assert.equal(api.mergeCodecProfileAnnotations(old,next).subtitles[0].inferredLanguage,undefined);
  }
});
test('refactored serializer keeps the existing strict profile fingerprint byte-for-byte',async()=>{
  const p=profile();
  const priorPayload=JSON.stringify({protocol:2,metadataComplete:true,probeSource:'gatewayprobe',
    probedAt:p.probedAt,container:'matroska',durationSeconds:600,fileSizeBytes:40000000,audioTracks:p.audioTracks});
  assert.equal(await api.languageValidationProfileFingerprint(p,p.audioTracks,p.fileSizeBytes),
    createHash('sha256').update(priorPayload).digest('hex'));
});

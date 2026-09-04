const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createStrictLidInference } = require('../services/media-gateway/src/strict-lid-inference');
const { buildWhisperBatchArgs } = require('../services/media-gateway/src/strict-lid-batch');
const good = { ok: true, samples: [{ text: 'sample', lang: 'en', prob: .99 }] };
test('strict accelerator keeps Whisper auto language and full transcripts', () => {
 const args=buildWhisperBatchArgs({model:'small',wavPaths:['one'],outputPrefixes:['out'],threads:2,vadModel:'vad'});
 assert.ok(args.includes('-otxt')); assert.ok(args.includes('auto'));
 assert.ok(args.includes('--vad')); assert.ok(!args.includes('--detect-language'));
});
test('healthy VAD returns untouched evidence without a second inference', async () => {
 let calls=0; const engine=createStrictLidInference();
 assert.deepEqual(await engine.run({vadModel:'vad',timeoutMs:1000},async()=>{calls++;return good;}),good);
 assert.equal(calls,1); assert.equal(engine.health().expiryRequired,false);
});
test('VAD failure falls back once on same WAV within total deadline and opens circuit', async () => {
 let time=1000; const engine=createStrictLidInference({now:()=>time}); const calls=[];
 const options={vadModel:'vad',timeoutMs:1000,wavPaths:['same']};
 const result=await engine.run(options,async args=>{calls.push(args);time+=100;return args.vadModel?{ok:false}:good;});
 assert.deepEqual(result,good); assert.equal(calls.length,2);
 assert.equal(calls[0].timeoutMs,1000); assert.equal(calls[1].timeoutMs,900);
 assert.equal(calls[1].wavPaths,options.wavPaths); assert.equal(calls[1].vadModel,null);
 assert.equal(engine.health().circuitOpen,true);
 await engine.run(options,async args=>{assert.equal(args.vadModel,null);return good;});
 time+=300001;await engine.run(options,async args=>{assert.equal(args.vadModel,'vad');return good;});
 assert.equal(engine.health().circuitOpen,false);
});
test('viewer preemption or abort never starts fallback nor returns cached evidence', async () => {
 for(const key of ['aborted','preempted']){
  let count=0;const engine=createStrictLidInference();
  const result=await engine.run({vadModel:'vad',timeoutMs:1000},async()=>{count++;return {...good,[key]:true};});
  assert.equal(result.ok,false); assert.equal(result[key],true);assert.equal(count,1);
 }
 const controller=new AbortController();controller.abort();
 await createStrictLidInference().run({abortSignal:controller.signal},async()=>assert.fail('must not spawn'));
});
test('exceptions fall back, failed baseline never fabricates a verdict, budget cannot reset',async()=>{
 let time=100;const engine=createStrictLidInference({now:()=>time});let calls=0;
 const result=await engine.run({vadModel:'vad',timeoutMs:50},async()=>{calls++;time+=60;throw Error('private');});
 assert.equal(result.ok,false);assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('private'));
 const failed=await createStrictLidInference().run({timeoutMs:1000},async()=>({ok:false,samples:[]}));
 assert.equal(failed.ok,false);
});
test('supervision distinguishes permanent readiness, engine outage, VAD fallback and stalled jobs',async()=>{
 const {strictLidHealth}=await import('../supabase/functions/_shared/strict-lid-health.mjs');
 const db={contract:'strict-lid-runtime:v1',audioEnabled:true,legacyEnabled:false,workerHealthy:true,staleJobs:0,activeJobs:1};
 const gw={ok:true,languageDetectEngine:{runtimeVerified:true},strictLidProviderDrainProtocol:1,
  strictLidWindowCheckpointProtocol:1,strictLidTranscriptDiversityProtocol:1,strictLidInference:{protocol:1}};
 assert.equal(strictLidHealth(db,gw).state,'ready'); assert.equal(strictLidHealth(db,gw).expiryRequired,false);
 assert.ok(strictLidHealth(db,null).reasons.includes('strict-engine-unavailable'));
 assert.ok(strictLidHealth({...db,staleJobs:1},gw).reasons.includes('validation-jobs-stalled'));
 assert.ok(strictLidHealth(db,{...gw,strictLidInference:{protocol:1,circuitOpen:true}}).reasons.includes('vad-degraded-full-whisper-active'));
 assert.equal(strictLidHealth(null,gw).state,'degraded');
 assert.ok(!JSON.stringify(strictLidHealth({...db,secret:'private'},gw)).includes('private'));
});
test('retirement keeps strict publication and audio enabled; rollback cannot revive old canary',()=>{
 const sql=fs.readFileSync('supabase/migrations/20260904211500_strict_lid_permanent_supervision.sql','utf8');
 assert.ok(sql.includes('strict-multi-window-required'));assert.ok(sql.includes('reject_retired_lid_flags'));
 assert.ok(!sql.includes('delete from'));assert.ok(!sql.includes('set expires_at'));
 assert.ok(sql.includes('lease_expires_at<now()'));
});

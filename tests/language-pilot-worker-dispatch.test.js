'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-playback/index.ts'),'utf8');
const start=source.indexOf('async function runLanguageValidationRetryWorker(');
const end=source.indexOf('async function revalidateLanguageValidationClaim(',start);
class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
function fixture(authorized=true) {
  const calls=[],scheduled=[];
  const db={rpc:async(name,args)=>{calls.push(name);return {data:name==='norva_verify_cron_secret'?authorized:[{job_id:ids[0]}]};}};
  const context=vm.createContext({HttpError,LANGUAGE_VALIDATION_RETRY_WORKER_BATCH:2,LANGUAGE_VALIDATION_RETRY_WORKER_PROTOCOL:1,
    PLAYBACK_SESSION_UUID_PATTERN:/^[a-f0-9-]{36}$/,recordOrEmpty:v=>v||{},stringOr:(v,d)=>typeof v==='string'?v:d,
    throwDb:()=>{throw Error('unexpected DB error');},requireLanguageValidationWaitUntil:()=>()=>{},
    scheduleLanguageValidationJob:(_wait,_db,id)=>{scheduled.push(id);return true;}});
  vm.runInContext(stripTypeScriptTypes(source.slice(start,end)),context);
  return {calls,scheduled,run:body=>context.runLanguageValidationRetryWorker(new Request('https://fixture.invalid',{
    method:'POST',headers:{authorization:'Bearer not-a-real-secret'},body:typeof body==='string'?body:JSON.stringify(body)}),db)};
}
test('authorized pilot dispatcher schedules exactly the named jobs without scanning or rewriting other jobs',async()=>{
  const f=fixture();const result=await f.run({jobIds:ids});
  assert.equal(result.scheduled,2);assert.deepEqual(f.scheduled,ids);assert.deepEqual(f.calls,['norva_verify_cron_secret']);
  const none=fixture();await none.run({jobIds:[]});assert.deepEqual(none.scheduled,[]);
});
test('ordinary cron dispatch remains due-queue based; invalid pilot lists and unauthenticated requests cannot schedule',async()=>{
  const normal=fixture();await normal.run({});assert.deepEqual(normal.calls,['norva_verify_cron_secret','list_due_catalog_file_audio_validation_jobs']);
  for(const body of [{jobIds:[...ids,ids[0]]},{jobIds:[ids[0],ids[0]]},{jobIds:['bad']},{jobIds:ids,force:true},'{',' '.repeat(2049)]) {
    const f=fixture();await assert.rejects(f.run(body),e=>e.status===400);assert.deepEqual(f.scheduled,[]);
  }
  const denied=fixture(false);await assert.rejects(denied.run({jobIds:ids}),e=>e.status===403);assert.deepEqual(denied.scheduled,[]);
});

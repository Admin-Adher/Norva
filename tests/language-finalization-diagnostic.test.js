'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(require('node:path').join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const fragment = source.slice(source.indexOf('async function finalizeLanguageValidationJob('), source.indexOf('async function failLanguageValidationJob('));
function harness() {
  const logs = [];
  class HttpError extends Error { constructor(status, message, details) { super(message); this.status=status; this.details=details; } }
  const context = vm.createContext({ console: {warn: (...args) => logs.push(args)}, HttpError,
    recordOrEmpty: value => value && typeof value === 'object' ? value : {}, stringOr: (value, fallback) => typeof value === 'string' ? value : fallback });
  vm.runInContext(transformSync(fragment, { loader: 'ts', target: 'es2022' }).code, context);
  return { context, logs };
}
const current = { fingerprint: 'private-fingerprint', exactProfile: {profileProbedAt: 'private-date', fileSizeBytes:123}, expectedAudioIndices:[1] };
test('RPC failure logs only its allowlisted code and timing, retaining the existing failure contract', async () => {
  const {context,logs}=harness(); const calls=[];
  const db={rpc:async (...args)=>{calls.push(args);return {data:null,error:{code:'57014',message:'private-provider-url',details:'private-owner',hint:'private-token'}};}};
  await assert.rejects(context.finalizeLanguageValidationJob(db,'private-job','private-lease',{profileFingerprint:current.fingerprint},current), e=>e.status===409 && e.details.code==='LANGUAGE_VALIDATION_FINALIZE_FAILED');
  assert.equal(calls.length,1); assert.equal(calls[0][0],'finalize_catalog_file_audio_validation_job');
  assert.equal(logs.length,1); assert.equal(logs[0][0],'[norva-playback:language-finalization]');
  assert.deepEqual(Object.keys(logs[0][1]).sort(),['code','elapsedMs','outcome']);
  assert.equal(logs[0][1].code,'57014'); assert.equal(logs[0][1].outcome,'rpc_error');
  assert.ok(logs[0][1].elapsedMs>=0); assert.doesNotMatch(JSON.stringify(logs),/private/);
});
test('empty RPC result is distinct from an SQL error and is not accepted as success', async()=>{
  const {context,logs}=harness();
  await assert.rejects(context.finalizeLanguageValidationJob({rpc:async()=>({data:null,error:null})},'job','lease',{},current),e=>e.details.code==='LANGUAGE_VALIDATION_FINALIZE_FAILED');
  assert.equal(logs[0][1].outcome,'empty_result'); assert.equal(logs[0][1].code,null);
});
test('successful finalization remains silent and fingerprint validation remains enforced',async()=>{
  const {context,logs}=harness(); const db={rpc:async()=>({data:{verifiedAt:'date'},error:null})};
  await context.finalizeLanguageValidationJob(db,'job','lease',{profileFingerprint:current.fingerprint},current);
  await assert.rejects(context.finalizeLanguageValidationJob(db,'job','lease',{profileFingerprint:'changed'},current),e=>e.details.code==='LANGUAGE_VALIDATION_PROFILE_CHANGED');
  assert.equal(logs.length,0);
});
test('unexpected codes and invalid timing cannot expose arbitrary error fields',()=>{
  const {context}=harness();
  for(const code of ['private-token','ZZ999','https://private.invalid/media',null,{},57014]) {
    const result=context.languageFinalizationDiagnostic({code,message:'private-message'},Infinity);
    assert.equal(result.code,null); assert.equal(result.elapsedMs,null); assert.doesNotMatch(JSON.stringify(result),/private/);
  }
  assert.equal(context.languageFinalizationDiagnostic({code:'PT409'},-3).elapsedMs,0);
  assert.equal(context.languageFinalizationDiagnostic({code:'PGRST202'},2.3).code,'PGRST202');
});

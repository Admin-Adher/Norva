'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const {transformSync}=require('esbuild');
const source=fs.readFileSync(path.join(__dirname,'../supabase/functions/norva-source-sync/index.ts'),'utf8');
const start=source.indexOf('async function deferEnrichmentFleetAccessGuard(');
const end=source.indexOf('async function runEnrichmentFleetClaim(',start);
assert.ok(start>=0&&end>start);
const code=transformSync(source.slice(start,end),{loader:'ts',target:'es2022'}).code;
function harness(visibility,finishFailure=false){
  const calls=[];
  const defer=vm.runInNewContext(code+'\ndeferEnrichmentFleetAccessGuard',{
    sourceCatalogVisible:async(...args)=>{calls.push(['visibility',...args]);if(visibility instanceof Error)throw visibility;return visibility;},
    finishEnrichmentFleetClaim:async(...args)=>{calls.push(['finish',...args]);if(finishFailure)throw Error('database unavailable');},
  });
  return {defer,calls};
}
for(const release of [false,true]){
  test(`visible source epoch drift retries in one minute; release remains ${release}`,async()=>{
    const {defer,calls}=harness(true);const db={};const claim={source_id:'source',user_id:'owner'};
    await defer(db,claim,release);
    assert.deepEqual(calls[0],['visibility','source','owner',db]);
    assert.equal(calls[1][3],true);assert.equal(calls[1][4],60);
    assert.equal(calls[1][5].skipped,'source_catalog_changed');assert.equal(calls[1][6],release);
  });
  test(`confirmed hidden source retains daily delay; release remains ${release}`,async()=>{
    const {defer,calls}=harness(false);await defer({}, {}, release);
    assert.equal(calls[1][3],true);assert.equal(calls[1][4],86400);
    assert.equal(calls[1][5].skipped,'source_not_catalog_visible');assert.equal(calls[1][6],release);
  });
  test(`visibility outage fails closed without classifying source hidden; release remains ${release}`,async()=>{
    const {defer,calls}=harness(Error('private transport detail'));await defer({}, {}, release);
    assert.equal(calls[1][3],false);assert.equal(calls[1][4],300);
    assert.equal(calls[1][5].errorCode,'CATALOG_VISIBILITY_UNAVAILABLE');assert.equal(calls[1][6],release);
    assert.ok(!JSON.stringify(calls).includes('private transport detail'));
  });
}
test('claim completion failure propagates instead of claiming successful recovery',async()=>{
  const {defer}=harness(true,true);await assert.rejects(defer({}, {}, false),/database unavailable/);
});
test('both stale-guard exits use current visibility and preserve remote-work lease evidence',()=>{
  const dispatcher=source.slice(end,source.indexOf('// Claim a bounded, fair batch',end));
  assert.equal(dispatcher.match(/await deferEnrichmentFleetAccessGuard\(db, claim, localLane \|\| responseReceived\)/g)?.length,2);
  assert.match(dispatcher,/if \(!\(await sourceCatalogVisible[\s\S]*24 \* 60 \* 60/);
});

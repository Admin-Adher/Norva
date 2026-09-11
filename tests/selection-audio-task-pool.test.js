const test=require('node:test');
const assert=require('node:assert/strict');
const lib=import('../ops/hetzner/services/selection-audio-task-pool.mjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const job=n=>({id:`job-${n}`,external_id:`file-${n}`});

test('two owned jobs can overlap, refill promptly and drain without detaching provider work',async()=>{
  const {createSelectionAudioTaskPool}=await lib;const pool=createSelectionAudioTaskPool({maximum:2});
  const gates=[deferred(),deferred(),deferred()];const seen=[];let claimed=0;
  const args={limit:2,claim:async()=>job(claimed++),process:async j=>{const n=Number(j.id.slice(4));seen.push(n);await gates[n].promise;}};
  assert.equal(await pool.fill(args),2);assert.equal(pool.size(),2);assert.equal(await pool.fill(args),0);assert.equal(claimed,2);
  gates[1].resolve();await pool.progress();assert.equal(pool.size(),1);
  assert.equal(await pool.fill(args),1);assert.equal(claimed,3);assert.deepEqual(seen,[0,1,2]);
  gates[0].resolve();gates[2].resolve();await pool.drain();assert.equal(pool.size(),0);
});
test('default stays at one; aborted, overlapping and fast polls remain bounded',async()=>{
  const {createSelectionAudioTaskPool}=await lib;const pool=createSelectionAudioTaskPool();const pending=deferred();let claims=0;
  const args={claim:async()=>{claims++;await pending.promise;return job(1);},process:async()=>{}};
  const first=pool.fill(args);assert.equal(await pool.fill(args),0);assert.equal(claims,1);pending.resolve();assert.equal(await first,1);await pool.drain();
  const controller=new AbortController();controller.abort();assert.equal(await pool.fill({...args,signal:controller.signal}),0);assert.equal(claims,1);
  const fast=createSelectionAudioTaskPool({maximum:2});claims=0;
  assert.equal(await fast.fill({limit:2,claim:async()=>job(claims++),process:async()=>{}}),2);await fast.drain();assert.equal(claims,2);
  assert.throws(()=>createSelectionAudioTaskPool({maximum:3}));
});
test('one task failure does not cancel another or reset a lease; all completions stay attached',async()=>{
  const {createSelectionAudioTaskPool}=await lib;let errors=0;let claims=0;const gate=deferred();
  const pool=createSelectionAudioTaskPool({maximum:2,onError:()=>{errors++;}});
  await pool.fill({limit:2,claim:async()=>job(claims++),process:async j=>{if(j.id==='job-0') throw Error('synthetic');await gate.promise;}});
  await pool.progress();assert.equal(errors,1);assert.equal(pool.size(),1);gate.resolve();await pool.drain();assert.equal(errors,1);
});

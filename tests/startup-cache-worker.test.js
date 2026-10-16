const test = require('node:test'), assert = require('node:assert/strict');
const target = { userId: '00000000-0000-4000-8000-000000000001', sourceId: '00000000-0000-4000-8000-000000000002', itemType: 'movie', itemId: '1' };
const load = () => import('../ops/hetzner/media/startup-cache-worker.mjs');
test('startup worker accepts only a bounded private catalogue queue', async () => {
  const { startupTargets } = await load();
  assert.deepEqual(startupTargets([target]), [target]);
  for (const input of [[], Array(9).fill(target), [{ ...target, sourceUrl: 'secret' }], [{ ...target, itemType: 'live' }]])
    assert.throws(() => startupTargets(input));
});

test('global worker claims coordinates and acknowledges only positively drained preparations',async()=>{
 const {runGlobalStartupCycle}=await load(),leaseId='00000000-0000-4000-8000-000000000003',calls=[];
 const fetchImpl=async(url,req)=>{const b=JSON.parse(req.body);calls.push([new URL(url).pathname,b]);
  return {ok:true,json:async()=>new URL(url).pathname.endsWith('prepare')
   ?{protocol:1,prepared:true,providerDrained:true,refreshAfterSeconds:300}
   :b.action==='claim'?{protocol:1,enabled:true,job:{leaseId,target}}:{protocol:1,acknowledged:true}};};
 assert.equal(await runGlobalStartupCycle({endpoint:'https://edge.invalid/startup-cache/prepare',token:'private',fetchImpl}),true);
 assert.deepEqual(calls.map(([url])=>url),['/startup-cache/queue','/startup-cache/prepare','/startup-cache/queue']);
 assert.deepEqual(calls[1][1],target);assert.equal(calls[2][1].leaseId,leaseId);assert.equal(calls[2][1].providerDrained,true);
});

test('global worker stops without acknowledgment after unknown transport or missing drain evidence',async()=>{
 const {runGlobalStartupCycle}=await load();
 for(const transport of [false,true]){
  const actions=[];
  const fetchImpl=async(url,req)=>{const b=JSON.parse(req.body);actions.push(b.action || 'prepare');
   if(new URL(url).pathname.endsWith('prepare')){if(transport)throw Error('uncertain');return {ok:true,json:async()=>({protocol:1,prepared:true})};}
   return {ok:true,json:async()=>({protocol:1,enabled:true,job:{leaseId:'00000000-0000-4000-8000-000000000003',target}})};};
  assert.equal(await runGlobalStartupCycle({endpoint:'https://edge.invalid/startup-cache/prepare',token:'private',fetchImpl}),false);
  assert.deepEqual(actions,['claim','prepare']);
 }
});

test('global worker rejects provider URLs and honors disabled enrollment and shutdown',async()=>{
 const {runGlobalStartupCycle}=await load();let calls=0;
 const args={endpoint:'https://edge.invalid/startup-cache/prepare',token:'private',fetchImpl:async()=>{
  calls++;return {ok:true,json:async()=>({protocol:1,enabled:true,job:{leaseId:'00000000-0000-4000-8000-000000000003',target:{...target,sourceUrl:'secret'}}})};}};
 assert.equal(await runGlobalStartupCycle(args),false);assert.equal(calls,1);
 assert.equal(await runGlobalStartupCycle({...args,stopping:()=>true}),true);assert.equal(calls,1);
 assert.equal(await runGlobalStartupCycle({...args,fetchImpl:async()=>({ok:true,json:async()=>({protocol:1,enabled:false,job:null})})}),true);
});
test('worker serializes files, skips fresh entries and never logs provider text', async () => {
  const { runStartupCycle } = await load(); let active = 0, maximum = 0; const results = [];
  assert.equal(await runStartupCycle({ targets: [target, { ...target, itemId: '2' }, { ...target, itemId: '3' }],
    endpoint: 'https://edge.invalid/startup-cache/prepare', token: 'private', eligible: i => i !== 1,
    fetchImpl: async () => { maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 2)); active--;
      return { ok: true, json: async () => ({ protocol: 1, prepared: true, refreshAfterSeconds: 99999, reason: 'credentials' }) }; },
    onResult: (i,r) => results.push([i,r]) }), true);
  assert.equal(maximum, 1); assert.deepEqual(results.map(x => x[0]), [0,2]);
  assert.equal(results[0][1].refreshAfterSeconds, 300); assert.doesNotMatch(JSON.stringify(results), /credentials|private/);
});
test('uncertain service response stops the worker cycle before another account acquisition', async () => {
  const { runStartupCycle } = await load(); let calls = 0;
  assert.equal(await runStartupCycle({ targets: [target, target], endpoint: 'https://edge.invalid/startup-cache/prepare', token: 'private',
    fetchImpl: async () => { calls++; throw Error('provider credentials'); } }), false);
  assert.equal(calls, 1);
});

test('worker preserves only fixed deferral reasons, including profile recovery, without arbitrary server text', async () => {
  const { runStartupCycle } = await load();
  for (const reason of ['exact-file-evidence-unavailable', 'profile-refreshed', 'profile-refresh-deferred',
    'account-presence', 'viewer-active', 'provider credentials or URL']) {
    let observed;
    await runStartupCycle({ targets: [target], endpoint: 'https://edge.invalid/startup-cache/prepare', token: 'private',
      fetchImpl: async () => ({ ok: true, json: async () => ({ protocol: 1, prepared: false, reason }) }),
      onResult: (_i,r) => { observed = r; } });
    assert.equal(observed.reason, reason.includes('credentials') ? 'deferred' : reason);
    assert.equal(observed.prepared, false);
  }
});

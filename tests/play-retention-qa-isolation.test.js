const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../supabase/functions/_shared/play-retention-qa.mjs');
const owner='00000000-0000-4000-8000-000000000902';
const now=Date.parse('2026-10-01T18:00:00Z');
const config={mode:'isolated-google-play-retention',userId:owner,runId:'00000000-0000-4000-8000-000000000903',
  url:'http://norva-play-retention-qa-rest:3000',key:'x'.repeat(40),createdAt:'2026-10-01T17:00:00Z',expiresAt:'2026-10-01T20:00:00Z'};
test('isolated Play QA requires one exact owner, fixed private endpoint and bounded expiry',async()=>{
  const {validPlayQaConfig}=await modulePromise;
  assert.equal(validPlayQaConfig(config,owner,now),true);
  for(const patch of [{mode:'production'},{userId:'other'},{url:'https://api.norva.tv'},{key:''},{runId:'x'},
    {expiresAt:'2026-10-01T18:00:00Z'},{expiresAt:'2026-10-02T17:00:00Z'},{createdAt:'2026-10-01T19:00:00Z'}])
    assert.equal(validPlayQaConfig({...config,...patch},owner,now),false);
});
test('missing or unrelated configuration never creates a QA client',async()=>{
  const {playQaContext}=await modulePromise; const create=()=>{throw Error('must not connect');};
  assert.equal(await playQaContext(owner,create,{read:async()=>{throw Object.assign(Error(),{name:'NotFound'});}}),null);
  assert.equal(await playQaContext('another-owner',create,{read:async()=>JSON.stringify(config),now:()=>now}),null);
});
test('QA cannot connect to production or use an unattested database',async()=>{
  const {playQaContext}=await modulePromise;
  for(const data of [null,{}, {runId:config.runId,userId:owner,environment:'PRODUCTION'},
    {runId:config.runId,userId:owner,environment:'SANDBOX',productionWrites:true,expiresAt:config.expiresAt}]) {
    await assert.rejects(playQaContext(owner,()=>({rpc:async()=>({data})}),
      {read:async()=>JSON.stringify(config),now:()=>now}),/identity_rejected/);
  }
});

test('unreadable or malformed QA configuration fails closed',async()=>{
  const {playQaContext}=await modulePromise;
  const create=()=>{throw Error('must not connect');};
  await assert.rejects(playQaContext(owner,create,{read:async()=>'{'}),/configuration_unavailable/);
  await assert.rejects(playQaContext(owner,create,{read:async()=>{throw Error('denied');}}),/configuration_unavailable/);
});
test('attested QA rewrites only its private REST path and refuses redirects',async()=>{
  const {playQaContext}=await modulePromise; let opts,received;
  const db={rpc:async()=>({data:{runId:config.runId,userId:owner,environment:'SANDBOX',productionWrites:false,expiresAt:config.expiresAt}})};
  const result=await playQaContext(owner,(url,key,options)=>{assert.equal(url,config.url);opts=options;return db;},
    {read:async()=>JSON.stringify(config),now:()=>now,fetch:async(u,i)=>{received={u,i};return new Response('{}');}});
  assert.equal(result.db,db);
  await opts.global.fetch(config.url+'/rest/v1/rpc/example',{method:'POST'});
  assert.equal(received.u,config.url+'/rpc/example'); assert.equal(received.i.redirect,'error');
  await opts.global.fetch(new URL(config.url+'/rest/v1/rpc/example'),{method:'POST'});
  assert.equal(received.u,config.url+'/rpc/example');
  assert.throws(()=>opts.global.fetch('https://api.norva.tv/rest/v1/rpc/example',{}),/route_rejected/);
});

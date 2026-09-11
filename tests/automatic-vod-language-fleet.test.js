'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.join(__dirname, '..');
const loaded = import(pathToFileURL(path.join(root, 'supabase/functions/_shared/automatic-vod-language-fleet.mjs')));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const migration = read('supabase/migrations/20260911113013_automatic_vod_language_fleet.sql');
const playback = read('supabase/functions/norva-playback/index.ts');
const sync = read('supabase/functions/norva-source-sync/index.ts');
async function run(overrides = {}) {
  const events = [];
  const file = { current: true, needsProbe: false, ready: true, identified: false, verified: false };
  const options = {
    claim: { scanned: 12 },
    inspect: async () => { events.push('inspect'); return file; },
    probe: async () => { events.push('probe'); return { attempted: 1, persisted: 1 }; },
    enqueue: async () => { events.push('enqueue'); return true; },
    finish: async (outcome) => { events.push(outcome); },
    ...overrides,
  };
  const result = await (await loaded).processAutomaticVodLanguageFile(options);
  return { result, events };
}
test('cached unknowns enqueue without contacting the provider', async () => {
  const { result, events } = await run();
  assert.equal(result.queued, 1); assert.equal(result.attempted, 0);
  assert.deepEqual(events.slice(0, 2), ['inspect', 'enqueue']);
});
for (const state of ['verified', 'identified']) test(`${state} maps do not start a second analysis`, async () => {
  const { result, events } = await run({ inspect: async () => ({ current: true, [state]: true }) });
  assert.equal(result[state], 1); assert.equal(events.length, 1);
});
test('a new file uses one exact probe, rereads persistence, then enqueues', async () => {
  let reads = 0; let probes = 0;
  const { result } = await run({ inspect: async () => ({ current: true, needsProbe: reads++ === 0, ready: true }),
    probe: async () => { probes++; return { attempted: 1, persisted: 1 }; } });
  assert.equal(probes, 1); assert.equal(reads, 2); assert.equal(result.queued, 1);
});
for (const key of ['skipped', 'stopped']) test(`provider ${key} never becomes a detection failure`, async () => {
  const { result, events } = await run({ inspect: async () => ({ current: true, needsProbe: true }),
    probe: async () => ({ [key]: 'provider-account-busy', attempted: 0, persisted: 0 }) });
  assert.equal(result.deferred, 1); assert.equal(result.failed, 0); assert.equal(result.attempted, 0);
  assert.ok(!events.includes('enqueue'));
});
test('ownership change after a probe prevents enqueue', async () => {
  let reads = 0;
  const { result, events } = await run({ inspect: async () => ({ current: reads++ === 0, needsProbe: true }) });
  assert.equal(result.code, 'source-changed'); assert.ok(!events.includes('enqueue'));
});
test('an insufficient exact profile stays unsupported, never guessed', async () => {
  const { result, events } = await run({ inspect: async () => ({ current: true, ready: false }) });
  assert.equal(result.outcome, 'unsupported'); assert.ok(!events.includes('enqueue'));
});
test('quota backpressure defers without a provider retry', async () => {
  const { result } = await run({ enqueue: async () => false });
  assert.equal(result.deferred, 1); assert.equal(result.attempted, 0);
});
test('transport uncertainty consumes an intake attempt, not an audio certificate', async () => {
  const { result } = await run({ inspect: async () => ({ current: true, needsProbe: true }),
    probe: async () => { throw new Error('private url and token'); } });
  assert.equal(result.failed, 1); assert.equal(result.attempted, 1);
  assert.equal(result.code, 'intake-request-failed');
  assert.doesNotMatch(JSON.stringify(result), /private url|token/);
});
test('structured circuit errors are deferred and cannot leak error text', async () => {
  const { result } = await run({ inspect: async () => { throw { details: { code: 'PROVIDER_PROBE_CIRCUIT_OPEN' } }; } });
  assert.equal(result.deferred, 1); assert.equal(result.attempted, 0);
});
test('unpersisted HTTP success is not an identified file', async () => {
  const { result } = await run({ inspect: async () => ({ current: true, needsProbe: true }),
    probe: async () => ({ persisted: 0, attempted: 1 }) });
  assert.equal(result.failed, 1); assert.equal(result.identified, 0);
});
test('an ACK failure is not caught and retried as another outcome', async () => {
  let acknowledgements = 0;
  await assert.rejects(run({ finish: async () => { acknowledgements++; throw new Error('ack failed'); } }), /ack failed/);
  assert.equal(acknowledgements, 1);
});
test('fresh intake is paged, all-account, generation-bound and never offset-based', () => {
  assert.match(migration, /order by v\.id limit 256/);
  assert.match(migration, /v\.generation_id=v_generation/);
  assert.match(migration, /pg_try_advisory_xact_lock/);
  assert.doesNotMatch(migration, /admin_internal_accounts|admin_enrichment_accounts|\boffset\b/i);
  assert.match(migration, /generation_id is distinct from excluded\.generation_id/);
});
test('all network/model safety boundaries remain enforced', () => {
  assert.match(migration, /j\.quarantined_at is not null/);
  assert.match(migration, /prior\.quarantined_at is not null/);
  assert.match(migration, /attempts between 0 and 3/);
  assert.match(migration, /lost-intake-lease/);
  assert.match(migration, /\)>=2/); assert.match(migration, /\)>=20/);
  assert.match(migration, /enrichment_paused/); assert.match(migration, /audio_lid_enabled/);
  assert.match(playback, /body\.allowSourceLocal === true && identityKey === `source:\$\{sourceId\}`/);
  assert.match(playback, /return `source:\$\{sourceId\}`/);
  assert.match(migration, /v_job\.item_type='movie'[\s\S]*v_job\.identity_key='source:'\|\|v_job\.source_id::text/);
});
test('intake integrates into the existing fleet without new provider crons', () => {
  assert.match(sync, /automaticUnknowns: lane === 0/);
  assert.match(playback, /body\.automaticUnknowns === true && requestedType === "movie" && sourceId/);
  assert.match(playback, /runCodecProfileBackfill\(new Request/);
  assert.match(migration, /values\('automatic_vod_language_fleet_enabled',false\)/);
  assert.doesNotMatch(migration, /cron\.schedule|truncate |delete from public\.catalog_file_audio_validation_jobs/i);
});
test('new tables and RPCs are not publicly accessible', () => {
  for (const table of ['catalog_vod_language_sweeps','catalog_vod_language_intake']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /from public,anon,authenticated/);
  assert.match(migration, /to service_role/);
  assert.match(migration, /p_variant.*p_lease_token/s);
});

// Execute the actual Edge intake function as well as its pure orchestrator.
async function edgeFixture({ identified=false, verified=false, missingProfile=false, changedIdentity=false, revoked=false }={}) {
  const vm=require('node:vm'); const {stripTypeScriptTypes}=require('node:module');
  const events=[]; const user='owner', source='source', variant='variant';
  let hasProfile=!missingProfile;
  const claim={variantId:variant,itemId:'file',identityKey:'source:source',leaseToken:'lease',scanned:1};
  const db={
    async rpc(name,args) { events.push({name,args}); return {data:name==='claim_catalog_vod_language_file'?claim:true}; },
    from(table) {
      const where={}; const query={select(){return query;},eq(key,value){where[key]=value;return query;},
        async maybeSingle(){events.push({table,where});return {data:{id:variant,external_id:'file',codec_profile:hasProfile?{}:null}};}};
      return query;
    },
  };
  const context=vm.createContext({ Request, Deno:{env:{get:()=> 'internal-test-token'}},
    requireLanguageValidationEntitlement:async()=>{if(revoked)throw {code:'revoked'};},
    languageValidationAccessWasRevoked:e=>e.code==='revoked',
    recordOrEmpty:v=>v||{},stringOr:(v,f)=>typeof v==='string'?v:f,stringOrNull:v=>v??null,
    throwDb:()=>{throw new Error('database');},HttpError:Error,
    assertSourceCatalogVisible:async()=>{},loadLanguageValidationIdentity:async()=>changedIdentity?'new-identity':'source:source',
    loadLanguageValidationCache:async()=>({audio_tracks:[{index:0,lang:identified?'en':null}]}),
    exactLanguageValidationProfileFromGateway:p=>{if(!p)throw new Error('missing profile');return {profile:{durationSeconds:3600},audioTracks:[{index:0}],fileSizeBytes:1000,profileProbedAt:'fixture'};},
    languageValidationProfileFingerprint:async()=> 'fingerprint',cacheMatchesObservedFileProfile:()=>true,
    exactCachedAudioTracks:()=>true,requireStrictLidWindowCount:()=>6,cachedStrictLanguageValidation:()=>verified,
    normalizeIsoLang:v=>v==='en'?'en':null,
    processAutomaticVodLanguageFile:(await loaded).processAutomaticVodLanguageFile,
    runCodecProfileBackfill:async req=>{events.push({probe:await req.json(),authorization:req.headers.get('Authorization')});hasProfile=true;return {attempted:1,persisted:1};},
    enqueueAutomaticStrictLanguageValidation:async args=>{events.push({enqueued:{userId:args.userId,sourceId:args.sourceId,variantId:args.variantId,identityKey:args.identityKey}});return true;},
  });
  const begin=playback.indexOf('async function runAutomaticVodLanguageIntake(');
  const end=playback.indexOf('// Automatic UNTAGGED',begin);
  vm.runInContext(stripTypeScriptTypes(playback.slice(begin,end)),context);
  return {result:await context.runAutomaticVodLanguageIntake(db,user,source),events};
}

test('real Edge intake rejects revoked accounts before claiming or contacting providers',async()=>{
  const h=await edgeFixture({revoked:true});assert.equal(h.result.skipped,'account-not-entitled');assert.equal(h.events.length,0);
});
for(const flag of ['identified','verified']) test(`real Edge ${flag} cache avoids provider/model work`,async()=>{
  const h=await edgeFixture({[flag]:true});assert.equal(h.result[flag],1);
  assert.ok(!h.events.some(e=>e.probe||e.enqueued));
});
test('real Edge unknown inventory enters the existing strict queue with owned coordinates',async()=>{
  const h=await edgeFixture();assert.equal(h.result.queued,1);assert.ok(!h.events.some(e=>e.probe));
  assert.deepEqual(h.events.find(e=>e.enqueued).enqueued,{userId:'owner',sourceId:'source',variantId:'variant',identityKey:'source:source'});
  assert.deepEqual(h.events.find(e=>e.table).where,{user_id:'owner',source_id:'source',id:'variant',item_type:'movie'});
});
test('real Edge private-key drift never opens a provider or enqueues',async()=>{
  const h=await edgeFixture({changedIdentity:true});assert.equal(h.result.code,'source-changed');assert.ok(!h.events.some(e=>e.probe||e.enqueued));
});
test('real Edge missing profile requests exactly one private-capable authenticated probe',async()=>{
  const h=await edgeFixture({missingProfile:true});assert.equal(h.result.queued,1);
  const probes=h.events.filter(e=>e.probe);assert.equal(probes.length,1);
  assert.deepEqual(probes[0].probe,{userId:'owner',variantIds:['variant'],allowSourceLocal:true});
  assert.equal(probes[0].authorization,'Bearer internal-test-token');
  assert.equal(h.events.filter(e=>e.name==='finish_catalog_vod_language_file').length,1);
});

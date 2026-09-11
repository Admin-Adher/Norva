const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a+start.length);
  assert(a >= 0 && b > a);return source.slice(a,b);
}
const functions = section('async function codecProfileBackgroundBlockReason(', 'function episodeAudioTracks(')
  + section('async function providerAccountBusyForCrawler(', '\nasync function ');

function fixture({ kind = 'presence', session = null, dbError = false, rpcError = false, rpcMissing = false } = {}) {
  const calls = [];
  const db = {
    from(table) {
      const fields = {};
      const query = {
        select() { return query; }, eq(k,v) { fields[k]=v;return query; },
        in(k,v) { fields[k]=v;return query; }, gt() { return query; },
        limit() {
          const active = table === 'cloud_playback_sessions'
            && Array.isArray(fields.status) && fields.status.includes('pending')
            && ((session === 'own' && fields.user_id) || (session === 'shared' && fields.provider_account_hash));
          return Promise.resolve({ data: active ? [{id:'fixture'}] : [], error:dbError ? {} : null });
        },
      };return query;
    },
    async rpc(name) {
      calls.push(name);
      return { data: rpcMissing ? null : name === 'provider_account_busy' || !['presence','catalog-refresh'].includes(kind),
        error: rpcError ? {} : null };
    },
  };
  const context = vm.createContext({ CRAWL_VIEWER_GRACE_MS:240000,PREGEN_ACTIVE_TTL_MS:240000,
    providerAccountKeyFromUrl:()=> 'fixture-key',providerAccountHashFromUrl:async()=> 'fixture-hash' });
  vm.runInContext(stripTypeScriptTypes(functions),context);
  return {context,db,calls};
}

for (const kind of ['presence','catalog-refresh']) {
  test(`${kind} previously blocked exact profiles but not the corrected fenced metadata reader`,async()=>{
    const h=fixture({kind});
    assert.equal(await h.context.episodeBackgroundBlockReason(h.db,'owner','https://fixture.invalid'), 'provider-account-busy');
    h.calls.length=0;
    assert.equal(await h.context.codecProfileBackgroundBlockReason(h.db,'owner','https://fixture.invalid'),null);
    assert.deepEqual(h.calls,['provider_account_busy_for_catalog_refresh']);
  });
}
for (const kind of ['playback','language-validation','unknown']) {
  test(`${kind} activity still prevents metadata provider access`,async()=>{
    const h=fixture({kind});
    assert.equal(await h.context.codecProfileBackgroundBlockReason(h.db,'owner','https://fixture.invalid'),'provider-account-busy');
  });
}
for (const session of ['own','shared']) {
  test(`pending ${session} playback wins before metadata provider access`,async()=>{
    const h=fixture({session});
    assert.equal(await h.context.codecProfileBackgroundBlockReason(h.db,'owner','https://fixture.invalid'),
      session==='own'?'live-session':'provider-account-busy');
    assert.deepEqual(h.calls,[]);
  });
}
for (const option of ['dbError','rpcError','rpcMissing']) {
  test(`${option} fails closed`,async()=>{
    const h=fixture({[option]:true});
    assert.notEqual(await h.context.codecProfileBackgroundBlockReason(h.db,'owner','https://fixture.invalid'),null);
  });
}
test('exact profile errors retain only an internal stage/status, never private payloads',async()=>{
  const logs=[];
  const owner='10000000-0000-4000-8000-000000000001', variant='20000000-0000-4000-8000-000000000002';
  class HttpError extends Error { constructor(status,message) {super(message);this.status=status;} }
  const rows=[{id:variant,source_id:'source',external_id:'movie'}];
  const q={select(){return q;},eq(){return q;},in:async()=>({data:rows,error:null})};
  const context=vm.createContext({ Deno:{env:{get:()=> 'fixture-token'}},HttpError,
    recordOrEmpty:v=>v||{},stringOr:(v,f)=>typeof v==='string'?v:f,
    PLAYBACK_SESSION_UUID_PATTERN:/^[0-9a-f-]{36}$/,
    codecProfileBackgroundBlockReason:async()=>null,
    getRuntimeConfig:async()=>({mediaGatewayUrl:'https://fixture.invalid',mediaGatewayToken:'fixture-token'}),
    resolveSourceIdentity:async()=>({key:'identity'}),
    resolvePlaybackTarget:async()=>{throw new HttpError(502,'private https://fixture.invalid/user/secret');},
    console:{warn:(label,value)=>logs.push({label,value})} });
  vm.runInContext(stripTypeScriptTypes(section('async function runCodecProfileBackfill(', 'async function runLidBenchmarkEndpoint(')),context);
  await assert.rejects(context.runCodecProfileBackfill({headers:new Headers({Authorization:'Bearer fixture-token'}),
    json:async()=>({userId:owner,variantIds:[variant]})},{from:()=>q}),e=>e.status===502);
  assert.equal(logs.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(logs[0].value)),{stage:'target-resolution',status:502,kind:'http'});
  assert.doesNotMatch(JSON.stringify(logs),/secret|fixture-token|https:|10000000/);
});

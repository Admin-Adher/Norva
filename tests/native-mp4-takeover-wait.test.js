const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const src = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
const code = stripTypeScriptTypes(src.slice(src.indexOf('async function releaseSupersededPlaybackSessions('),
  src.indexOf('const PROVIDER_NETWORK_CAUSES')), { mode: 'transform' });
function harness(expire) {
  const ctx = vm.createContext({ Set, console: { warn() {} }, PROVIDER_SLOT_RELEASE_DELAY_MS: 2500,
    PROVIDER_NATIVE_TAKEOVER_GRACE_MS: 6000, stringOr: (v, f) => typeof v === 'string' ? v : f,
    throwDb: () => { throw Error('db'); }, expirePlaybackSession: expire });
  vm.runInContext(code, ctx); return ctx;
}
test('only the owner pilot and wholly acknowledged Gateway closures use the shorter cooldown', () => {
  const { supersededPlaybackWaitMs: wait } = harness();
  assert.equal(wait('direct', 1, 1, true), 2500);
  for (const [released, drained, pilot] of [[1,0,true],[2,1,true],[1,1,false],[1,2,true]])
    assert.equal(wait('direct', released, drained, pilot), 6000);
  assert.equal(wait('transcode', 1, 0, false), 2500);
  assert.equal(wait('direct', 0, 0, true), 0);
});
test('failed, missing and unacknowledged old sessions cannot qualify a replacement', async () => {
  const ctx = harness(async id => { if (id === 'failed') throw Error('drain');
    return { nativeGatewayDrained: id === 'drained' }; });
  const db = { from: () => ({ select: () => ({ in: async () => ({
    data: ['drained','failed','device'].map(id => ({id,user_id:'owner'})) }) }) }) };
  const drained = new Set();
  const count = await ctx.releaseSupersededPlaybackSessions(['drained','failed','device','missing'], db, drained);
  assert.equal(count, 4); assert.deepEqual([...drained], ['drained']);
  assert.equal(ctx.supersededPlaybackWaitMs('direct', count, drained.size, true), 6000);
});
test('closure evidence requires server marker, explicit Gateway acknowledgement and no cleanup error', () => {
  const section = src.slice(src.indexOf('async function expirePlaybackSession('), src.indexOf('async function playbackHealth('));
  assert.match(section, /recordOrEmpty\(session\.playback_hint\)\.__norvaNativeMp4SessionV1 === true/);
  assert.match(section, /rawResponse\.ok && rawResult\.ok === true/);
  assert.match(section, /Number\.isInteger\(rawResult\.nativeRevoked\) && rawResult\.nativeRevoked >= 0/);
  assert.match(section, /nativeGatewayDrained && gatewayErrors\.length === 0 && mediaCacheErrors\.length === 0/);
});

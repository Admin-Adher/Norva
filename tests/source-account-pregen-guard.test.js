const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const helper = import('../supabase/functions/_shared/source-account-pregen-guard.mjs');
test('only an explicit successful false RPC result opens the account gate', async () => {
    const { sourceAccountPregenActive } = await helper;
    for (const data of [true, null, undefined, 0, '', [], {}, 'false']) {
        assert.equal(await sourceAccountPregenActive({ rpc: async () => ({ data }) }, 'owner', 'source'), true);
    }
    assert.equal(await sourceAccountPregenActive({ rpc: async () => ({ data: false }) }, 'owner', 'source'), false);
});
test('errors and missing source identity always fail closed', async () => {
    const { sourceAccountPregenActive } = await helper;
    for (const db of [
        { rpc: async () => ({ data: false, error: { code: '57014' } }) },
        { rpc: async () => { throw new Error('network unavailable'); } },
        { rpc: async () => null },
    ]) assert.equal(await sourceAccountPregenActive(db, 'owner', 'source'), true);
    const neverCall = { rpc: () => { throw new Error('must not call without complete scope'); } };
    assert.equal(await sourceAccountPregenActive(neverCall, '', 'source'), true);
    assert.equal(await sourceAccountPregenActive(neverCall, 'owner', ''), true);
});
test('SQL receives the exact owner and source without provider credentials or account hashes', async () => {
    const { sourceAccountPregenActive } = await helper;
    const calls = [];
    assert.equal(await sourceAccountPregenActive({ rpc: async (...args) => { calls.push(args); return { data: false }; } }, 'owner', 'source'), false);
    assert.deepEqual(calls, [['catalog_source_account_pregen_active', { p_user_id: 'owner', p_source_id: 'source' }]]);
});
test('automatic profile narrowing is internal and rechecks exact selected sources', () => {
    const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
    const body = source.slice(source.indexOf('async function runCodecProfileBackfill('), source.indexOf('async function runLidBenchmarkEndpoint('));
    assert.match(body, /pregenSourceId = ""/);
    assert.match(body, /pregenSourceId && variants\.some\(\(variant\) => stringOr\(variant\.source_id, ""\) !== pregenSourceId\)/);
    assert.match(body, /const initialBlock = await codecProfileBackgroundBlockReason\(db, userId, "", pregenSourceId\)/);
    assert.match(body, /const beforeClaimBlock = await codecProfileBackgroundBlockReason\(db, userId, targetUrl, pregenSourceId\)/);
    assert.match(body, /const raceBlock = await codecProfileBackgroundBlockReason\(db, userId, targetUrl, pregenSourceId\)/);
    assert.doesNotMatch(body, /body\.pregenSourceId/);
    const benchmark = source.slice(source.indexOf('async function runLidBenchmark('), source.indexOf('async function codecProfileBackgroundBlockReason('));
    assert.equal((benchmark.match(/accountPregenActive\(db, userId\)/g) || []).length, 2);
    assert.doesNotMatch(benchmark, /accountPregenActive\(db, userId,/);
});

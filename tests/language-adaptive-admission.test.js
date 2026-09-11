'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { decideLanguageBackgroundCapacity: decide, createLanguageResourceSampler } = require('../services/media-gateway/src/language-background-capacity');
const { classifyCodecProbeFailure: classify } = require('../services/media-gateway/src/codec-probe-diagnostic');
const sample = { at: 100000, cpuRatio: 0.2, memoryRatio: 0.1, hostLoadRatio: 0.1 };
const activity = { viewer: false, starting: false, foregroundInference: false, benchmark: false, backgroundProcesses: 0, brokers: 0 };
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\r\n/g, '\n');
const edge = read('supabase/functions/norva-playback/index.ts');
const sql = read('supabase/migrations/20260911123735_lid_adaptive_quota.sql');

test('idle capacity never exceeds the existing two-worker ceiling', () => assert.equal(decide(sample, activity, sample.at).maxWorkers, 2));
for (const key of ['viewer', 'starting', 'foregroundInference', 'benchmark']) test(`${key} pauses new background admissions`, () => {
    assert.equal(decide(sample, { ...activity, [key]: true }, sample.at).maxWorkers, 0);
});
for (const [key, moderate, high] of [['cpuRatio', .6, .8], ['memoryRatio', .75, .85], ['hostLoadRatio', .7, .9]]) test(`${key} reduces then pauses admissions`, () => {
    assert.equal(decide({ ...sample, [key]: moderate }, activity, sample.at).maxWorkers, 1);
    assert.equal(decide({ ...sample, [key]: high }, activity, sample.at).maxWorkers, 0);
});
for (const key of ['backgroundProcesses', 'brokers']) test(`${key} occupancy cannot admit more network/inference work`, () => {
    assert.equal(decide(sample, { ...activity, [key]: 2 }, sample.at).maxWorkers, 0);
});
test('missing, malformed, future and stale telemetry fails closed', () => {
    for (const s of [null, {}, { ...sample, cpuRatio: NaN }, { ...sample, at: sample.at + 1 }, { ...sample, at: sample.at - 30001 }]) {
        assert.equal(decide(s, activity, sample.at).maxWorkers, 0);
    }
});
test('resource sampler uses the container quota and memory limit, not host capacity alone', async () => {
    let at = 0; let usage = 0; let unavailable = false;
    const sampler = createLanguageResourceSampler({ now: () => at, interval: () => ({ unref() {} }),
        os: { cpus: () => Array(16), totalmem: () => 10000, loadavg: () => [4] },
        readFile: async file => {
            if (unavailable) throw Error('cgroup unavailable');
            return file.endsWith('cpu.stat') ? `usage_usec ${usage}` : file.endsWith('cpu.max') ? '600000 100000' : file.endsWith('memory.current') ? '100' : '1000';
        } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sampler.snapshot(), null);
    at = 5000; usage = 15000000; await sampler.sample();
    assert.deepEqual(sampler.snapshot(), { at, cpuRatio: .5, memoryRatio: .1, hostLoadRatio: .25 });
    unavailable = true; await sampler.sample(); assert.equal(sampler.snapshot(), null);
});

for (const [text, expected] of [['Codec probe timeout', 'codec_probe_timeout'], ['HTTP error 403', 'codec_probe_access_denied'],
    ['HTTP 404', 'codec_probe_file_unavailable'], ['moov atom not found', 'codec_probe_invalid_media'],
    ['Codec probe returned invalid JSON', 'codec_probe_invalid_response'], ['Connection reset by peer', 'codec_probe_transport_failed'],
    ['unknown private URL', 'codec_probe_failed']]) test(`probe diagnostic: ${expected}`, () => assert.equal(classify(new Error(text)), expected));
for (const code of ['PROVIDER_BUSY', 'PROXY_AUTH_FAILED', 'viewer_preempted', 'account_busy']) test(`${code} remains authoritative`, () => {
    assert.equal(classify({ code, message: 'Codec probe timeout' }), code);
});
test('diagnostics contain no provider or exception content', () => assert.doesNotMatch(classify({ message: 'https://private/token/secret', code: 'not a safe code' }), /private|secret|https/));

async function refreshFixture({ capacity = { protocol: 1, maxWorkers: 2, reason: 'capacity-available', observedAt: new Date().toISOString() }, rpcResult = true, failFetch = false } = {}) {
    const calls = [];
    const context = vm.createContext({ AbortSignal, Number, getRuntimeConfig: async () => ({ mediaGatewayUrl: 'https://gateway.invalid' }),
        recordOrEmpty: v => v || {}, fetch: async () => { if (failFetch) throw Error('unreachable'); return { ok: true, json: async () => ({ ok: true, languageBackgroundCapacity: capacity }) }; } });
    const begin = edge.indexOf('async function refreshLanguageBackgroundCapacity(');
    const end = edge.indexOf('async function processOneLanguageValidationTrack(', begin);
    vm.runInContext(stripTypeScriptTypes(edge.slice(begin, end)), context);
    const allowed = await context.refreshLanguageBackgroundCapacity({ rpc: async (name, args) => { calls.push({ name, args }); return { data: rpcResult }; } });
    return { allowed, calls };
}
test('real Edge reports capacity before the distributed admission, without provider data', async () => {
    const h = await refreshFixture(); assert.equal(h.allowed, true); assert.equal(h.calls[0].name, 'report_catalog_language_capacity');
    assert.equal(h.calls[0].args.p_max_workers, 2); assert.equal(Object.keys(h.calls[0].args).length, 3);
});
test('real Edge rejects unavailable gateway, rejected report, oversized or zero capacity', async () => {
    for (const options of [{ failFetch: true }, { rpcResult: false }, { capacity: {} }, { capacity: { protocol: 1, maxWorkers: 3 } },
        { capacity: { protocol: 1, maxWorkers: 0, reason: 'viewer-priority' } }]) {
        assert.equal((await refreshFixture(options)).allowed, false);
    }
});
test('both intake and worker refresh capacity before claims, without spending a retry', () => {
    for (const [start, end, claim] of [['async function processOneLanguageValidationTrack(', 'async function finalizeLanguageValidationTrackWindows(', 'claim_catalog_file_audio_validation_job'],
        ['async function runAutomaticVodLanguageIntake(', '// Automatic UNTAGGED', 'claim_catalog_vod_language_file']]) {
        const body = edge.slice(edge.indexOf(start), edge.indexOf(end, edge.indexOf(start)));
        assert.ok(body.indexOf('refreshLanguageBackgroundCapacity') < body.indexOf(claim));
    }
});
test('SQL keeps manual quota, explicit server origins and fail-closed atomic admission', () => {
    assert.match(sql, /request_origin text not null default 'legacy'/);
    assert.match(sql, /job.request_origin <> ''automatic''/);
    assert.match(sql, /p_cached_audio_tracks, ''manual''/);
    assert.match(sql, /v_now, null, ''automatic''/);
    assert.match(sql, /catalog-language-admission/);
    assert.match(sql, /max_workers between 0 and 2/);
    assert.match(sql, /interval '10 seconds'/);
    assert.match(sql, /j\.lease_expires_at>clock_timestamp\(\)/);
    assert.match(sql, /j.quarantined_at is null/);
    assert.doesNotMatch(sql, /delete from|truncate |set quarantined_at|cron\.schedule/i);
});

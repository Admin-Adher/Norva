'use strict';

const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { FIXTURE_IDS, FIXTURES, PROTOCOL } = require('../src/fixture-registry');

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CASE_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 250;

function strictOrigin(value) {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch (_) { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash || parsed.pathname !== '/') {
        throw new Error('MEDIA_LAB_PRIVATE_ORIGIN_INVALID');
    }
    return parsed.toString().replace(/\/+$/, '');
}

function strictToken(value) {
    const token = String(value || '');
    if (token.length < 32 || token.length > 8_192 || /\s/.test(token)) {
        throw new Error('MEDIA_LAB_PRIVATE_TOKEN_INVALID');
    }
    return token;
}

function fixtureById(id) {
    return FIXTURES.find((fixture) => fixture.id === id) || null;
}

async function boundedJson(response) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error('MEDIA_LAB_PRIVATE_RESPONSE_TOO_LARGE');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('MEDIA_LAB_PRIVATE_RESPONSE_TOO_LARGE');
    if (bytes.length === 0) return null;
    try { return JSON.parse(bytes.toString('utf8')); } catch (_) {
        throw new Error('MEDIA_LAB_PRIVATE_RESPONSE_INVALID');
    }
}

async function runPrivateCase({
    fixtureId,
    origin = 'http://127.0.0.1:8093',
    token,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_CASE_TIMEOUT_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
    const fixture = fixtureById(fixtureId);
    if (!fixture) throw new Error('MEDIA_LAB_PRIVATE_FIXTURE_INVALID');
    if (typeof fetchImpl !== 'function') throw new Error('MEDIA_LAB_PRIVATE_FETCH_INVALID');
    const runnerOrigin = strictOrigin(origin);
    const runnerToken = strictToken(token);
    const boundedTimeout = Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= DEFAULT_CASE_TIMEOUT_MS
        ? timeoutMs
        : DEFAULT_CASE_TIMEOUT_MS;
    const boundedPoll = Number.isInteger(pollIntervalMs) && pollIntervalMs >= 10 && pollIntervalMs <= 5_000
        ? pollIntervalMs
        : POLL_INTERVAL_MS;
    const actor = crypto.randomBytes(32).toString('base64url');
    const endpoint = `${runnerOrigin}/v1/current`;
    const baseHeaders = Object.freeze({
        Authorization: `Bearer ${runnerToken}`,
        'X-Norva-Lab-Actor': actor,
    });
    const request = async (method, body = null) => {
        const response = await fetchImpl(endpoint, {
            method,
            headers: {
                ...baseHeaders,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: 'error',
            signal: AbortSignal.timeout(Math.min(15_000, boundedTimeout)),
        });
        const payload = response.status === 204 ? null : await boundedJson(response);
        return { status: response.status, payload };
    };

    const deadline = Date.now() + boundedTimeout;
    try {
        const started = await request('POST', { protocol: PROTOCOL, fixtureId });
        if (![200, 202].includes(started.status)) throw new Error('MEDIA_LAB_PRIVATE_START_FAILED');
        let state = started.payload;
        while (state?.state !== 'complete') {
            if (state?.state !== 'running' || state?.fixtureId !== fixtureId) {
                throw new Error('MEDIA_LAB_PRIVATE_STATE_INVALID');
            }
            if (Date.now() >= deadline) throw new Error('MEDIA_LAB_PRIVATE_CASE_TIMEOUT');
            await delay(boundedPoll);
            const current = await request('GET');
            if (current.status !== 200) throw new Error('MEDIA_LAB_PRIVATE_POLL_FAILED');
            state = current.payload;
        }
        const result = state?.result;
        if (state.fixtureId !== fixtureId || result?.protocol !== PROTOCOL || result?.status !== 'pass'
            || result?.pipeline !== fixture.expected.pipeline || result?.reason !== fixture.expected.reason
            || result?.cleanupPassed !== true) {
            throw new Error('MEDIA_LAB_PRIVATE_CASE_FAILED');
        }
        return Object.freeze({ fixtureId, result: Object.freeze({ ...result }) });
    } finally {
        await request('DELETE').catch(() => {});
    }
}

async function main(argv = process.argv.slice(2), env = process.env) {
    const requested = argv.length === 0 ? ['h264-closed-aac'] : argv;
    const fixtureIds = requested.length === 1 && requested[0] === 'all' ? [...FIXTURE_IDS] : requested;
    if (!fixtureIds.length || fixtureIds.some((id) => !FIXTURE_IDS.includes(id))) {
        throw new Error('MEDIA_LAB_PRIVATE_FIXTURE_INVALID');
    }
    const results = [];
    for (const fixtureId of fixtureIds) {
        const completed = await runPrivateCase({
            fixtureId,
            origin: env.MEDIA_LAB_PRIVATE_RUNNER_ORIGIN || 'http://127.0.0.1:8093',
            token: env.MEDIA_LAB_RUNNER_TOKEN,
            timeoutMs: Number(env.MEDIA_LAB_RUN_TIMEOUT_MS) || DEFAULT_CASE_TIMEOUT_MS,
        });
        const result = completed.result;
        const summary = {
            fixtureId,
            pipeline: result.pipeline,
            reason: result.reason,
            ttffMs: result.ttffMs,
            providerGets: result.providerGets,
            maximumConcurrentProviderGets: result.maximumConcurrentProviderGets,
            ffmpegSpawns: result.ffmpegSpawns,
            rebufferCount: result.rebufferCount,
            seekPassed: result.seekPassed,
            audioPassed: result.audioPassed,
            cleanupPassed: result.cleanupPassed,
        };
        process.stdout.write(`MEDIA_LAB_CASE_OK ${JSON.stringify(summary)}\n`);
        results.push(summary);
    }
    process.stdout.write(`MEDIA_LAB_CAMPAIGN_OK ${JSON.stringify({ protocol: PROTOCOL, cases: results.length })}\n`);
    return results;
}

if (require.main === module) {
    main().catch((error) => {
        const code = /^MEDIA_LAB_[A-Z0-9_]+$/.test(String(error?.message || ''))
            ? error.message
            : 'MEDIA_LAB_PRIVATE_FAILED';
        process.stderr.write(`MEDIA_LAB_CASE_FAIL ${code}\n`);
        process.exitCode = 1;
    });
}

module.exports = Object.freeze({
    runPrivateCase,
    main,
    strictOrigin,
    strictToken,
    boundedJson,
});

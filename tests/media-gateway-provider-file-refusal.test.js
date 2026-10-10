'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { providerFileRefusalResponse, shouldRetryProviderStatus } = require('../services/media-gateway/src/providerFailure');

const gateway = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8').replace(/\r\n/g, '\n');
const begin = gateway.indexOf('        try {\n            await ensureBoundedMkvInputPump(session, sessionRequestAbortController.signal);');
const end = gateway.indexOf('\n        // Cold playback owns a retained provider body', begin);
assert.ok(begin >= 0 && end > begin, 'the shipped finite-VOD startup catch must be exercised');
const actualStartup = gateway.slice(begin, end);

async function runStartup(error, { aborted = false, cleanupFails = false } = {}) {
    const counts = { prepares: 0, cleanups: 0 };
    let response = null;
    const logged = [];
    const res = {
        status(status) { this.statusCode = status; return this; },
        json(body) { response = { status: this.statusCode, body: JSON.parse(JSON.stringify(body)) }; return response; },
    };
    const context = vm.createContext({
        session: {}, sessionRequestAbortController: { signal: { aborted } },
        ensureBoundedMkvInputPump: async () => { counts.prepares += 1; throw error; },
        stopSession: async () => { counts.cleanups += 1; if (cleanupFails) throw new Error('fixture cleanup failure'); },
        removeSessionDir: async () => { throw new Error('directory removal cannot replace session drain'); },
        outputDir: '/fixture/output', sourceUrl: 'https://fixture.invalid/movie/private-account/private-secret/123.mkv',
        sanitizeLog: () => '[sanitized]',
        console: { warn: (_message, _safeText, details) => logged.push(JSON.parse(JSON.stringify(details))) },
        providerFileRefusalResponse, res,
    });
    await vm.runInContext('(async () => {\n' + actualStartup + '\n})()', context);
    return { response, counts, logged };
}

for (const upstreamStatus of [401, 403]) {
    test('finite startup gives a bounded file refusal for upstream ' + upstreamStatus + ' without another request', async () => {
        const error = Object.assign(new Error('https://fixture.invalid/movie/private-account/private-secret/123.mkv forbidden'), {
            code: 'PROVIDER_REQUEST_FAILED', upstreamStatus, status: upstreamStatus, retryable: false,
            payload: { token: 'fixture-private-token', account: 'private-account' },
        });
        const result = await runStartup(error);
        assert.deepEqual(result.counts, { prepares: 1, cleanups: 1 });
        assert.deepEqual(result.response, { status: 502, body: {
            error: 'This media file is currently unavailable.', code: 'PROVIDER_FILE_REFUSED',
        } });
        assert.deepEqual(result.logged, [{ upstreamStatus, retryable: false }]);
        assert.doesNotMatch(JSON.stringify(result.response), /401|403|https:|private-account|private-secret|token|forbidden|concurren/i);
        assert.equal(shouldRetryProviderStatus(upstreamStatus), false);
    });
}

test('untrusted or differently classified errors do not become a file-refusal response', () => {
    for (const upstreamStatus of [undefined, null, '401', '403', 400, 404, 407, 416, 429, 458, 502, 503]) {
        assert.equal(providerFileRefusalResponse({ code: 'PROVIDER_REQUEST_FAILED', upstreamStatus }), null);
    }
    for (const code of ['PROXY_AUTH_FAILED', 'PROVIDER_BUSY', 'PROVIDER_RATE_LIMIT', 'RANGE_UNSUPPORTED', undefined]) {
        assert.equal(providerFileRefusalResponse({ code, upstreamStatus: 403 }), null);
    }
});

test('provider busy keeps its original 458 contract ahead of the new file response', async () => {
    for (const error of [
        { code: 'PROVIDER_BUSY', upstreamStatus: 403 },
        { status: 458, code: 'PROVIDER_REQUEST_FAILED', upstreamStatus: 403 },
    ]) {
        const result = await runStartup(error);
        assert.equal(result.response.status, 458);
        assert.equal(result.response.body.code, 'PROVIDER_BUSY');
        assert.equal(result.response.body.upstreamStatus, 458);
        assert.deepEqual(result.counts, { prepares: 1, cleanups: 1 });
    }
});

test('proxy authentication keeps the service-unavailable contract', async () => {
    const result = await runStartup({ code: 'PROXY_AUTH_FAILED', upstreamStatus: 407 });
    assert.deepEqual(result.response, { status: 502, body: {
        error: 'The media service is temporarily unavailable.', code: 'PROXY_AUTH_FAILED', networkCause: 'proxy_auth',
    } });
});

test('the existing 404 missing-file response is preserved', async () => {
    const result = await runStartup({ code: 'PROVIDER_REQUEST_FAILED', upstreamStatus: 404 });
    assert.deepEqual(result.response, { status: 404, body: {
        error: 'Media file not found on the provider (404).', code: 'PROVIDER_HTTP_ERROR',
    } });
});

test('container repair evidence is passed through before provider-refusal handling', async () => {
    const details = { protocol: 1, code: 'SOURCE_CONTAINER_MISMATCH', observedContainer: 'mp4' };
    const result = await runStartup({ code: 'SOURCE_CONTAINER_MISMATCH', details, upstreamStatus: 403 });
    assert.deepEqual(result.response, { status: 409, body: details });
    assert.equal(result.logged.length, 0);
});

test('range and transient transport errors retain their original handling', async () => {
    for (const error of [
        { code: 'RANGE_UNSUPPORTED', upstreamStatus: 200 },
        { code: 'PROVIDER_REQUEST_FAILED', upstreamStatus: 503, retryable: true },
    ]) {
        const result = await runStartup(error);
        assert.deepEqual(result.response, { status: 502, body: {
            error: 'Unable to prepare this media file for reliable playback.', code: error.code,
        } });
        assert.deepEqual(result.counts, { prepares: 1, cleanups: 1 });
    }
    assert.equal(shouldRetryProviderStatus(503), true);
});

test('aborted preparation preserves cancellation instead of reporting file refusal', async () => {
    const error = Object.assign(new Error('cancelled'), { code: 'PROVIDER_REQUEST_FAILED', upstreamStatus: 403 });
    await assert.rejects(runStartup(error, { aborted: true }), actual => actual === error);
});

test('failed session cleanup delegates to outer failure handling before a provider response', async () => {
    await assert.rejects(runStartup({ code: 'PROVIDER_REQUEST_FAILED', upstreamStatus: 403 }, { cleanupFails: true }),
        error => error.message === 'fixture cleanup failure');
});


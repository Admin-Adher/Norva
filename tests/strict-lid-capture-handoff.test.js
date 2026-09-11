'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { stripTypeScriptTypes } = require('node:module');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\r\n/g, '\n');
const edge = read('supabase/functions/norva-playback/index.ts');
const gateway = read('services/media-gateway/src/index.js');
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
class HttpError extends Error { constructor(status, message, details) { super(message); this.status = status; this.details = details; } }
const uuid = '12345678-1234-4234-8234-123456789012';
const drain = { providerDrained: true, providerDrainProtocol: 1 };
const hash = 'a'.repeat(64);

function edgeFixture(options = {}) {
    const events = []; const failures = []; let account = false; let identity = false;
    const claim = { jobId: uuid, trackIndex: 1, identityKey: 'fixture', profileFingerprint: hash };
    const current = { identityKey: 'fixture', fingerprint: hash, userId: 'test-owner', itemType: 'movie', sourceId: 'source', itemId: 'item',
        expectedAudioIndices: options.indices || [1], exactProfile: { fileSizeBytes: 1000000, profile: { durationSeconds: 3600 } } };
    const captured = { captureProtocol: 1, captured: true, expiresAt: Date.now() + 1800000, sha256: hash, ...drain };
    const db = { rpc: async (name, args = {}) => {
        events.push('rpc:' + name);
        if (name === 'claim_catalog_file_audio_validation_job') return { data: claim };
        if (name === 'catalog_language_capture_pipeline_enabled') return { data: options.enabled !== false };
        if (name === 'catalog_language_exact_file_admission_enabled') return { data: options.exactFlagUnavailable ? null : options.exact === true };
        if (name === 'claim_provider_account_language_validation') { account = true; return { data: true }; }
        if (name === 'claim_provider_file_probe') { identity = true; return { data: true }; }
        if (name === 'claim_provider_exact_file_probe') {
            assert.equal(account, true, 'mono account must be reserved before an exact file');
            assert.equal(args.p_identity_key, current.identityKey); assert.equal(args.p_item_type, current.itemType);
            assert.equal(args.p_external_id, current.itemId); assert.equal(args.p_provider_account_hash, hash);
            identity = !options.exactBusy; return { data: identity };
        }
        if (name === 'begin_catalog_file_audio_validation_provider_attempt') return { data: { allowed: true, attemptToken: uuid } };
        if (name === 'provider_account_language_validation_lease_is_current') return { data: account };
        if (name === 'checkpoint_catalog_file_audio_capture') {
            if (options.handoffFails) return { data: null };
            if (!options.cached) { assert.equal(account, true); assert.equal(identity, true); assert.equal(args.p_attempt_token, uuid); }
            else assert.equal(args.p_attempt_token, null);
            account = false; identity = false; return { data: uuid };
        }
        if (name === 'checkpoint_catalog_file_audio_validation_window') {
            assert.equal(account, false, 'account release must precede evidence checkpoint');
            return options.evidenceFails ? { error: true } : { data: { complete: false } };
        }
        if (name === 'release_provider_account_language_validation') { account = false; return { data: true }; }
        if (name === 'release_provider_exact_file_probe') {
            assert.equal(args.p_identity_key, current.identityKey); assert.equal(args.p_external_id, current.itemId);
            assert.equal(args.p_item_type, current.itemType); identity = false; return { data: true };
        }
        if (name === 'finish_catalog_file_audio_validation_provider_attempt') return { data: { settled: true } };
        throw Error('unexpected fixture RPC ' + name);
    } };
    const context = vm.createContext({ crypto, HttpError, Date, AbortSignal, DOMException,
        console: { warn() {} }, PLAYBACK_SESSION_UUID_PATTERN: /^[a-f0-9-]{36}$/,
        LANGUAGE_VALIDATION_TASK_BUDGET_MS: 240000, LANGUAGE_VALIDATION_JOB_LEASE_SECONDS: 300,
        LANGUAGE_VALIDATION_LEASE_SECONDS: 300, LANGUAGE_VALIDATION_ACCOUNT_LEASE_SECONDS: 300,
        LANGUAGE_VALIDATION_SCOPE: 'lid', LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL: 1,
        LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS: 20, LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS: 4,
        LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS: 300000,
        refreshLanguageBackgroundCapacity: async () => true,
        recordOrEmpty: x => x || {}, stringOr: (x, fallback) => x ?? fallback, stringOrNull: x => x || null,
        boundedNullableInt: x => Number.isInteger(x) ? x : null,
        revalidateLanguageValidationClaim: async () => current, requireStrictLidWindowCount: () => 6,
        strictLidWindowStateFromClaim: () => ({ position: 0, count: 6, protocol: 1, tokens: [] }),
        sameStrictLidWindowState: () => true, strictLidWindowCountForDuration: () => 6,
        resolvePlaybackTarget: async () => ({ targetUrl: 'https://fixture.invalid/file' }), assertHttpUrl() {},
        providerAccountHashFromUrl: async () => hash, providerAccountKeyFromUrl: () => 'fixture', sha256Hex: async () => hash,
        assertProviderCircuitClosed: async () => events.push('provider-circuit'),
        assertLanguageValidationIdle: async () => events.push('provider-idle'), languageValidationFetchBudgetMs: () => 230000,
        createBytePipeCapability: async (...args) => ({ gatewayUrl: 'https://gateway.invalid', serviceToken: 'fixture', capability: JSON.stringify(args[9]) }),
        fetch: async (url, request) => {
            const action = url.includes('/capture/') ? url.split('/capture/')[1].split('?')[0] : 'legacy';
            events.push('fetch:' + action);
            const claims = JSON.parse(request.headers['X-Norva-Byte-Pipe-Token']);
            if (action !== 'legacy') { assert.equal(claims.captureAction, action); assert.equal(claims.captureTrackIndex, 1); }
            if (action === 'capture') assert.deepEqual(claims.captureTrackIndices, current.expectedAudioIndices.slice(0, 4));
            if (action === 'status') return { ok: !options.statusFails, status: options.statusFails ? 503 : 200,
                payload: options.cached ? captured : { captureProtocol: 1, captured: false, ...drain } };
            if (action === 'capture') return options.busy ? { ok: false, status: 502, payload: { code: 'PROVIDER_BUSY', upstreamStatus: 458, ...drain } }
                : { ok: true, status: 200, payload: captured };
            if (action === 'infer') {
                assert.equal(account, false); assert.equal(identity, false); assert.equal(claims.captureRelease, uuid);
                return options.inferFails ? { ok: false, status: 409, payload: { code: 'preempted', ...drain } }
                    : { ok: true, status: 200, payload: { windowOrdinal: 1, windowCount: 6, receipt: 'opaque', ...drain } };
            }
            if (action === 'ack') { if (options.ackFails) throw Error('lost ACK'); return { ok: true, payload: { acknowledged: true, ...drain } }; }
            throw Error('unexpected fixture fetch');
        },
        readLanguageValidationGatewayResponse: async response => ({ ok: true, payload: response.payload }),
        strictLanguageProviderDrainAttested: p => p.providerDrained === true && p.providerDrainProtocol === 1,
        extractProviderStatus: p => p.upstreamStatus, sanitizeTelemetryText: x => x, textFromGatewayDetails: () => '',
        isProviderBusyFailure: ({ code }) => code === 'PROVIDER_BUSY', openProviderPlaybackCircuit: async () => { events.push('circuit-open'); return {}; },
        strictLidWindowCheckpointFromGateway: p => p.receipt || null,
        releaseProviderFileProbe: async () => { events.push('identity-release'); identity = false; },
        failLanguageValidationJob: async (_db, failure) => failures.push(failure),
        languageValidationTaskErrorCode: e => e.details?.code || e.message,
        languageValidationTaskErrorIsTerminal: () => false, languageValidationTaskRetryAt: () => null,
        languageValidationGatewayRetryAt: () => null,
    });
    vm.runInContext(stripTypeScriptTypes(section(edge, 'async function exactFileProbeAdmissionEnabled(', 'async function runAutomaticVodLanguageMetadataBatch('), { mode: 'transform' }), context);
    vm.runInContext(stripTypeScriptTypes(section(edge, 'async function processOneLanguageValidationTrack(', 'async function finalizeLanguageValidationTrackWindows('), { mode: 'transform' }), context);
    return { events, failures, run: () => context.processOneLanguageValidationTrack(db, uuid), slots: () => ({ account, identity }) };
}

test('actual Edge worker persists capture and releases both leases BEFORE calling local inference', async () => {
    const f = edgeFixture(); await f.run(); assert.deepEqual(f.failures, []);
    const stages = ['fetch:status', 'provider-idle', 'fetch:capture', 'rpc:checkpoint_catalog_file_audio_capture',
        'fetch:infer', 'rpc:checkpoint_catalog_file_audio_validation_window', 'fetch:ack'];
    for (let i = 1; i < stages.length; i++) assert.ok(f.events.indexOf(stages[i - 1]) < f.events.indexOf(stages[i]), stages[i]);
    assert.deepEqual(f.slots(), { account: false, identity: false });
});

test('actual Edge retry uses local capture without idle checks, provider claims or another acquisition', async () => {
    const f = edgeFixture({ cached: true }); await f.run(); assert.deepEqual(f.failures, []);
    assert.ok(f.events.includes('fetch:infer')); assert.ok(f.events.includes('fetch:ack'));
    for (const event of ['provider-idle', 'provider-circuit', 'fetch:capture', 'rpc:claim_provider_file_probe',
        'rpc:claim_provider_account_language_validation', 'rpc:begin_catalog_file_audio_validation_provider_attempt']) {
        assert.equal(f.events.includes(event), false, event);
    }
});

test('actual Edge exact-file mode still owns the mono account and hands off both leases before inference', async () => {
    const f = edgeFixture({ exact: true }); await f.run(); assert.deepEqual(f.failures, []);
    assert.ok(f.events.indexOf('rpc:claim_provider_account_language_validation') < f.events.indexOf('rpc:claim_provider_exact_file_probe'));
    assert.equal(f.events.includes('rpc:claim_provider_file_probe'), false);
    assert.ok(f.events.indexOf('rpc:checkpoint_catalog_file_audio_capture') < f.events.indexOf('fetch:infer'));
    assert.deepEqual(f.slots(), { account: false, identity: false });
});

test('actual Edge unavailable exact gate and occupied exact file stop before provider I/O and release their own account', async () => {
    for (const option of ['exactFlagUnavailable', 'exactBusy']) {
        const f = edgeFixture({ exact: true, [option]: true }); await f.run();
        assert.equal(f.failures.length, 1); assert.equal(f.events.includes('fetch:capture'), false);
        assert.equal(f.events.includes('rpc:claim_provider_file_probe'), false);
        assert.deepEqual(f.slots(), { account: false, identity: false });
    }
});

test('actual Edge provider refusal in exact-file mode releases only after its positive drain receipt', async () => {
    const f = edgeFixture({ exact: true, busy: true }); await f.run();
    assert.equal(f.failures[0].terminal, true); assert.equal(f.events.includes('fetch:infer'), false);
    assert.ok(f.events.includes('rpc:release_provider_exact_file_probe')); assert.equal(f.events.includes('identity-release'), false);
    assert.deepEqual(f.slots(), { account: false, identity: false });
});

test('actual Edge signs at most four remaining exact job tracks in a single provider capture', async () => {
    const f = edgeFixture({ indices: [1, 2, 4, 8, 16] }); await f.run(); assert.deepEqual(f.failures, []);
    assert.equal(f.events.filter(e => e === 'fetch:capture').length, 1);
});

for (const [flag, forbidden] of [['statusFails', 'fetch:capture'], ['handoffFails', 'fetch:infer'],
    ['inferFails', 'fetch:ack'], ['evidenceFails', 'fetch:ack']]) {
    test(`actual Edge ${flag} cannot cross its next durable boundary`, async () => {
        const f = edgeFixture({ [flag]: true }); await f.run(); assert.equal(f.failures.length, 1);
        assert.equal(f.events.includes(forbidden), false);
        if (['inferFails', 'evidenceFails'].includes(flag)) assert.equal(f.events.includes('rpc:finish_catalog_file_audio_validation_provider_attempt'), false);
    });
}

test('actual Edge lost ACK retains durable evidence and first provider 458 stays terminal', async () => {
    const acknowledged = edgeFixture({ ackFails: true }); await acknowledged.run(); assert.deepEqual(acknowledged.failures, []);
    const busy = edgeFixture({ busy: true }); await busy.run();
    assert.equal(busy.failures[0].terminal, true); assert.ok(busy.events.includes('circuit-open'));
    assert.equal(busy.events.includes('fetch:infer'), false); assert.equal(busy.events.filter(e => e === 'fetch:capture').length, 1);
});

function gatewayFixture(overrides = {}) {
    const called = [];
    const claims = { uid: 'fixture', url: 'https://fixture.invalid/file', captureProtocol: 1, captureAction: 'infer',
        captureTrackIndex: 1, captureRelease: uuid, ...overrides.claims };
    const res = new EventEmitter(); res.statusCode = 200;
    res.status = n => { res.statusCode = n; return res; }; res.json = p => { res.payload = p; res.writableEnded = true; return p; };
    const context = vm.createContext({ Number, String, Date, Set, AbortController, setTimeout, clearTimeout,
        LID_LEGACY_FULL_SCOPE: 'fixture', detectLanguageCapabilityFromHeader: () => 'signed-fixture',
        validateDetectLanguageCapability: () => ({ claims }),
        strictLidWindowClaimContext: () => ({ windowOrdinal: 1, fileSizeBytes: 1000000 }),
        LANGUAGE_CAPTURE_PIPELINE_ENABLED: overrides.enabled !== false,
        strictLidCaptureStore: { snapshot: () => ({ ready: true }) },
        strictLidWindowReceiptBinding: () => ({}), sha256Hex: () => hash, proxyKeyFromUrl: () => 'fixture',
        rejectWhileLidBenchmarkRuns: () => false, FFMPEG_USER_AGENT: 'fixture',
        strictLidCapturePipeline: { compute: async () => {
            called.push('infer'); if (overrides.missing) throw Object.assign(Error(), { code: 'LID_CAPTURE_NOT_FOUND' });
            return { receipt: 'opaque' };
        } },
    });
    vm.runInContext(section(gateway, 'async function handleStrictLidCaptureRequest(', "for (const action of ['status'"), context);
    return { res, called, run: () => context.handleStrictLidCaptureRequest({ query: { index: '1' } }, res, 'infer') };
}
test('actual Gateway compute route is gated by protocol, action, track and signed release proof', async () => {
    for (const claims of [{ captureProtocol: 0 }, { captureAction: 'capture' }, { captureTrackIndex: 2 }, { captureRelease: null },
        { captureTrackIndices: [1, 2] }, { captureTrackIndices: [1, 1] }, { captureTrackIndices: [2] }, { captureTrackIndices: [] }]) {
        const f = gatewayFixture({ claims }); await f.run(); assert.equal(f.res.statusCode, 400); assert.deepEqual(f.called, []);
    }
    const off = gatewayFixture({ enabled: false }); await off.run(); assert.equal(off.res.statusCode, 503); assert.deepEqual(off.called, []);
    const on = gatewayFixture(); await on.run(); assert.equal(on.res.statusCode, 200); assert.equal(on.res.payload.receipt, 'opaque');
});
test('actual Gateway missing stored audio returns 409, never transparently downloads again', async () => {
    const f = gatewayFixture({ missing: true }); await f.run(); assert.equal(f.res.statusCode, 409);
    assert.equal(f.res.payload.code, 'LID_CAPTURE_NOT_FOUND'); assert.equal(f.res.payload.providerDrained, true);
    assert.deepEqual(f.called, ['infer']);
});

test('local handoff and inference retries fit inside the private 30-minute buffer lifetime', () => {
    const context = vm.createContext({ HttpError, Date, Set, LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS: 300000,
        languageValidationTaskErrorCode: e => e.details.code, recordOrEmpty: x => x || {}, stringOrNull: x => x || null,
        languageValidationTaskErrorIsTerminal: () => false });
    vm.runInContext(stripTypeScriptTypes(section(edge, 'function languageValidationTaskRetryAt(', 'function languageValidationPendingResponse(')), context);
    for (const [code, delay] of [['LANGUAGE_CAPTURE_GATEWAY_UNAVAILABLE', 300000],
        ['LANGUAGE_CAPTURE_STATUS_UNAVAILABLE', 300000], ['LANGUAGE_CAPTURE_INFERENCE_DEFERRED', 30000],
        ['LANGUAGE_CAPTURE_HANDOFF_REJECTED', 30000], ['LANGUAGE_VALIDATION_TASK_BUDGET_EXHAUSTED', 30000]]) {
        const before = Date.now(); const due = Date.parse(context.languageValidationTaskRetryAt(new HttpError(503, '', { code })));
        assert.ok(due >= before + delay && due <= Date.now() + delay);
        assert.ok(due < before + 1800000);
    }
});

test('capture routes remain service-authenticated and never put provider capability in URL or JSON body', () => {
    assert.match(gateway, /app\.post\(`\/detect-language\/capture\/\$\{action\}`, setDetectLanguageSecurityHeaders, requireGatewayAuth/);
    const client = section(edge, 'async function requestLanguageCaptureWindow(', 'async function checkpointLanguageCapture(');
    assert.match(client, /"X-Norva-Byte-Pipe-Token": access\.capability/);
    assert.doesNotMatch(client, /body:|url.*capability|\/\$\{access\.capability\}/);
    const compute = section(edge, 'async function computeCapturedLanguageWindow(', 'async function finalizeLanguageValidationTrackWindows(');
    assert.doesNotMatch(compute, /claim_provider|release_provider|begin_catalog_file_audio_validation_provider_attempt/);
    assert.ok(compute.indexOf('checkpoint_catalog_file_audio_validation_window') < compute.indexOf('"ack"'));
});

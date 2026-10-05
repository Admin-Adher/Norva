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
    const events = []; const failures = []; const jobOwners = []; const providerOwners = [];
    let account = false; let identity = false; let position = 0; let capacityChecks = 0;
    const claim = { jobId: uuid, trackIndex: 1, identityKey: 'fixture', profileFingerprint: hash };
    const current = { identityKey: 'fixture', fingerprint: hash, userId: 'test-owner', itemType: 'movie', sourceId: 'source', itemId: 'item',
        expectedAudioIndices: options.indices || [1], exactProfile: { fileSizeBytes: 1000000, profile: { durationSeconds: 3600 } } };
    const captured = { captureProtocol: 1, captured: true, expiresAt: Date.now() + 1800000, sha256: hash, ...drain };
    const db = { rpc: async (name, args = {}) => {
        events.push('rpc:' + name);
        if (name === 'claim_catalog_file_audio_validation_job') {
            jobOwners.push(args.p_lease_owner);
            return { data: options.claimDeniedOnSecond && position > 0 ? null : claim };
        }
        if (name === 'list_due_catalog_file_audio_validation_jobs') {
            if (!options.releaseFails) assert.equal(account, false, 'previous provider lease must be released before another selection');
            assert.equal(identity, false, 'previous file lease must be released before another selection');
            return { data: [{ job_id: options.otherJobFirst ? 'different-job' : uuid }] };
        }
        if (name === 'catalog_language_capture_pipeline_enabled_for_job') {
            assert.equal(args.p_job_id, uuid, 'capture approval must be resolved for the claimed job');
            return options.captureFlagError ? { data: null, error: true } : { data: options.enabled !== false };
        }
        if (name === 'catalog_language_exact_file_enabled_for_source') {
            assert.equal(args.p_user, current.userId);
            assert.equal(args.p_source, current.sourceId);
            return { data: options.exactFlagUnavailable ? null : options.exact === true };
        }
        if (name === 'request_language_validation_catalog_yield') {
            assert.equal(args.p_job_id, uuid);
            assert.ok(args.p_lease_owner);
            assert.ok(args.p_account_key);
            return options.yieldError ? { error: true } : { data: options.yieldMissing ? null : !options.yieldCooldown };
        }
        if (name === 'claim_provider_account_language_validation') {
            if (account) return { data: false };
            providerOwners.push(args.p_lease_owner); account = true; return { data: true };
        }
        if (name === 'claim_provider_file_probe') { identity = true; return { data: true }; }
        if (name === 'claim_provider_exact_file_probe_for_source') {
            assert.equal(args.p_user, current.userId); assert.equal(args.p_source, current.sourceId);
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
            if (!options.legacySuccess) assert.equal(account, false, 'account release must precede evidence checkpoint');
            if (options.evidenceFails) return { error: true };
            position++;
            return { data: options.unknownCheckpoint ? {} : { complete: false } };
        }
        if (name === 'release_provider_account_language_validation') {
            if (options.releaseFails) return { error: true };
            account = false; return { data: true };
        }
        if (name === 'release_provider_exact_file_probe') {
            assert.equal(args.p_identity_key, current.identityKey); assert.equal(args.p_external_id, current.itemId);
            assert.equal(args.p_item_type, current.itemType); identity = false; return { data: true };
        }
        if (name === 'finish_catalog_file_audio_validation_provider_attempt') return { data: { settled: true } };
        throw Error('unexpected fixture RPC ' + name);
    } };
    const context = vm.createContext({ crypto, HttpError, Date, AbortSignal, DOMException,
        console: { warn() {}, info() {} }, PLAYBACK_SESSION_UUID_PATTERN: /^[a-f0-9-]{36}$/,
        LANGUAGE_VALIDATION_TASK_BUDGET_MS: 270000, LANGUAGE_VALIDATION_FETCH_TIMEOUT_MS: 240000,
        LANGUAGE_VALIDATION_JOB_LEASE_SECONDS: 300, languageValidationTasks: new Map(),
        LANGUAGE_VALIDATION_LEASE_SECONDS: 300, LANGUAGE_VALIDATION_ACCOUNT_LEASE_SECONDS: 300,
        LANGUAGE_VALIDATION_SCOPE: 'lid', LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL: 1,
        LANGUAGE_VALIDATION_SAMPLE_DURATION_SECONDS: 20, LANGUAGE_VALIDATION_MAX_CONSECUTIVE_PROVIDER_NO_PROGRESS: 4,
        LANGUAGE_VALIDATION_GATEWAY_FAILURE_RETRY_MS: 300000,
        refreshLanguageBackgroundCapacity: async () => {
            events.push('capacity'); capacityChecks++;
            return !(options.capacityLostOnSecond && capacityChecks > 1);
        },
        recordOrEmpty: x => x || {}, stringOr: (x, fallback) => x ?? fallback, stringOrNull: x => x || null,
        boundedNullableInt: x => Number.isInteger(x) ? x : null,
        revalidateLanguageValidationClaim: async () => current, requireStrictLidWindowCount: () => 6,
        strictLidWindowStateFromClaim: () => ({ position, count: 6, protocol: 1, tokens: Array.from({ length: position }, (_, i) => 'opaque-' + (i + 1)) }),
        sameStrictLidWindowState: () => true, strictLidWindowCountForDuration: () => 6,
        resolvePlaybackTarget: async () => ({ targetUrl: 'https://fixture.invalid/file' }), assertHttpUrl() {},
        providerAccountHashFromUrl: async () => hash, providerAccountKeyFromUrl: () => 'fixture', sha256Hex: async () => hash,
        assertProviderCircuitClosed: async () => events.push('provider-circuit'),
        assertLanguageValidationIdle: async () => {
            events.push('provider-idle');
            if (options.viewerOnSecond && position > 0) throw new HttpError(409, '', { code: 'PROVIDER_ACCOUNT_BUSY' });
        }, languageValidationFetchBudgetMs: () => 230000,
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
                if (options.inferResponse) return options.inferResponse;
                return options.inferFails ? { ok: false, status: 409, payload: { code: 'preempted', ...drain } }
                    : { ok: true, status: 200, payload: { windowOrdinal: claims.windowOrdinal, windowCount: 6, receipt: 'opaque-' + claims.windowOrdinal, ...drain } };
            }
            if (action === 'ack') { if (options.ackFails) throw Error('lost ACK'); return { ok: true, payload: { acknowledged: true, ...drain } }; }
            if (action === 'legacy' && (options.enabled === false || options.captureFlagError)) {
                if (options.legacySuccess) return { ok: true, status: 200,
                    payload: { windowOrdinal: claims.windowOrdinal, windowCount: 6, receipt: 'legacy-' + claims.windowOrdinal, ...drain } };
                return { ok: false, status: 503, payload: { code: 'fixture-legacy-boundary', ...drain } };
            }
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
    vm.runInContext(stripTypeScriptTypes(section(edge, 'function scheduleLanguageValidationJob(', 'function languageValidationJobScheduleDue('), { mode: 'transform' }), context);
    if (options.realFailurePolicy) vm.runInContext(stripTypeScriptTypes(section(edge,
        'function languageValidationTaskErrorCode(', 'function languageValidationPendingResponse('), { mode: 'transform' }), context);
    return { events, failures, jobOwners, providerOwners,
        run: () => context.processOneLanguageValidationTrack(db, uuid),
        runScheduled: async () => {
            let pending;
            assert.equal(context.scheduleLanguageValidationJob(task => { pending = task; }, db, uuid), true);
            await pending;
        },
        slots: () => ({ account, identity }) };
}

test('scheduled capture continuation uses a new claim and both provider guards after the durable handoff', async () => {
    const f = edgeFixture(); await f.runScheduled();
    assert.deepEqual(f.failures, []);
    assert.equal(f.events.filter(e => e === 'fetch:capture').length, 2);
    assert.equal(f.events.filter(e => e === 'fetch:infer').length, 2);
    assert.equal(f.events.filter(e => e === 'capacity').length, 2);
    assert.equal(f.events.filter(e => e === 'provider-idle').length, 4);
    assert.equal(f.events.filter(e => e === 'provider-circuit').length, 4);
    assert.equal(new Set(f.jobOwners).size, 2, 'each stage claims afresh, then renews its own owner');
    assert.equal(new Set(f.providerOwners).size, 2);
    assert.ok(f.events.indexOf('fetch:ack') < f.events.indexOf('rpc:list_due_catalog_file_audio_validation_jobs'));
    assert.deepEqual(f.slots(), { account: false, identity: false });
});

test('cached local inference can continue after a durable receipt without obtaining a provider connection', async () => {
    const f = edgeFixture({ cached: true }); await f.runScheduled();
    assert.equal(f.events.filter(e => e === 'fetch:infer').length, 2);
    assert.equal(f.events.filter(e => e === 'fetch:capture').length, 0);
    assert.equal(f.providerOwners.length, 0);
    assert.equal(new Set(f.jobOwners).size, 2);
});

test('failed legacy account release keeps its lease and prevents a second provider read', async () => {
    const f = edgeFixture({ enabled: false, legacySuccess: true, releaseFails: true }); await f.runScheduled();
    assert.equal(f.events.filter(e => e === 'fetch:legacy').length, 1);
    assert.equal(f.events.filter(e => e === 'rpc:claim_provider_account_language_validation').length, 2);
    assert.equal(f.providerOwners.length, 1, 'the second account claim cannot steal the retained first lease');
    assert.equal(f.failures.length, 1);
    assert.equal(f.failures[0].errorCode, 'LANGUAGE_VALIDATION_PROVIDER_LEASE_BUSY');
    assert.deepEqual(f.slots(), { account: true, identity: false });
});

for (const flag of ['capacityLostOnSecond', 'claimDeniedOnSecond', 'viewerOnSecond', 'otherJobFirst', 'unknownCheckpoint', 'evidenceFails']) {
    test(`scheduled continuation stops for ${flag} without another capture`, async () => {
        const f = edgeFixture({ [flag]: true }); await f.runScheduled();
        assert.equal(f.events.filter(e => e === 'fetch:capture').length, 1);
        assert.equal(f.providerOwners.length, 1);
        assert.deepEqual(f.slots(), { account: false, identity: false });
    });
}

test('actual Edge worker persists capture and releases both leases BEFORE calling local inference', async () => {
    const f = edgeFixture(); await f.run(); assert.deepEqual(f.failures, []);
    const stages = ['fetch:status', 'provider-idle', 'fetch:capture', 'rpc:checkpoint_catalog_file_audio_capture',
        'fetch:infer', 'rpc:checkpoint_catalog_file_audio_validation_window', 'fetch:ack'];
    for (let i = 1; i < stages.length; i++) assert.ok(f.events.indexOf(stages[i - 1]) < f.events.indexOf(stages[i]), stages[i]);
    assert.deepEqual(f.slots(), { account: false, identity: false });
});

test('catalogue priority is requested before both unchanged provider admission checks', async () => {
    const f = edgeFixture({ yieldCooldown: true }); await f.run();
    assert.deepEqual(f.failures, []);
    assert.ok(f.events.indexOf('rpc:request_language_validation_catalog_yield') < f.events.indexOf('provider-idle'));
    assert.equal(f.events.filter(e => e === 'provider-idle').length, 2);
    assert.ok(f.events.indexOf('rpc:claim_provider_file_probe') < f.events.indexOf('fetch:capture'));
});

for (const option of ['yieldError', 'yieldMissing']) test(`${option} prevents provider acquisition`, async () => {
    const f = edgeFixture({ [option]: true }); await f.run();
    assert.ok(f.failures.length);
    for (const event of ['fetch:capture', 'rpc:claim_provider_file_probe', 'rpc:claim_provider_account_language_validation']) {
        assert.equal(f.events.includes(event), false);
    }
});

test('actual Edge retry uses local capture without idle checks, provider claims or another acquisition', async () => {
    const f = edgeFixture({ cached: true }); await f.run(); assert.deepEqual(f.failures, []);
    assert.ok(f.events.includes('fetch:infer')); assert.ok(f.events.includes('fetch:ack'));
    for (const event of ['provider-idle', 'provider-circuit', 'fetch:capture', 'rpc:claim_provider_file_probe',
        'rpc:claim_provider_account_language_validation', 'rpc:begin_catalog_file_audio_validation_provider_attempt']) {
        assert.equal(f.events.includes(event), false, event);
    }
});

test('actual Edge missing or denied job approval never uses the new capture path', async () => {
    for (const options of [{ enabled:false }, { captureFlagError:true }]) {
        const f=edgeFixture(options); await f.run();
        assert.ok(f.events.includes('rpc:catalog_language_capture_pipeline_enabled_for_job'));
        for (const action of ['status','capture','infer','ack']) assert.equal(f.events.includes('fetch:'+action),false);
        assert.ok(f.events.includes('provider-idle'), 'existing non-capture admission remains authoritative');
    }
});

test('actual Edge exact-file mode still owns the mono account and hands off both leases before inference', async () => {
    const f = edgeFixture({ exact: true }); await f.run(); assert.deepEqual(f.failures, []);
    assert.ok(f.events.indexOf('rpc:claim_provider_account_language_validation') < f.events.indexOf('rpc:claim_provider_exact_file_probe_for_source'));
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
        enrichmentPilot: { allowsFile: () => overrides.pilotDenied !== true },
        strictLidCaptureStore: { snapshot: () => ({ ready: true }) },
        strictLidWindowReceiptBinding: () => ({}), sha256Hex: () => hash, proxyKeyFromUrl: () => 'fixture',
        rejectWhileLidBenchmarkRuns: () => false, FFMPEG_USER_AGENT: 'fixture',
        strictLidCapturePipeline: { compute: async () => {
            if (overrides.failure) throw overrides.failure;
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

test('actual Gateway route preserves the terminal incomplete-MP4 classification', async () => {
    const f = gatewayFixture({ failure: Object.assign(new Error('fixed'), {
        code: 'MP4_DECLARED_MEDIA_EXCEEDS_FILE', status: 422, providerDrained: true }) });
    await f.run();
    assert.equal(f.res.statusCode, 422);
    assert.equal(f.res.payload.code, 'MP4_DECLARED_MEDIA_EXCEEDS_FILE');
    assert.equal(f.res.payload.providerDrained, true);
});
test('actual Gateway missing stored audio returns 409, never transparently downloads again', async () => {
    const f = gatewayFixture({ missing: true }); await f.run(); assert.equal(f.res.statusCode, 409);
    assert.equal(f.res.payload.code, 'LID_CAPTURE_NOT_FOUND'); assert.equal(f.res.payload.providerDrained, true);
    assert.deepEqual(f.called, ['infer']);
});

test('short no-speech PCM flows through actual sampler, Gateway and Edge as incomplete daily failure without another capture', async (t) => {
    const fsp = require('node:fs/promises');
    const os = require('node:os');
    const { prepareStrictLidSpeechSample } = require('../services/media-gateway/src/strict-lid-speech-sampler');
    const { planStrictSpeechWindow } = require('../services/media-gateway/src/strict-lid-speech-window');
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-short-capture-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('norva-short-capture-'));
        await fsp.rm(directory, { recursive: true, force: true });
    });
    const pcm = Buffer.alloc(44 + 611477 * 2);
    pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
    pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(16000, 24); pcm.writeUInt32LE(32000, 28);
    pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
    pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40);
    const wavPath = path.join(directory, 'raw.wav'); await fsp.writeFile(wavPath, pcm);
    const context = vm.createContext({ Date,
        createStrictLidCapturePipeline: options => options,
        capturePipelineError: code => Object.assign(new Error(code), { code }),
        planStrictSpeechWindow,
        runStrictSpeechSampler: (input, plan, options) => prepareStrictLidSpeechSample({
            wavPath: input, plan, ...options, bin: '/fixture/vad', model: '/fixture/model',
            runVadImpl: async () => ({ ok: true, outcome: 'succeeded', segments: [] }),
        }),
        runStrictWhisperBatch: () => assert.fail('no valid window must never reach language recognition'),
    });
    vm.runInContext(section(gateway, 'function initializeStrictLidCapturePipeline(',
        'async function handleStrictLidCaptureRequest('), context);
    let failure;
    try { await context.initializeStrictLidCapturePipeline({}).infer(wavPath,
        { durationSeconds: 5891.136, windowOrdinal: 6, samplingPass: 0 }, { accountKey: 'fixture' }, new AbortController().signal); }
    catch (error) { failure = error; }
    assert.equal(failure?.code, 'LID_CAPTURE_AUDIO_WINDOW_UNAVAILABLE');
    assert.deepEqual(await fsp.readFile(wavPath), pcm, 'existing PCM remains immutable');
    const g = gatewayFixture({ failure }); await g.run();
    assert.equal(g.res.statusCode, 422);
    assert.equal(g.res.payload.code, failure.code);
    assert.equal(g.res.payload.providerDrained, true);
    const f = edgeFixture({ cached: true, realFailurePolicy: true,
        inferResponse: { ok: false, status: g.res.statusCode, payload: g.res.payload } });
    await f.run();
    assert.equal(f.failures.length, 1);
    assert.equal(f.failures[0].errorCode, 'LANGUAGE_CAPTURE_AUDIO_WINDOW_UNAVAILABLE');
    assert.equal(f.failures[0].terminal, true);
    assert.equal(f.failures[0].retryAt, null, 'use existing daily failure default, not 30-second capture retry');
    for (const event of ['fetch:capture', 'fetch:ack', 'rpc:checkpoint_catalog_file_audio_validation_window',
        'rpc:reset_catalog_file_audio_validation_windows', 'rpc:claim_provider_account_language_validation']) {
        assert.equal(f.events.includes(event), false, event);
    }
});

test('Edge only terminates attested deterministic short-window failure; transient preparation failures keep local retry', async () => {
    for (const response of [
        { status: 502, payload: { code: 'LID_CAPTURE_PREPARATION_FAILED', ...drain } },
        { status: 422, payload: { code: 'LID_CAPTURE_AUDIO_WINDOW_UNAVAILABLE', providerDrained: false, providerDrainProtocol: 1 } },
        { status: 502, payload: { code: 'LID_CAPTURE_AUDIO_WINDOW_UNAVAILABLE', ...drain } },
    ]) {
        const before = Date.now();
        const f = edgeFixture({ cached: true, realFailurePolicy: true, inferResponse: { ok: false, ...response } });
        await f.run();
        assert.equal(f.failures[0].errorCode, 'LANGUAGE_CAPTURE_INFERENCE_DEFERRED');
        assert.equal(f.failures[0].terminal, false);
        assert.ok(Date.parse(f.failures[0].retryAt) >= before + 30000);
        assert.equal(f.events.includes('fetch:capture'), false);
    }
});

test('actual Gateway excludes an out-of-cohort capture action BEFORE touching retained audio or compute', async () => {
    const f=gatewayFixture({pilotDenied:true});await f.run();
    assert.equal(f.res.statusCode,429);assert.equal(f.res.payload.providerDrained,true);assert.deepEqual(f.called,[]);
});

test('actual Edge capability generator signs all capture modes, complete track list and opaque file scope',async()=>{
    const secret='fixture-secret-that-is-not-a-production-credential';
    const context=vm.createContext({HttpError,Date,Number,Set,encoder:new TextEncoder(),
        Deno:{env:{get:()=>undefined}},
        PLAYBACK_SESSION_UUID_PATTERN:/^[a-f0-9-]{36}$/,LANGUAGE_VALIDATION_WINDOW_CHECKPOINT_PROTOCOL:1,
        getRuntimeConfig:async()=>({mediaGatewayRouting:{defaultRoute:{url:'https://gateway.invalid',token:secret}}}),
        hmacBase64Url:async(key,value)=>crypto.createHmac('sha256',key).update(value).digest('base64url'),
        base64Url:bytes=>Buffer.from(bytes).toString('base64url')});
    vm.runInContext(stripTypeScriptTypes(section(edge,'async function createBytePipeCapability(',
        'async function createBytePipeAccess('),{mode:'transform'}),context);
    for(const action of ['status','capture','infer','ack']) {
        const fields={windowCheckpointProtocol:1,jobId:uuid,profileFingerprint:hash,windowCount:6,windowOrdinal:1,
            captureProtocol:1,captureAction:action,captureTrackIndex:1,enrichmentFileKey:'b'.repeat(64),
            ...(action==='capture'?{captureTrackIndices:[1,2,4,8]}:{}),...(action==='infer'?{captureRelease:uuid}:{})};
        const access=await context.createBytePipeCapability('session','owner','https://fixture.invalid/file',
            new Date(Date.now()+120000).toISOString(),{},null,'lid-legacy-full',1000000,3600,fields);
        const [payload64,signature]=access.capability.split('.');
        const raw=Buffer.from(payload64,'base64url').toString(),payload=JSON.parse(raw);
        assert.equal(signature,crypto.createHmac('sha256',secret).update(raw).digest('base64url'));
        assert.equal(payload.enrichmentFileKey,fields.enrichmentFileKey);assert.equal(payload.captureAction,action);
        assert.deepEqual(payload.captureTrackIndices,action==='capture'?[1,2,4,8]:[1]);
    }
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

test('actual capture extraction keeps broker failure authoritative even after FFmpeg exits successfully', async () => {
    for (const ok of [true, false]) {
        let pipeline; let audioReads = 0;
        const upstream = Object.assign(Error('private provider failure'), { code: 'RANGE_LENGTH_MISMATCH', status: 502 });
        let result = { ok, processClosed: true };
        const context = vm.createContext({
            Buffer, path, createStrictLidCapturePipeline: options => { pipeline = options; return options; },
            capturePipelineError: code => Object.assign(Error(code), { code }),
            selectionEnrichmentPolicy: { describe: () => true }, sha256Hex: () => hash,
            isAccountJobBusy: () => false, withAccountJobLock: async (_key, fn) => fn(),
            planStrictSpeechWindow: () => ({ searchStartSeconds: 3600, searchDurationSeconds: 60 }),
            runStrictLidMultiExtract: async () => result,
            FFMPEG_PATH: 'fixture', loopbackOnlyEnv: () => ({}),
            fsp: { open: async () => ({ close: async () => {} }),
                stat: async () => ({ size: 64 }), readFile: async () => { audioReads++; return Buffer.alloc(64); } },
        });
        vm.runInContext(section(gateway, 'function initializeStrictLidCapturePipeline(', 'async function handleStrictLidCaptureRequest('), context);
        context.initializeStrictLidCapturePipeline({ withWorkspace: fn => fn('/tmp/fixture.wav') });
        const binding = { trackIndex: 1, durationSeconds: 7200, windowOrdinal: 4 };
        const input = { url: 'https://fixture.invalid/movie', selectionCapability: {} };
        await assert.rejects(pipeline.extract({ inputUrl: 'http://127.0.0.1/fixture', terminalError: upstream }, binding, input), error => error === upstream);
        assert.equal(audioReads, 0, 'provider failure cannot reach audio persistence');
        result = { ok: false, preempted: true };
        await assert.rejects(pipeline.extract({ terminalError: upstream }, binding, input), { code: 'LANGUAGE_VALIDATION_VIEWER_PREEMPTED' });
        result = { ok: true, processClosed: true };
        assert.equal((await pipeline.extract({ terminalError: null }, binding, input)).length, 64);
        assert.equal(audioReads, 1);
    }
});

test('captured audio permits a slow full-model quality fallback without a new provider request', async () => {
    let time = 0; let pipeline; let passes = 0;
    const { createStrictLidInference } = require('../services/media-gateway/src/strict-lid-inference');
    const engine = createStrictLidInference({ now: () => time });
    const signal = new AbortController().signal;
    const context = vm.createContext({
        Date: { now: () => time },
        createStrictLidCapturePipeline: options => { pipeline = options; return options; },
        capturePipelineError: code => Object.assign(Error(code), { code }),
        planStrictSpeechWindow: () => ({}),
        runStrictSpeechSampler: async () => { time += 5000; return { ok: true, offset: 0, selection: {} }; },
        runStrictWhisperBatch: (paths, options) => engine.run({ ...options, wavPaths: paths, vadModel: 'fixture' }, async args => {
            const duration = ++passes === 1 ? 20000 : 60000;
            time += Math.min(duration, args.timeoutMs);
            if (args.timeoutMs < duration) return { ok: false, timedOut: true, samples: [] };
            return { ok: true, samples: [{ disposition: passes === 1 ? 'weak' : 'accepted', result: { language: 'te' } }] };
        }),
        strictLanguageBatchSampleResult: sample => sample,
        createStrictLidWindowReceipt: ({ evidence }) => evidence.disposition,
        GATEWAY_TOKEN: 'fixture',
    });
    vm.runInContext(section(gateway, 'function initializeStrictLidCapturePipeline(', 'async function handleStrictLidCaptureRequest('), context);
    context.initializeStrictLidCapturePipeline({});
    const result = await pipeline.infer('/private/fixture.wav', { durationSeconds: 3600, windowOrdinal: 1, windowCount: 6 },
        { accountKey: 'fixture' }, signal);
    assert.equal(result.receipt, 'accepted');
    assert.equal(time, 85000);
    assert.equal(passes, 2);
    assert.equal(engine.health().qualityFallbackRecoveredSamples, 1);
});

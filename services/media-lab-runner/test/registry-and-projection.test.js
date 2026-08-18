'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    FIXTURE_IDS,
    FIXTURES,
    parseRunRequest,
    RequestValidationError,
} = require('../src/fixture-registry');
const { projectResult } = require('../src/result-projection');
const { MediaLabRunner, provisionalResult } = require('../src/runner');
const { readManifest, buildPlan, main } = require('../scripts/generate-fixtures');
const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
const pgsSeedGenerator = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'generate-pgs-seed.py'),
    'utf8',
);

function runnerSourceDigest() {
    const projectRoot = path.join(__dirname, '..', '..', '..');
    const files = [
        'services/media-lab-runner/Dockerfile',
        'services/media-lab-runner/package.json',
        'services/media-lab-runner/package-lock.json',
        'services/media-gateway/src/ocr_pgs.py',
        'public/js/vendor/hls-1.5.7.min.js',
    ];
    const walk = (relativeDirectory) => {
        for (const entry of fs.readdirSync(path.join(projectRoot, relativeDirectory), { withFileTypes: true })) {
            const relativePath = path.posix.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) walk(relativePath);
            else if (entry.isFile()) files.push(relativePath);
        }
    };
    for (const directory of [
        'services/media-lab-runner/src',
        'services/media-lab-runner/scripts',
        'services/media-lab-runner/fixtures',
    ]) walk(directory);
    const manifest = files.sort().map((relativePath) => {
        const digest = require('node:crypto').createHash('sha256')
            .update(fs.readFileSync(path.join(projectRoot, relativePath)))
            .digest('hex');
        return `${digest}  ${relativePath}\n`;
    }).join('');
    return require('node:crypto').createHash('sha256').update(manifest).digest('hex');
}

test('the registry is an exact fixed eleven-fixture corpus', () => {
    assert.equal(FIXTURE_IDS.length, 11);
    assert.equal(FIXTURES.length, 11);
    assert.deepEqual(FIXTURES.map((fixture) => fixture.id), [...FIXTURE_IDS]);
    assert.deepEqual(FIXTURE_IDS, [
        'h264-closed-aac',
        'h264-closed-ac3',
        'h264-open-gop',
        'h264-multi-audio',
        'hevc-eac3-cold',
        'h264-level52',
        'h264-bad-timestamps',
        'h264-pgs',
        'h264-no-etag',
        'hevc-full-cache',
        'provider-458',
    ]);
    assert.equal(new Set(FIXTURE_IDS).size, 11);
    assert.equal(FIXTURES.find((item) => item.id === 'h264-no-etag').provider.etag, 'weak');
    assert.equal(FIXTURES.find((item) => item.id === 'hevc-full-cache').provider.seedBeforeMeasure, true);
    assert.equal(FIXTURES.find((item) => item.id === 'hevc-full-cache').provider.providerExpected, false);
    assert.equal(FIXTURES.find((item) => item.id === 'provider-458').provider.first458, true);
    assert.equal(FIXTURES.find((item) => item.id === 'h264-closed-aac').provider.expectedGets, 2);
    assert.equal(FIXTURES.find((item) => item.id === 'h264-open-gop').provider.expectedGets, 1);
    assert.equal(FIXTURES.find((item) => item.id === 'hevc-full-cache').provider.expectedGets, 0);
    assert.ok(FIXTURES.filter((item) => item.id !== 'provider-458').every((item) => item.expected.under10Seconds));
    assert.equal(FIXTURES.find((item) => item.id === 'h264-open-gop').expected.runtimeReason, 'vaapi-transcode-ready');
    assert.equal(FIXTURES.find((item) => item.id === 'hevc-full-cache').expected.runtimeReason, 'complete-hls-cache-hit');
    assert.deepEqual(FIXTURES.find((item) => item.id === 'h264-level52').expected.runtimeReasons, [
        'vaapi-transcode-ready',
        'encode-rate-below-minimum',
    ]);
});

test('a matching pipeline cannot hide a mismatched Gateway startup policy', () => {
    const fixture = FIXTURES.find((item) => item.id === 'h264-open-gop');
    const physical = {
        protocol: 1,
        kind: 'norva-media-lab-physical-v1',
        status: 'pass',
        pipeline: 'video-transcode',
        reason: 'open-gop',
        gatewayObserved: true,
        browserObserved: true,
        cleanupObserved: true,
        metrics: {
            ttffMs: 900,
            manifestReadyMs: 600,
            firstSegmentMs: 700,
            bufferedAheadSeconds: 6,
            productionRateX: 10,
            browserBufferRateX: 10,
            rebufferCount: 0,
            rebufferMs: 0,
            ffmpegSpawns: 1,
            analyzerSpawns: 0,
            seekPassed: true,
            audioPassed: true,
        },
    };
    const provider = { providerGets: 1, maximumConcurrentProviderGets: 1, http458: 0 };
    const rejected = provisionalResult(fixture, physical, provider);
    assert.equal(rejected.status, 'fail');
    assert.equal(rejected.reason, 'runtime-policy-mismatch');

    const accepted = provisionalResult(fixture, { ...physical, reason: 'vaapi-transcode-ready' }, provider);
    assert.equal(accepted.status, 'pass');
    assert.equal(accepted.reason, 'open-gop');
});

test('the Level 5.2 stress fixture accepts only the two threshold-adjacent VAAPI policies', () => {
    const fixture = FIXTURES.find((item) => item.id === 'h264-level52');
    const physical = {
        protocol: 1,
        kind: 'norva-media-lab-physical-v1',
        status: 'pass',
        pipeline: 'video-transcode',
        reason: 'encode-rate-below-minimum',
        gatewayObserved: true,
        browserObserved: true,
        cleanupObserved: true,
        metrics: {
            ttffMs: 2_400,
            manifestReadyMs: 2_000,
            firstSegmentMs: 2_200,
            bufferedAheadSeconds: 4,
            productionRateX: 1.99,
            browserBufferRateX: 10,
            rebufferCount: 0,
            rebufferMs: 0,
            ffmpegSpawns: 1,
            analyzerSpawns: 2,
            seekPassed: true,
            audioPassed: true,
        },
    };
    const provider = { providerGets: 1, maximumConcurrentProviderGets: 1, http458: 0 };
    assert.equal(provisionalResult(fixture, physical, provider).status, 'pass');
    assert.equal(provisionalResult(fixture, { ...physical, reason: 'encode-rate-unavailable' }, provider).status, 'fail');
});

test('a playback verdict does not erase independently successful cleanup evidence', async () => {
    const providerRun = {
        mediaUrl: 'http://127.0.0.1:8093/provider/h264-closed-aac',
        snapshot() {
            return { providerGets: 2, maximumConcurrentProviderGets: 1, http458: 0 };
        },
        close() { return true; },
        capabilityActive() { return false; },
    };
    const runner = new MediaLabRunner({
        providerSimulator: {
            async fixtureAvailable() { return true; },
            async openFixture() { return providerRun; },
        },
        getProviderBaseUrl: () => 'http://127.0.0.1:8093',
        adapter: {
            async runPhysicalCase({ fixture }) {
                return {
                    protocol: 1,
                    kind: 'norva-media-lab-physical-v1',
                    status: 'pass',
                    pipeline: fixture.expected.pipeline,
                    reason: fixture.expected.runtimeReason,
                    gatewayObserved: true,
                    browserObserved: true,
                    cleanupObserved: true,
                    metrics: {
                        ttffMs: 500,
                        manifestReadyMs: 250,
                        firstSegmentMs: 350,
                        bufferedAheadSeconds: 6,
                        productionRateX: 10,
                        browserBufferRateX: 10,
                        rebufferCount: 1,
                        rebufferMs: 150,
                        ffmpegSpawns: 1,
                        analyzerSpawns: 0,
                        seekPassed: true,
                        audioPassed: true,
                    },
                };
            },
        },
    });
    const result = await runner.runCase({ protocol: 1, fixtureId: 'h264-closed-aac' });
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'playback-validation-failed');
    assert.equal(result.cleanupPassed, true);
});

test('run requests accept only protocol and one fixed fixture ID', () => {
    assert.equal(parseRunRequest({ protocol: 1, fixtureId: 'h264-closed-aac' }).id, 'h264-closed-aac');
    for (const invalid of [
        null,
        [],
        { protocol: '1', fixtureId: 'h264-closed-aac' },
        { protocol: 1, fixtureId: 'unknown' },
        { protocol: 1, fixtureId: 'h264-closed-aac', strategy: 'legacy' },
        { protocol: 1, fixtureId: 'https://provider.invalid/private.mkv' },
        { protocol: 1, fixtureId: 'h264-closed-aac', providerUrl: 'https://provider.invalid' },
    ]) {
        assert.throws(() => parseRunRequest(invalid), RequestValidationError);
    }
    const inherited = Object.create({ providerUrl: 'https://provider.invalid' });
    inherited.protocol = 1;
    inherited.fixtureId = 'h264-closed-aac';
    assert.throws(() => parseRunRequest(inherited), RequestValidationError);
});

test('the physical result projection is bounded and cannot emit URLs, IDs, secrets or raw errors', () => {
    const result = projectResult({
        protocol: 99,
        status: 'pass',
        pipeline: 'video-copy-audio-copy',
        reason: 'mkv-h264-copy-ready',
        ttffMs: 6_321.12349,
        manifestReadyMs: 1_500,
        firstSegmentMs: 1_800,
        bufferedAheadSeconds: 8,
        productionRateX: 2,
        browserBufferRateX: 2,
        rebufferCount: 0,
        rebufferMs: 0,
        providerGets: 1,
        maximumConcurrentProviderGets: 1,
        ffmpegSpawns: 1,
        analyzerSpawns: 0,
        http458: 0,
        retriesAfter458: 0,
        seekPassed: true,
        audioPassed: true,
        cleanupPassed: true,
        fixtureId: 'h264-closed-aac',
        runId: 'run-secret',
        providerUrl: 'https://provider.invalid/private.mkv',
        accessToken: 'Bearer secret',
        stack: 'private path',
        raw: { secret: true },
    });
    assert.equal(result.protocol, 1);
    assert.equal(result.ttffMs, 6_321.123);
    assert.deepEqual(Object.keys(result), [
        'protocol', 'status', 'pipeline', 'reason', 'ttffMs', 'manifestReadyMs',
        'firstSegmentMs', 'bufferedAheadSeconds', 'productionRateX',
        'browserBufferRateX', 'rebufferCount', 'rebufferMs', 'providerGets',
        'maximumConcurrentProviderGets', 'ffmpegSpawns', 'analyzerSpawns',
        'http458', 'retriesAfter458', 'seekPassed', 'audioPassed', 'cleanupPassed',
    ]);
    assert.doesNotMatch(JSON.stringify(result), /fixture|run-secret|https?:|bearer|private|raw/i);

    for (const invalid of [
        { status: 'pass', pipeline: 'other', reason: 'ok' },
        { status: 'pass', pipeline: 'cache-hit', reason: 'https://leak.invalid' },
        { status: 'pass', pipeline: 'cache-hit', reason: 'ok', providerGets: 1.5 },
        { status: 'pass', pipeline: 'cache-hit', reason: 'ok', ttffMs: Number.NaN },
        { status: 'pass', pipeline: 'cache-hit', reason: 'ok', ttffMs: 600_001 },
    ]) assert.throws(() => projectResult(invalid), /INVALID_MEDIA_LAB_RESULT/);
});

test('fixture generation manifest and command plan are stable and match the fixed registry', async () => {
    const manifest = readManifest();
    const first = buildPlan(manifest, path.join('C:\\', 'fixed-output'));
    const second = buildPlan(manifest, path.join('C:\\', 'fixed-output'));
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((item) => item.id), [...FIXTURE_IDS]);
    assert.equal(first.find((item) => item.id === 'provider-458').state, 'response-only');
    assert.equal(first.find((item) => item.id === 'h264-pgs').state, 'requires-pinned-seed');
    assert.equal(first.find((item) => item.id === 'h264-bad-timestamps').state, 'requires-post-generation-verification');
    assert.match(
        first.find((item) => item.id === 'h264-level52').args.join(' '),
        /duration=4(?:\s|$)/,
    );
    assert.match(JSON.stringify(first), /2026-08-17T00:00:00Z/);
    assert.doesNotMatch(JSON.stringify(first), /https?:\/\//i);
    await assert.rejects(() => main(['--unknown']), /Usage:/);

    const manifestSource = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'manifest.json'), 'utf8');
    assert.doesNotMatch(manifestSource, /providerUrl|account|credential|token|https?:\/\//i);
});

test('production image builds the fixed media corpus and synthesizes its PGS seed locally', () => {
    assert.match(dockerfile, /FROM node:22-bookworm-slim AS fixture-builder/);
    assert.match(dockerfile, /COPY services\/media-gateway\/src\/ocr_pgs\.py \.\/tools\/ocr_pgs\.py/);
    assert.match(dockerfile, /generate-pgs-seed\.py[\s\S]*generate-fixtures\.js --execute/);
    assert.match(dockerfile, /--from=fixture-builder \/build\/fixtures \.\/fixtures/);
    assert.match(pgsSeedGenerator, /module\._synth_cue_segments/);
    assert.match(pgsSeedGenerator, /module\.parse_sup/);
    assert.doesNotMatch(pgsSeedGenerator, /https?:\/\//);
});

test('the immutable runner source marker covers every file copied into its image', () => {
    const markerPath = path.join(__dirname, '..', '..', '..', 'ops', 'hetzner', 'media', 'media-lab-runner-source.sha256');
    const expected = fs.readFileSync(markerPath, 'utf8').trim();
    assert.match(expected, /^[0-9a-f]{64}$/);
    assert.equal(runnerSourceDigest(), expected);
});

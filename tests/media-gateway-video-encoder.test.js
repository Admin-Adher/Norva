'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');

const {
    preflightVideoEncoder,
    publicVideoEncoderStatus,
    resolveVideoEncoderConfig,
    videoEncoderInputArgs,
    videoEncoderOutputArgs,
} = require('../services/media-gateway/src/video-encoder');

function characterDeviceFileSystem() {
    return {
        statSync(value) {
            assert.equal(value, '/dev/dri/renderD128');
            return { isCharacterDevice: () => true };
        },
    };
}

test('software encoding remains the default and preserves the libx264 graph', () => {
    const config = resolveVideoEncoderConfig({}, null);
    assert.deepEqual(config, {
        protocol: 1,
        backend: 'software',
        hardware: false,
        device: null,
        preflight: 'not-required',
    });
    assert.deepEqual(preflightVideoEncoder(config), { ready: true, status: 'software-ready' });
    assert.deepEqual(videoEncoderInputArgs(config, true), []);
    const normal = videoEncoderOutputArgs(config, { forceAligned: false, targetSeconds: 4 });
    assert.equal(normal[normal.indexOf('-c:v') + 1], 'libx264');
    assert.equal(normal.includes('-force_key_frames'), false);
    const aligned = videoEncoderOutputArgs(config, { forceAligned: true, targetSeconds: 2 });
    assert.equal(aligned[aligned.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*2)');
});

test('VAAPI is explicit, device-bound and preflighted with one local frame', () => {
    const config = resolveVideoEncoderConfig({
        MEDIA_GATEWAY_VIDEO_ENCODER: 'vaapi',
        MEDIA_GATEWAY_VAAPI_DEVICE: '/dev/dri/renderD128',
    }, characterDeviceFileSystem());
    let call = null;
    const preflight = preflightVideoEncoder(config, {
        ffmpegPath: '/opt/ffmpeg/ffmpeg',
        spawnSync(binary, args, options) {
            call = { binary, args, options };
            return { status: 0 };
        },
    });
    assert.deepEqual(preflight, { ready: true, status: 'vaapi-ready' });
    assert.equal(call.binary, '/opt/ffmpeg/ffmpeg');
    assert.equal(call.args[call.args.indexOf('-vaapi_device') + 1], '/dev/dri/renderD128');
    assert.equal(call.args[call.args.indexOf('-c:v') + 1], 'h264_vaapi');
    assert.equal(call.args[call.args.indexOf('-frames:v') + 1], '1');
    assert.equal(call.options.timeout, 15_000);
    assert.equal(call.options.stdio, 'ignore');
});

test('VAAPI graph uploads NV12, requests HLS-boundary IDRs and never affects copy mode', () => {
    const config = resolveVideoEncoderConfig({ MEDIA_GATEWAY_VIDEO_ENCODER: 'vaapi' }, characterDeviceFileSystem());
    assert.deepEqual(videoEncoderInputArgs(config, false), []);
    assert.deepEqual(videoEncoderInputArgs(config, true), ['-vaapi_device', '/dev/dri/renderD128']);
    const args = videoEncoderOutputArgs(config, { forceAligned: false, targetSeconds: 4 });
    assert.equal(args[args.indexOf('-vf') + 1], 'format=nv12,hwupload');
    assert.equal(args[args.indexOf('-c:v') + 1], 'h264_vaapi');
    assert.equal(args[args.indexOf('-qp') + 1], '23');
    assert.equal(args[args.indexOf('-bf') + 1], '0');
    assert.equal(args[args.indexOf('-force_key_frames') + 1], 'expr:gte(t,n_forced*4)');
    assert.equal(args.includes('libx264'), false);
});

test('invalid or unavailable VAAPI configuration fails closed without software fallback', () => {
    assert.throws(
        () => resolveVideoEncoderConfig({ MEDIA_GATEWAY_VIDEO_ENCODER: 'cuda' }),
        { code: 'VIDEO_ENCODER_BACKEND_INVALID' },
    );
    assert.throws(
        () => resolveVideoEncoderConfig({
            MEDIA_GATEWAY_VIDEO_ENCODER: 'vaapi',
            MEDIA_GATEWAY_VAAPI_DEVICE: '/tmp/renderD128',
        }),
        { code: 'VIDEO_ENCODER_VAAPI_DEVICE_INVALID' },
    );
    assert.throws(
        () => resolveVideoEncoderConfig({ MEDIA_GATEWAY_VIDEO_ENCODER: 'vaapi' }, {
            statSync() { throw new Error('missing'); },
        }),
        { code: 'VIDEO_ENCODER_VAAPI_DEVICE_MISSING' },
    );
    const config = resolveVideoEncoderConfig({ MEDIA_GATEWAY_VIDEO_ENCODER: 'vaapi' }, characterDeviceFileSystem());
    assert.throws(
        () => preflightVideoEncoder(config, { spawnSync: () => ({ status: 1 }) }),
        { code: 'VIDEO_ENCODER_VAAPI_PREFLIGHT_FAILED' },
    );
    assert.equal(publicVideoEncoderStatus(config, { ready: true, status: 'vaapi-ready' }).backend, 'vaapi');
});

test('the production image carries the Mesa VAAPI driver but keeps software as the environment default', () => {
    const root = path.join(__dirname, '..');
    const dockerfile = fs.readFileSync(path.join(root, 'services/media-gateway/Dockerfile'), 'utf8');
    const environment = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    assert.match(dockerfile, /ffmpeg\s+mesa-va-drivers/);
    assert.match(dockerfile, /^ARG WHISPER_BUILD_JOBS=4$/m);
    assert.match(dockerfile, /cmake --build build --parallel "\$\{WHISPER_BUILD_JOBS\}"/);
    assert.doesNotMatch(dockerfile, /cmake --build build -j(?:\s|\\)/);
    assert.match(dockerfile, /RUN npm ci --omit=dev --ignore-scripts/);
    assert.doesNotMatch(dockerfile, /RUN npm install --omit=dev/);
    assert.match(environment, /^MEDIA_GATEWAY_VIDEO_ENCODER=software$/m);
    assert.match(environment, /^MEDIA_GATEWAY_VAAPI_DEVICE=\/dev\/dri\/renderD128$/m);
});

test('video encoder capacity follows only encode children and releases deterministically', () => {
    const gateway = fs.readFileSync(path.join(__dirname, '..', 'services/media-gateway/src/index.js'), 'utf8')
        .replace(/\r\n?/g, '\n');
    const start = gateway.indexOf('const activeVideoEncoderAdmissions = new Set();');
    const end = gateway.indexOf('// sourceUrl -> { profile, expiresAt }', start);
    assert.ok(start >= 0 && end > start);
    const harness = vm.runInNewContext(`(() => {
        const MAX_ACTIVE_VIDEO_ENCODER_SESSIONS = 1;
        const videoModeForSession = (session) => session.videoMode;
        ${gateway.slice(start, end)}
        return { activeVideoEncoderAdmissions, reserveVideoEncoderAdmission, releaseVideoEncoderAdmission };
    })()`);
    const copy = { id: 'copy', videoMode: 'copy' };
    const first = { id: 'encode-1', videoMode: 'encode' };
    const second = { id: 'encode-2', videoMode: 'encode' };
    assert.equal(harness.reserveVideoEncoderAdmission(copy), true);
    assert.equal(harness.activeVideoEncoderAdmissions.size, 0);
    assert.equal(harness.reserveVideoEncoderAdmission(first), true);
    assert.equal(harness.activeVideoEncoderAdmissions.size, 1);
    assert.equal(harness.reserveVideoEncoderAdmission(second), false);
    harness.releaseVideoEncoderAdmission(first);
    assert.equal(harness.reserveVideoEncoderAdmission(second), true);
    harness.releaseVideoEncoderAdmission(second);
    assert.equal(harness.activeVideoEncoderAdmissions.size, 0);
});

test('shared-host VAAPI compose is private, single-instance and resource bounded', () => {
    const root = path.join(__dirname, '..');
    const composePath = path.join(root, 'ops/hetzner/media/docker-compose.vaapi.yml');
    const compose = yaml.load(fs.readFileSync(composePath, 'utf8'));
    const gateway = compose?.services?.gateway;
    assert.ok(gateway);
    assert.equal(gateway.image, '${MEDIA_GATEWAY_IMAGE:?MEDIA_GATEWAY_IMAGE is required}');
    assert.equal(gateway.pull_policy, 'never');
    assert.deepEqual(gateway.ports, ['127.0.0.1:${MEDIA_GATEWAY_HOST_PORT:-8081}:8080']);
    assert.deepEqual(gateway.devices, ['/dev/dri/renderD128:/dev/dri/renderD128']);
    assert.deepEqual(gateway.group_add, ['${RENDER_GID:?RENDER_GID is required}']);
    assert.equal(gateway.cpus, '${MEDIA_GATEWAY_CPUS:-6.0}');
    assert.equal(gateway.mem_limit, '${MEDIA_GATEWAY_MEMORY_LIMIT:-10g}');
    assert.equal(gateway.pids_limit, 512);
    assert.deepEqual(gateway.cap_drop, ['ALL']);
    assert.equal(gateway.privileged, undefined);
    assert.equal(gateway.environment.MEDIA_GATEWAY_VIDEO_ENCODER, 'vaapi');
    assert.equal(gateway.environment.MAX_ACTIVE_VIDEO_ENCODER_SESSIONS, '${MAX_ACTIVE_VIDEO_ENCODER_SESSIONS:-4}');
    assert.equal(gateway.environment.MKV_CACHE_COORDINATION_MODE, 'local');
    assert.equal(gateway.environment.MKV_CACHE_SINGLE_INSTANCE_ATTESTED, 'true');
    assert.equal(compose.networks['norva-internal'].external, true);
    assert.equal(compose.networks['norva-internal'].name, '${NORVA_DOCKER_NETWORK:-norva_default}');
    assert.deepEqual(gateway.command.slice(0, 6), ['ionice', '-c2', '-n7', 'nice', '-n', '10']);
    assert.match(gateway.healthcheck.test.at(-1), /videoEncoder\?\.backend !== 'vaapi'/);
    assert.match(gateway.healthcheck.test.at(-1), /mkvCompleteHlsCache\?\.enabled !== true/);
});

test('shared-host runtime preparation is revision-pinned and never prints secrets', () => {
    const root = path.join(__dirname, '..');
    const script = fs.readFileSync(path.join(root, 'ops/hetzner/media/prepare-vaapi-runtime.sh'), 'utf8');
    assert.match(script, /EXPECTED_IMAGE='norva-media-gateway:vaapi-27a72a5fbf51'/);
    assert.match(script, /EXPECTED_IMAGE_ID='sha256:0a46547ba4d365f1132fc0471b4500cd428683624f0097497659c59ec0384ece'/);
    assert.match(script, /EXPECTED_BUNDLE_SHA256='27a72a5fbf51e43a34cf41a08383b912fceeb70fce07b11d40a24f7ea1ccdd56'/);
    assert.match(script, /^NORVA_EDGE_CALLBACK_BASE=http:\/\/127\.0\.0\.1:9$/m);
    assert.doesNotMatch(script, /^NORVA_EDGE_CALLBACK_BASE=https:\/\/api\.norva\.tv/m);
    assert.match(script, /\[\[ ! -e "\$\{ENV_PATH\}" \]\] \|\| die 'env-already-exists'/);
    assert.match(script, /docker compose --env-file "\$\{TEMP_ENV\}"[^\n]+config -q/);
    assert.match(script, /chmod 0600 "\$\{ENV_PATH\}"/);
    assert.doesNotMatch(script, /printf[^\n]*(?:GATEWAY_TOKEN_VALUE|PROOF_HMAC_KEY|CACHE_HMAC_KEY)/);
    assert.doesNotMatch(script, /set -x|env-already-exists.*rm -f/);
});

test('private VAAPI smoke uses only a local range provider and never prints the gateway secret', () => {
    const root = path.join(__dirname, '..');
    const provider = fs.readFileSync(path.join(root, 'ops/hetzner/media/private-vaapi-smoke-provider.mjs'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'ops/hetzner/media/private-vaapi-smoke-client.mjs'), 'utf8');
    const runner = fs.readFileSync(path.join(root, 'ops/hetzner/media/run-private-vaapi-smoke.sh'), 'utf8');
    assert.match(provider, /Content-Range/);
    assert.match(provider, /ETag: etag/);
    assert.match(provider, /maximumConcurrent/);
    assert.match(client, /videoMode === 'encode'/);
    assert.match(client, /audioMode === 'transcode'/);
    assert.match(client, /startupTimings\?\.videoEncoder === 'vaapi'/);
    assert.match(client, /startupPolicy\?\.eligible === true/);
    assert.match(client, /startupPolicy\?\.reason === 'vaapi-transcode-ready'/);
    assert.match(client, /startupPolicy\?\.minimumEncodeRateX\) === 2/);
    assert.match(client, /unauthorizedResponse\.status === 401/);
    assert.match(client, /sourceAfter\.maximumConcurrent === 1/);
    assert.match(client, /seekOffset: 1/);
    assert.match(client, /completeHlsCachePublished !== true/);
    assert.match(client, /entry\?\.playbackSessionId === CANARY_PLAYBACK_SESSION_ID/);
    assert.match(runner, /--network none/);
    assert.match(runner, /NORVA_EDGE_CALLBACK_BASE=http:\/\/127\.0\.0\.1:9/);
    assert.match(runner, /docker exec -i norva-media-gateway node --input-type=module -/);
    assert.doesNotMatch(runner, /cat .*\.env\.media-vaapi|set -x|echo .*GATEWAY_TOKEN/);
    assert.doesNotMatch(client, /console\.log\([^\n]*(?:TOKEN|sourceUrl|hlsUrl)/);
});

test('private H264 fast-path smoke trains full-file proof and measures copy without cache masking', () => {
    const root = path.join(__dirname, '..');
    const client = fs.readFileSync(path.join(root, 'ops/hetzner/media/private-h264-fastpath-smoke-client.mjs'), 'utf8');
    const runner = fs.readFileSync(path.join(root, 'ops/hetzner/media/run-private-h264-fastpath-smoke.sh'), 'utf8');
    assert.match(client, /training\.videoMode === 'encode'/);
    assert.match(client, /mkvH264FastStartProof/);
    assert.match(client, /replay\.videoMode === 'copy'/);
    assert.match(client, /expectedAudioMode: 'copy'/);
    assert.match(client, /expectedAudioMode: 'transcode'/);
    assert.match(client, /replay\.startupPolicy\?\.eligible === true/);
    assert.match(client, /replay\.startupTimings\.totalMs\) < 10_000/);
    assert.match(client, /sourceAfter\.getRequests === 2/);
    assert.match(client, /sourceAfter\.maximumConcurrent === 1/);
    assert.match(runner, /MKV_COMPLETE_HLS_CACHE_ENABLED=false/);
    assert.match(runner, /--read-only/);
    assert.match(runner, /--tmpfs \/tmp:rw,nosuid,nodev,noexec/);
    assert.match(runner, /NORVA_CANARY_CASE=aac/);
    assert.match(runner, /NORVA_CANARY_CASE=eac3/);
    assert.match(runner, /-c:v libx264/);
    assert.match(runner, /open-gop=0/);
    assert.doesNotMatch(runner.slice(0, runner.indexOf("echo '===START_EPHEMERAL_CACHELESS_GATEWAY==='")), /h264_vaapi/);
    assert.doesNotMatch(runner, /set -x|echo .*GATEWAY_TOKEN|cat .*\.env\.media-vaapi/);
    assert.doesNotMatch(client, /console\.log\([^\n]*(?:TOKEN|sourceUrl|hlsUrl|mkvH264FastStartProof)/);
});

test('promoted private Gateway soak is revision-pinned, read-only and checks every idle resource', () => {
    const root = path.join(__dirname, '..');
    const script = fs.readFileSync(path.join(root, 'ops/hetzner/media/soak-private-vaapi-gateway.sh'), 'utf8');
    assert.match(script, /EXPECTED_IMAGE='norva-media-gateway:vaapi-53705bd7e404'/);
    assert.match(script, /EXPECTED_IMAGE_ID='sha256:7d4cd36a567785471be857d4b4464755a36b734dab430eb8f6675b51cd8bf3af'/);
    assert.match(script, /EXPECTED_BUNDLE_SHA256='53705bd7e404f5a1805c4ff3ab75cd2ef81f3f38ac843d7135c4e2f3856d2c11'/);
    assert.match(script, /NORVA_EDGE_CALLBACK_BASE=http:\/\/127\.0\.0\.1:9/);
    for (const field of [
        'activeSessions === 0',
        'totalSessions === 0',
        'videoEncoderCapacity?.active === 0',
        'vodInputPump?.active === 0',
        'rawPumpCount === 0',
        'viewerStartupReservations === 0',
        'viewerSessionStartupAdmissions === 0',
        'viewerSessionStartupLockCount === 0',
        'viewerSessionStartupWaiters === 0',
        'backgroundCpuProcessCount === 0',
    ]) assert.ok(script.includes(field), field);
    assert.match(script, /mkvCompleteHlsCache\?\.coordinationMode === "local"/);
    assert.match(script, /mkvCompleteHlsCache\?\.singleInstanceAttested === true/);
    assert.doesNotMatch(script, /docker (?:rm|stop|restart|compose|run)|curl\s+-(?:X|d)|sed -i|rm -rf|set -x/);
    assert.doesNotMatch(script, /echo .*TOKEN|cat .*\.env\.media-vaapi/);
});

test('private complete-cache smoke requires one cold provider read then a zero-provider zero-FFmpeg replay', () => {
    const root = path.join(__dirname, '..');
    const client = fs.readFileSync(path.join(root, 'ops/hetzner/media/private-complete-cache-smoke-client.mjs'), 'utf8');
    const runner = fs.readFileSync(path.join(root, 'ops/hetzner/media/run-private-complete-cache-smoke.sh'), 'utf8');
    assert.match(client, /cold\.videoMode === 'encode'/);
    assert.match(client, /cold\.startupTimings\?\.videoEncoder === 'vaapi'/);
    assert.match(client, /mkvCompleteHlsCacheProof/);
    assert.match(client, /hit\.videoModeReason [!=]== 'complete_hls_cache_hit'/);
    assert.match(client, /hit\.startupTimings\?\.providerGetCount\) === 0/);
    assert.match(client, /hit\.startupTimings\?\.ffmpegSpawnCount\) === 0/);
    assert.match(client, /sourceAfterHit\.getRequests === sourceAfterCold\.getRequests/);
    assert.match(client, /sourceAfterHit\.bytesServed === sourceAfterCold\.bytesServed/);
    assert.match(client, /activeLeases\) === 0/);
    assert.match(runner, /MKV_COMPLETE_HLS_CACHE_ENABLED=true/);
    assert.match(runner, /MKV_COMPLETE_HLS_CACHE_ROOT=\/canary-cache/);
    assert.match(runner, /MEDIA_GATEWAY_VIDEO_ENCODER=vaapi/);
    assert.match(runner, /-c:v hevc_vaapi/);
    assert.match(runner, /--read-only/);
    assert.match(runner, /--tmpfs \/tmp:rw,nosuid,nodev,noexec/);
    assert.doesNotMatch(runner, /set -x|echo .*GATEWAY_TOKEN|cat .*\.env\.media-vaapi/);
    assert.doesNotMatch(client, /console\.log\([^\n]*(?:TOKEN|sourceUrl|hlsUrl|mkvCompleteHlsCacheProof)/);
});

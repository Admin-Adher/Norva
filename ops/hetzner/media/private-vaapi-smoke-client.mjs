import crypto from 'node:crypto';

const GATEWAY_ORIGIN = String(process.env.NORVA_CANARY_GATEWAY_ORIGIN || 'http://127.0.0.1:8080');
const PROVIDER_ORIGIN = String(process.env.NORVA_CANARY_PROVIDER_ORIGIN || 'http://norva-media-canary-provider:8090');
const TOKEN = String(process.env.GATEWAY_TOKEN || '');
const REQUEST_TIMEOUT_MS = 120_000;
const CANARY_PLAYBACK_SESSION_ID = String(
    process.env.NORVA_CANARY_PLAYBACK_SESSION_ID || 'norva-private-vaapi-canary-v1',
);

function requireCondition(condition, code) {
    if (!condition) throw new Error(code);
}

async function request(pathname, { method = 'GET', body, playbackToken = false } = {}) {
    const response = await fetch(`${GATEWAY_ORIGIN}${pathname}`, {
        method,
        headers: {
            ...(playbackToken ? {} : { Authorization: `Bearer ${TOKEN}` }),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response;
}

async function json(response, code) {
    try {
        return await response.json();
    } catch (_) {
        throw new Error(code);
    }
}

async function providerStats() {
    const response = await fetch(`${PROVIDER_ORIGIN}/stats`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
    });
    requireCondition(response.status === 200, 'PROVIDER_STATS_STATUS');
    return json(response, 'PROVIDER_STATS_JSON');
}

function localPlaybackUrl(value) {
    const parsed = new URL(value);
    return `${GATEWAY_ORIGIN}${parsed.pathname}${parsed.search}`;
}

async function waitForDrain() {
    const deadline = Date.now() + 15_000;
    let last = null;
    while (Date.now() < deadline) {
        const response = await fetch(`${GATEWAY_ORIGIN}/health`, { signal: AbortSignal.timeout(5_000) });
        last = await json(response, 'HEALTH_DRAIN_JSON');
        if (last.activeSessions === 0 && last.videoEncoderCapacity?.active === 0 &&
            last.vodInputPump?.active === 0 && last.rawPumpCount === 0) return last;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`GATEWAY_DRAIN_TIMEOUT_${Number(last?.activeSessions || -1)}`);
}

requireCondition(TOKEN.length >= 32, 'GATEWAY_TOKEN_UNAVAILABLE');
let sessionId = null;
let receipt = null;
try {
    const initialHealthResponse = await fetch(`${GATEWAY_ORIGIN}/health`, {
        signal: AbortSignal.timeout(5_000),
    });
    const initialHealth = await json(initialHealthResponse, 'INITIAL_HEALTH_JSON');
    requireCondition(initialHealthResponse.status === 200 && initialHealth.ok === true, 'INITIAL_HEALTH_FAILED');
    requireCondition(initialHealth.videoEncoder?.backend === 'vaapi', 'ENCODER_NOT_VAAPI');
    requireCondition(initialHealth.videoEncoder?.ready === true, 'ENCODER_NOT_READY');
    requireCondition(initialHealth.activeSessions === 0, 'GATEWAY_NOT_IDLE');

    const source = await providerStats();
    requireCondition(Number.isSafeInteger(source.fileSizeBytes) && source.fileSizeBytes > 0, 'FIXTURE_SIZE_INVALID');
    const ownerKey = crypto.createHash('sha256').update('norva/private-vaapi-canary/v1').digest('hex');
    const createResponse = await request('/sessions', {
        method: 'POST',
        body: {
            sourceUrl: `${PROVIDER_ORIGIN}/fixture-hevc-eac3.mkv`,
            playbackSessionId: CANARY_PLAYBACK_SESSION_ID,
            ownerKey,
            mode: 'remux',
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            userAgent: 'Norva-Private-VAAPI-Canary/1',
            playbackHint: { container: 'mkv', itemType: 'movie', streamType: 'movie' },
            playbackIdentity: {
                sourceId: 'norva-private-canary',
                itemType: 'movie',
                itemId: 'hevc-eac3-vaapi-smoke',
                variantId: 'fixture-v1',
            },
            codecProfile: {
                metadataComplete: true,
                probeSource: 'exact_file_canary',
                probedAt: new Date().toISOString(),
                fileSizeBytes: source.fileSizeBytes,
                container: 'matroska,webm',
                durationSeconds: 14,
                videoStreamIndex: 0,
                videoCodec: 'hevc',
                videoProfile: 'Main',
                videoPixelFormat: 'yuv420p',
                videoWidth: 1280,
                videoHeight: 720,
                audioCodec: 'eac3',
                audioProfile: '',
                audioChannels: 2,
                audioSampleRate: 48_000,
                audioChannelLayout: 'stereo',
                audioTracks: [{
                    index: 1,
                    codec: 'eac3',
                    profile: '',
                    channels: 2,
                    sampleRate: 48_000,
                    channelLayout: 'stereo',
                    default: true,
                }],
                subtitles: [],
            },
            audioCodec: 'eac3',
            audioChannels: 2,
            audioStreamIndex: 1,
            audioMode: 'transcode',
            videoCodec: 'hevc',
            clientAudioPassthrough: false,
            // A one-second seek keeps this smoke intentionally ineligible for
            // persistent cache/proof promotion while exercising the same real
            // provider pump, VAAPI encode and authenticated HLS routes.
            seekOffset: 1,
        },
    });
    requireCondition(createResponse.status === 201, `SESSION_CREATE_STATUS_${createResponse.status}`);
    const created = await json(createResponse, 'SESSION_CREATE_JSON');
    sessionId = typeof created.id === 'string' ? created.id : null;
    requireCondition(sessionId, 'SESSION_ID_MISSING');
    requireCondition(created.videoMode === 'encode', 'VIDEO_MODE_NOT_ENCODE');
    requireCondition(created.audioMode === 'transcode', 'AUDIO_MODE_NOT_TRANSCODE');
    requireCondition(created.requestedSeekOffset === 1, 'CANARY_SEEK_NOT_APPLIED');
    requireCondition(created.startupTimings?.videoEncoder === 'vaapi', 'SESSION_ENCODER_NOT_VAAPI');
    requireCondition(Number(created.startupTimings?.ffmpegSpawnCount) === 1, 'FFMPEG_SPAWN_COUNT_INVALID');
    requireCondition(created.startupTimings?.completeHlsCacheHit !== true, 'UNEXPECTED_CACHE_HIT');
    requireCondition(created.startupTimings?.completeHlsCachePublished !== true, 'UNEXPECTED_CACHE_PUBLISH');
    requireCondition(created.startupPolicy?.pipeline === 'video-transcode', 'STARTUP_PIPELINE_INVALID');
    requireCondition(created.startupPolicy?.eligible === true, 'VAAPI_FAST_START_NOT_ELIGIBLE');
    requireCondition(created.startupPolicy?.reason === 'vaapi-transcode-ready', 'VAAPI_FAST_START_REASON_INVALID');
    requireCondition(Number(created.startupPolicy?.targetBufferSeconds) === 6, 'VAAPI_FAST_START_BUFFER_INVALID');
    requireCondition(Number(created.startupPolicy?.minimumEncodeRateX) === 2, 'VAAPI_FAST_START_RATE_FLOOR_INVALID');
    requireCondition(Number(created.startupPolicy?.observedEncodeRateX) >= 2, 'VAAPI_FAST_START_RATE_INVALID');

    const localHls = localPlaybackUrl(created.hlsUrl);
    const unauthorized = new URL(localHls);
    unauthorized.searchParams.set('token', 'wrong');
    const unauthorizedResponse = await fetch(unauthorized, { signal: AbortSignal.timeout(5_000) });
    requireCondition(unauthorizedResponse.status === 401, 'PLAYLIST_AUTH_NOT_ENFORCED');

    const playlistResponse = await fetch(localHls, { signal: AbortSignal.timeout(10_000) });
    requireCondition(playlistResponse.status === 200, `PLAYLIST_STATUS_${playlistResponse.status}`);
    const playlist = await playlistResponse.text();
    const segmentLines = playlist.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('.ts'));
    requireCondition(segmentLines.length >= 3, 'PLAYLIST_SEGMENT_COUNT_LOW');
    const segmentUrl = new URL(segmentLines[0], localHls);
    const segmentResponse = await fetch(segmentUrl, { signal: AbortSignal.timeout(10_000) });
    requireCondition(segmentResponse.status === 200, `SEGMENT_STATUS_${segmentResponse.status}`);
    const firstSegment = Buffer.from(await segmentResponse.arrayBuffer());
    requireCondition(firstSegment.length >= 188 && firstSegment[0] === 0x47, 'SEGMENT_MPEGTS_INVALID');

    const sourceAfter = await providerStats();
    requireCondition(sourceAfter.getRequests >= 1, 'PROVIDER_GET_MISSING');
    requireCondition(sourceAfter.rangeRequests >= 1, 'PROVIDER_RANGE_MISSING');
    requireCondition(sourceAfter.maximumConcurrent === 1, 'PROVIDER_CONCURRENCY_INVALID');
    requireCondition(sourceAfter.invalidRanges === 0, 'PROVIDER_RANGE_INVALID');

    const deleteResponse = await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    requireCondition(deleteResponse.status === 200, `SESSION_DELETE_STATUS_${deleteResponse.status}`);
    sessionId = null;
    const drained = await waitForDrain();
    receipt = {
        ok: true,
        protocol: 1,
        createStatus: 201,
        videoMode: created.videoMode,
        audioMode: created.audioMode,
        encoder: created.startupTimings.videoEncoder,
        startupPipeline: created.startupPolicy.pipeline,
        startupPolicyReason: created.startupPolicy.reason,
        targetBufferSeconds: created.startupPolicy.targetBufferSeconds,
        startupMs: Number(created.startupTimings.totalMs) || null,
        productionRateX: Number(created.startupTimings.mediaProductionRateX) || null,
        playlistSegments: segmentLines.length,
        firstSegmentBytes: firstSegment.length,
        providerGets: sourceAfter.getRequests,
        providerRangeGets: sourceAfter.rangeRequests,
        providerMaximumConcurrent: sourceAfter.maximumConcurrent,
        activeSessionsAfterCleanup: drained.activeSessions,
        activeEncodersAfterCleanup: drained.videoEncoderCapacity.active,
    };
} finally {
    if (!sessionId) {
        const debugResponse = await request('/debug/sessions').catch(() => null);
        if (debugResponse?.status === 200) {
            const debug = await json(debugResponse, 'DEBUG_SESSIONS_JSON').catch(() => null);
            const orphan = Array.isArray(debug?.sessions)
                ? debug.sessions.find((entry) => entry?.playbackSessionId === CANARY_PLAYBACK_SESSION_ID)
                : null;
            sessionId = typeof orphan?.id === 'string' ? orphan.id : null;
        }
    }
    if (sessionId) {
        await request(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => null);
        await waitForDrain().catch(() => null);
    }
}

console.log(`NORVA_PRIVATE_VAAPI_SMOKE_OK ${JSON.stringify(receipt)}`);

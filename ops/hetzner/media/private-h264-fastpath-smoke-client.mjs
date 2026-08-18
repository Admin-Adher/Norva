import crypto from 'node:crypto';

const GATEWAY_ORIGIN = 'http://127.0.0.1:8080';
const PROVIDER_ORIGIN = 'http://norva-media-canary-provider:8090';
const TOKEN = String(process.env.GATEWAY_TOKEN || '');
const CASE = String(process.env.NORVA_CANARY_CASE || '');
const REQUEST_TIMEOUT_MS = 120_000;
const CASES = Object.freeze({
    aac: Object.freeze({
        route: '/fixture-h264-aac.mkv',
        itemId: 'h264-closed-aac-fastpath',
        audioCodec: 'aac',
        audioProfile: 'LC',
        expectedAudioMode: 'copy',
        expectedPipeline: 'copy',
    }),
    eac3: Object.freeze({
        route: '/fixture-h264-eac3.mkv',
        itemId: 'h264-closed-eac3-fastpath',
        audioCodec: 'eac3',
        audioProfile: '',
        expectedAudioMode: 'transcode',
        expectedPipeline: 'audio-transcode',
    }),
});
const fixture = CASES[CASE];

function requireCondition(condition, code) {
    if (!condition) throw new Error(code);
}

async function gatewayRequest(pathname, { method = 'GET', body } = {}) {
    return fetch(`${GATEWAY_ORIGIN}${pathname}`, {
        method,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

async function responseJson(response, code) {
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
    return responseJson(response, 'PROVIDER_STATS_JSON');
}

async function waitForSessionEnd(sessionId) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const response = await gatewayRequest(`/sessions/${encodeURIComponent(sessionId)}`);
        requireCondition(response.status === 200, `SESSION_POLL_STATUS_${response.status}`);
        const state = await responseJson(response, 'SESSION_POLL_JSON');
        if (state.status === 'ended') return state;
        requireCondition(state.status !== 'failed', 'SESSION_FAILED');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('SESSION_END_TIMEOUT');
}

async function waitForDrain() {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const response = await fetch(`${GATEWAY_ORIGIN}/health`, { signal: AbortSignal.timeout(5_000) });
        const health = await responseJson(response, 'HEALTH_DRAIN_JSON');
        if (health.activeSessions === 0 && health.videoEncoderCapacity?.active === 0 &&
            health.vodInputPump?.active === 0 && health.rawPumpCount === 0) return health;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('GATEWAY_DRAIN_TIMEOUT');
}

async function findCanarySession(playbackSessionId) {
    const response = await gatewayRequest('/debug/sessions').catch(() => null);
    if (response?.status !== 200) return null;
    const payload = await responseJson(response, 'DEBUG_SESSIONS_JSON').catch(() => null);
    const found = Array.isArray(payload?.sessions)
        ? payload.sessions.find((entry) => entry?.playbackSessionId === playbackSessionId)
        : null;
    return typeof found?.id === 'string' ? found.id : null;
}

async function cleanupSession(sessionId, playbackSessionId) {
    const resolvedId = sessionId || await findCanarySession(playbackSessionId);
    if (resolvedId) {
        await gatewayRequest(`/sessions/${encodeURIComponent(resolvedId)}`, { method: 'DELETE' }).catch(() => null);
    }
    await waitForDrain().catch(() => null);
}

function exactProfile(fileSizeBytes) {
    return {
        metadataComplete: true,
        probeSource: 'gateway_inband',
        probedAt: new Date().toISOString(),
        fileSizeBytes,
        container: 'matroska,webm',
        durationSeconds: 14,
        videoStreamIndex: 0,
        videoCodec: 'h264',
        videoProfile: 'High',
        videoPixelFormat: 'yuv420p',
        videoWidth: 1280,
        videoHeight: 720,
        audioCodec: fixture.audioCodec,
        audioProfile: fixture.audioProfile,
        audioChannels: 2,
        audioSampleRate: 48_000,
        audioChannelLayout: 'stereo',
        audioTracks: [{
            index: 1,
            codec: fixture.audioCodec,
            profile: fixture.audioProfile,
            channels: 2,
            sampleRate: 48_000,
            channelLayout: 'stereo',
            default: true,
        }],
        subtitles: [],
    };
}

function sessionBody(profile, playbackSessionId) {
    const ownerKey = crypto.createHash('sha256').update('norva/private-h264-fastpath-canary/v1').digest('hex');
    return {
        sourceUrl: `${PROVIDER_ORIGIN}${fixture.route}`,
        playbackSessionId,
        ownerKey,
        mode: 'remux',
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        userAgent: 'Norva-Private-H264-FastPath-Canary/1',
        playbackHint: { container: 'mkv', itemType: 'movie', streamType: 'movie' },
        playbackIdentity: {
            sourceId: 'norva-private-canary',
            itemType: 'movie',
            itemId: fixture.itemId,
            variantId: 'fixture-v1',
        },
        codecProfile: profile,
        audioCodec: fixture.audioCodec,
        audioProfile: fixture.audioProfile,
        audioChannels: 2,
        audioStreamIndex: 1,
        clientAudioPassthrough: true,
        seekOffset: 0,
    };
}

async function createSession(profile, playbackSessionId) {
    const response = await gatewayRequest('/sessions', {
        method: 'POST',
        body: sessionBody(profile, playbackSessionId),
    });
    requireCondition(response.status === 201, `SESSION_CREATE_STATUS_${response.status}`);
    const payload = await responseJson(response, 'SESSION_CREATE_JSON');
    requireCondition(typeof payload.id === 'string', 'SESSION_ID_MISSING');
    return payload;
}

async function verifyHls(created) {
    const publicUrl = new URL(created.hlsUrl);
    const localUrl = new URL(`${publicUrl.pathname}${publicUrl.search}`, GATEWAY_ORIGIN);
    const denied = new URL(localUrl);
    denied.searchParams.set('token', 'wrong');
    requireCondition((await fetch(denied, { signal: AbortSignal.timeout(5_000) })).status === 401,
        'PLAYLIST_AUTH_NOT_ENFORCED');
    const playlistResponse = await fetch(localUrl, { signal: AbortSignal.timeout(10_000) });
    requireCondition(playlistResponse.status === 200, `PLAYLIST_STATUS_${playlistResponse.status}`);
    const playlist = await playlistResponse.text();
    const segments = playlist.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('.ts'));
    requireCondition(segments.length >= 3, 'PLAYLIST_SEGMENT_COUNT_LOW');
    const segmentResponse = await fetch(new URL(segments[0], localUrl), { signal: AbortSignal.timeout(10_000) });
    requireCondition(segmentResponse.status === 200, `SEGMENT_STATUS_${segmentResponse.status}`);
    const bytes = Buffer.from(await segmentResponse.arrayBuffer());
    requireCondition(bytes.length >= 188 && bytes[0] === 0x47, 'SEGMENT_MPEGTS_INVALID');
    return { count: segments.length, firstBytes: bytes.length };
}

requireCondition(TOKEN.length >= 32, 'GATEWAY_TOKEN_UNAVAILABLE');
requireCondition(Boolean(fixture), 'CANARY_CASE_INVALID');
let activeSessionId = null;
let activePlaybackSessionId = null;
try {
    const healthResponse = await fetch(`${GATEWAY_ORIGIN}/health`, { signal: AbortSignal.timeout(5_000) });
    const health = await responseJson(healthResponse, 'INITIAL_HEALTH_JSON');
    requireCondition(healthResponse.status === 200 && health.ok === true, 'INITIAL_HEALTH_FAILED');
    requireCondition(health.videoEncoder?.backend === 'vaapi' && health.videoEncoder?.ready === true,
        'ENCODER_NOT_READY');
    requireCondition(health.mkvCompleteHlsCache?.enabled === false, 'CACHE_MUST_BE_DISABLED');
    requireCondition(health.mkvH264FastStart?.copyActivationReady === true, 'FASTPATH_NOT_READY');
    requireCondition(health.mkvH264FastStart?.fullFileProofSigningConfigured === true, 'PROOF_SIGNING_NOT_READY');
    requireCondition(health.activeSessions === 0, 'GATEWAY_NOT_IDLE');

    const initialProvider = await providerStats();
    requireCondition(Number.isSafeInteger(initialProvider.fileSizeBytes) && initialProvider.fileSizeBytes > 0,
        'FIXTURE_SIZE_INVALID');
    const initialProfile = exactProfile(initialProvider.fileSizeBytes);

    activePlaybackSessionId = `norva-h264-${CASE}-training-v1`;
    const training = await createSession(initialProfile, activePlaybackSessionId);
    activeSessionId = training.id;
    requireCondition(training.videoMode === 'encode', 'TRAINING_VIDEO_MODE_NOT_ENCODE');
    requireCondition(training.videoModeReason === 'finite_mkv_h264_requires_full_proof',
        'TRAINING_REASON_INVALID');
    requireCondition(training.startupTimings?.videoEncoder === 'vaapi', 'TRAINING_ENCODER_NOT_VAAPI');
    requireCondition(Number(training.startupTimings?.analyzerSpawnCount) === 2, 'TRAINING_ANALYZERS_MISSING');
    const trainingEnded = await waitForSessionEnd(training.id);
    const trainingDelete = await gatewayRequest(`/sessions/${encodeURIComponent(training.id)}`, { method: 'DELETE' });
    requireCondition(trainingDelete.status === 200, `TRAINING_DELETE_STATUS_${trainingDelete.status}`);
    const trainingCleanup = await responseJson(trainingDelete, 'TRAINING_DELETE_JSON');
    activeSessionId = null;
    activePlaybackSessionId = null;
    const trainedProfile = trainingCleanup.finalCodecProfile;
    if (typeof trainedProfile?.mkvH264FastStartProof !== 'string') {
        const postTrainingHealth = await fetch(`${GATEWAY_ORIGIN}/health`, {
            signal: AbortSignal.timeout(5_000),
        }).then((response) => responseJson(response, 'TRAINING_DIAGNOSTIC_HEALTH_JSON')).catch(() => null);
        const postTrainingProvider = await providerStats().catch(() => null);
        const timings = trainingEnded?.startupTimings || {};
        console.error(`NORVA_PRIVATE_H264_TRAINING_DIAGNOSTIC ${JSON.stringify({
            protocol: 1,
            case: CASE,
            endedStatus: trainingEnded?.status || null,
            startup: {
                analyzerSpawnCount: Number(timings.analyzerSpawnCount) || 0,
                inbandCodecProfileApplied: timings.inbandCodecProfileApplied === true,
                inbandCodecProfileComplete: timings.inbandCodecProfileComplete === true,
                mkvH264FastStartProofProduced: timings.mkvH264FastStartProofProduced === true,
                inbandCodecProfileMs: Number(timings.inbandCodecProfileMs) || null,
                totalMs: Number(timings.totalMs) || null,
            },
            pumpLast: postTrainingHealth?.vodInputPump?.last || null,
            finalProfile: trainedProfile ? {
                metadataComplete: trainedProfile.metadataComplete === true,
                probeSource: trainedProfile.probeSource || null,
                durationSeconds: Number(trainedProfile.durationSeconds) || null,
                fileSizeBytes: Number(trainedProfile.fileSizeBytes) || null,
                videoStreamIndex: Number.isInteger(trainedProfile.videoStreamIndex)
                    ? trainedProfile.videoStreamIndex
                    : null,
                videoCodec: trainedProfile.videoCodec || null,
                videoProfile: trainedProfile.videoProfile || null,
                videoPixelFormat: trainedProfile.videoPixelFormat || null,
                videoWidth: Number(trainedProfile.videoWidth) || null,
                videoHeight: Number(trainedProfile.videoHeight) || null,
                audioTrackCount: Array.isArray(trainedProfile.audioTracks)
                    ? trainedProfile.audioTracks.length
                    : null,
                subtitleTrackCount: Array.isArray(trainedProfile.subtitles)
                    ? trainedProfile.subtitles.length
                    : null,
            } : null,
            provider: postTrainingProvider ? {
                getRequests: postTrainingProvider.getRequests,
                rangeRequests: postTrainingProvider.rangeRequests,
                maximumConcurrent: postTrainingProvider.maximumConcurrent,
                invalidRanges: postTrainingProvider.invalidRanges,
            } : null,
        })}`);
    }
    requireCondition(typeof trainedProfile?.mkvH264FastStartProof === 'string', 'TRAINING_PROOF_MISSING');
    requireCondition(trainedProfile.mkvH264FastStartProof.length <= 8_192, 'TRAINING_PROOF_OVERSIZED');
    requireCondition(!trainedProfile.mkvCompleteHlsCacheProof, 'CACHE_PROOF_UNEXPECTED');
    await waitForDrain();

    activePlaybackSessionId = `norva-h264-${CASE}-replay-v1`;
    const replay = await createSession(trainedProfile, activePlaybackSessionId);
    activeSessionId = replay.id;
    requireCondition(replay.videoMode === 'copy', 'REPLAY_VIDEO_MODE_NOT_COPY');
    requireCondition(replay.videoModeReason === 'mkv_h264_fast_start_copy', 'REPLAY_REASON_INVALID');
    requireCondition(replay.audioMode === fixture.expectedAudioMode, 'REPLAY_AUDIO_MODE_INVALID');
    requireCondition(replay.startupPolicy?.pipeline === fixture.expectedPipeline, 'REPLAY_PIPELINE_INVALID');
    requireCondition(replay.startupPolicy?.eligible === true, 'REPLAY_POLICY_NOT_ELIGIBLE');
    requireCondition(replay.startupPolicy?.targetBufferSeconds === 6, 'REPLAY_BUFFER_INVALID');
    requireCondition(Number(replay.startupPolicy?.observedEncodeRateX) >= 1.15, 'REPLAY_RATE_TOO_LOW');
    requireCondition(Number(replay.startupTimings?.totalMs) > 0 && Number(replay.startupTimings.totalMs) < 10_000,
        'REPLAY_STARTUP_NOT_SUB10');
    requireCondition(Number(replay.startupTimings?.ffmpegSpawnCount) === 1, 'REPLAY_FFMPEG_COUNT_INVALID');
    const hls = await verifyHls(replay);
    const replayDelete = await gatewayRequest(`/sessions/${encodeURIComponent(replay.id)}`, { method: 'DELETE' });
    requireCondition(replayDelete.status === 200, `REPLAY_DELETE_STATUS_${replayDelete.status}`);
    activeSessionId = null;
    activePlaybackSessionId = null;
    const drained = await waitForDrain();
    const sourceAfter = await providerStats();
    requireCondition(sourceAfter.getRequests === 2, 'PROVIDER_GET_COUNT_INVALID');
    requireCondition(sourceAfter.rangeRequests === 2, 'PROVIDER_RANGE_COUNT_INVALID');
    requireCondition(sourceAfter.maximumConcurrent === 1, 'PROVIDER_CONCURRENCY_INVALID');
    requireCondition(sourceAfter.invalidRanges === 0, 'PROVIDER_INVALID_RANGE');

    console.log(`NORVA_PRIVATE_H264_FASTPATH_OK ${JSON.stringify({
        ok: true,
        protocol: 1,
        case: CASE,
        trainingVideoMode: training.videoMode,
        trainingStartupMs: Number(training.startupTimings?.totalMs) || null,
        replayVideoMode: replay.videoMode,
        replayAudioMode: replay.audioMode,
        replayPipeline: replay.startupPolicy.pipeline,
        replayStartupMs: Number(replay.startupTimings.totalMs),
        productionRateX: Number(replay.startupPolicy.observedEncodeRateX),
        targetBufferSeconds: replay.startupPolicy.targetBufferSeconds,
        playlistSegments: hls.count,
        firstSegmentBytes: hls.firstBytes,
        providerGets: sourceAfter.getRequests,
        providerRangeGets: sourceAfter.rangeRequests,
        providerMaximumConcurrent: sourceAfter.maximumConcurrent,
        activeSessionsAfterCleanup: drained.activeSessions,
        activeEncodersAfterCleanup: drained.videoEncoderCapacity.active,
    })}`);
} finally {
    await cleanupSession(activeSessionId, activePlaybackSessionId);
}

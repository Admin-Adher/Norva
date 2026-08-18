import crypto from 'node:crypto';

const GATEWAY_ORIGIN = 'http://127.0.0.1:8080';
const PROVIDER_ORIGIN = 'http://norva-media-cache-canary-provider:8090';
const TOKEN = String(process.env.GATEWAY_TOKEN || '');
const REQUEST_TIMEOUT_MS = 120_000;
const COLD_PLAYBACK_ID = 'norva-private-complete-cache-cold-v1';
const HIT_PLAYBACK_ID = 'norva-private-complete-cache-hit-v1';
const SOURCE_URL = `${PROVIDER_ORIGIN}/fixture-hevc-eac3.mkv`;
const OWNER_KEY = crypto.createHash('sha256').update('norva/private-complete-cache-canary/v1').digest('hex');
const PLAYBACK_IDENTITY = Object.freeze({
    sourceId: 'norva-private-cache-canary',
    itemType: 'movie',
    itemId: 'hevc-eac3-complete-cache-smoke',
    variantId: 'fixture-v1',
});

function requireCondition(condition, code) {
    if (!condition) throw new Error(code);
}

function sha256Hex(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function normalizeCodecToken(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
}

function structuralProfileFingerprint(profile, fileSizeBytes) {
    const audioTracks = (Array.isArray(profile?.audioTracks)
        ? profile.audioTracks
        : (Array.isArray(profile?.audio_tracks) ? profile.audio_tracks : []))
        .map((track) => ({
            index: Number(track?.index),
            codec: normalizeCodecToken(track?.codec),
            profile: normalizeCodecToken(track?.profile),
            channels: Number(track?.channels),
            sampleRate: Number(track?.sampleRate ?? track?.sample_rate),
            channelLayout: normalizeCodecToken(track?.channelLayout ?? track?.channel_layout),
            default: track?.default === true,
        }))
        .sort((left, right) => left.index - right.index);
    const subtitles = (Array.isArray(profile?.subtitles)
        ? profile.subtitles
        : (Array.isArray(profile?.subtitleTracks)
            ? profile.subtitleTracks
            : (Array.isArray(profile?.subtitle_tracks) ? profile.subtitle_tracks : [])))
        .map((track) => ({ index: Number(track?.index), codec: normalizeCodecToken(track?.codec) }))
        .sort((left, right) => left.index - right.index);
    return sha256Hex(JSON.stringify({
        protocol: 2,
        metadataComplete: profile?.metadataComplete === true || profile?.metadata_complete === true,
        fileSizeBytes: Number(fileSizeBytes),
        container: normalizeCodecToken(profile?.container),
        durationSeconds: Number(profile?.durationSeconds ?? profile?.duration_seconds ?? profile?.duration),
        videoStreamIndex: Number(profile?.videoStreamIndex ?? profile?.video_stream_index),
        videoCodec: normalizeCodecToken(profile?.videoCodec ?? profile?.video_codec ?? profile?.video),
        videoProfile: normalizeCodecToken(profile?.videoProfile ?? profile?.video_profile),
        videoPixelFormat: normalizeCodecToken(profile?.videoPixelFormat ?? profile?.video_pixel_format ?? profile?.pix_fmt),
        videoWidth: Number(profile?.videoWidth ?? profile?.video_width ?? profile?.width),
        videoHeight: Number(profile?.videoHeight ?? profile?.video_height ?? profile?.height),
        audioCodec: normalizeCodecToken(profile?.audioCodec ?? profile?.audio_codec ?? profile?.audio),
        audioProfile: normalizeCodecToken(profile?.audioProfile ?? profile?.audio_profile),
        audioChannels: Number(profile?.audioChannels ?? profile?.audio_channels ?? profile?.channels),
        audioSampleRate: Number(profile?.audioSampleRate ?? profile?.audio_sample_rate),
        audioChannelLayout: normalizeCodecToken(profile?.audioChannelLayout ?? profile?.audio_channel_layout),
        audioTracks,
        subtitles,
    }));
}

function cacheProofBindingDiagnostics(profile, fileSizeBytes) {
    try {
        const envelope = String(profile?.mkvCompleteHlsCacheProof || '');
        const [payloadPart] = envelope.split('.');
        const proof = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
        const structuralProfile = structuralProfileFingerprint(profile, fileSizeBytes);
        const profileFingerprintFor = ({ requestedMode, audioStreamIndex, audioMode, clientAudioPassthrough }) => (
            sha256Hex(stableJson({
                schema: 'mkv-complete-hls-profile-v1',
                structuralProfile,
                requestedMode,
                audioStreamIndex,
                audioMode,
                clientAudioPassthrough,
            }))
        );
        const expectedProfileFingerprint = profileFingerprintFor({
            requestedMode: 'remux',
            audioStreamIndex: 1,
            audioMode: 'transcode',
            clientAudioPassthrough: false,
        });
        let matchingProfileVariant = null;
        for (const requestedMode of ['remux', 'transcode']) {
            for (const audioStreamIndex of [1, 0, null]) {
                for (const audioMode of ['transcode', 'copy', 'encode', 'eac3', '']) {
                    for (const clientAudioPassthrough of [false, true]) {
                        if (proof.profileFingerprint === profileFingerprintFor({
                            requestedMode,
                            audioStreamIndex,
                            audioMode,
                            clientAudioPassthrough,
                        })) {
                            matchingProfileVariant = {
                                requestedMode,
                                audioStreamIndex,
                                audioMode,
                                clientAudioPassthrough,
                            };
                        }
                    }
                }
            }
        }
        const providerSlotKey = `owner:${OWNER_KEY}/${new URL(SOURCE_URL).host.toLowerCase()}`;
        const expectedItemScope = sha256Hex(stableJson(PLAYBACK_IDENTITY));
        return {
            parsed: true,
            protocol: proof.protocol === 2,
            scope: proof.scope === 'complete-hls',
            build: proof.build === 1,
            fresh: Number.isSafeInteger(proof.expiresAtMs) && Date.now() <= proof.expiresAtMs,
            source: proof.sourceUrlSha256 === sha256Hex(SOURCE_URL),
            provider: proof.providerScopeSha256 === sha256Hex(providerSlotKey),
            tenant: proof.tenantScopeSha256 === sha256Hex(OWNER_KEY),
            item: proof.itemScopeSha256 === expectedItemScope,
            file: proof.fileSizeBytes === Number(fileSizeBytes),
            profile: proof.profileFingerprint === expectedProfileFingerprint,
            profileVariant: matchingProfileVariant || 'structural-or-unexpected',
            effectiveUrl: /^[a-f0-9]{64}$/.test(String(proof.effectiveUrlSha256 || '')),
            strongEtag: /^[a-f0-9]{64}$/.test(String(proof.strongEtagSha256 || '')),
            pipeline: typeof proof.pipelineBuild === 'string' && proof.pipelineBuild.startsWith('mkv-complete-hls-mpegts-v4:'),
        };
    } catch (_) {
        return { parsed: false };
    }
}

async function request(pathname, { method = 'GET', body } = {}) {
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
    try { return await response.json(); } catch (_) { throw new Error(code); }
}

async function providerStats() {
    const response = await fetch(`${PROVIDER_ORIGIN}/stats`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
    });
    requireCondition(response.status === 200, 'PROVIDER_STATS_STATUS');
    return responseJson(response, 'PROVIDER_STATS_JSON');
}

async function health() {
    const response = await fetch(`${GATEWAY_ORIGIN}/health`, { signal: AbortSignal.timeout(5_000) });
    requireCondition(response.status === 200, 'GATEWAY_HEALTH_STATUS');
    return responseJson(response, 'GATEWAY_HEALTH_JSON');
}

function localPlaybackUrl(value) {
    const parsed = new URL(value);
    return `${GATEWAY_ORIGIN}${parsed.pathname}${parsed.search}`;
}

async function waitForEndlist(hlsUrl) {
    const deadline = Date.now() + 60_000;
    let playlist = '';
    while (Date.now() < deadline) {
        const response = await fetch(hlsUrl, { signal: AbortSignal.timeout(5_000) });
        requireCondition(response.status === 200, `PLAYLIST_STATUS_${response.status}`);
        playlist = await response.text();
        if (playlist.includes('#EXT-X-ENDLIST')) return playlist;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`PLAYLIST_ENDLIST_TIMEOUT_${playlist.length}`);
}

async function waitForDrain() {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        const state = await health();
        if (state.activeSessions === 0 && state.totalSessions === 0 &&
            state.videoEncoderCapacity?.active === 0 && state.vodInputPump?.active === 0 &&
            state.rawPumpCount === 0 && state.mkvCompleteHlsCache?.stats?.activeLeases === 0) return state;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('GATEWAY_DRAIN_TIMEOUT');
}

function sessionBody(fileSizeBytes, codecProfile, playbackSessionId) {
    return {
        sourceUrl: SOURCE_URL,
        playbackSessionId,
        ownerKey: OWNER_KEY,
        mode: 'remux',
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        userAgent: 'Norva-Private-Complete-Cache-Canary/1',
        playbackHint: { container: 'mkv', itemType: 'movie', streamType: 'movie' },
        playbackIdentity: PLAYBACK_IDENTITY,
        codecProfile: codecProfile ?? {
            metadataComplete: true,
            probeSource: 'exact_file_canary',
            probedAt: new Date().toISOString(),
            fileSizeBytes,
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
        seekOffset: 0,
    };
}

requireCondition(TOKEN.length >= 32, 'GATEWAY_TOKEN_UNAVAILABLE');
const initialHealth = await health();
requireCondition(initialHealth.activeSessions === 0 && initialHealth.totalSessions === 0, 'GATEWAY_NOT_IDLE');
requireCondition(initialHealth.videoEncoder?.backend === 'vaapi' && initialHealth.videoEncoder?.ready === true, 'VAAPI_NOT_READY');
requireCondition(initialHealth.mkvCompleteHlsCache?.enabled === true, 'COMPLETE_CACHE_NOT_ENABLED');

const sourceBefore = await providerStats();
requireCondition(Number.isSafeInteger(sourceBefore.fileSizeBytes) && sourceBefore.fileSizeBytes > 0, 'FIXTURE_SIZE_INVALID');

let activeSessionId = null;
let receipt = null;
try {
    const coldResponse = await request('/sessions', {
        method: 'POST',
        body: sessionBody(sourceBefore.fileSizeBytes, null, COLD_PLAYBACK_ID),
    });
    requireCondition(coldResponse.status === 201, `COLD_CREATE_STATUS_${coldResponse.status}`);
    const cold = await responseJson(coldResponse, 'COLD_CREATE_JSON');
    activeSessionId = typeof cold.id === 'string' ? cold.id : null;
    requireCondition(activeSessionId, 'COLD_SESSION_ID_MISSING');
    requireCondition(cold.videoMode === 'encode', 'COLD_VIDEO_MODE_INVALID');
    requireCondition(cold.audioMode === 'transcode', 'COLD_AUDIO_MODE_INVALID');
    requireCondition(cold.startupTimings?.videoEncoder === 'vaapi', 'COLD_ENCODER_INVALID');
    requireCondition(Number(cold.startupTimings?.ffmpegSpawnCount) === 1, 'COLD_FFMPEG_COUNT_INVALID');
    requireCondition(cold.startupTimings?.completeHlsCacheHit !== true, 'COLD_FALSE_CACHE_HIT');

    const coldPlaylist = await waitForEndlist(localPlaybackUrl(cold.hlsUrl));
    const coldSegments = coldPlaylist.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('.ts'));
    requireCondition(coldSegments.length >= 3, 'COLD_SEGMENTS_MISSING');

    const coldDelete = await request(`/sessions/${encodeURIComponent(activeSessionId)}`, { method: 'DELETE' });
    requireCondition(coldDelete.status === 200, `COLD_DELETE_STATUS_${coldDelete.status}`);
    const coldCleanup = await responseJson(coldDelete, 'COLD_DELETE_JSON');
    activeSessionId = null;
    const trainedProfile = coldCleanup.finalCodecProfile;
    requireCondition(typeof trainedProfile?.mkvCompleteHlsCacheProof === 'string', 'CACHE_PROOF_MISSING');
    requireCondition(trainedProfile.mkvCompleteHlsCacheProof.length <= 8_192, 'CACHE_PROOF_OVERSIZED');
    await waitForDrain();

    const sourceAfterCold = await providerStats();
    requireCondition(sourceAfterCold.getRequests === 1, 'COLD_PROVIDER_GET_COUNT_INVALID');
    requireCondition(sourceAfterCold.rangeRequests === 1, 'COLD_PROVIDER_RANGE_COUNT_INVALID');
    requireCondition(sourceAfterCold.maximumConcurrent === 1, 'COLD_PROVIDER_CONCURRENCY_INVALID');

    const beforeHitHealth = await health();
    const promotionsBeforeHit = Number(beforeHitHealth.mkvCompleteHlsCache?.stats?.promotions || 0);
    requireCondition(promotionsBeforeHit >= 1, 'CACHE_PROMOTION_MISSING');

    const hitResponse = await request('/sessions', {
        method: 'POST',
        body: sessionBody(sourceBefore.fileSizeBytes, trainedProfile, HIT_PLAYBACK_ID),
    });
    requireCondition(hitResponse.status === 201, `HIT_CREATE_STATUS_${hitResponse.status}`);
    const hit = await responseJson(hitResponse, 'HIT_CREATE_JSON');
    activeSessionId = typeof hit.id === 'string' ? hit.id : null;
    requireCondition(activeSessionId, 'HIT_SESSION_ID_MISSING');
    if (hit.videoModeReason !== 'complete_hls_cache_hit') {
        const [diagnosticHealth, diagnosticProvider] = await Promise.all([health(), providerStats()]);
        const cacheStats = diagnosticHealth.mkvCompleteHlsCache?.stats || {};
        console.error(`NORVA_PRIVATE_COMPLETE_CACHE_DIAGNOSTIC ${JSON.stringify({
            videoMode: hit.videoMode ?? null,
            audioMode: hit.audioMode ?? null,
            videoModeReason: hit.videoModeReason ?? null,
            startupPolicyReason: hit.startupPolicy?.reason ?? null,
            completeHlsCacheHit: hit.startupTimings?.completeHlsCacheHit === true,
            providerGetCount: Number(hit.startupTimings?.providerGetCount || 0),
            ffmpegSpawnCount: Number(hit.startupTimings?.ffmpegSpawnCount || 0),
            cache: {
                promotions: Number(cacheStats.promotions || 0),
                hits: Number(cacheStats.hits || 0),
                misses: Number(cacheStats.misses || 0),
                invalidProofs: Number(cacheStats.invalidProofs || 0),
                corruptions: Number(cacheStats.corruptions || 0),
                activeLeases: Number(cacheStats.activeLeases || 0),
            },
            proofBindings: cacheProofBindingDiagnostics(trainedProfile, sourceBefore.fileSizeBytes),
            provider: {
                getRequests: Number(diagnosticProvider.getRequests || 0),
                rangeRequests: Number(diagnosticProvider.rangeRequests || 0),
                maximumConcurrent: Number(diagnosticProvider.maximumConcurrent || 0),
            },
        })}`);
        throw new Error(`HIT_REASON_INVALID_${String(hit.videoModeReason || 'missing').slice(0, 80)}`);
    }
    requireCondition(hit.startupPolicy?.reason === 'complete-hls-cache-hit', 'HIT_POLICY_INVALID');
    requireCondition(hit.startupTimings?.completeHlsCacheHit === true, 'HIT_ATTESTATION_MISSING');
    requireCondition(Number(hit.startupTimings?.providerGetCount) === 0, 'HIT_PROVIDER_COUNT_INVALID');
    requireCondition(Number(hit.startupTimings?.ffmpegSpawnCount) === 0, 'HIT_FFMPEG_COUNT_INVALID');
    requireCondition(!JSON.stringify(hit).includes('mkvCompleteHlsCacheProof'), 'CACHE_PROOF_LEAKED');

    const hitPlaylistUrl = localPlaybackUrl(hit.hlsUrl);
    const unauthorizedUrl = new URL(hitPlaylistUrl);
    unauthorizedUrl.searchParams.set('token', 'wrong');
    const unauthorized = await fetch(unauthorizedUrl, { signal: AbortSignal.timeout(5_000) });
    requireCondition(unauthorized.status === 401, 'HIT_PLAYLIST_AUTH_MISSING');
    const hitPlaylist = await waitForEndlist(hitPlaylistUrl);
    const hitSegments = hitPlaylist.split(/\r?\n/).filter((line) => line && !line.startsWith('#') && line.includes('.ts'));
    requireCondition(hitSegments.length === coldSegments.length, 'HIT_GRAPH_DRIFT');
    const firstSegment = await fetch(new URL(hitSegments[0], hitPlaylistUrl), { signal: AbortSignal.timeout(10_000) });
    requireCondition(firstSegment.status === 200, `HIT_SEGMENT_STATUS_${firstSegment.status}`);
    const firstBytes = Buffer.from(await firstSegment.arrayBuffer());
    requireCondition(firstBytes.length >= 188 && firstBytes[0] === 0x47, 'HIT_SEGMENT_INVALID');

    const sourceAfterHit = await providerStats();
    requireCondition(sourceAfterHit.getRequests === sourceAfterCold.getRequests, 'HIT_OPENED_PROVIDER');
    requireCondition(sourceAfterHit.bytesServed === sourceAfterCold.bytesServed, 'HIT_READ_PROVIDER_BYTES');

    const hitDelete = await request(`/sessions/${encodeURIComponent(activeSessionId)}`, { method: 'DELETE' });
    requireCondition(hitDelete.status === 200, `HIT_DELETE_STATUS_${hitDelete.status}`);
    activeSessionId = null;
    const drained = await waitForDrain();
    const cacheStats = drained.mkvCompleteHlsCache?.stats || {};
    requireCondition(Number(cacheStats.hits) >= 1, 'CACHE_HIT_COUNTER_MISSING');
    requireCondition(Number(cacheStats.activeLeases) === 0, 'CACHE_LEASE_LEAK');

    receipt = {
        ok: true,
        protocol: 1,
        coldVideoMode: cold.videoMode,
        coldAudioMode: cold.audioMode,
        coldStartupMs: Number(cold.startupTimings?.totalMs) || null,
        coldFfmpegSpawns: Number(cold.startupTimings?.ffmpegSpawnCount),
        coldProviderGets: sourceAfterCold.getRequests,
        cachePromotions: Number(cacheStats.promotions),
        hitReason: hit.videoModeReason,
        hitStartupMs: Number(hit.startupTimings?.totalMs) || null,
        hitProviderGets: Number(hit.startupTimings?.providerGetCount),
        hitFfmpegSpawns: Number(hit.startupTimings?.ffmpegSpawnCount),
        providerGetsAfterHit: sourceAfterHit.getRequests,
        providerMaximumConcurrent: sourceAfterHit.maximumConcurrent,
        cacheHits: Number(cacheStats.hits),
        activeLeasesAfterCleanup: Number(cacheStats.activeLeases),
        activeSessionsAfterCleanup: drained.activeSessions,
    };
} finally {
    if (activeSessionId) {
        await request(`/sessions/${encodeURIComponent(activeSessionId)}`, { method: 'DELETE' }).catch(() => null);
        await waitForDrain().catch(() => null);
    }
}

console.log(`NORVA_PRIVATE_COMPLETE_CACHE_OK ${JSON.stringify(receipt)}`);

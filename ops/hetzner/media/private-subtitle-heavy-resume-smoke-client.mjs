import crypto from 'node:crypto';

const GATEWAY_ORIGIN = String(process.env.NORVA_CANARY_GATEWAY_ORIGIN || 'http://127.0.0.1:8080');
const PROVIDER_ORIGIN = String(
    process.env.NORVA_CANARY_PROVIDER_ORIGIN || 'http://norva-media-subtitle-heavy-provider:8090',
);
const PROVIDER_ROUTE = '/fixture-subtitle-heavy.mkv';
const TOKEN = String(process.env.GATEWAY_TOKEN || '');
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_STARTUP_MS = 10_000;
const FIXTURE_DURATION_SECONDS = 45;
const SUBTITLE_LANGUAGES = Object.freeze([
    'eng', 'fra', 'spa', 'deu', 'ita', 'por', 'ara', 'hin',
    'ben', 'urd', 'tam', 'tel', 'mal', 'mar', 'guj', 'pan',
    'tur', 'rus', 'ukr', 'pol', 'nld', 'swe', 'nor', 'dan',
    'fin', 'ces', 'ron', 'ell', 'heb', 'fas', 'kor', 'jpn',
]);

function requireCondition(condition, code) {
    if (!condition) throw new Error(code);
}

async function request(pathname, { method = 'GET', body, playbackToken = false } = {}) {
    return fetch(`${GATEWAY_ORIGIN}${pathname}`, {
        method,
        headers: {
            ...(playbackToken ? {} : { Authorization: `Bearer ${TOKEN}` }),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

async function json(response, code) {
    try {
        return await response.json();
    } catch (_) {
        throw new Error(code);
    }
}

function localPlaybackUrl(value) {
    const parsed = new URL(value);
    return `${GATEWAY_ORIGIN}${parsed.pathname}${parsed.search}`;
}

async function providerStats() {
    const response = await fetch(`${PROVIDER_ORIGIN}/stats`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
    });
    requireCondition(response.status === 200, 'PROVIDER_STATS_STATUS');
    return json(response, 'PROVIDER_STATS_JSON');
}

async function health() {
    const response = await fetch(`${GATEWAY_ORIGIN}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
    });
    requireCondition(response.status === 200, 'GATEWAY_HEALTH_STATUS');
    return json(response, 'GATEWAY_HEALTH_JSON');
}

function isFullyDrained(snapshot) {
    return snapshot?.activeSessions === 0
        && snapshot?.videoEncoderCapacity?.active === 0
        && snapshot?.vodInputPump?.active === 0
        && snapshot?.rawPumpCount === 0
        && snapshot?.activeStrictLidBrokers === 0;
}

async function waitForDrain() {
    const deadline = Date.now() + 15_000;
    let last = null;
    while (Date.now() < deadline) {
        last = await health();
        if (isFullyDrained(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`GATEWAY_DRAIN_TIMEOUT_${Number(last?.activeSessions ?? -1)}`);
}

function codecProfile(fileSizeBytes) {
    return {
        metadataComplete: true,
        probeSource: 'exact_file_probe',
        probedAt: new Date().toISOString(),
        fileSizeBytes,
        container: 'matroska,webm',
        durationSeconds: FIXTURE_DURATION_SECONDS,
        videoStreamIndex: 0,
        videoCodec: 'h264',
        videoProfile: 'High',
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
            channels: 2,
            sampleRate: 48_000,
            channelLayout: 'stereo',
            language: 'eng',
            title: 'English',
            default: true,
        }],
        subtitles: SUBTITLE_LANGUAGES.map((language, order) => ({
            index: order + 2,
            order,
            codec: 'subrip',
            subtitleType: 'text',
            extractable: true,
            language,
            title: `Exact ${language.toUpperCase()}`,
            default: order === 0,
            forced: false,
        })),
    };
}

function sessionBody({ fileSizeBytes, seekOffset, requestedSubtitleStreamIndex, ordinal }) {
    return {
        sourceUrl: `${PROVIDER_ORIGIN}${PROVIDER_ROUTE}`,
        playbackSessionId: `norva-private-subtitle-heavy-v1-${ordinal}`,
        ownerKey: crypto.createHash('sha256')
            .update(`norva/private-subtitle-heavy-resume/v1/${ordinal}`)
            .digest('hex'),
        mode: 'transcode',
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        userAgent: 'Norva-Private-Subtitle-Heavy-Resume-Canary/1',
        playbackHint: { container: 'mkv', itemType: 'movie', streamType: 'movie' },
        playbackIdentity: {
            sourceId: 'norva-private-subtitle-heavy-canary',
            itemType: 'movie',
            itemId: 'subtitle-heavy-resume-smoke',
            variantId: 'fixture-v1',
        },
        codecProfile: codecProfile(fileSizeBytes),
        audioCodec: 'eac3',
        audioChannels: 2,
        audioStreamIndex: 1,
        audioMode: 'transcode',
        videoCodec: 'h264',
        clientAudioPassthrough: false,
        seekOffset,
        ...(Number.isInteger(requestedSubtitleStreamIndex)
            ? { subtitleStreamIndex: requestedSubtitleStreamIndex }
            : {}),
    };
}

async function inspectHls(created) {
    const masterUrl = localPlaybackUrl(created.hlsUrl);
    const masterResponse = await fetch(masterUrl, { signal: AbortSignal.timeout(10_000) });
    requireCondition(masterResponse.status === 200, `MASTER_STATUS_${masterResponse.status}`);
    const master = await masterResponse.text();
    const masterLines = master.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const subtitleRenditionCount = masterLines.filter((line) => (
        line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=SUBTITLES')
    )).length;
    requireCondition(subtitleRenditionCount === 8, `MASTER_SUBTITLE_COUNT_${subtitleRenditionCount}`);

    const variantMarker = masterLines.findIndex((line) => line.startsWith('#EXT-X-STREAM-INF:'));
    requireCondition(variantMarker >= 0 && masterLines[variantMarker + 1], 'MASTER_VARIANT_MISSING');
    const variantUrl = new URL(masterLines[variantMarker + 1], masterUrl);
    const variantResponse = await fetch(variantUrl, { signal: AbortSignal.timeout(10_000) });
    requireCondition(variantResponse.status === 200, `VARIANT_STATUS_${variantResponse.status}`);
    const variant = await variantResponse.text();
    const segmentName = variant.split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#') && line.includes('.ts'));
    requireCondition(segmentName, 'VARIANT_SEGMENT_MISSING');
    const segmentResponse = await fetch(new URL(segmentName, variantUrl), {
        signal: AbortSignal.timeout(10_000),
    });
    requireCondition(segmentResponse.status === 200, `SEGMENT_STATUS_${segmentResponse.status}`);
    const segment = Buffer.from(await segmentResponse.arrayBuffer());
    requireCondition(segment.length >= 188 && segment[0] === 0x47, 'SEGMENT_MPEGTS_INVALID');
    return { subtitleRenditionCount, firstSegmentBytes: segment.length };
}

async function runPlayback({ fileSizeBytes, seekOffset, requestedSubtitleStreamIndex, ordinal }) {
    const startedAt = performance.now();
    const response = await request('/sessions', {
        method: 'POST',
        body: sessionBody({ fileSizeBytes, seekOffset, requestedSubtitleStreamIndex, ordinal }),
    });
    const startupMs = Math.round(performance.now() - startedAt);
    requireCondition(response.status === 201, `SESSION_${ordinal}_STATUS_${response.status}`);
    const created = await json(response, `SESSION_${ordinal}_JSON`);
    requireCondition(typeof created.id === 'string' && created.id.length > 0, `SESSION_${ordinal}_ID`);
    requireCondition(startupMs < MAX_STARTUP_MS, `SESSION_${ordinal}_STARTUP_${startupMs}`);
    requireCondition(created.videoMode === 'encode', `SESSION_${ordinal}_VIDEO_MODE`);
    requireCondition(created.startupTimings?.videoEncoder === 'vaapi', `SESSION_${ordinal}_ENCODER`);
    requireCondition(Number(created.startupTimings?.ffmpegSpawnCount) === 1, `SESSION_${ordinal}_SPAWNS`);
    requireCondition(created.exactSubtitleHls?.enabled === true, `SESSION_${ordinal}_SUBTITLE_DISABLED`);
    requireCondition(created.exactSubtitleHls?.reason === 'enabled-partial', `SESSION_${ordinal}_SUBTITLE_REASON`);
    requireCondition(created.exactSubtitleHls?.sourceTrackCount === 32, `SESSION_${ordinal}_SOURCE_COUNT`);
    requireCondition(created.exactSubtitleHls?.preparedTrackCount === 8, `SESSION_${ordinal}_PREPARED_COUNT`);
    requireCondition(created.subtitleRenditions?.length === 8, `SESSION_${ordinal}_RENDITION_COUNT`);
    if (Number.isInteger(requestedSubtitleStreamIndex)) {
        requireCondition(
            created.subtitleRenditions?.[0]?.streamIndex === requestedSubtitleStreamIndex,
            `SESSION_${ordinal}_REQUESTED_TRACK_NOT_FIRST`,
        );
    }
    const hls = await inspectHls(created);
    return { created, startupMs, hls };
}

requireCondition(TOKEN.length >= 32, 'GATEWAY_TOKEN_UNAVAILABLE');
const initial = await health();
requireCondition(initial.ok === true && initial.version === 161, 'GATEWAY_VERSION_INVALID');
requireCondition(initial.videoEncoder?.backend === 'vaapi' && initial.videoEncoder?.ready === true, 'VAAPI_NOT_READY');
requireCondition(isFullyDrained(initial), 'GATEWAY_NOT_IDLE');

const source = await providerStats();
requireCondition(Number.isSafeInteger(source.fileSizeBytes) && source.fileSizeBytes > 0, 'FIXTURE_SIZE_INVALID');
const results = [];
let activeSessionId = null;
try {
    const cold = await runPlayback({ fileSizeBytes: source.fileSizeBytes, seekOffset: 0, ordinal: 'cold' });
    activeSessionId = cold.created.id;
    let deleteResponse = await request(`/sessions/${encodeURIComponent(activeSessionId)}`, { method: 'DELETE' });
    requireCondition(deleteResponse.status === 200, `COLD_DELETE_${deleteResponse.status}`);
    activeSessionId = null;
    const coldDrain = await waitForDrain();
    results.push({
        kind: 'cold',
        startupMs: cold.startupMs,
        serverStartupMs: Number(cold.created.startupTimings?.totalMs) || null,
        preparedSubtitleTracks: cold.created.exactSubtitleHls.preparedTrackCount,
        fullSubtitleTracks: cold.created.exactSubtitleHls.sourceTrackCount,
        firstSegmentBytes: cold.hls.firstSegmentBytes,
        drain: isFullyDrained(coldDrain),
    });

    const requestedSubtitleStreamIndex = 33;
    const resumed = await runPlayback({
        fileSizeBytes: source.fileSizeBytes,
        seekOffset: 18,
        requestedSubtitleStreamIndex,
        ordinal: 'resume',
    });
    activeSessionId = resumed.created.id;
    requireCondition(Number(resumed.created.actualStartOffset) >= 17, 'RESUME_OFFSET_NOT_APPLIED');
    deleteResponse = await request(`/sessions/${encodeURIComponent(activeSessionId)}`, { method: 'DELETE' });
    requireCondition(deleteResponse.status === 200, `RESUME_DELETE_${deleteResponse.status}`);
    activeSessionId = null;
    const resumeDrain = await waitForDrain();
    results.push({
        kind: 'resume-on-demand-track',
        startupMs: resumed.startupMs,
        serverStartupMs: Number(resumed.created.startupTimings?.totalMs) || null,
        requestedSubtitleStreamIndex,
        preparedFirstStreamIndex: resumed.created.subtitleRenditions[0].streamIndex,
        preparedSubtitleTracks: resumed.created.exactSubtitleHls.preparedTrackCount,
        fullSubtitleTracks: resumed.created.exactSubtitleHls.sourceTrackCount,
        firstSegmentBytes: resumed.hls.firstSegmentBytes,
        drain: isFullyDrained(resumeDrain),
    });

    const finalSource = await providerStats();
    requireCondition(finalSource.maximumConcurrent === 1, 'PROVIDER_CONCURRENCY_INVALID');
    requireCondition(finalSource.invalidRanges === 0, 'PROVIDER_RANGE_INVALID');
    console.log(`NORVA_SUBTITLE_HEAVY_RESUME_SMOKE_OK ${JSON.stringify({
        protocol: 1,
        gatewayVersion: initial.version,
        startupTargetMs: MAX_STARTUP_MS,
        results,
        providerMaximumConcurrent: finalSource.maximumConcurrent,
        providerRangeRequests: finalSource.rangeRequests,
    })}`);
} finally {
    if (activeSessionId) {
        await request(`/sessions/${encodeURIComponent(activeSessionId)}`, { method: 'DELETE' }).catch(() => null);
        await waitForDrain().catch(() => null);
    }
}

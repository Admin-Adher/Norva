const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const app = express();

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.NORVA_MEDIA_GATEWAY_TOKEN || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(os.tmpdir(), 'norva-media-gateway'));
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';
const DEFAULT_TTL_SECONDS = clampInt(process.env.SESSION_TTL_SECONDS, 30 * 60, 60, 12 * 60 * 60);
const STARTUP_TIMEOUT_MS = clampInt(process.env.STARTUP_TIMEOUT_MS, 45_000, 5_000, 180_000);
const PLAYLIST_REQUEST_TIMEOUT_MS = clampInt(process.env.PLAYLIST_REQUEST_TIMEOUT_MS, 45_000, 5_000, 180_000);
const XTREAM_REQUEST_TIMEOUT_MS = clampInt(process.env.XTREAM_REQUEST_TIMEOUT_MS, 15_000, 5_000, 60_000);
const CODEC_PROBE_TIMEOUT_MS = clampInt(process.env.CODEC_PROBE_TIMEOUT_MS, 12_000, 1_000, 30_000);
const CODEC_PROBE_ANALYZE_DURATION_US = clampInt(process.env.CODEC_PROBE_ANALYZE_DURATION_US, 2_000_000, 250_000, 20_000_000);
const CODEC_PROBE_SIZE_BYTES = clampInt(process.env.CODEC_PROBE_SIZE_BYTES, 2_000_000, 64_000, 20_000_000);
const MAX_SUBTITLE_TRACKS = clampInt(process.env.MAX_SUBTITLE_TRACKS, 32, 1, 64);
const STOP_CONFLICTING_SOURCE_SESSIONS = (process.env.STOP_CONFLICTING_SOURCE_SESSIONS || 'true') !== 'false';
const STOP_CONFLICTING_OWNER_SESSIONS = (process.env.STOP_CONFLICTING_OWNER_SESSIONS || 'true') !== 'false';
const FFMPEG_USER_AGENT = process.env.FFMPEG_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Norva/1.0';
const MAX_LOG_TAIL = 12000;
const GATEWAY_VERSION = 31;
// Fallback audio path: plain AAC-LC stereo @48k. Source HE-AAC / unusual sample
// rates can make hls.js label the track mp4a.40.5 (HE-AAC), and Chrome's MSE
// may reject the append. Copy audio only when the codec hint is browser-safe.
const TRANSCODE_AUDIO_ARGS = [
    '-af', 'aresample=48000:async=1:first_pts=0',
    '-c:a', 'aac',
    '-profile:a', 'aac_low',
    '-ar', '48000',
    '-ac', '2',
    '-b:a', '160k'
];

const sessions = new Map();
const lastFailures = [];
const probeStats = {
    attempts: 0,
    successes: 0,
    failures: 0,
    empty: 0,
    last: null,
    lastFailure: null
};

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cors);

app.options('*', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'norva-media-gateway',
        version: GATEWAY_VERSION,
        codecProbe: true,
        codecProbeTimeoutMs: CODEC_PROBE_TIMEOUT_MS,
        codecProbeAnalyzeDurationUs: CODEC_PROBE_ANALYZE_DURATION_US,
        codecProbeSizeBytes: CODEC_PROBE_SIZE_BYTES,
        maxSubtitleTracks: MAX_SUBTITLE_TRACKS,
        probeStats,
        activeSessions: activeSessionCount(),
        totalSessions: sessions.size,
        lastFailureCount: lastFailures.length,
        time: new Date().toISOString()
    });
});

app.get('/debug/failures', requireGatewayAuth, (req, res) => {
    res.json({
        ok: true,
        service: 'norva-media-gateway',
        version: GATEWAY_VERSION,
        failures: lastFailures
    });
});

app.get('/debug/sessions', requireGatewayAuth, (req, res) => {
    res.json({
        ok: true,
        service: 'norva-media-gateway',
        version: GATEWAY_VERSION,
        sessions: Array.from(sessions.values()).map(debugSession)
    });
});

app.post('/xtream/epg', requireGatewayAuth, async (req, res) => {
    try {
        const {
            serverUrl,
            username,
            password,
            streamId,
            action = 'get_short_epg',
            limit,
            userAgent
        } = req.body || {};

        const normalizedAction = action === 'get_simple_data_table' ? 'get_simple_data_table' : 'get_short_epg';
        if (!serverUrl || !isHttpUrl(serverUrl) || !username || !password || !streamId) {
            return res.status(400).json({ error: 'serverUrl, username, password and streamId are required' });
        }

        const url = xtreamPlayerApiUrl({
            serverUrl,
            username,
            password,
            action: normalizedAction,
            streamId,
            limit: normalizedAction === 'get_short_epg' ? limit : ''
        });
        const payload = await fetchProviderJson(url, sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT);
        res.json(payload);
    } catch (err) {
        const status = Number.isInteger(err.status) ? err.status : 502;
        res.status(status).json({
            error: err.publicMessage || 'IPTV provider request failed',
            details: err.details || undefined
        });
    }
});

app.post('/sessions', requireGatewayAuth, async (req, res) => {
    try {
        const {
            sourceUrl,
            playbackSessionId,
            ownerKey,
            mode = 'remux',
            expiresAt,
            userAgent,
            playbackHint,
            codecProfile,
            audioCodec,
            audioProfile,
            audioChannels,
            audioStreamIndex,
            audio_stream_index,
            audioMode,
            videoCodec,
            clientAudioPassthrough,
            seekOffset,
            startOffset,
            resumeTime
        } = req.body || {};
        if (!sourceUrl || !isHttpUrl(sourceUrl)) {
            return res.status(400).json({ error: 'sourceUrl must be a valid http(s) URL' });
        }

        const normalizedOwnerKey = normalizeSessionKey(ownerKey);
        if (STOP_CONFLICTING_OWNER_SESSIONS && normalizedOwnerKey) {
            await stopConflictingOwnerSessions(normalizedOwnerKey);
        }

        if (STOP_CONFLICTING_SOURCE_SESSIONS) {
            await stopConflictingSourceSessions(sourceUrl);
        }

        const id = crypto.randomUUID();
        const accessToken = randomToken();
        const outputDir = resolveSessionDir(id);
        await fsp.mkdir(outputDir, { recursive: true });
        const sourceKey = sourceSessionKey(sourceUrl);

        const expiresAtDate = expiresAt ? new Date(expiresAt) : new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);
        const normalizedPlaybackHint = asRecord(playbackHint);
        const normalizedSeekOffset = normalizeSeekOffset(
            seekOffset ??
            startOffset ??
            resumeTime ??
            normalizedPlaybackHint.seekOffset ??
            normalizedPlaybackHint.seek_offset ??
            normalizedPlaybackHint.startOffset ??
            normalizedPlaybackHint.start_offset ??
            normalizedPlaybackHint.resumeTime ??
            normalizedPlaybackHint.resume_time
        );
        let normalizedCodecProfile = asRecord(codecProfile || normalizedPlaybackHint.codecProfile || normalizedPlaybackHint.codec_profile);
        let codecProfileSource = hasUsefulCodecProfile(normalizedCodecProfile) ? 'request' : '';
        const shouldProbe = shouldProbeCodecProfile(normalizedPlaybackHint, sourceUrl);
        const shouldCompleteProfile = shouldProbe && shouldProbeMissingSubtitleTracks(normalizedCodecProfile, normalizedPlaybackHint, sourceUrl);
        if ((!codecProfileSource || shouldCompleteProfile) && shouldProbe) {
            try {
                const probedCodecProfile = await probeCodecProfile(sourceUrl, sanitizeUserAgent(userAgent) || FFMPEG_USER_AGENT);
                if (hasUsefulCodecProfile(probedCodecProfile)) {
                    normalizedCodecProfile = mergeCodecProfiles(normalizedCodecProfile, probedCodecProfile);
                    codecProfileSource = codecProfileSource ? `${codecProfileSource}+gateway_probe` : 'gateway_probe';
                }
            } catch (err) {
                rememberProbeFailure(err.message || String(err), sourceUrl);
                console.warn('[media-gateway] codec probe skipped:', sanitizeLog(err.message || String(err), sourceUrl));
            }
        }
        const session = {
            id,
            playbackSessionId: playbackSessionId || null,
            sourceUrl,
            sourceKey,
            ownerKey: normalizedOwnerKey,
            mode: mode === 'transcode' ? 'transcode' : 'remux',
            userAgent: sanitizeUserAgent(userAgent),
            playbackHint: normalizedPlaybackHint,
            seekOffset: normalizedSeekOffset,
            codecProfile: normalizedCodecProfile,
            codecProfileSource,
            audioCodec: stringOrNull(audioCodec) || stringOrNull(normalizedPlaybackHint.audioCodec) || stringOrNull(normalizedPlaybackHint.audio_codec) || stringOrNull(normalizedCodecProfile.audioCodec) || stringOrNull(normalizedCodecProfile.audio_codec) || stringOrNull(normalizedCodecProfile.audio),
            audioProfile: stringOrNull(audioProfile) || stringOrNull(normalizedPlaybackHint.audioProfile) || stringOrNull(normalizedPlaybackHint.audio_profile) || stringOrNull(normalizedCodecProfile.audioProfile) || stringOrNull(normalizedCodecProfile.audio_profile),
            audioChannels: nullableInt(audioChannels ?? normalizedPlaybackHint.audioChannels ?? normalizedPlaybackHint.audio_channels ?? normalizedCodecProfile.audioChannels ?? normalizedCodecProfile.audio_channels ?? normalizedCodecProfile.channels),
            audioStreamIndex: normalizeAudioStreamIndex(audioStreamIndex ?? audio_stream_index ?? normalizedPlaybackHint.audioStreamIndex ?? normalizedPlaybackHint.audio_stream_index),
            audioMode: stringOrNull(audioMode) || stringOrNull(normalizedPlaybackHint.audioMode) || stringOrNull(normalizedPlaybackHint.audio_mode),
            videoCodec: stringOrNull(videoCodec) || stringOrNull(normalizedPlaybackHint.videoCodec) || stringOrNull(normalizedPlaybackHint.video_codec) || stringOrNull(normalizedCodecProfile.videoCodec) || stringOrNull(normalizedCodecProfile.video_codec) || stringOrNull(normalizedCodecProfile.video),
            clientAudioPassthrough: clientAudioPassthrough === false || normalizedPlaybackHint.clientAudioPassthrough === false || normalizedPlaybackHint.client_audio_passthrough === false ? false : true,
            status: 'starting',
            outputDir,
            playlistPath: path.join(outputDir, 'playlist.m3u8'),
            accessToken,
            createdAt: new Date(),
            expiresAt: expiresAtDate,
            ffmpeg: null,
            lastError: null,
            logTail: ''
        };

        sessions.set(id, session);
        session.ffmpeg = startFfmpeg(session);

        const hlsUrl = publicUrl(req, `/sessions/${id}/playlist.m3u8?token=${encodeURIComponent(accessToken)}`);
        try {
            await waitForPlaylist(session, STARTUP_TIMEOUT_MS);
            if (session.status === 'starting') session.status = 'ready';
        } catch (err) {
            const detail = session.lastError || err.message || 'Playlist was not generated';
            rememberFailure(session, detail);
            await stopSession(session);
            return res.status(502).json({
                error: 'Failed to start media session',
                details: detail
            });
        }

        res.status(201).json({
            id,
            status: session.status,
            mode: session.mode,
            audioMode: audioModeForSession(session),
            audioStreamIndex: session.audioStreamIndex,
            codecProfile: session.codecProfile,
            codecProfileSource: session.codecProfileSource || null,
            hlsUrl,
            expiresAt: session.expiresAt.toISOString()
        });
    } catch (err) {
        console.error('[media-gateway] create session failed:', err);
        res.status(500).json({ error: 'Failed to create media session' });
    }
});

app.get('/sessions/:id', requireGatewayAuth, (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(serializeSession(req, session));
});

app.delete('/sessions/:id', requireGatewayAuth, async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    await stopSession(session);
    res.json({ success: true });
});

app.get('/sessions/:id/playlist.m3u8', requirePlaybackToken, async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');

    try {
        await waitForPlaylist(session, PLAYLIST_REQUEST_TIMEOUT_MS);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const playlist = await fsp.readFile(session.playlistPath, 'utf8');
        res.send(rewritePlaylistSegments(playlist, session.accessToken));
    } catch (err) {
        const status = session.lastError ? 502 : 202;
        res.status(status).send(session.lastError || 'Playlist is not ready yet');
    }
});

app.get('/sessions/:id/:file', requirePlaybackToken, (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');

    const requested = path.basename(req.params.file);
    const filePath = path.join(session.outputDir, requested);
    if (!isWithin(session.outputDir, filePath)) return res.status(400).send('Invalid segment path');
    if (!fs.existsSync(filePath)) return res.status(404).send('Segment not found');

    res.setHeader('Content-Type', segmentContentType(requested));
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.sendFile(filePath);
});

app.use((err, req, res, next) => {
    console.error('[media-gateway] server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

async function bootstrap() {
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
    app.listen(PORT, () => {
        console.log(`Norva Media Gateway listening on ${PORT}`);
        console.log(`Output directory: ${OUTPUT_DIR}`);
    });
}

function startFfmpeg(session) {
    const segmentPattern = path.join(session.outputDir, 'segment-%05d.ts');
    const audioArgs = audioArgsForSession(session);
    const audioMap = audioMapForSession(session);
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        '-y',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_at_eof', '1',
        '-reconnect_delay_max', '5',
        '-rw_timeout', '15000000',
        '-user_agent', session.userAgent || FFMPEG_USER_AGENT,
        '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
        ...(session.seekOffset > 0 ? ['-ss', String(session.seekOffset)] : []),
        '-i', session.sourceUrl,
        '-fflags', '+genpts',
        '-map', '0:v:0?',
        '-map', audioMap,
        '-max_muxing_queue_size', '1024'
    ];

    if (session.mode === 'transcode') {
        args.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-profile:v', 'high',
            '-level', '4.1',
            '-pix_fmt', 'yuv420p',
            '-crf', '23',
            '-g', '48',
            '-sc_threshold', '0',
            ...audioArgs
        );
    } else {
        args.push(
            '-c:v', 'copy',
            ...audioArgs
        );
    }

    args.push(
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        // EVENT playlist: a growing VOD transcode the player can seek from the
        // start. Avoids the live-edge chase that LIVE playlists trigger, and
        // ffmpeg appends #EXT-X-ENDLIST on clean completion.
        '-hls_playlist_type', 'event',
        '-hls_segment_type', 'mpegts',
        // No `append_list`: it injected a spurious leading #EXT-X-DISCONTINUITY
        // that stalled hls.js fragment indexing. `temp_file` makes each segment
        // appear in the playlist only once fully written (no partial reads).
        '-hls_flags', 'independent_segments+temp_file',
        '-hls_segment_filename', segmentPattern,
        session.playlistPath
    );

    appendSubtitleOutputs(args, session);

    const child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    session.status = 'starting';

    child.stderr.on('data', (chunk) => {
        const text = sanitizeLog(chunk.toString(), session.sourceUrl);
        appendLogTail(session, text);
        if (text.trim()) console.warn(`[ffmpeg:${session.id}] ${text.trim()}`);
    });

    child.on('error', (err) => {
        session.status = 'failed';
        session.lastError = err.message;
        console.error(`[ffmpeg:${session.id}] failed to start:`, err.message);
    });

    child.on('exit', (code, signal) => {
        if (session.status !== 'ended' && code !== 0) {
            session.status = 'failed';
            const reason = lastNonEmptyLine(session.logTail);
            session.lastError = `FFmpeg exited with code ${code ?? 'null'} signal ${signal ?? 'none'}${reason ? `: ${reason}` : ''}`;
        } else if (session.status !== 'failed') {
            session.status = 'ended';
        }
    });

    waitForPlaylist(session, STARTUP_TIMEOUT_MS)
        .then(() => {
            if (session.status === 'starting') session.status = 'ready';
        })
        .catch((err) => {
            if (session.status === 'starting') {
                console.warn(`[ffmpeg:${session.id}] playlist still warming after ${STARTUP_TIMEOUT_MS}ms: ${err.message}`);
            }
        });

    return child;
}

function audioArgsForSession(session) {
    return shouldCopyAudio(session) ? ['-c:a', 'copy'] : TRANSCODE_AUDIO_ARGS;
}

function audioModeForSession(session) {
    return shouldCopyAudio(session) ? 'copy' : 'transcode';
}

function appendSubtitleOutputs(args, session) {
    const tracks = subtitleTracksForSession(session);
    if (!tracks.length) return;

    for (const track of tracks) {
        args.push(
            '-map', `0:${track.index}?`,
            '-c:s', 'webvtt',
            '-flush_packets', '1',
            '-f', 'webvtt',
            path.join(session.outputDir, `sub_${track.index}.vtt`)
        );
    }
    console.log(`[media-gateway] extracting subtitle stream(s): ${tracks.map((track) => track.index).join(', ')}`);
}

function subtitleTracksForSession(session) {
    const tracks = Array.isArray(session.codecProfile?.subtitles)
        ? session.codecProfile.subtitles
        : (Array.isArray(session.playbackHint?.subtitles) ? session.playbackHint.subtitles : []);
    const seen = new Set();

    return tracks
        .filter((track) => track && track.extractable === true && subtitleKind(track.codec) === 'text')
        .map((track) => ({ ...track, index: nullableInt(track.index) }))
        .filter((track) => {
            if (track.index === null || track.index === undefined) return false;
            if (seen.has(track.index)) return false;
            seen.add(track.index);
            return true;
        })
        .slice(0, MAX_SUBTITLE_TRACKS);
}

function shouldCopyAudio(session) {
    const requestedMode = normalizeCodecToken(session.audioMode);
    if (requestedMode === 'transcode' || requestedMode === 'encode') return false;
    if (session.clientAudioPassthrough === false) return false;

    const selectedTrack = selectedAudioTrackForSession(session);
    const codec = normalizeCodecToken(
        selectedTrack?.codec ||
        session.audioCodec ||
        session.codecProfile?.audioCodec ||
        session.codecProfile?.audio_codec ||
        session.codecProfile?.audio
    );
    const profile = normalizeCodecToken(
        session.audioProfile ||
        session.codecProfile?.audioProfile ||
        session.codecProfile?.audio_profile
    );
    const channels = nullableInt(selectedTrack?.channels ?? session.audioChannels ?? session.codecProfile?.audioChannels ?? session.codecProfile?.audio_channels ?? session.codecProfile?.channels);

    if (!codec) return false;
    if (!Number.isInteger(channels) || channels <= 0) return false;
    if (channels && channels > 2) return false;
    if (isKnownUnsafeAudio(codec, profile)) return false;
    return isKnownBrowserSafeAudio(codec, profile);
}

function audioMapForSession(session) {
    const selectedTrack = selectedAudioTrackForSession(session);
    const selectedIndex = nullableInt(selectedTrack?.index);
    if (Number.isInteger(selectedIndex)) return `0:${selectedIndex}?`;
    if (Number.isInteger(session.audioStreamIndex)) return `0:${session.audioStreamIndex}?`;
    return '0:a:0?';
}

function selectedAudioTrackForSession(session) {
    const tracks = Array.isArray(session.codecProfile?.audioTracks)
        ? session.codecProfile.audioTracks
        : (Array.isArray(session.codecProfile?.audio_tracks) ? session.codecProfile.audio_tracks : []);
    if (!tracks.length) return null;
    if (Number.isInteger(session.audioStreamIndex)) {
        const selected = tracks.find((track) => nullableInt(track?.index) === session.audioStreamIndex);
        if (selected) return selected;
    }
    return tracks.find((track) => track?.default === true) || tracks[0] || null;
}

function isKnownBrowserSafeAudio(codec, profile) {
    const joined = `${codec} ${profile}`;
    if (hasHeAacMarker(joined)) return false;
    return (
        codec.includes('aac') ||
        codec.includes('mp4a.40.2') ||
        codec.includes('mp3') ||
        codec.includes('opus') ||
        codec.includes('vorbis')
    );
}

function isKnownUnsafeAudio(codec, profile) {
    const joined = `${codec} ${profile}`;
    return (
        hasHeAacMarker(joined) ||
        codec.includes('eac3') ||
        codec.includes('e-ac3') ||
        codec.includes('ac3') ||
        codec.includes('dts') ||
        codec.includes('truehd') ||
        codec.includes('flac') ||
        codec.includes('pcm')
    );
}

function hasHeAacMarker(value) {
    const normalized = normalizeCodecToken(value);
    return (
        normalized.includes('heaac') ||
        normalized.includes('aache') ||
        normalized.includes('sbr') ||
        normalized.includes('mp4a.40.5') ||
        normalized.includes('mp4a.40.29')
    );
}

async function probeCodecProfile(sourceUrl, userAgent) {
    const startedAt = Date.now();
    probeStats.attempts += 1;
    const args = [
        '-v', 'error',
        '-rw_timeout', '8000000',
        '-user_agent', userAgent || FFMPEG_USER_AGENT,
        '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
        '-analyzeduration', String(CODEC_PROBE_ANALYZE_DURATION_US),
        '-probesize', String(CODEC_PROBE_SIZE_BYTES),
        '-show_streams',
        '-show_format',
        '-print_format', 'json',
        sourceUrl
    ];

    const payload = await runFfprobe(args, CODEC_PROBE_TIMEOUT_MS, sourceUrl);
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const video = streams.find((stream) => stream?.codec_type === 'video') || {};
    const audioStreams = streams.filter((stream) => stream?.codec_type === 'audio');
    const subtitleStreams = streams.filter((stream) => stream?.codec_type === 'subtitle');
    const audio = audioStreams[0] || {};
    const format = asRecord(payload.format);
    const profile = compactRecord({
        videoCodec: stringOrNull(video.codec_name),
        videoProfile: stringOrNull(video.profile),
        videoWidth: nullableInt(video.width),
        videoHeight: nullableInt(video.height),
        videoPixelFormat: stringOrNull(video.pix_fmt),
        audioCodec: stringOrNull(audio.codec_name),
        audioProfile: stringOrNull(audio.profile),
        audioChannels: nullableInt(audio.channels),
        audioChannelLayout: stringOrNull(audio.channel_layout),
        audioSampleRate: nullableInt(audio.sample_rate),
        audioTracks: audioStreams.map((stream, order) => compactRecord({
            index: nullableInt(stream.index),
            order,
            language: streamLanguage(stream),
            title: streamTitle(stream, `Audio ${order + 1}`),
            codec: stringOrNull(stream.codec_name),
            channels: nullableInt(stream.channels),
            default: stream.disposition?.default === 1
        })),
        subtitles: subtitleStreams.map((stream, order) => {
            const codec = stringOrNull(stream.codec_name);
            const subtitleType = subtitleKind(codec);
            const extractable = subtitleType === 'text';
            return compactRecord({
                index: nullableInt(stream.index),
                order,
                language: streamLanguage(stream),
                title: streamTitle(stream, `Subtitle ${order + 1}`),
                codec,
                subtitleType,
                extractable,
                burnInRequired: subtitleType === 'image',
                unsupportedReason: extractable
                    ? null
                    : (subtitleType === 'image'
                        ? 'Image subtitles require burn-in video transcoding'
                        : `Unsupported subtitle codec: ${codec || 'unknown'}`)
            });
        }),
        container: stringOrNull(format.format_name),
        durationSeconds: nullableFloat(format.duration),
        bitRate: nullableInt(format.bit_rate),
        probeSource: 'gateway_probe',
        probeMs: Math.max(1, Date.now() - startedAt),
        probedAt: new Date().toISOString()
    });
    if (hasUsefulCodecProfile(profile)) {
        probeStats.successes += 1;
        probeStats.last = compactRecord({
            ok: true,
            streamCount: streams.length,
            videoCount: streams.filter((stream) => stream?.codec_type === 'video').length,
            audioCount: audioStreams.length,
            subtitleCount: subtitleStreams.length,
            extractableSubtitleCount: profile.subtitles.filter((track) => track.extractable === true).length,
            probeMs: profile.probeMs,
            time: profile.probedAt
        });
        return profile;
    }

    probeStats.empty += 1;
    probeStats.last = {
        ok: false,
        reason: 'empty_profile',
        streamCount: streams.length,
        probeMs: Math.max(1, Date.now() - startedAt),
        time: new Date().toISOString()
    };
    return {};
}

function rememberProbeFailure(detail, sourceUrl) {
    probeStats.failures += 1;
    probeStats.lastFailure = {
        detail: sanitizeLog(detail || 'Codec probe failed', sourceUrl).slice(0, 1000),
        time: new Date().toISOString()
    };
    probeStats.last = {
        ok: false,
        reason: 'probe_failed',
        time: probeStats.lastFailure.time
    };
}

function streamLanguage(stream) {
    const tags = asRecord(stream?.tags);
    return stringOrNull(tags.language || tags.LANGUAGE || tags.lang || tags.LANG);
}

function streamTitle(stream, fallback) {
    const tags = asRecord(stream?.tags);
    return stringOrNull(tags.title || tags.TITLE || tags.handler_name || tags.HANDLER_NAME) || fallback;
}

function subtitleKind(codec) {
    const normalized = normalizeCodecToken(codec);
    if (['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'movtext', 'text'].includes(normalized)) return 'text';
    if (['hdmvpgssubtitle', 'dvdsubtitle', 'dvbsubtitle', 'xsub'].includes(normalized)) return 'image';
    return normalized ? 'unknown' : '';
}

function runFfprobe(args, timeoutMs, sourceUrl) {
    return new Promise((resolve, reject) => {
        const child = spawn(FFPROBE_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let finished = false;
        const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            child.kill('SIGTERM');
            reject(new Error('Codec probe timeout'));
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 512_000) stdout = stdout.slice(-512_000);
        });
        child.stderr.on('data', (chunk) => {
            stderr += sanitizeLog(chunk.toString(), sourceUrl);
            if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
        });
        child.on('error', (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('exit', (code, signal) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`Codec probe exited with code ${code ?? 'null'} signal ${signal ?? 'none'}${stderr ? `: ${lastNonEmptyLine(stderr)}` : ''}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout || '{}'));
            } catch (err) {
                reject(new Error(`Codec probe returned invalid JSON: ${err.message}`));
            }
        });
    });
}

function hasUsefulCodecProfile(profile) {
    const record = asRecord(profile);
    return Boolean(
        stringOrNull(record.videoCodec) ||
        stringOrNull(record.video_codec) ||
        stringOrNull(record.video) ||
        stringOrNull(record.audioCodec) ||
        stringOrNull(record.audio_codec) ||
        stringOrNull(record.audio) ||
        (Array.isArray(record.audioTracks) && record.audioTracks.length > 0) ||
        (Array.isArray(record.audio_tracks) && record.audio_tracks.length > 0) ||
        (Array.isArray(record.subtitles) && record.subtitles.length > 0) ||
        (Array.isArray(record.subtitleTracks) && record.subtitleTracks.length > 0) ||
        (Array.isArray(record.subtitle_tracks) && record.subtitle_tracks.length > 0)
    );
}

function mergeCodecProfiles(baseProfile, probeProfile) {
    const base = asRecord(baseProfile);
    const probe = asRecord(probeProfile);
    return compactRecord({
        ...base,
        ...probe,
        audioTracks: Array.isArray(probe.audioTracks) && probe.audioTracks.length ? probe.audioTracks : base.audioTracks,
        subtitles: Array.isArray(probe.subtitles) && probe.subtitles.length ? probe.subtitles : base.subtitles,
    });
}

function shouldProbeMissingSubtitleTracks(profile, playbackHint, sourceUrl) {
    const record = asRecord(profile);
    if (
        (Array.isArray(record.subtitles) && record.subtitles.length > 0) ||
        (Array.isArray(record.subtitleTracks) && record.subtitleTracks.length > 0) ||
        (Array.isArray(record.subtitle_tracks) && record.subtitle_tracks.length > 0)
    ) return false;

    const hint = asRecord(playbackHint);
    const streamType = String(hint.streamType || hint.stream_type || hint.itemType || hint.item_type || '').toLowerCase();
    if (streamType === 'live' || streamType === 'channel') return false;

    const container = String(hint.container || record.container || '').toLowerCase();
    if (['mkv', 'webm', 'avi'].includes(container)) return true;

    try {
        const extension = path.extname(new URL(sourceUrl).pathname).replace(/^\./, '').toLowerCase();
        return ['mkv', 'webm', 'avi'].includes(extension);
    } catch (_) {
        return streamType === 'series' || streamType === 'movie';
    }
}

function shouldProbeCodecProfile(playbackHint, sourceUrl) {
    const hint = asRecord(playbackHint);
    const streamType = String(hint.streamType || hint.stream_type || hint.itemType || hint.item_type || '').toLowerCase();
    if (streamType === 'live' || streamType === 'channel') return false;
    const container = String(hint.container || '').toLowerCase();
    if (container === 'm3u8' || container === 'ts') return false;
    try {
        const extension = path.extname(new URL(sourceUrl).pathname).replace(/^\./, '').toLowerCase();
        if (extension === 'm3u8' || extension === 'ts') return false;
        return ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv', 'mpeg', 'mpg', 'vob'].includes(extension) || streamType === 'movie' || streamType === 'series';
    } catch (_) {
        return streamType === 'movie' || streamType === 'series';
    }
}

async function waitForPlaylist(session, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (session.lastError) throw new Error(session.lastError);
        if (fs.existsSync(session.playlistPath)) return;
        await sleep(250);
    }
    throw new Error('Playlist timeout');
}

async function stopSession(session) {
    if (session.stoppingPromise) return session.stoppingPromise;

    session.status = 'stopping';
    session.stoppingPromise = (async () => {
        const child = session.ffmpeg;
        session.ffmpeg = null;
        await stopChildProcess(child);
        session.status = 'ended';
        sessions.delete(session.id);
        await removeSessionDir(session.outputDir);
    })();

    return session.stoppingPromise;
}

async function stopConflictingSourceSessions(sourceUrl) {
    const sourceKey = sourceSessionKey(sourceUrl);
    if (!sourceKey) return;

    const conflicts = Array.from(sessions.values()).filter((session) => {
        if (session.sourceKey !== sourceKey) return false;
        return isSessionBlockingProviderSlot(session);
    });

    await Promise.allSettled(conflicts.map(async (session) => {
        console.log(`[media-gateway] stopping previous session for same source: ${session.id}`);
        await stopSession(session);
    }));
}

async function stopConflictingOwnerSessions(ownerKey) {
    const normalizedOwnerKey = normalizeSessionKey(ownerKey);
    if (!normalizedOwnerKey) return;

    const conflicts = Array.from(sessions.values()).filter((session) => {
        if (session.ownerKey !== normalizedOwnerKey) return false;
        return isSessionBlockingProviderSlot(session);
    });

    await Promise.allSettled(conflicts.map(async (session) => {
        console.log(`[media-gateway] stopping previous session for same owner: ${session.id}`);
        await stopSession(session);
    }));
}

function activeSessionCount() {
    return Array.from(sessions.values())
        .filter((session) => session.status === 'starting' || session.status === 'ready')
        .length;
}

function isSessionBlockingProviderSlot(session) {
    return session?.status === 'starting' || session?.status === 'ready' || session?.status === 'stopping';
}

function stopChildProcess(child, timeoutMs = 2500) {
    return new Promise((resolve) => {
        if (!child || child.exitCode !== null || child.signalCode) {
            resolve();
            return;
        }

        let done = false;
        let killTimer = null;
        const finish = () => {
            if (done) return;
            done = true;
            if (killTimer) clearTimeout(killTimer);
            child.off('exit', finish);
            child.off('error', finish);
            resolve();
        };
        killTimer = setTimeout(() => {
            if (!done) {
                try { child.kill('SIGKILL'); } catch (_) { }
            }
        }, timeoutMs);

        child.once('exit', finish);
        child.once('error', finish);
        try {
            child.kill('SIGTERM');
        } catch (_) {
            finish();
        }
    });
}

function normalizeSessionKey(value) {
    if (typeof value !== 'string') return '';
    const normalized = value.trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

async function removeSessionDir(dir) {
    const resolved = path.resolve(dir);
    if (!isWithin(OUTPUT_DIR, resolved) || resolved === OUTPUT_DIR) return;
    await fsp.rm(resolved, { recursive: true, force: true });
}

function requireGatewayAuth(req, res, next) {
    if (!GATEWAY_TOKEN) {
        return res.status(503).json({ error: 'Gateway token is not configured' });
    }
    const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token || !timingSafeEqual(token, GATEWAY_TOKEN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function requirePlaybackToken(req, res, next) {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send('Session not found');
    if (session.expiresAt.getTime() < Date.now()) {
        stopSession(session).catch((err) => console.error('[media-gateway] cleanup failed:', err));
        return res.status(410).send('Session expired');
    }
    const token = req.query.token || '';
    if (!token || !timingSafeEqual(String(token), session.accessToken)) {
        return res.status(401).send('Unauthorized');
    }
    next();
}

function cors(req, res, next) {
    const allowed = (process.env.ALLOWED_ORIGINS || 'https://norva-eight.vercel.app,https://norva-pgkk.vercel.app')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    const origin = req.headers.origin;
    if (origin && (allowed.includes('*') || allowed.includes(origin) || isLocalOrigin(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (allowed[0]) {
        res.setHeader('Access-Control-Allow-Origin', allowed[0]);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
    res.setHeader('Vary', 'Origin');
    next();
}

function serializeSession(req, session) {
    return {
        id: session.id,
        playbackSessionId: session.playbackSessionId,
        status: session.status,
        mode: session.mode,
        audioMode: audioModeForSession(session),
        audioStreamIndex: session.audioStreamIndex,
        codecProfile: session.codecProfile,
        codecProfileSource: session.codecProfileSource || null,
        hlsUrl: publicUrl(req, `/sessions/${session.id}/playlist.m3u8?token=${encodeURIComponent(session.accessToken)}`),
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        lastError: session.lastError,
        logTail: session.logTail
    };
}

function debugSession(session) {
    const selectedTrack = selectedAudioTrackForSession(session);
    return {
        id: session.id,
        playbackSessionId: session.playbackSessionId,
        status: session.status,
        mode: session.mode,
        audioMode: audioModeForSession(session),
        audioStreamIndex: session.audioStreamIndex,
        audioMap: audioMapForSession(session),
        audioCodec: session.audioCodec,
        audioChannels: session.audioChannels,
        selectedAudioTrack: selectedTrack
            ? {
                index: nullableInt(selectedTrack.index),
                language: selectedTrack.language || null,
                title: selectedTrack.title || null,
                codec: selectedTrack.codec || null,
                channels: nullableInt(selectedTrack.channels),
                default: selectedTrack.default === true
            }
            : null,
        codecProfileSource: session.codecProfileSource || null,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        lastError: session.lastError,
        logTail: String(session.logTail || '').slice(-1200)
    };
}

function publicUrl(req, pathname) {
    if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL}${pathname}`;
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}${pathname}`;
}

function resolveSessionDir(id) {
    const dir = path.resolve(OUTPUT_DIR, id);
    if (!isWithin(OUTPUT_DIR, dir)) throw new Error('Invalid session directory');
    return dir;
}

function isWithin(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function randomToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function timingSafeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

function xtreamPlayerApiUrl({ serverUrl, username, password, action, streamId, limit }) {
    const url = new URL(`${String(serverUrl).replace(/\/+$/, '')}/player_api.php`);
    url.searchParams.set('username', String(username));
    url.searchParams.set('password', String(password));
    url.searchParams.set('action', action);
    url.searchParams.set('stream_id', String(streamId));
    if (limit) url.searchParams.set('limit', String(limit));
    return url.href;
}

async function fetchProviderJson(url, userAgent) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), XTREAM_REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json,text/plain,*/*',
                'User-Agent': userAgent
            }
        });
        const text = await response.text();
        const payload = text ? safeJson(text) : {};
        if (!response.ok) {
            const error = new Error('IPTV provider request failed');
            error.status = response.status;
            error.publicMessage = 'IPTV provider request failed';
            error.details = payload;
            throw error;
        }
        return payload;
    } catch (err) {
        if (err.status) throw err;
        const error = new Error('Unable to reach IPTV provider');
        error.status = err.name === 'AbortError' ? 504 : 502;
        error.publicMessage = 'Unable to reach IPTV provider';
        error.details = err.message;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return { raw: String(text || '').slice(0, 2000) };
    }
}

function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringOrNull(value) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return String(value);
    return null;
}

function nullableInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAudioStreamIndex(value) {
    const parsed = nullableInt(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1024) return null;
    return parsed;
}

function nullableFloat(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSeekOffset(value) {
    const parsed = nullableFloat(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.max(0, Math.min(Math.floor(parsed), 24 * 60 * 60));
}

function compactRecord(record) {
    return Object.fromEntries(Object.entries(asRecord(record)).filter(([, value]) => (
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !(typeof value === 'number' && !Number.isFinite(value))
    )));
}

function normalizeCodecToken(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9.]+/g, '');
}

function sanitizeUserAgent(value) {
    if (typeof value !== 'string') return null;
    // Strip control chars (incl. CR/LF) so the value cannot inject extra
    // FFmpeg header lines, then cap length defensively.
    const cleaned = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (!cleaned) return null;
    return cleaned.slice(0, 256);
}

function sourceSessionKey(value) {
    try {
        const url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        const folder = parts[0] || '';
        const username = parts[1] || '';
        const password = parts[2] || '';
        const identity = `${url.origin}/${folder}/${username}/${password}`;
        return crypto.createHash('sha256').update(identity).digest('hex');
    } catch (_) {
        return '';
    }
}

function segmentContentType(file) {
    if (file.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
    if (file.endsWith('.m4s')) return 'video/iso.segment';
    if (file.endsWith('.mp4')) return 'video/mp4';
    if (file.endsWith('.aac')) return 'audio/aac';
    return 'video/mp2t';
}

function appendLogTail(session, text) {
    session.logTail = `${session.logTail || ''}${text}`.slice(-MAX_LOG_TAIL);
}

function rememberFailure(session, detail) {
    lastFailures.push({
        id: session.id,
        playbackSessionId: session.playbackSessionId,
        mode: session.mode,
        status: session.status,
        detail: String(detail || '').slice(0, 1000),
        logTail: String(session.logTail || '').slice(-2000),
        time: new Date().toISOString()
    });
    while (lastFailures.length > 10) lastFailures.shift();
}

function rewritePlaylistSegments(playlist, token) {
    const encodedToken = encodeURIComponent(token);
    return String(playlist || '')
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#EXT-X-MAP')) {
                return line.replace(/URI="([^"]+)"/i, (_match, uri) => `URI="${appendToken(uri, encodedToken)}"`);
            }
            if (trimmed.startsWith('#')) return line;
            if (/^https?:\/\//i.test(trimmed)) return appendToken(trimmed, encodedToken);
            return appendToken(trimmed, encodedToken);
        })
        .join('\n');
}

function appendToken(uri, encodedToken) {
    if (/[?&]token=/.test(uri)) return uri;
    return `${uri}${uri.includes('?') ? '&' : '?'}token=${encodedToken}`;
}

function sanitizeLog(text, sourceUrl) {
    let safe = String(text || '');
    try {
        const parsed = new URL(sourceUrl);
        safe = safe.replaceAll(sourceUrl, `${parsed.origin}/<redacted>`);
        for (const part of parsed.pathname.split('/').filter(Boolean)) {
            if (part.length >= 4) safe = safe.replaceAll(part, '<redacted>');
        }
        for (const [key, value] of parsed.searchParams.entries()) {
            if (value) safe = safe.replaceAll(value, '<redacted>');
            safe = safe.replaceAll(key, '<redacted>');
        }
    } catch (_) {
        safe = safe.replace(/https?:\/\/\S+/g, '<redacted-url>');
    }
    return safe;
}

function lastNonEmptyLine(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-1)[0] || '';
}

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value || ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalOrigin(origin) {
    try {
        const { hostname } = new URL(origin);
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch (_) {
        return false;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
        if (session.expiresAt.getTime() < now) {
            stopSession(session).catch((err) => console.error('[media-gateway] cleanup failed:', err));
        }
    }
}, 60 * 1000).unref();

bootstrap().catch((err) => {
    console.error('[media-gateway] bootstrap failed:', err);
    process.exit(1);
});

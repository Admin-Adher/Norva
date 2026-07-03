const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const db = require('../db');
const transcodeSession = require('../services/transcodeSession');
const { normalizeUpstreamError, sanitizeErrorMessage } = require('../utils/upstreamError');

/**
 * Transcode Routes
 * 
 * Direct streaming (backward compatible):
 *   GET /api/transcode?url=...&start=...
 * 
 * HLS session-based (new, supports seeking):
 *   POST /api/transcode/session        - Create new session
 *   GET  /api/transcode/:id/stream.m3u8 - Get HLS playlist
 *   GET  /api/transcode/:id/:segment.ts - Get segment file
 *   DELETE /api/transcode/:id          - Stop and cleanup session
 *   GET /api/transcode/sessions        - List all sessions (debug)
 */

// Start session cleanup interval
transcodeSession.startCleanupInterval();

/**
 * Create a new transcode session
 * POST /api/transcode/session
 * Body: { url: string, seekOffset?: number, start?: number }
 */
router.post('/session', async (req, res) => {
    const { url, seekOffset, start, videoMode, videoCodec, audioCodec, audioChannels, audioStreamIndex, subtitleTracks } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    try {
        const textSubtitleTracks = Array.isArray(subtitleTracks) ? subtitleTracks.slice(0, 8) : [];
        if (textSubtitleTracks.length > 0) {
            console.log(`[Transcode] Extracting subtitle stream(s): ${textSubtitleTracks.map(t => t.index).join(', ')}`);
        }

        const sessionOptions = {
            ffmpegPath,
            userAgent,
            seekOffset: seekOffset || start || 0,
            hwEncoder: settings.hwEncoder || 'software',
            maxResolution: settings.maxResolution || '1080p',
            quality: settings.quality || 'medium',
            audioMixPreset: settings.audioMixPreset || 'auto', // Audio downmix preset
            // Upscaling options
            upscaleEnabled: settings.upscaleEnabled || false,
            upscaleMethod: settings.upscaleMethod || 'hardware',
            upscaleTarget: settings.upscaleTarget || '1080p',
            videoMode: videoMode, // 'copy' or 'encode'
            videoCodec: videoCodec, // 'h264', 'hevc', etc.
            audioCodec: audioCodec, // 'aac', 'ac3', etc.
            audioChannels: audioChannels, // number of channels (2=stereo)
            audioStreamIndex: audioStreamIndex, // ffprobe stream index for multi-audio VOD
            // Text subtitle tracks to extract in-process as growing .vtt files
            // (zero extra provider connections — see addSubtitleOutputArgs)
            subtitleTracks: textSubtitleTracks
        };

        // Full video encoding (HEVC/10-bit/upscale) can take longer to emit
        // the first segment than audio-only/copy sessions, especially on CPU.
        const startupTimeoutMs = videoMode === 'encode' ? 45000 : 15000;

        // Connection-limit / auth errors (401/403/429) on single-connection
        // IPTV accounts are usually transient: the previous stream's slot (or
        // the ffprobe pass that just ran) hasn't been released by the provider
        // yet. Rather than failing the title outright, wait for the slot to
        // free up and try again a couple of times before giving up.
        const RETRYABLE_CODES = new Set([
            'UPSTREAM_UNAUTHORIZED', 'UPSTREAM_FORBIDDEN', 'UPSTREAM_RATE_LIMIT',
            'UPSTREAM_PROVIDER_BUSY'
        ]);
        // 2s + 6s + 9s spans the provider's ~8s slot-release window (the old
        // 1.8s+3.5s topped out at 5.3s total — always INSIDE the busy window).
        const RETRY_DELAYS_MS = [2000, 6000, 9000];
        const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

        let lastUpstream = null;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const session = await transcodeSession.createSession(url, sessionOptions);
            await session.start();
            const ready = await session.waitForPlaylist(startupTimeoutMs);

            if (ready) {
                return res.json({
                    sessionId: session.id,
                    playlistUrl: `/api/transcode/${session.id}/stream.m3u8`,
                    status: session.status
                });
            }

            // Surface the FFmpeg error (e.g. "Server returned 401 Unauthorized")
            // so the client can show a meaningful message instead of spinning
            const detail = (session.stderrTail || session.error || 'Playlist not generated in time').trim();
            lastUpstream = normalizeUpstreamError(detail);
            // Wait for FFmpeg to fully die (releases the provider connection)
            // before we either retry or report failure.
            await transcodeSession.removeSession(session.id);

            const canRetry = RETRYABLE_CODES.has(lastUpstream.code) && attempt < MAX_ATTEMPTS - 1;
            if (!canRetry) break;

            const delay = RETRY_DELAYS_MS[attempt];
            console.log(`[Transcode] ${lastUpstream.code} on attempt ${attempt + 1}/${MAX_ATTEMPTS}; ` +
                `provider slot likely still busy, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        const upstream = lastUpstream || normalizeUpstreamError('Playlist not generated in time');
        if (upstream.code === 'UPSTREAM_PROVIDER_BUSY') res.set('Retry-After', '8');
        return res.status(upstream.terminal ? 502 : 500).json({
            error: upstream.friendly,
            details: upstream.details.slice(-300),
            code: upstream.code,
            upstreamStatus: upstream.upstreamStatus,
            terminal: upstream.terminal,
            ...(upstream.code === 'UPSTREAM_PROVIDER_BUSY' ? { retryAfter: 8 } : {})
        });

    } catch (err) {
        const upstream = normalizeUpstreamError(err);
        console.error('[Transcode] Session creation failed:', upstream.details);
        res.status(upstream.terminal ? 502 : 500).json({
            error: upstream.terminal ? upstream.friendly : 'Failed to create session',
            details: upstream.details,
            code: upstream.code,
            upstreamStatus: upstream.upstreamStatus,
            terminal: upstream.terminal
        });
    }
});

/**
 * Get HLS playlist for a session
 * GET /api/transcode/:sessionId/stream.m3u8
 */
router.get('/:sessionId/stream.m3u8', async (req, res) => {
    const { sessionId } = req.params;
    const session = transcodeSession.getSession(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    const playlist = await session.getPlaylist();
    if (!playlist) {
        return res.status(404).json({ error: 'Playlist not ready' });
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(playlist);
});

/**
 * Get a segment file for a session
 * GET /api/transcode/:sessionId/:segment.ts
 */
router.get('/:sessionId/:segment', async (req, res) => {
    const { sessionId, segment } = req.params;

    const session = transcodeSession.getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    // In-process extracted subtitles: growing WebVTT files (sub_<index>.vtt)
    if (/^sub_\d+\.vtt$/.test(segment)) {
        const vttPath = await session.getSegment(segment);
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store'); // file grows while transcoding
        if (!vttPath) {
            // Track exists but FFmpeg hasn't written the first cue yet
            return res.send('WEBVTT\n\n');
        }
        try {
            // Size-based ETag: the file is append-only, so an unchanged size
            // means no new cues. Lets the client poll fast (sub-second) and
            // get cheap 304s instead of re-downloading the whole file.
            const stat = await fs.stat(vttPath);
            const etag = `"vtt-${stat.size}"`;
            res.setHeader('ETag', etag);
            if (req.headers['if-none-match'] === etag) {
                return res.status(304).end();
            }
            const body = await fs.readFile(vttPath, 'utf8');
            return res.send(body && body.trim() ? body : 'WEBVTT\n\n');
        } catch (err) {
            return res.send('WEBVTT\n\n');
        }
    }

    // Only handle .ts files beyond this point
    if (!segment.endsWith('.ts')) {
        return res.status(404).json({ error: 'Invalid segment' });
    }

    const segmentPath = await session.getSegment(segment);
    if (!segmentPath) {
        return res.status(404).json({ error: 'Segment not found' });
    }

    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache forever (immutable)
    res.sendFile(segmentPath);
});

/**
 * Stop and cleanup a session
 * DELETE /api/transcode/:sessionId
 */
router.delete('/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    try {
        await transcodeSession.removeSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove session', details: err.message });
    }
});

/**
 * List all active sessions (for debugging)
 * GET /api/transcode/sessions
 */
router.get('/sessions', (req, res) => {
    res.json(transcodeSession.getAllSessions());
});

/**
 * Direct transcode stream (backward compatible, no seeking)
 * GET /api/transcode?url=...&start=...
 * 
 * Transcodes audio to AAC for browser compatibility while passing video through.
 * This fixes playback issues with Dolby/AC3/EAC3 audio that browsers can't decode.
 */
router.get('/', async (req, res) => {
    const { url, start, audioStreamIndex } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const startOffset = parseFloat(start);
    const hasStartOffset = Number.isFinite(startOffset) && startOffset > 0;
    const selectedAudioStreamIndex = Number.parseInt(audioStreamIndex, 10);
    const audioMap = Number.isInteger(selectedAudioStreamIndex) && selectedAudioStreamIndex >= 0
        ? `0:${selectedAudioStreamIndex}?`
        : '0:a:0?';

    // Get User-Agent from settings
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);

    console.log(`[Transcode] Starting transcoding for: ${sanitizeErrorMessage(url)}`);
    console.log(`[Transcode] Using User-Agent: ${settings.userAgentPreset}`);
    console.log(`[Transcode] Using binary: ${ffmpegPath}`);

    // FFmpeg arguments for transcoding
    // Optimized for VOD content with incompatible audio (Dolby/AC3/EAC3)
    // Also works for live streams with ad stitching (Pluto TV, etc.)
    const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-user_agent', userAgent,
        // Faster startup - reduced probe/analyze for quicker first bytes
        '-probesize', '2000000', // 2MB (reduced from 5MB)
        '-analyzeduration', '3000000', // 3 seconds (reduced from 10s)
        // Error resilience: generate timestamps, discard corrupt packets
        '-fflags', '+genpts+discardcorrupt+nobuffer',
        // Ignore errors in stream and continue
        '-err_detect', 'ignore_err',
        // Limit max demux delay to prevent buffering issues
        '-max_delay', '2000000',
        // Reconnect settings for network drops (useful for live streams)
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '3',
        // Prevent Range/HEAD requests that some providers reject with 405
        '-seekable', '0',
        ...(hasStartOffset ? ['-ss', String(startOffset)] : []),
        '-i', url,
        // Map video and selected audio stream (avoid subtitle streams causing issues)
        '-map', '0:v:0',
        '-map', audioMap, // ? makes audio optional if not present
        // Video: passthrough (no re-encoding = fast!)
        '-c:v', 'copy',
        // Audio: Transcode to browser-compatible AAC
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        // Handle async audio/video using async filter
        '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
        // Timestamp handling
        '-fps_mode', 'passthrough',
        '-async', '1',
        '-max_muxing_queue_size', '2048',
        // Fragmented MP4 for streaming (browser-compatible)
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
        '-flush_packets', '1', // Send data immediately
        '-' // Output to stdout
    ];

    console.log(`[Transcode] Full command: ${ffmpegPath} ${sanitizeErrorMessage(args.join(' '))}`);

    let ffmpeg;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (spawnErr) {
        console.error('[Transcode] Failed to spawn FFmpeg:', spawnErr);
        return res.status(500).json({ error: 'FFmpeg spawn failed', details: spawnErr.message });
    }

    // Collect stderr for error reporting
    let stderrBuffer = '';

    // Set headers for fragmented MP4
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Pipe stdout to response
    ffmpeg.stdout.pipe(res);

    // Log stderr (useful for debugging transcoding failures)
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        stderrBuffer += msg;
        console.log(`[FFmpeg] ${msg}`);
    });

    // Cleanup on client disconnect
    req.on('close', () => {
        console.log('[Transcode] Client disconnected, killing FFmpeg process');
        ffmpeg.kill('SIGKILL');
    });

    // Handle process exit
    ffmpeg.on('exit', (code) => {
        if (code !== null && code !== 0 && code !== 255) { // 255 is often returned on kill
            console.error(`[Transcode] FFmpeg exited with code ${code}`);
        }
    });

    // Handle spawn errors
    ffmpeg.on('error', (err) => {
        console.error('[Transcode] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Transcoding failed to start' });
        }
    });
});

module.exports = router;

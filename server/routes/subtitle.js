const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { normalizeUpstreamError } = require('../utils/upstreamError');

const TEXT_SUBTITLE_CODECS = new Set([
    'subrip',
    'srt',
    'ass',
    'ssa',
    'mov_text',
    'webvtt',
    'text',
    'microdvd',
    'subviewer',
    'subviewer1',
    'sami',
    'realtext',
    'mpl2',
    'jacosub',
    'pjs'
]);
const IMAGE_SUBTITLE_CODECS = new Set([
    'hdmv_pgs_subtitle',
    'pgs',
    'dvd_subtitle',
    'dvb_subtitle',
    'xsub'
]);

const DEFAULT_WINDOW_SECONDS = 5 * 60;
const MAX_WINDOW_SECONDS = 15 * 60;
const EXTRACTION_TIMEOUT_MS = 30 * 1000;

function parsePositiveNumber(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function clampWindowDuration(value) {
    const parsed = parsePositiveNumber(value) || DEFAULT_WINDOW_SECONDS;
    return Math.min(parsed, MAX_WINDOW_SECONDS);
}

/**
 * Subtitle extraction endpoint
 * GET /api/subtitle?url=...&index=...&start=...
 * 
 * Extracts a specific subtitle track and converts it to WebVTT on the fly.
 * When start is provided, FFmpeg seeks before the input so cue timestamps are
 * rebased to the local playback timeline used by restarted transcode sessions.
 */
router.get('/', async (req, res) => {
    const { url, index, start, codec, duration } = req.query;

    if (!url || index === undefined) {
        return res.status(400).json({ error: 'URL and index parameters are required' });
    }

    const trackIndex = Number.parseInt(index, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) {
        return res.status(400).json({ error: 'Invalid subtitle track index' });
    }

    const startOffset = Number.parseFloat(start);
    const hasStartOffset = Number.isFinite(startOffset) && startOffset > 0;
    const windowDuration = clampWindowDuration(duration);
    const subtitleCodec = String(codec || '').toLowerCase();
    if (subtitleCodec && !TEXT_SUBTITLE_CODECS.has(subtitleCodec)) {
        const reason = IMAGE_SUBTITLE_CODECS.has(subtitleCodec)
            ? 'Image subtitles cannot be converted to WebVTT. Use burn-in transcoding for this track.'
            : `Unsupported subtitle codec: ${subtitleCodec}`;
        return res.status(415).json({ error: reason, codec: subtitleCodec });
    }

    const ffmpegPath = req.app.locals.ffmpegPath || 'ffmpeg';
    const settings = await db.settings.get();
    const userAgent = db.getUserAgent(settings);
    const outputPath = path.join(os.tmpdir(), `norva-subtitle-${Date.now()}-${crypto.randomUUID()}.vtt`);

    console.log(`[Subtitle] Extracting track=${trackIndex}, codec=${subtitleCodec || 'unknown'}, start=${hasStartOffset ? startOffset : 0}, duration=${windowDuration}s`);

    const args = [
        '-y',
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        '-user_agent', userAgent,
        '-probesize', '2000000',
        '-analyzeduration', '3000000',
        ...(hasStartOffset ? ['-ss', String(startOffset)] : []),
        '-i', url,
        '-map', `0:${trackIndex}`,
        '-t', String(windowDuration),
        // No make_zero: it would snap the first cue of the window to 0 and
        // desync everything after it. Input-side -ss already rebases timestamps.
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        outputPath
    ];

    let ffmpeg;
    let stderr = '';
    let processClosed = false;
    let clientClosed = false;
    let timedOut = false;
    try {
        ffmpeg = spawn(ffmpegPath, args);
    } catch (err) {
        console.error('[Subtitle] Failed to spawn FFmpeg:', err);
        return res.status(500).send('Subtitle extraction failed');
    }

    const timer = setTimeout(() => {
        if (!processClosed) {
            timedOut = true;
            stderr += `\nSubtitle extraction timed out after ${EXTRACTION_TIMEOUT_MS}ms`;
            ffmpeg.kill('SIGKILL');
        }
    }, EXTRACTION_TIMEOUT_MS);

    ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
    });

    res.on('close', () => {
        if (res.writableEnded) return;
        clientClosed = true;
        console.warn('[Subtitle] Client closed before subtitle extraction completed');
        if (!processClosed) {
            ffmpeg.kill('SIGKILL');
        }
    });

    ffmpeg.on('error', (err) => {
        clearTimeout(timer);
        console.error('[Subtitle] Failed to spawn FFmpeg:', err);
        if (!res.headersSent) {
            res.status(500).send('Subtitle extraction failed');
        }
    });

    ffmpeg.on('close', async (code) => {
        clearTimeout(timer);
        processClosed = true;
        if (clientClosed) {
            fs.promises.unlink(outputPath).catch(() => {});
            return;
        }

        if (timedOut || code !== 0) {
            const upstream = normalizeUpstreamError(stderr || `Subtitle FFmpeg exited with code ${code}`);
            console.warn(`[Subtitle] FFmpeg exited with code ${code}: ${stderr.slice(-500)}`);
            fs.promises.unlink(outputPath).catch(() => {});
            if (!res.headersSent) {
                res.status(timedOut ? 504 : (upstream.code === 'UPSTREAM_UNAUTHORIZED' ? 502 : 500)).json({
                    error: timedOut ? 'Subtitle extraction timed out' : (upstream.friendly || 'Subtitle extraction failed'),
                    details: upstream.details,
                    code: timedOut ? 'SUBTITLE_TIMEOUT' : upstream.code
                });
            }
            return;
        }

        let body;
        try {
            body = await fs.promises.readFile(outputPath, 'utf8');
        } catch (err) {
            console.warn('[Subtitle] Failed to read extracted subtitle file:', err.message);
            body = '';
        } finally {
            fs.promises.unlink(outputPath).catch(() => {});
        }

        if (!String(body || '').trim()) {
            body = 'WEBVTT\n\n';
        }

        console.log(`[Subtitle] Extracted ${Buffer.byteLength(body)} bytes`);

        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('X-Subtitle-Window-Duration', String(windowDuration));
        if (hasStartOffset) {
            res.setHeader('X-Subtitle-Window-Start', String(startOffset));
        }
        res.send(body);
    });
});

module.exports = router;

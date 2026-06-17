const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { normalizeUpstreamError, sanitizeErrorMessage } = require('../utils/upstreamError');

/**
 * Probe endpoint - detects stream codecs and container
 * GET /api/probe?url=...
 * 
 * Returns:
 * {
 *   video: "h264",
 *   audio: "aac",
 *   container: "mpegts",
 *   compatible: true,
 *   needsRemux: false,
 *   needsTranscode: false
 * }
 */

// Probe cache (URL → result)
const probeCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Browser-compatible codecs
const BROWSER_VIDEO_CODECS = ['h264', 'avc', 'avc1'];
const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];
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
const IGNORED_SUBTITLE_CODECS = new Set(['timed_id3', 'bin_data']);
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

function parsePositiveInteger(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getPixelFormatBitDepth(pixelFormat) {
    const fmt = String(pixelFormat || '').toLowerCase();
    const match = fmt.match(/p(9|1[0-6])(?:le|be)?$/) || fmt.match(/(?:^|_)(9|1[0-6])(?:le|be)?$/);
    return match ? parsePositiveInteger(match[1]) : null;
}

function getVideoBitDepth(stream) {
    return parsePositiveInteger(stream?.bits_per_raw_sample)
        || parsePositiveInteger(stream?.bits_per_sample)
        || getPixelFormatBitDepth(stream?.pix_fmt);
}

function getH264Compatibility(stream) {
    const profile = String(stream?.profile || '').toLowerCase();
    const pixelFormat = String(stream?.pix_fmt || '').toLowerCase();
    const bitDepth = getVideoBitDepth(stream);

    if (/high\s*10|high\s*4:2:2|high\s*4:4:4|high\s*422|high\s*444|cavlc\s*4:4:4/i.test(profile)) {
        return {
            browserSafe: false,
            copySafe: false,
            reason: `unsupported H.264 profile: ${stream.profile}`
        };
    }

    if (bitDepth && bitDepth > 8) {
        return {
            browserSafe: false,
            copySafe: false,
            reason: `unsupported ${bitDepth}-bit video`
        };
    }

    if (/yuv422|yuv444|gbr|rgb|gray10|gray12|gray16/i.test(pixelFormat)) {
        return {
            browserSafe: false,
            copySafe: false,
            reason: `unsupported pixel format: ${stream.pix_fmt}`
        };
    }

    return {
        browserSafe: true,
        copySafe: true,
        reason: null
    };
}

function getVideoCompatibility(stream, codec) {
    const videoCodec = String(codec || '').toLowerCase();

    if (!BROWSER_VIDEO_CODECS.some(c => videoCodec.includes(c))) {
        return {
            browserSafe: false,
            copySafe: false,
            reason: `unsupported video codec: ${videoCodec || 'unknown'}`
        };
    }

    if (videoCodec.includes('h264') || videoCodec.includes('avc')) {
        return getH264Compatibility(stream);
    }

    return {
        browserSafe: false,
        copySafe: false,
        reason: `video codec needs re-encode: ${videoCodec}`
    };
}

function getStreamLanguage(stream) {
    return stream?.tags?.language || 'und';
}

function getStreamTitle(stream, fallback) {
    return stream?.tags?.title || stream?.tags?.handler_name || fallback;
}

function getSubtitleCodec(stream) {
    return String(stream?.codec_name || '').toLowerCase();
}

function getSubtitleKind(stream) {
    const codec = getSubtitleCodec(stream);
    if (TEXT_SUBTITLE_CODECS.has(codec)) return 'text';
    if (IMAGE_SUBTITLE_CODECS.has(codec)) return 'image';
    return 'unknown';
}

function sniffStream(url, userAgent = null, timeout = 2500, redirects = 0) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.get(url, {
            headers: {
                'User-Agent': userAgent || DEFAULT_USER_AGENT,
                Accept: '*/*'
            },
            timeout
        }, (response) => {
            const statusCode = response.statusCode || 0;
            const location = response.headers.location;
            if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirects < 3) {
                response.resume();
                const nextUrl = new URL(location, url).toString();
                sniffStream(nextUrl, userAgent, timeout, redirects + 1).then(resolve, reject);
                return;
            }

            const chunks = [];
            let total = 0;
            const finish = () => {
                const buffer = Buffer.concat(chunks, total);
                resolve(classifySniff(buffer, response.headers['content-type'], statusCode));
            };

            response.on('data', (chunk) => {
                chunks.push(chunk);
                total += chunk.length;
                if (total >= 4096) {
                    req.destroy();
                    finish();
                }
            });
            response.on('end', finish);
        });

        req.on('timeout', () => {
            req.destroy(new Error('Sniff timeout'));
        });
        req.on('error', reject);
    });
}

function classifySniff(buffer, contentType = '', statusCode = 0) {
    const type = String(contentType || '').toLowerCase();
    const text = buffer.toString('utf8', 0, Math.min(buffer.length, 256)).trimStart();
    let kind = 'unknown';

    if (text.startsWith('#EXTM3U') || type.includes('mpegurl') || type.includes('m3u8')) {
        kind = 'hls';
    } else if (buffer[0] === 0x47 || type.includes('mp2t') || type.includes('mpegts')) {
        kind = 'mpegts';
    } else if (buffer.includes(Buffer.from('ftyp'), 0)) {
        kind = 'mp4';
    }

    return {
        kind,
        statusCode,
        contentType: contentType || null,
        bytes: buffer.length
    };
}

/**
 * Probe stream with ffprobe
 */
function getProbeTimeout(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 8000;
    return Math.min(Math.max(parsed, 2500), 15000);
}

function probeStream(url, ffprobePath, userAgent = null, timeout = 8000) {
    return new Promise((resolve, reject) => {
        const args = [
            '-v', 'error',
            '-user_agent', userAgent || DEFAULT_USER_AGENT,
            '-rw_timeout', String(timeout * 1000),
            '-print_format', 'json',
            '-show_streams',
            '-show_format',
            // 2MB / 3s is enough for VOD files (codec + duration come from the
            // container header) and roughly halves probe latency on slow providers
            '-probesize', '2000000',
            '-analyzeduration', '3000000',
            url
        ];

        const proc = spawn(ffprobePath, args);
        let stdout = '';
        let stderr = '';

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error('Probe timeout'));
        }, timeout);

        proc.stdout.on('data', (data) => { stdout += data; });
        proc.stderr.on('data', (data) => { stderr += data; });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output'));
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

/**
 * Analyze probe result and determine compatibility
 */
function analyzeProbeResult(probeResult, url) {
    const streams = probeResult.streams || [];
    const format = probeResult.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStreams = streams.filter(s => s.codec_type === 'audio');
    const audioStream = audioStreams.find(s => s.disposition?.default === 1) || audioStreams[0];

    const videoCodec = videoStream?.codec_name?.toLowerCase() || 'unknown';
    const audioCodec = audioStream?.codec_name?.toLowerCase() || 'unknown';
    const container = format.format_name?.toLowerCase() || 'unknown';
    const duration = parseFloat(format.duration);
    const videoProfile = videoStream?.profile || null;
    const videoPixelFormat = videoStream?.pix_fmt || null;
    const videoBitDepth = getVideoBitDepth(videoStream);
    const videoCompatibility = getVideoCompatibility(videoStream, videoCodec);

    // Check codec compatibility
    const videoOk = videoCompatibility.browserSafe;
    const audioOk = BROWSER_AUDIO_CODECS.some(c => audioCodec.includes(c));

    // Browser-safe containers
    // Note: We exclude 'webm' because ffprobe reports MKV as "matroska,webm", 
    // and H.264/AAC in MKV/WebM is not universally supported. Best to remux to MP4.
    const BROWSER_CONTAINERS = ['hls', 'mp4', 'mov'];
    const containerOk = BROWSER_CONTAINERS.some(c => container.includes(c));

    // Check if it's a raw TS stream (not HLS)
    const isRawTs = (container.includes('mpegts') || url.endsWith('.ts')) && !url.includes('.m3u8');

    // Extract audio and subtitle tracks
    const audioTracks = audioStreams.map((s, i) => ({
        index: s.index,
        order: i,
        language: getStreamLanguage(s),
        title: getStreamTitle(s, `Audio ${i + 1}`),
        codec: s.codec_name || 'unknown',
        channels: s.channels || 0,
        default: s.disposition?.default === 1
    }));

    const subtitleStreams = streams.filter(s => {
        const codec = getSubtitleCodec(s);
        return s.codec_type === 'subtitle' && !IGNORED_SUBTITLE_CODECS.has(codec);
    });

    const subtitles = subtitleStreams.map((s, i) => {
        const codec = getSubtitleCodec(s);
        const kind = getSubtitleKind(s);
        const extractable = kind === 'text';
        return {
            index: s.index,
            order: i,
            language: getStreamLanguage(s),
            title: getStreamTitle(s, `Subtitle ${i + 1}`),
            codec: s.codec_name,
            subtitleType: kind,
            extractable,
            default: s.disposition?.default === 1,
            forced: s.disposition?.forced === 1,
            hearingImpaired: s.disposition?.hearing_impaired === 1,
            disposition: s.disposition || {},
            burnInRequired: kind === 'image',
            unsupportedReason: extractable
                ? null
                : (kind === 'image'
                    ? 'Image subtitles require burn-in video transcoding'
                    : `Unsupported subtitle codec: ${codec || 'unknown'}`)
        };
    });

    // Determine what processing is needed
    // 4. MKV files often cause OOM/decoding issues in browser fMP4 remux, 
    // so we force them to "needsTranscode" which uses HLS (more robust).
    // The frontend will still use "copy" mode if codecs are compatible.
    const isMkv = container.includes('matroska') || container.includes('webm') || url.endsWith('.mkv');

    // 1. Incompatible audio/video OR MKV -> Transcode (or HLS Copy)
    const needsTranscode = !audioOk || !videoOk || isMkv;

    // 2. Compatible audio/video but incompatible container (non-MKV) -> Remux (fMP4 pipe)
    const needsRemux = !needsTranscode && (!containerOk || isRawTs);

    const compatible = !needsTranscode && !needsRemux;

    return {
        video: videoCodec,
        audio: audioCodec,
        videoProfile: videoProfile,
        videoPixelFormat: videoPixelFormat,
        videoBitDepth: videoBitDepth,
        videoBrowserSafe: videoCompatibility.browserSafe,
        videoCopySafe: videoCompatibility.copySafe,
        videoCompatibilityReason: videoCompatibility.reason,
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        duration: Number.isFinite(duration) && duration > 0 ? duration : null,
        audioChannels: audioStream?.channels || 0, // For Smart Audio Copy
        audioTracks: audioTracks,
        container: container,
        compatible: compatible,
        needsRemux: needsRemux,
        needsTranscode: needsTranscode,
        subtitles: subtitles
    };
}

router.get('/', async (req, res) => {
    const { url, ua } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const ffprobePath = req.app.locals.ffprobePath;
    const timeout = getProbeTimeout(req.query.timeout);
    const cacheKey = `${url}${ua ? `|${ua}` : ''}`;

    if (!ffprobePath) {
        // No ffprobe available - assume needs transcoding to be safe
        console.log('[Probe] FFprobe not available, assuming transcode needed');
        return res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            duration: null,
            audioTracks: [],
            subtitles: [],
            videoProfile: null,
            videoPixelFormat: null,
            videoBitDepth: null,
            videoBrowserSafe: false,
            videoCopySafe: false,
            videoCompatibilityReason: 'ffprobe unavailable',
            compatible: false,
            needsRemux: false,
            needsTranscode: true
        });
    }

    // Check cache
    const cached = probeCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[Probe] Cache hit for: ${sanitizeErrorMessage(url).substring(0, 50)}...`);
        return res.json(cached.result);
    }

    console.log(`[Probe] Probing: ${sanitizeErrorMessage(url).substring(0, 80)}... ${ua ? `(UA: ${ua})` : ''}`);

    try {
        const probeResult = await probeStream(url, ffprobePath, ua, timeout);
        const analysis = analyzeProbeResult(probeResult, url);

        // Cache result
        probeCache.set(cacheKey, { result: analysis, timestamp: Date.now() });

        console.log(`[Probe] Result: video=${analysis.video}, audio=${analysis.audio}, ` +
            `profile=${analysis.videoProfile || 'unknown'}, pix_fmt=${analysis.videoPixelFormat || 'unknown'}, ` +
            `container=${analysis.container}, compatible=${analysis.compatible}, ` +
            `videoCopySafe=${analysis.videoCopySafe}, ` +
            `needsRemux=${analysis.needsRemux}, needsTranscode=${analysis.needsTranscode}`);

        res.json(analysis);
    } catch (err) {
        const upstream = normalizeUpstreamError(err);
        console.error('[Probe] Failed:', upstream.details);

        // Only assume transcode for unknown technical probe failures. If the
        // provider already refused the stream, retrying with FFmpeg just adds
        // pressure on the account and can trigger more rate limits.
        res.json({
            video: 'unknown',
            audio: 'unknown',
            container: 'unknown',
            duration: null,
            audioTracks: [],
            subtitles: [],
            videoProfile: null,
            videoPixelFormat: null,
            videoBitDepth: null,
            videoBrowserSafe: false,
            videoCopySafe: false,
            videoCompatibilityReason: 'probe failed',
            compatible: false,
            needsRemux: false,
            needsTranscode: !upstream.terminal,
            error: upstream.details,
            friendlyError: upstream.friendly,
            upstreamCode: upstream.code,
            upstreamStatus: upstream.upstreamStatus,
            upstreamFailure: upstream.terminal
        });
    }
});

router.get('/sniff', async (req, res) => {
    const { url, ua } = req.query;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    const timeout = getProbeTimeout(req.query.timeout || 2500);

    try {
        const result = await sniffStream(url, ua, timeout);
        console.log(`[Probe] Sniff: kind=${result.kind}, status=${result.statusCode}, type=${result.contentType || 'unknown'} for ${sanitizeErrorMessage(url).substring(0, 80)}...`);
        res.json(result);
    } catch (err) {
        const upstream = normalizeUpstreamError(err);
        console.warn('[Probe] Sniff failed:', upstream.details);
        res.json({
            kind: 'unknown',
            statusCode: upstream.upstreamStatus || null,
            contentType: null,
            bytes: 0,
            error: upstream.details,
            friendlyError: upstream.friendly,
            code: upstream.code,
            terminal: upstream.terminal
        });
    }
});

module.exports = router;

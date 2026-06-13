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
const DEFAULT_TTL_SECONDS = clampInt(process.env.SESSION_TTL_SECONDS, 30 * 60, 60, 12 * 60 * 60);
const STARTUP_TIMEOUT_MS = clampInt(process.env.STARTUP_TIMEOUT_MS, 45_000, 5_000, 180_000);
const PLAYLIST_REQUEST_TIMEOUT_MS = clampInt(process.env.PLAYLIST_REQUEST_TIMEOUT_MS, 45_000, 5_000, 180_000);
const STOP_CONFLICTING_SOURCE_SESSIONS = (process.env.STOP_CONFLICTING_SOURCE_SESSIONS || 'true') !== 'false';
const STOP_CONFLICTING_OWNER_SESSIONS = (process.env.STOP_CONFLICTING_OWNER_SESSIONS || 'true') !== 'false';
const FFMPEG_USER_AGENT = process.env.FFMPEG_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Norva/1.0';
const MAX_LOG_TAIL = 12000;

const sessions = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(cors);

app.options('*', (req, res) => res.status(204).end());

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        service: 'norva-media-gateway',
        version: 7,
        activeSessions: activeSessionCount(),
        totalSessions: sessions.size,
        time: new Date().toISOString()
    });
});

app.post('/sessions', requireGatewayAuth, async (req, res) => {
    try {
        const { sourceUrl, playbackSessionId, ownerKey, mode = 'remux', expiresAt } = req.body || {};
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
        const session = {
            id,
            playbackSessionId: playbackSessionId || null,
            sourceUrl,
            sourceKey,
            ownerKey: normalizedOwnerKey,
            mode: mode === 'transcode' ? 'transcode' : 'remux',
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
        res.status(201).json({
            id,
            status: session.status,
            mode: session.mode,
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
        '-user_agent', FFMPEG_USER_AGENT,
        '-headers', 'Accept: */*\r\nConnection: keep-alive\r\n',
        '-i', session.sourceUrl,
        '-fflags', '+genpts',
        '-map', '0:v:0?',
        '-map', '0:a:0?',
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
            '-c:a', 'aac',
            '-b:a', '128k'
        );
    } else {
        args.push(
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k'
        );
    }

    args.push(
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '8',
        '-hls_segment_type', 'mpegts',
        '-hls_flags', 'delete_segments+append_list+independent_segments',
        '-hls_segment_filename', segmentPattern,
        session.playlistPath
    );

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
    session.status = 'ended';
    if (session.ffmpeg && !session.ffmpeg.killed) {
        session.ffmpeg.kill('SIGTERM');
    }
    sessions.delete(session.id);
    await removeSessionDir(session.outputDir);
}

async function stopConflictingSourceSessions(sourceUrl) {
    const sourceKey = sourceSessionKey(sourceUrl);
    if (!sourceKey) return;

    const conflicts = Array.from(sessions.values()).filter((session) => {
        if (session.sourceKey !== sourceKey) return false;
        return session.status === 'starting' || session.status === 'ready';
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
        return session.status === 'starting' || session.status === 'ready';
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
        hlsUrl: publicUrl(req, `/sessions/${session.id}/playlist.m3u8?token=${encodeURIComponent(session.accessToken)}`),
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        lastError: session.lastError,
        logTail: session.logTail
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
    if (file.endsWith('.m4s')) return 'video/iso.segment';
    if (file.endsWith('.mp4')) return 'video/mp4';
    if (file.endsWith('.aac')) return 'audio/aac';
    return 'video/mp2t';
}

function appendLogTail(session, text) {
    session.logTail = `${session.logTail || ''}${text}`.slice(-MAX_LOG_TAIL);
}

function rewritePlaylistSegments(playlist, token) {
    const encodedToken = encodeURIComponent(token);
    return String(playlist || '')
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
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

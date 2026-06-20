const express = require('express');
const router = express.Router();
const { getDb } = require('../db/sqlite');
const { sources } = require('../db');
const xtreamApi = require('../services/xtreamApi');
const http = require('http');
const https = require('https');
const { normalizeUpstreamError, sanitizeErrorMessage } = require('../utils/upstreamError');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const liveModeScanJobs = new Map();
let activeLiveModeScanJobId = null;

const TYPE_TO_DB = {
    channel: 'live',
    movie: 'movie',
    series: 'series'
};

const DB_TO_TYPE = {
    live: 'channel',
    movie: 'movie',
    series: 'series'
};

function normalizeItemType(itemType) {
    return TYPE_TO_DB[itemType] ? itemType : null;
}

function rowToStatus(row) {
    return {
        source_id: row.source_id,
        item_id: row.item_id,
        item_type: DB_TO_TYPE[row.type] || row.type,
        status: row.playback_status || 'unknown',
        failures: row.playback_failures || 0,
        last_error: row.playback_last_error || null,
        updated_at: row.playback_checked_at || null,
        mode: row.playback_mode || 'unknown',
        mode_reason: row.playback_mode_reason || null,
        mode_checked_at: row.playback_mode_checked_at || null
    };
}

function parseJson(value, fallback = {}) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (err) {
        return fallback;
    }
}

function sniffStream(url, timeout = 2500, redirects = 0) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, value) => {
            if (settled) return;
            settled = true;
            fn(value);
        };

        const parsed = new URL(url);
        const client = parsed.protocol === 'https:' ? https : http;
        const req = client.get(url, {
            headers: {
                'User-Agent': DEFAULT_USER_AGENT,
                Accept: '*/*'
            },
            timeout
        }, (response) => {
            const statusCode = response.statusCode || 0;
            const location = response.headers.location;
            if ([301, 302, 303, 307, 308].includes(statusCode) && location && redirects < 3) {
                response.resume();
                const nextUrl = new URL(location, url).toString();
                sniffStream(nextUrl, timeout, redirects + 1).then(
                    result => done(resolve, result),
                    err => done(reject, err)
                );
                return;
            }

            const chunks = [];
            let total = 0;
            const finish = () => {
                const buffer = Buffer.concat(chunks, total);
                done(resolve, classifySniff(buffer, response.headers['content-type'], statusCode));
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

        req.on('timeout', () => req.destroy(new Error('Sniff timeout')));
        req.on('error', err => done(reject, err));
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

    return { kind, statusCode, contentType: contentType || null, bytes: buffer.length };
}

function buildLiveStreamUrl(source, row) {
    const data = parseJson(row.data);
    if (source?.type === 'xtream') {
        return xtreamApi.createFromSource(source).buildStreamUrl(row.item_id, 'live', 'ts');
    }

    return row.stream_url || data.stream_url || data.url || data.file || data.link || '';
}

function classifyPlaybackMode(sniff) {
    const statusCode = Number(sniff?.statusCode || 0);
    if (statusCode >= 400) {
        return {
            mode: 'unknown',
            status: 'broken',
            reason: `HTTP ${statusCode}`
        };
    }

    switch (sniff?.kind) {
        case 'hls':
            return {
                mode: 'direct_hls',
                status: null,
                reason: 'HLS manifest detected'
            };
        case 'mpegts':
            return {
                mode: 'transcoding_audio',
                status: 'ok',
                reason: 'MPEG-TS detected; audio transcode path preferred'
            };
        case 'mp4':
            return {
                mode: 'direct_play',
                status: 'ok',
                reason: 'MP4/fMP4 container detected'
            };
        default:
            return {
                mode: 'unknown',
                status: null,
                reason: sniff?.contentType ? `Unknown content type: ${sniff.contentType}` : 'Unknown stream container'
            };
    }
}

function updateLiveMode(row, result) {
    const db = getDb();
    const now = Date.now();

    if (result.status === 'ok') {
        db.prepare(`
            UPDATE playlist_items
            SET playback_mode = ?,
                playback_mode_reason = ?,
                playback_mode_checked_at = ?,
                playback_status = 'ok',
                playback_failures = 0,
                playback_last_error = NULL,
                playback_checked_at = ?
            WHERE source_id = ? AND type = 'live' AND item_id = ?
        `).run(result.mode, result.reason, now, now, row.source_id, row.item_id);
    } else if (result.status === 'broken') {
        db.prepare(`
            UPDATE playlist_items
            SET playback_mode = ?,
                playback_mode_reason = ?,
                playback_mode_checked_at = ?,
                playback_status = 'broken',
                playback_failures = COALESCE(playback_failures, 0) + 1,
                playback_last_error = ?,
                playback_checked_at = ?
            WHERE source_id = ? AND type = 'live' AND item_id = ?
        `).run(result.mode, result.reason, now, result.reason, now, row.source_id, row.item_id);
    } else {
        db.prepare(`
            UPDATE playlist_items
            SET playback_mode = ?,
                playback_mode_reason = ?,
                playback_mode_checked_at = ?
            WHERE source_id = ? AND type = 'live' AND item_id = ?
        `).run(result.mode, result.reason, now, row.source_id, row.item_id);
    }

    return db.prepare(`
        SELECT source_id, item_id, type, playback_status, playback_failures,
               playback_last_error, playback_checked_at, playback_mode,
               playback_mode_reason, playback_mode_checked_at
        FROM playlist_items
        WHERE source_id = ? AND type = 'live' AND item_id = ?
    `).get(row.source_id, row.item_id);
}

function snapshotJob(job, cursor = 0) {
    const safeCursor = Math.max(0, parseInt(cursor, 10) || 0);
    const entries = job.entries.slice(safeCursor);
    return {
        success: true,
        jobId: job.id,
        status: job.status,
        sourceId: job.sourceId,
        scope: job.scope || 'all',
        scopeLabel: job.scopeLabel || null,
        total: job.total,
        scanned: job.scanned,
        directHls: job.directHls,
        transcodingAudio: job.transcodingAudio,
        directPlay: job.directPlay,
        broken: job.broken,
        unknown: job.unknown,
        skipped: job.skipped,
        error: job.error || null,
        cancelledBy: job.cancelledBy || null,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt || null,
        cursor: safeCursor,
        nextCursor: safeCursor + entries.length,
        entries
    };
}

async function scanLiveModeRow(row, sourceMap) {
    const source = sourceMap.get(Number(row.source_id));
    const url = source ? buildLiveStreamUrl(source, row) : '';

    if (!url) {
        return updateLiveMode(row, {
            mode: 'unknown',
            status: null,
            reason: 'No stream URL available'
        });
    }

    try {
        const sniff = await sniffStream(url, 3000);
        return updateLiveMode(row, classifyPlaybackMode(sniff));
    } catch (err) {
        const upstream = normalizeUpstreamError(err);
        const reason = upstream.friendly || sanitizeErrorMessage(err.message || 'Sniff failed');
        return updateLiveMode(row, {
            mode: 'unknown',
            status: upstream.terminal ? 'broken' : null,
            reason
        });
    }
}

async function runLiveModeScanJob(job, rows, sourceMap) {
    try {
        job.status = 'running';
        job.updatedAt = Date.now();

        await runWithConcurrency(rows, 3, async (row) => {
            if (job.cancelRequested) return;
            const updated = await scanLiveModeRow(row, sourceMap);
            if (job.cancelRequested) return;
            const entry = rowToStatus(updated);
            job.entries.push(entry);

            job.scanned += 1;
            if (entry.mode === 'direct_hls') job.directHls += 1;
            else if (entry.mode === 'transcoding_audio') job.transcodingAudio += 1;
            else if (entry.mode === 'direct_play') job.directPlay += 1;
            else job.unknown += 1;
            if (entry.status === 'broken') job.broken += 1;
            if (entry.mode_reason === 'No stream URL available') job.skipped += 1;
            job.updatedAt = Date.now();
        });

        job.status = job.cancelRequested ? 'cancelled' : 'complete';
        job.finishedAt = Date.now();
        job.updatedAt = job.finishedAt;
    } catch (err) {
        job.status = 'error';
        job.error = err.message || 'Scan failed';
        job.finishedAt = Date.now();
        job.updatedAt = job.finishedAt;
        console.error('Live mode scan job failed:', err);
    } finally {
        if (activeLiveModeScanJobId === job.id) {
            activeLiveModeScanJobId = null;
        }
    }
}

function getScanSignature({ requestedSourceId, requestedCategoryName, itemsWereProvided, requestedItems, scopeLabel }) {
    if (itemsWereProvided) {
        const keys = requestedItems
            .map(item => `${item.sourceId}:${item.itemId}`)
            .sort()
            .join('|');
        return `items:${scopeLabel || requestedCategoryName || ''}:${keys}`;
    }
    if (requestedCategoryName) {
        return `category:${requestedSourceId || 'all'}:${requestedCategoryName}`;
    }
    return `all:${requestedSourceId || 'all'}`;
}

async function runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let next = 0;

    async function runner() {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
    return results;
}

router.get('/', (req, res) => {
    try {
        const { sourceId, itemType, includeOk, includeModes } = req.query;
        const params = [];
        let sql = `
            SELECT source_id, item_id, type, playback_status, playback_failures,
                   playback_last_error, playback_checked_at, playback_mode,
                   playback_mode_reason, playback_mode_checked_at
            FROM playlist_items
            WHERE ${includeModes === 'true'
                ? `(COALESCE(playback_status, 'unknown') != 'unknown' OR COALESCE(playback_mode, 'unknown') != 'unknown')`
                : `COALESCE(playback_status, 'unknown') != 'unknown'`}
        `;

        if (sourceId) {
            sql += ' AND source_id = ?';
            params.push(parseInt(sourceId, 10));
        }

        if (itemType) {
            const normalized = normalizeItemType(itemType);
            if (!normalized) return res.status(400).json({ error: 'Invalid itemType' });
            sql += ' AND type = ?';
            params.push(TYPE_TO_DB[normalized]);
        } else {
            sql += ` AND type IN ('live', 'movie', 'series')`;
        }

        if (includeOk !== 'true' && includeModes !== 'true') {
            sql += ` AND playback_status = 'broken'`;
        }

        const rows = getDb().prepare(sql).all(...params);
        res.json(rows.map(rowToStatus));
    } catch (err) {
        console.error('Error loading playback statuses:', err);
        res.status(500).json({ error: 'Failed to load playback statuses' });
    }
});

router.post('/scan-live-modes', async (req, res) => {
    try {
        const requestedSourceId = req.body.sourceId ? parseInt(req.body.sourceId, 10) : null;
        const requestedCategoryName = String(req.body.categoryName || '').trim();
        const requestedScopeLabel = String(req.body.scopeLabel || requestedCategoryName || '').trim();
        const itemsWereProvided = Array.isArray(req.body.items);
        const requestedItems = itemsWereProvided
            ? req.body.items
                .map(item => ({
                    sourceId: parseInt(item.sourceId ?? item.source_id, 10),
                    itemId: String(item.itemId ?? item.item_id ?? '').trim()
                }))
                .filter(item => Number.isFinite(item.sourceId) && item.sourceId > 0 && item.itemId)
            : [];

        const requestedSignature = getScanSignature({
            requestedSourceId,
            requestedCategoryName,
            itemsWereProvided,
            requestedItems,
            scopeLabel: requestedScopeLabel
        });

        if (activeLiveModeScanJobId) {
            const activeJob = liveModeScanJobs.get(activeLiveModeScanJobId);
            if (activeJob && activeJob.status === 'running') {
                if (activeJob.signature === requestedSignature) {
                    return res.status(202).json(snapshotJob(activeJob, req.body.cursor || 0));
                }

                activeJob.cancelRequested = true;
                activeJob.cancelledBy = requestedScopeLabel || requestedCategoryName || 'new scan';
                activeJob.status = 'cancelled';
                activeJob.finishedAt = Date.now();
                activeJob.updatedAt = activeJob.finishedAt;
                activeLiveModeScanJobId = null;
            }
        }

        const db = getDb();
        const allSources = await sources.getAll();
        const sourceMap = new Map(
            allSources
                .filter(source => source.enabled !== false)
                .map(source => [Number(source.id), source])
        );

        if (requestedSourceId && !sourceMap.has(requestedSourceId)) {
            return res.status(404).json({ error: 'Source not found or disabled' });
        }

        const params = [];
        let sql = `
            SELECT source_id, item_id, name, stream_url, data
            FROM playlist_items
            WHERE type = 'live'
              AND is_hidden = 0
        `;

        if (requestedSourceId) {
            sql += ` AND source_id = ?`;
            params.push(requestedSourceId);
        } else if (sourceMap.size > 0) {
            const placeholders = [...sourceMap.keys()].map(() => '?').join(',');
            sql += ` AND source_id IN (${placeholders})`;
            params.push(...sourceMap.keys());
        }

        if (itemsWereProvided && requestedItems.length === 0) {
            sql += ` AND 1 = 0`;
        } else if (requestedItems.length > 0) {
            const keys = [...new Set(requestedItems.map(item => `${item.sourceId}:${item.itemId}`))];
            const placeholders = keys.map(() => '?').join(',');
            sql += ` AND (CAST(source_id AS TEXT) || ':' || item_id) IN (${placeholders})`;
            params.push(...keys);
        } else if (requestedCategoryName) {
            sql += `
                AND EXISTS (
                    SELECT 1
                    FROM categories c
                    WHERE c.source_id = playlist_items.source_id
                      AND c.type = 'live'
                      AND c.category_id = playlist_items.category_id
                      AND c.name = ?
                )
            `;
            params.push(requestedCategoryName);
        }

        const rows = db.prepare(sql).all(...params);
        const scope = itemsWereProvided
            ? 'items'
            : requestedCategoryName
                ? 'category'
                : 'all';
        const jobId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const job = {
            id: jobId,
            status: 'queued',
            sourceId: requestedSourceId,
            scope,
            scopeLabel: requestedCategoryName || requestedScopeLabel || null,
            signature: requestedSignature,
            cancelRequested: false,
            cancelledBy: null,
            total: rows.length,
            scanned: 0,
            directHls: 0,
            transcodingAudio: 0,
            directPlay: 0,
            broken: 0,
            unknown: 0,
            skipped: 0,
            entries: [],
            startedAt: Date.now(),
            updatedAt: Date.now(),
            finishedAt: null,
            error: null
        };

        liveModeScanJobs.set(jobId, job);
        activeLiveModeScanJobId = jobId;
        setImmediate(() => runLiveModeScanJob(job, rows, sourceMap));

        res.status(202).json(snapshotJob(job, 0));
    } catch (err) {
        console.error('Error scanning live playback modes:', err);
        res.status(500).json({ error: 'Failed to scan live playback modes' });
    }
});

router.get('/scan-live-modes/:jobId', (req, res) => {
    const job = liveModeScanJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Scan job not found' });
    res.json(snapshotJob(job, req.query.cursor || 0));
});

/**
 * Reset broken statuses that were caused by connection-limit errors (401/403/429).
 * These were incorrectly marked as broken — the title itself is fine.
 * POST /api/playback-status/reset-connection-errors
 */
router.post('/reset-connection-errors', (req, res) => {
    try {
        const db = getDb();
        // Match errors that are connection/auth related, not structural
        const result = db.prepare(`
            UPDATE playlist_items
            SET playback_status = 'unknown',
                playback_failures = 0,
                playback_last_error = NULL,
                playback_checked_at = NULL
            WHERE playback_status = 'broken'
              AND (
                playback_last_error LIKE '%401%'
                OR playback_last_error LIKE '%Unauthorized%'
                OR playback_last_error LIKE '%403%'
                OR playback_last_error LIKE '%Forbidden%'
                OR playback_last_error LIKE '%429%'
                OR playback_last_error LIKE '%rate limit%'
                OR playback_last_error LIKE '%Too Many Requests%'
                OR playback_last_error LIKE '%UPSTREAM_UNAUTHORIZED%'
                OR playback_last_error LIKE '%UPSTREAM_FORBIDDEN%'
                OR playback_last_error LIKE '%UPSTREAM_RATE_LIMIT%'
                OR playback_last_error LIKE '%limited to one connection%'
                OR playback_last_error LIKE '%connection%'
              )
        `).run();
        res.json({ success: true, reset: result.changes });
    } catch (err) {
        console.error('Error resetting connection errors:', err);
        res.status(500).json({ error: 'Failed to reset' });
    }
});

router.post('/report', (req, res) => {
    try {
        const sourceId = parseInt(req.body.sourceId ?? req.body.source_id, 10);
        const itemType = normalizeItemType(req.body.itemType ?? req.body.item_type);
        const itemId = String(req.body.itemId ?? req.body.item_id ?? '').trim();
        const status = String(req.body.status || '').toLowerCase();
        const reason = String(req.body.reason || req.body.error || '').slice(0, 500);

        if (!sourceId || !itemType || !itemId || !['ok', 'broken'].includes(status)) {
            return res.status(400).json({ error: 'sourceId, itemType, itemId and status are required' });
        }
        if (status === 'broken' && /empty src/i.test(reason)) {
            return res.json({ success: true, ignored: true, reason: 'empty-src' });
        }

        const dbType = TYPE_TO_DB[itemType];
        const now = Date.now();
        const db = getDb();
        let result;

        if (status === 'ok') {
            result = db.prepare(`
                UPDATE playlist_items
                SET playback_status = 'ok',
                    playback_failures = 0,
                    playback_last_error = NULL,
                    playback_checked_at = ?
                WHERE source_id = ? AND type = ? AND item_id = ?
            `).run(now, sourceId, dbType, itemId);
        } else {
            result = db.prepare(`
                UPDATE playlist_items
                SET playback_status = 'broken',
                    playback_failures = COALESCE(playback_failures, 0) + 1,
                    playback_last_error = ?,
                    playback_checked_at = ?
                WHERE source_id = ? AND type = ? AND item_id = ?
            `).run(reason, now, sourceId, dbType, itemId);
        }

        const row = db.prepare(`
            SELECT source_id, item_id, type, playback_status, playback_failures,
                   playback_last_error, playback_checked_at, playback_mode,
                   playback_mode_reason, playback_mode_checked_at
            FROM playlist_items
            WHERE source_id = ? AND type = ? AND item_id = ?
        `).get(sourceId, dbType, itemId);

        res.json({
            success: true,
            updated: result.changes,
            entry: row ? rowToStatus(row) : {
                source_id: sourceId,
                item_id: itemId,
                item_type: itemType,
                status,
                failures: status === 'broken' ? 1 : 0,
                last_error: status === 'broken' ? reason : null,
                updated_at: now
            }
        });
    } catch (err) {
        console.error('Error reporting playback status:', err);
        res.status(500).json({ error: 'Failed to report playback status' });
    }
});

module.exports = router;

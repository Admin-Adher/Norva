'use strict';

const crypto = require('node:crypto');
const { TsLandmarks } = require('./finite-ts-landmarks');
const { probeTsOrigin } = require('./finite-ts-seek-index');
const PACKET = 188, WINDOW = 2 * 1024 * 1024, HEADER = 262144;
const align = value => Math.max(0, Math.floor(value / PACKET) * PACKET);

// Hints select a place to READ, never a place from which playback is authorized.
// No media, validators, credentials or trusted timeline is stored here. Every
// candidate below must be rediscovered in complete current broker responses.
class TsSeekHints {
    constructor({ now = Date.now } = {}) { this.now = now; this.entries = new Map(); }
    begin({ ownerKey, sourceUrl, fileSizeBytes }) {
        if (!/^[a-f0-9]{64}$/.test(ownerKey || '') || typeof sourceUrl !== 'string'
            || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) return null;
        const key = crypto.createHash('sha256').update(JSON.stringify([ownerKey, sourceUrl, fileSizeBytes])).digest('hex');
        const store = this;
        return {
            observe({ start, bytes }) {
                const scan = scanTsWindow(start, bytes);
                if (!scan || !scan.video.length) return;
                let entry = store.entries.get(key);
                if (!entry || store.now() - entry.at > 600000) entry = { at: store.now(), clocks: [], points: [] };
                entry.clocks = [...new Map([...entry.clocks, ...scan.video].map(c => [c.packetOffset, c])).values()]
                    .sort((a, b) => a.packetOffset - b.packetOffset);
                while (entry.clocks.length > 512) entry.clocks = entry.clocks.filter((_, i) => i % 2 === 0);
                entry.points = [...new Map([...entry.points, ...scan.points].map(p => [p.byteOffset, p])).values()]
                    .sort((a, b) => a.byteOffset - b.byteOffset);
                while (entry.points.length > 256) entry.points = entry.points.filter((_, i) => i % 2 === 0);
                store.entries.delete(key); store.entries.set(key, entry);
                while (store.entries.size > 16) store.entries.delete(store.entries.keys().next().value);
            },
            pointHint(absoluteSeconds) {
                const entry = store.entries.get(key);
                if (!entry || store.now() < entry.at || store.now() - entry.at > 600000) return null;
                const p = entry.points.filter(p => absoluteSeconds - p.pts / 90000 >= 1
                    && absoluteSeconds - p.pts / 90000 <= 18).at(-1);
                // Include earlier audio PES bytes when rereading the IDR. The
                // point is still only a hint until the fresh scan proves it.
                return p ? align(Math.max(HEADER, p.byteOffset - 65536)) : null;
            },
            estimate(absoluteSeconds, bytesPerSecond) {
                const entry = store.entries.get(key);
                if (!entry || store.now() < entry.at || store.now() - entry.at > 600000) return null;
                const nearest = entry.clocks.reduce((a, b) => !a || Math.abs(b.pts / 90000 - absoluteSeconds)
                    < Math.abs(a.pts / 90000 - absoluteSeconds) ? b : a, null);
                if (!nearest || Math.abs(nearest.pts / 90000 - absoluteSeconds) > 30) return null;
                const nearby = nearest && entry.clocks.filter(c => c.signature === nearest.signature
                    && Math.abs(c.packetOffset - nearest.packetOffset) < WINDOW
                    && Math.abs(c.pts - nearest.pts) >= 180000 && Math.abs(c.pts - nearest.pts) < 1800000)
                    .sort((a, b) => Math.abs(a.pts - nearest.pts) - Math.abs(b.pts - nearest.pts))[0];
                const localRate = nearby && (nearby.packetOffset - nearest.packetOffset) / ((nearby.pts - nearest.pts) / 90000);
                if (localRate > bytesPerSecond / 8 && localRate < bytesPerSecond * 8) bytesPerSecond = localRate;
                return nearest ? align(nearest.packetOffset + (absoluteSeconds - nearest.pts / 90000) * bytesPerSecond) : null;
            },
        };
    }
}

function scanTsWindow(start, bytes, { navigationOnly = false } = {}) {
    if (!Number.isSafeInteger(start) || start < 0 || !Buffer.isBuffer(bytes)
        || bytes.length < PACKET * 10 || bytes.length > WINDOW) return null;
    const video = [], audio = [], points = [];
    let invalid = false;
    new TsLandmarks({ onInvalid: () => {
        invalid = true; video.length = 0; audio.length = 0; points.length = 0;
    }, onPoint: p => points.push(p),
        onClock: c => { if (c.signature) (c.video ? video : audio).push(c); },
    }).push(start, bytes);
    // After a reset, clocks in the new complete graph may locate another READ.
    // No such window can authorize playback or enter the trusted index.
    return (invalid && !navigationOnly) || !video.length ? null : { video, audio, points, invalid };
}

async function findFreshTsSeek({ read, fileSizeBytes, durationSeconds, seconds, hints, signal,
    probeOrigin = probeTsOrigin, now = Date.now, maxMs = 9000 } = {}) {
    const began = now();
    const result = { point: null, reads: 0, bytes: 0, reason: 'ineligible' };
    if (typeof read !== 'function' || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < WINDOW * 2
        || !Number.isFinite(durationSeconds) || durationSeconds <= 60 || durationSeconds > 86400
        || !Number.isFinite(seconds) || seconds <= 30 || seconds >= durationSeconds - 30) return result;
    const acquire = async (start, length, navigationOnly = false) => {
        if (signal?.aborted) throw Object.assign(Error('aborted'), { name: 'AbortError' });
        const end = Math.min(fileSizeBytes - 1, start + length - 1);
        const bytes = await read(start, end);
        result.reads++; result.bytes += bytes?.length || 0;
        if (!Buffer.isBuffer(bytes) || bytes.length !== end - start + 1) return null;
        return scanTsWindow(start, bytes, { navigationOnly });
    };
    // Fresh origin and graph, acquired using the same serialized broker. The
    // ffprobe subprocess only sees these already-received bytes, never a URL.
    const header = await read(0, HEADER - 1);
    result.reads++; result.bytes += header?.length || 0;
    const head = scanTsWindow(0, header);
    const origin = head && await probeOrigin(header);
    if (!origin || !head.video.some(c => c.pid === origin.videoPid)
        || !head.audio.some(c => c.pid === origin.audioPid)) return { ...result, reason: 'origin-unverified' };
    const signature = head.video[0].signature;
    const absoluteSeconds = seconds + origin.startSeconds;
    // AAC priming is far shorter than a second. Only the actual fresh ffprobe
    // codec can select this margin; other codecs keep the existing 2s guard.
    // The complete current IDR and audio on both sides remain mandatory.
    const minimumPreroll = origin.audioCodec === 'aac' ? 1 : 2;
    // The tail must confirm that the dated duration and fresh origin describe
    // this response's clock. No timestamp wrap or unrelated delivery timeline
    // may turn a byte estimate into an authorized seek.
    const tail = await acquire(align(fileSizeBytes - HEADER), HEADER + PACKET);
    const last = tail?.video.at(-1);
    if (!last || last.pid !== origin.videoPid || last.signature !== signature
        || Math.abs(last.pts / 90000 - origin.startSeconds - durationSeconds) > 2)
        return { ...result, reason: 'duration-unverified' };
    const rate = fileSizeBytes / durationSeconds;
    let predicted = hints?.pointHint?.(absoluteSeconds) ?? hints?.estimate(absoluteSeconds - 20, rate)
        ?? align((seconds - 20) * rate);
    for (let attempt = 0; attempt < 3; attempt++) {
        if (now() - began >= maxMs) return { ...result, reason: 'budget' };
        const length = attempt === 0 ? 512 * 1024 : WINDOW;
        const start = align(Math.min(fileSizeBytes - length, Math.max(HEADER, predicted)));
        const scan = await acquire(start, length, true);
        // A short window can end before the next complete program/PES header.
        // Retry the same position once with the normal window; missing clocks
        // do not authorize a point or trigger a speculative byte correction.
        if (!scan && attempt === 0) { predicted = start; continue; }
        if (!scan || scan.video.some(c => c.pid !== origin.videoPid || c.signature !== signature)
            || scan.audio.some(c => c.pid !== origin.audioPid || c.signature !== signature))
            return { ...result, reason: 'graph-or-clock-unverified' };
        result.scan = { invalidForPlayback: scan.invalid, points: scan.points.length, videoStart: scan.video[0].pts / 90000 - absoluteSeconds,
            videoEnd: scan.video.at(-1).pts / 90000 - absoluteSeconds, audio: scan.audio.length,
            candidates: scan.points.slice(-4).map(p => ({ beforeSeconds: absoluteSeconds - p.pts / 90000,
                audioBefore: scan.audio.some(c => c.dts <= p.dts && p.dts - c.dts <= 90000),
                audioAfter: scan.audio.some(c => c.dts >= p.dts + 180000),
                videoAfter: scan.video.at(-1).dts >= p.dts + 180000 })) };
        const point = !scan.invalid && scan.points.filter(p => p.signature === signature && p.videoPid === origin.videoPid
            && p.audioPid === origin.audioPid && absoluteSeconds - p.pts / 90000 >= minimumPreroll
            && (minimumPreroll === 2 || p.pts - p.dts <= 45000)
            && absoluteSeconds - p.pts / 90000 <= 18
            // Observe clean video beyond the IDR and audio on both sides of it.
            && scan.video.at(-1).dts >= p.dts + 180000
            && scan.audio.some(c => c.dts <= p.dts && p.dts - c.dts <= 90000)
            && scan.audio.some(c => c.dts >= p.dts + 180000)).at(-1);
        if (point) return { ...result, point: { ...point, absoluteSeconds }, reason: 'fresh-point' };
        // Fresh timestamps correct the next search estimate. Neither bitrate
        // nor historical metadata is ever used as the final playback offset.
        const first = scan.video[0], last = scan.video.at(-1);
        const span = (last.pts - first.pts) / 90000;
        const localRate = span > 1 ? (last.packetOffset - first.packetOffset) / span : rate;
        if (!(localRate > rate / 8 && localRate < rate * 8)) return { ...result, reason: 'rate-unverified' };
        predicted = align(first.packetOffset + (absoluteSeconds - (attempt === 0 ? 16 : 12) - first.pts / 90000) * localRate);
    }
    return { ...result, reason: 'point-not-found' };
}

module.exports = { TsSeekHints, scanTsWindow, findFreshTsSeek };

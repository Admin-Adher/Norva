'use strict';

// Diagnostic evidence only. Indexed media bytes are not HTMLMediaElement
// readiness and must not, by themselves, authorize automatic playback.
const MAX_SAMPLES = 1_000_000;
function requireValue(ok) { if (!ok) throw new Error('MP4_COVERAGE_UNSUPPORTED'); }
function safe64(b, offset, signed = false) {
    const n = signed ? b.readBigInt64BE(offset) : b.readBigUInt64BE(offset);
    requireValue(n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(n);
}
function boxes(b) {
    const out = []; let offset = 0;
    while (offset < b.length) {
        requireValue(offset + 8 <= b.length);
        let size = b.readUInt32BE(offset), header = 8;
        if (size === 1) { requireValue(offset + 16 <= b.length); size = safe64(b, offset + 8); header = 16; }
        requireValue(size >= header && offset + size <= b.length && out.length < 10000);
        out.push({ type: b.toString('ascii', offset + 4, offset + 8), body: b.subarray(offset + header, offset + size) });
        offset += size;
    }
    return out;
}
function child(b, type, optional = false) {
    const found = boxes(b).filter(x => x.type === type);
    requireValue(found.length === 1 || (optional && found.length === 0));
    return found[0]?.body;
}
function table(b, stride, offset = 8) {
    requireValue(b && b.length >= offset && b[0] === 0);
    const count = b.readUInt32BE(4);
    requireValue(count <= MAX_SAMPLES && b.length === offset + count * stride);
    return count;
}
function expand(b, signed = false) {
    requireValue(b && (b[0] === 0 || (signed && b[0] === 1)));
    const count = b.readUInt32BE(4);
    requireValue(count <= MAX_SAMPLES && b.length === 8 + count * 8);
    const out = [];
    for (let i = 0; i < count; i++) {
        const n = b.readUInt32BE(8 + i * 8);
        const v = signed && b[0] === 1 ? b.readInt32BE(12 + i * 8) : b.readUInt32BE(12 + i * 8);
        requireValue(n > 0 && out.length + n <= MAX_SAMPLES);
        for (let j = 0; j < n; j++) out.push(v);
    }
    return out;
}
function parseMp4CoverageIndex(moovBox, fileSizeBytes) {
    try {
        requireValue(Buffer.isBuffer(moovBox) && moovBox.length <= 8 * 1024 * 1024);
        requireValue(Number.isSafeInteger(fileSizeBytes) && fileSizeBytes > 0);
        const root = boxes(moovBox); requireValue(root.length === 1 && root[0].type === 'moov');
        const moov = root[0].body; requireValue(!child(moov, 'mvex', true));
        const tracks = []; let totalSamples = 0;
        for (const item of boxes(moov).filter(x => x.type === 'trak')) {
            const mdia = child(item.body, 'mdia'), hdlr = child(mdia, 'hdlr');
            requireValue(hdlr.length >= 12);
            const kind = hdlr.toString('ascii', 8, 12);
            if (!['vide', 'soun'].includes(kind)) continue;
            requireValue(tracks.length < 2);
            const mdhd = child(mdia, 'mdhd'); requireValue(mdhd[0] === 0 || mdhd[0] === 1);
            requireValue(mdhd.length >= (mdhd[0] ? 32 : 20));
            const scale = mdhd.readUInt32BE(mdhd[0] ? 20 : 12); requireValue(scale > 0);
            let edit = 0;
            const edts = child(item.body, 'edts', true);
            if (edts) {
                const elst = child(edts, 'elst'); requireValue(elst[0] === 0 || elst[0] === 1);
                const stride = elst[0] ? 20 : 12;
                requireValue(elst.length === 8 + stride && elst.readUInt32BE(4) === 1);
                edit = elst[0] ? safe64(elst, 16, true) : elst.readInt32BE(12);
                requireValue(edit >= 0 && elst.readInt16BE(8 + stride - 4) === 1 && elst.readInt16BE(8 + stride - 2) === 0);
            }
            const stbl = child(child(mdia, 'minf'), 'stbl');
            const durations = expand(child(stbl, 'stts')); requireValue(durations.length > 0 && durations.every(x => x > 0));
            const sz = child(stbl, 'stsz'); requireValue(sz.length >= 12 && sz[0] === 0);
            const count = sz.readUInt32BE(8), fixed = sz.readUInt32BE(4);
            requireValue(count === durations.length && count <= MAX_SAMPLES && sz.length === (fixed ? 12 : 12 + count * 4));
            totalSamples += count; requireValue(totalSamples <= MAX_SAMPLES);
            const ctts = child(stbl, 'ctts', true), composition = ctts ? expand(ctts, true) : Array(count).fill(0);
            requireValue(composition.length === count);
            const stco = child(stbl, 'stco', true), co64 = child(stbl, 'co64', true);
            requireValue(Boolean(stco) !== Boolean(co64));
            const offsets = stco || co64, width = co64 ? 8 : 4, chunks = table(offsets, width);
            const sc = child(stbl, 'stsc'), maps = table(sc, 12); requireValue(maps > 0);
            const mapping = [];
            for (let i = 0; i < maps; i++) {
                const first = sc.readUInt32BE(8 + i * 12), n = sc.readUInt32BE(12 + i * 12);
                requireValue(first >= 1 && first <= chunks && n > 0 && sc.readUInt32BE(16 + i * 12) === 1);
                requireValue(i ? first > mapping[i - 1].first : first === 1);
                mapping.push({ first, n });
            }
            const ss = child(stbl, 'stss', true), keys = new Set();
            if (ss) for (let i = 0, n = table(ss, 4); i < n; i++) {
                const key = ss.readUInt32BE(8 + 4 * i) - 1;
                requireValue(key >= 0 && key < count && !keys.has(key)); keys.add(key);
            }
            let sample = 0, time = 0, map = 0; const samples = [];
            for (let i = 1; i <= chunks; i++) {
                while (map + 1 < maps && i >= mapping[map + 1].first) map++;
                let byte = co64 ? safe64(offsets, 8 + (i - 1) * width) : offsets.readUInt32BE(8 + (i - 1) * width);
                for (let j = 0; j < mapping[map].n; j++, sample++) {
                    requireValue(sample < count);
                    const size = fixed || sz.readUInt32BE(12 + sample * 4);
                    requireValue(size > 0 && byte >= 0 && byte + size <= fileSizeBytes);
                    samples.push({ start: byte, end: byte + size - 1, dts: (time - edit) / scale,
                        pts: (time + composition[sample] - edit) / scale,
                        duration: durations[sample] / scale, sync: !ss || keys.has(sample) });
                    byte += size; time += durations[sample]; requireValue(Number.isSafeInteger(time));
                }
            }
            requireValue(sample === count); tracks.push({ kind, samples });
        }
        // Track selection is deliberately unsupported until tied to session claims.
        requireValue(tracks.filter(x => x.kind === 'vide').length === 1 && tracks.filter(x => x.kind === 'soun').length === 1);
        return { tracks, fileSizeBytes };
    } catch { return null; }
}

function indexedByteCoverage(index, ranges, targetSeconds) {
    if (!index || !Number.isFinite(targetSeconds) || targetSeconds < 0 || !Array.isArray(ranges) || ranges.length > 4096) return null;
    if (ranges.some(x => !x || typeof x !== 'object')) return null;
    const intervals = ranges.map(x => ({ start: x.start, end: x.end })).sort((a, b) => a.start - b.start);
    if (intervals.some(x => !Number.isSafeInteger(x.start) || !Number.isSafeInteger(x.end) || x.start < 0 || x.end < x.start || x.end >= index.fileSizeBytes)) return null;
    const merged = [];
    for (const x of intervals) {
        const prior = merged.at(-1);
        if (prior && x.start <= prior.end + 1) prior.end = Math.max(prior.end, x.end);
        else merged.push({ ...x });
    }
    const tracks = index.tracks.map(track => {
        let first = -1;
        for (let i = 0; i < track.samples.length; i++) {
            const s = track.samples[i];
            if (s.dts <= targetSeconds && (track.kind !== 'vide' || s.sync)) first = i;
        }
        if (first < 0) return { kind: track.kind, coveredThrough: null, samples: 0 };
        let last = first;
        for (; last < track.samples.length; last++) {
            const s = track.samples[last];
            if (!merged.some(x => x.start <= s.start && x.end >= s.end)) break;
        }
        const end = last > first ? track.samples[last - 1].dts + track.samples[last - 1].duration : null;
        return { kind: track.kind, coveredFrom: track.samples[first].dts, coveredThrough: end, samples: last - first };
    });
    const end = tracks.every(x => x.coveredThrough !== null) ? Math.min(...tracks.map(x => x.coveredThrough)) : null;
    return { evidence: 'indexed-dts-bytes-only', targetSeconds, secondsAhead: end === null ? 0 : Math.max(0, end - targetSeconds), tracks };
}

// Kept within one validated broker lifetime. Only its complete range store is
// consulted at query time; eviction, termination and close remove eligibility.
function createMp4CacheCoverage(fileSizeBytes) {
    let index = null, lastHead = null, lastTail = null;
    return {
        observeCompleteWindows(windows) {
            if (index) return null;
            const ordered = [...windows].filter(w => Buffer.isBuffer(w.payload)
                && w.payload.length === w.end - w.start + 1).sort((a, b) => a.start - b.start);
            // Chromium can split the trailing moov across several exact Range
            // reads. Join only complete, adjacent cached windows, never a hole
            // or a partial transport response. The temporary copy is bounded.
            const groups = [];
            for (const w of ordered) {
                const group = groups.at(-1);
                if (group && w.start <= group.end + 1) {
                    group.windows.push(w); group.end = Math.max(group.end, w.end);
                } else groups.push({ start: w.start, end: w.end, windows: [w] });
            }
            for (const group of groups) {
                const length = group.end - group.start + 1;
                if (length > 8 * 1024 * 1024 || (group.start !== 0 && group.end !== fileSizeBytes - 1)) continue;
                const signature = `${group.start}:${group.end}`, head = group.start === 0;
                if (signature === (head ? lastHead : lastTail)) continue;
                if (head) lastHead = signature; else lastTail = signature;
                const payload = Buffer.alloc(length);
                for (const w of group.windows) w.payload.copy(payload, w.start - group.start);
                this.observeCompleteWindow(group, payload);
                if (index) return { start: group.start, end: group.end, payload };
            }
            return null;
        },
        observeCompleteWindow(range, payload) {
            if (index || !Buffer.isBuffer(payload) || payload.length > 8 * 1024 * 1024
                || payload.length !== range.end - range.start + 1
                || (range.start !== 0 && range.end !== fileSizeBytes - 1)) return;
            let at = -1, candidates = 0;
            while (++candidates <= 16 && (at = payload.indexOf('moov', at + 1, 'ascii')) >= 0) {
                if (at < 4) continue;
                const length = payload.readUInt32BE(at - 4);
                if (length < 8 || at - 4 + length > payload.length) continue;
                index = parseMp4CoverageIndex(payload.subarray(at - 4, at - 4 + length), fileSizeBytes);
                if (index) return;
            }
        },
        snapshot(windows, targetSeconds, eligible = true) {
            if (!eligible || !index) return null;
            const ranges = [];
            for (const window of windows) {
                if (!Buffer.isBuffer(window.payload) || window.payload.length !== window.end - window.start + 1) return null;
                ranges.push({ start: window.start, end: window.end });
            }
            return indexedByteCoverage(index, ranges, targetSeconds);
        },
        clear() { index = null; lastHead = null; lastTail = null; },
    };
}

module.exports = { parseMp4CoverageIndex, indexedByteCoverage, createMp4CacheCoverage };

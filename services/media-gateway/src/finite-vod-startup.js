'use strict';

const token = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function startupHeaderCacheCapacity(configured, startupLimit) {
    if (configured === 0) return 0;
    // Each admitted startup needs its own prefix until its local probe ends.
    // Keep headroom for raw captures and completed entries; otherwise increasing
    // startup admission can evict the oldest in-flight Matroska profiles.
    return Math.min(256, Math.max(configured, startupLimit * 2));
}
function finiteVodStartupFormat(session, enabled = false) {
    if (!enabled || !session || Number(session.seekOffset || 0) !== 0) return null;
    const hint = session.playbackHint || {}, identity = session.playbackIdentity || {};
    const kind = token(identity.itemType || hint.streamType || hint.stream_type || hint.itemType);
    if (!['movie', 'vod', 'episode', 'series'].includes(kind)) return null;
    const container = token(session.sourceContainerAuthority?.container || hint.container || session.codecProfile?.container);
    if (['ts', 'mpegts'].includes(container)) return 'ts';
    if (container === 'mp4' || container.startsWith('movmp4')) return 'mp4';
    return null;
}

// Pipe input is permitted only when the complete MP4 initialization precedes
// media. A tail index, oversized/invalid box, or fragmented MP4 uses the normal
// seekable fallback. Never infer this property from the .mp4 extension.
function mp4PrefixState(buffer) {
    let offset = 0, moov = false;
    while (offset + 8 <= buffer.length) {
        let size = buffer.readUInt32BE(offset), header = 8;
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (size === 1) {
            if (offset + 16 > buffer.length) return 'incomplete';
            const large = buffer.readBigUInt64BE(offset + 8);
            if (large > BigInt(Number.MAX_SAFE_INTEGER)) return 'seekable';
            size = Number(large); header = 16;
        }
        if (type === 'mdat') return moov ? 'ready' : 'seekable';
        if (['moof', 'sidx'].includes(type) || size < header) return 'seekable';
        if (offset + size > buffer.length) return 'incomplete';
        if (type === 'moov') moov = true;
        offset += size;
    }
    return 'incomplete';
}

async function prefetchFiniteVodHeader(session, opened, { signal, read, capture, limit = 4 * 1024 * 1024 }) {
    const started = Date.now(), attempt = opened.attempt;
    const chunks = attempt.preloadedChunks ||= [];
    let size = 0;
    const prefix = [];
    const append = chunk => {
        if (opened.range.total && size + chunk.length > opened.range.end + 1) throw Object.assign(new Error('RANGE_LENGTH_MISMATCH'), { code: 'RANGE_LENGTH_MISMATCH' });
        capture(session, size, chunk); size += chunk.length;
        prefix.push(chunk);
    };
    chunks.forEach(append);
    let state = 'incomplete';
    while (true) {
        if (signal?.aborted) throw Object.assign(new Error('VOD_INPUT_ABORTED'), { code: 'VOD_INPUT_ABORTED' });
        state = session.retainedVodStartupFormat === 'seekable' ? 'seekable' : session.retainedVodStartupFormat === 'mp4'
            ? mp4PrefixState(Buffer.concat(prefix, size)) : (size >= 256 * 1024 ? 'ready' : 'incomplete');
        if (state !== 'incomplete' || size >= limit) break;
        const next = await read(attempt.reader, signal);
        if (next.error) throw next.error;
        if (next.aborted || next.timedOut) throw Object.assign(new Error('VOD_HEADER_INTERRUPTED'), { code: 'VOD_HEADER_INTERRUPTED' });
        if (next.done) break;
        const chunk = Buffer.from(next.value || []);
        if (!chunk.length) continue;
        chunks.push(chunk); append(chunk);
    }
    session.retainedVodHeaderReady = state === 'ready';
    session.startupTimings.retainedVodHeader = { format: session.retainedVodStartupFormat,
        bytes: size, ms: Date.now() - started, ready: session.retainedVodHeaderReady };
    return size;
}

function retainedVodStartupPolicy(session, pipeline) {
    if (!(session?.finiteVodOutputStartupFormat || session?.retainedVodStartupFormat)
        || !['copy', 'audio-transcode'].includes(pipeline)) return null;
    const proof = session.finiteTsStartupEvidence || {}, timings = session.startupTimings || {};
    const rate = Number(timings.sustainedMediaProductionRateX);
    const verified = proof.verified === true && proof.segmentCount >= 2 && proof.maxSegmentSeconds <= 12.25
        && Number(timings.playlistBufferSeconds) >= 12 && Number(timings.playlistPostFirstBufferSeconds) >= 4;
    const eligible = verified && Number.isFinite(rate) && rate >= 1.5 && rate <= 20;
    // Existing protocol name refers to independently decoded MPEG-TS output
    // segments. MP4 input earns exactly the same output evidence; old clients
    // already understand this conservative 12–24 second reserve.
    return { protocol: 2, pipeline, eligible, targetBufferSeconds: eligible ? (rate < 2 ? 24 : 12) : null,
        minimumEncodeRateX: 1.5, observedEncodeRateX: Number.isFinite(rate) && rate > 0 ? rate : null,
        reason: eligible ? 'finite-ts-verified-ready' : !verified ? 'ts-startup-decode-unverified' : 'encode-rate-below-minimum' };
}
module.exports = { finiteVodStartupFormat, mp4PrefixState, prefetchFiniteVodHeader, retainedVodStartupPolicy, startupHeaderCacheCapacity };

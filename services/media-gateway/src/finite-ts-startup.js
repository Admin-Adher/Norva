'use strict';

const token = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const index = (value) => value !== null && value !== undefined && value !== ''
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

// A .ts suffix alone also describes live TV. This optimization needs a finite,
// dated server probe and its actual stream map, not a provider label. It does
// not promote metadataComplete: that field has different in-band semantics.
function finiteTsProfileEligible(session, now = Date.now()) {
    if (!session || session.forceFullInputProbe === true) return false;
    const hint = record(session.playbackHint);
    const identity = record(session.playbackIdentity);
    const kind = token(identity.itemType || hint.streamType || hint.stream_type || hint.itemType || hint.item_type);
    if (!['movie', 'vod', 'episode', 'series'].includes(kind)) return false;
    const profile = record(session.codecProfile);
    if (!['ts', 'mpegts'].includes(token(profile.container))) return false;
    if (hint.container && !['ts', 'mpegts'].includes(token(hint.container))) return false;
    const origin = String(session.codecProfileSource || '').toLowerCase();
    if (origin !== 'request' && !origin.split('+').includes('gateway_probe')) return false;
    if (token(profile.probeSource ?? profile.probe_source) !== 'gatewayprobe') return false;
    const date = Date.parse(String(profile.probedAt ?? profile.probed_at ?? ''));
    const duration = Number(profile.durationSeconds ?? profile.duration_seconds ?? profile.duration);
    const size = Number(profile.fileSizeBytes ?? profile.file_size_bytes);
    if (!Number.isFinite(date) || date > now + 300_000
        || !Number.isFinite(duration) || duration <= 0 || duration > 86_400
        || !Number.isSafeInteger(size) || size <= 0) return false;
    if (!['h264', 'avc', 'avc1'].includes(token(profile.videoCodec ?? profile.video_codec))) return false;
    const tracks = profile.audioTracks ?? profile.audio_tracks;
    if (!Array.isArray(tracks) || !tracks.length || tracks.length > 128) return false;
    const indices = tracks.map((track) => index(track?.index));
    if (indices.some((value) => value === null) || new Set(indices).size !== tracks.length) return false;
    if (tracks.some((track) => !token(track?.codec) || ['unknown', 'none'].includes(token(track?.codec)))) return false;
    if (session.audioStreamIndex !== undefined && session.audioStreamIndex !== null) {
        const selected = index(session.audioStreamIndex);
        if (selected === null || !indices.includes(selected)) return false;
    }
    return true;
}

function finiteTsDemuxArgs() {
    // MPEG-TS normally performs extra tail reads to estimate duration. The
    // exact profile already supplies Norva's timeline; FFmpeg retains PTS-based
    // seeking, stream discovery and the existing strict-map/full-probe retry.
    return ['-skip_estimate_duration_from_pts', '1'];
}

function finiteTsHttpArgs() {
    // Serialize reusable HTTP requests in the same FFmpeg input. No second
    // provider stream, alternative proxy route or unbounded prefix cache.
    return ['-multiple_requests', '1', '-short_seek_size', '262144'];
}

module.exports = { finiteTsProfileEligible, finiteTsDemuxArgs, finiteTsHttpArgs };

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FINITE_TS_PROBE_BYTES = 512 * 1024;
const FINITE_TS_ANALYZE_US = 500_000;

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

function applyFiniteTsAccurateResume(session, encoder) {
    if (!finiteTsProfileEligible(session) || !(Number(session.seekOffset) > 0)
        || encoder?.backend !== 'vaapi' || encoder?.ready !== true) return false;
    const profile = record(session.codecProfile);
    const width = Number(profile.videoWidth ?? profile.video_width ?? profile.width);
    const height = Number(profile.videoHeight ?? profile.video_height ?? profile.height);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
        || width > 1920 || height > 1080) return false;
    // A copy seek can start audio at 17s but video at the next IDR (24s).
    // Decode from the input seek point and trim both streams accurately; never
    // jump the viewer forward across that gap or alter the provider identity.
    session.videoMode = 'encode';
    session.finiteTsResumeAligned = true;
    session.hlsTargetSeconds = 2;
    return true;
}

function finiteTsStartupPolicy(session, pipeline) {
    const encoded = pipeline === 'video-transcode' && session?.finiteTsResumeAligned === true
        && session?.startupTimings?.videoEncoder === 'vaapi';
    if (!finiteTsProfileEligible(session) || (!['copy', 'audio-transcode'].includes(pipeline) && !encoded)) return null;
    const evidence = record(session.finiteTsStartupEvidence);
    const timings = record(session.startupTimings);
    const rate = Number(timings.sustainedMediaProductionRateX);
    const buffer = Number(timings.playlistBufferSeconds);
    const maximum = Number(evidence.maxSegmentSeconds);
    const verified = evidence.verified === true && evidence.segmentCount >= 2
        && evidence.segmentCount <= 3 && maximum > 0 && maximum <= 12.25
        && Number(timings.playlistSegmentCount) >= evidence.segmentCount
        && buffer >= 12 && Number(timings.playlistPostFirstBufferSeconds) >= 4;
    const minimum = encoded ? 2 : 1.5;
    const eligible = verified && Number.isFinite(rate) && rate >= minimum && rate <= 20;
    // Keep two long segments for medium-rate inputs; a fast source can start
    // from one while the next independently decoded segment is already ready.
    const target = Math.min(24, Math.max(rate < 2 ? 24 : 12,
        Math.ceil(maximum * (rate >= 4 ? 1 : 2))));
    return { protocol: 2, eligible, pipeline, targetBufferSeconds: eligible ? target : null,
        minimumEncodeRateX: minimum, observedEncodeRateX: Number.isFinite(rate) && rate > 0 ? rate : null,
        reason: eligible ? (encoded ? 'vaapi-transcode-ready' : 'finite-ts-verified-ready')
            : !verified ? 'ts-startup-decode-unverified' : 'encode-rate-below-minimum' };
}

function decodeStartupSegment(bin, descriptor, { signal, spawnImpl = spawn, timeoutMs = 1500 } = {}) {
    return new Promise(resolve => {
        if (signal?.aborted) return resolve(false);
        let child, timer, killTimer, output = '', failed = false, settled = false;
        const finish = value => {
            if (settled) return;
            settled = true; clearTimeout(timer); clearTimeout(killTimer);
            signal?.removeEventListener('abort', stop); resolve(value);
        };
        const stop = () => {
            failed = true;
            try { child?.kill('SIGKILL'); } catch (_) {}
            killTimer ||= setTimeout(() => finish(false), 1000);
        };
        try {
            // The only input is an already-open local segment descriptor.
            // No URL, playlist, extra provider read, or full-film analysis.
            child = spawnImpl(bin, ['-hide_banner', '-v', 'error', '-nostdin', '-xerror',
                '-err_detect', 'explode', '-threads', '1', '-protocol_whitelist', 'pipe',
                '-format_whitelist', 'mpegts', '-f', 'mpegts', '-i', 'pipe:3',
                // Simultaneous per-stream frame caps can finish the muxer
                // before it emits audio. A tiny common time window preserves
                // both streams; the independent decoded-frame check stays.
                '-map', '0:V:0', '-map', '0:a:0', '-t', '0.5',
                '-threads', '1', '-f', 'framehash', 'pipe:1'],
            { stdio: ['ignore', 'pipe', 'pipe', descriptor], windowsHide: true });
        } catch (_) { finish(false); return; }
        child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 16384) stop(); });
        child.stderr.on('data', chunk => { if (chunk.length) stop(); });
        child.once('error', () => { stop(); });
        child.once('close', code => {
            const counts = [0, 0];
            for (const line of output.split('\n')) {
                const match = /^([01]),\s*-?\d+,\s*-?\d+,\s*\d+,\s*(\d+),\s*[a-f0-9]{64}\s*$/.exec(line);
                if (match && Number(match[2]) > 0) counts[Number(match[1])]++;
            }
            finish(!failed && !signal?.aborted && code === 0 && counts.every(n => n >= 2));
        });
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
        timer = setTimeout(stop, timeoutMs);
    });
}

async function verifyFiniteTsStartupSegments({ root, files, durations, bin, signal, decode = decodeStartupSegment }) {
    const reject = reason => ({ protocol: 1, verified: false, reason });
    if (!path.isAbsolute(root || '') || !Array.isArray(files) || files.length < 2
        || !Array.isArray(durations) || durations.length !== files.length
        || !files.every(name => /^segment-\d{5,8}\.ts$/.test(name))) return reject('invalid-segment-scope');
    const chosen = files.slice(0, 3), lengths = durations.slice(0, 3);
    if (lengths.some(n => !Number.isFinite(n) || n <= 0 || n > 12.25)) return reject('segment-duration');
    try {
        const resolved = path.resolve(root), directory = await fsp.lstat(resolved);
        if (!directory.isDirectory() || directory.isSymbolicLink() || await fsp.realpath(resolved) !== resolved) return reject('invalid-segment-root');
        for (const name of chosen) {
            if (signal?.aborted) return reject('aborted');
            const linked = await fsp.lstat(path.join(resolved, name));
            if (!linked.isFile() || linked.isSymbolicLink()) return reject('invalid-segment-file');
            const handle = await fsp.open(path.join(resolved, name), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            try {
                const before = await handle.stat();
                if (!before.isFile() || before.nlink !== 1 || before.ino !== linked.ino || before.dev !== linked.dev
                    || before.size <= 0 || before.size > 32 * 1024 * 1024) return reject('segment-size');
                if (!await decode(bin, handle.fd, { signal })) return reject('segment-decode');
                const after = await handle.stat();
                if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) return reject('segment-changed');
            } finally { await handle.close(); }
        }
        return { protocol: 1, verified: true, segmentCount: chosen.length, maxSegmentSeconds: Math.max(...lengths) };
    } catch (_) { return reject('segment-unavailable'); }
}

module.exports = { finiteTsProfileEligible, finiteTsDemuxArgs, finiteTsHttpArgs,
    FINITE_TS_PROBE_BYTES, FINITE_TS_ANALYZE_US, finiteTsStartupPolicy, verifyFiniteTsStartupSegments,
    decodeStartupSegment, applyFiniteTsAccurateResume };

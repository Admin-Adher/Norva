'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// VOD clients start at the first segment and use a new gateway session for
// seeks outside their buffered/seekable range. Bound the generated window and
// pause the producer when the client stops fetching (including viewer pause).
function boundedHlsArgs(enabled, admission = null, retainComplete = false) {
    if (retainComplete) {
        if (!enabled || !admission) throw new Error('RETAINED_HLS_ADMISSION_REQUIRED');
        // Keep the admitted, viewer-paced HTTP writer and its byte ceiling,
        // but retain every segment until clean EOF for manifest-last cache
        // publication. Ordinary viewers still use the rolling 64-segment path.
        return ['-hls_list_size', '0', '-hls_playlist_type', 'event',
            '-hls_flags', 'independent_segments', '-method', 'PUT', '-http_persistent', '0'];
    }
    return enabled
        ? ['-hls_list_size', '64', '-hls_delete_threshold', '16',
            '-hls_flags', admission ? 'independent_segments+delete_segments' : 'independent_segments+temp_file+delete_segments',
            ...(admission ? ['-method', 'PUT', '-http_persistent', '0'] : [])]
        : ['-hls_list_size', '0', '-hls_playlist_type', 'event',
            '-hls_flags', 'independent_segments+temp_file'];
}

function segmentNumber(name) {
    const match = /^(?:segment|video|audio_\d+)-(\d{5,8})\.ts$/.exec(name);
    return match ? Number(match[1]) : null;
}

function createHlsOutputControl({ root, child, targetSeconds = 4, aheadSeconds = 64,
    maxBytes = 512 * 1024 ** 2, minFreeBytes = 160 * 1024 ** 3,
    onFailure, intervalMs = 250, io = fs, admission = null }) {
    let stopped = false, paused = false, running = false, consumed = -1, produced = -1;
    let ticks = 0, bytes = 0, peakBytes = 0, pauses = 0, fileCount = 0, peakFiles = 0;
    const ahead = Math.max(4, Math.ceil(aheadSeconds / targetSeconds));
    function signal(value) {
        if (child.exitCode !== null || child.signalCode) return;
        child.kill(value);
    }
    function resume() { if (paused) { signal('SIGCONT'); paused = false; } }
    async function tick() {
        if (stopped || running) return;
        running = true;
        try {
            const entries = await io.readdir(root);
            if (stopped) return;
            fileCount = entries.length; peakFiles = Math.max(peakFiles, fileCount);
            produced = Math.max(produced, ...entries.map(segmentNumber).filter(n => n !== null));
            const shouldPause = produced - consumed >= ahead;
            if (!admission) {
                if (shouldPause && !paused) { signal('SIGSTOP'); paused = true; pauses++; }
                else if (!shouldPause) resume();
            }
            // Include subtitles, playlists and in-progress segments in the
            // safety check. Never certify a partial window as a complete film.
            if (++ticks % 4 === 1) {
                const stats = await Promise.all(entries.map(name => io.lstat(path.join(root, name)).catch(e => {
                    if (e.code === 'ENOENT') return null; throw e;
                })));
                if (stats.some(s => s && (!s.isFile() || s.isSymbolicLink()))) throw new Error('HLS_OUTPUT_UNSAFE');
                bytes = stats.reduce((sum, stat) => sum + (stat?.size || 0), 0);
                peakBytes = Math.max(peakBytes, bytes);
                const disk = await io.statfs(root);
                const free = Number(disk.bavail) * Number(disk.bsize);
                if (bytes > maxBytes || !Number.isSafeInteger(free) || free < minFreeBytes)
                    throw new Error('HLS_OUTPUT_STORAGE_CAPACITY');
            }
        } catch (error) {
            if (!stopped) {
                stopped = true; clearInterval(timer); resume();
                onFailure(error.message === 'HLS_OUTPUT_STORAGE_CAPACITY' ? error.message : 'HLS_OUTPUT_GUARD_FAILED');
            }
        } finally { running = false; }
    }
    const timer = setInterval(tick, intervalMs); timer.unref?.();
    return {
        served(name) {
            admission?.served(name);
            const number = segmentNumber(name);
            if (number !== null) { consumed = Math.max(consumed, number); if (produced - consumed < ahead) resume(); }
        },
        stop() { stopped = true; clearInterval(timer); resume(); return admission?.stop(); },
        finish() { stopped = true; clearInterval(timer); resume(); return admission?.finish(); },
        snapshot() { return { paused, pauses, consumed, produced, bytes, peakBytes, fileCount, peakFiles, maxBytes,
            ...(admission ? { outputAdmission: admission.snapshot() } : {}) }; },
        tick,
    };
}

module.exports = { boundedHlsArgs, segmentNumber, createHlsOutputControl };

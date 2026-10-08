'use strict';

const fs = require('node:fs');
const io = require('node:fs/promises');
const path = require('node:path');
const { committedSubtitleSnapshot, MAX_BYTES } = require('./committed-subtitle-snapshot');

// Files stay inside the session's existing bounded output reservation. Neither
// sidecar is a public artifact or a certificate of coverage / end of stream.
function committedSubtitleOutputArgs(renditions, root, seek = []) {
    // tee has its own parser in addition to argv. Refuse ambiguous paths.
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(root)) throw new Error('SUBTITLE_OUTPUT_PATH_INVALID');
    return renditions.flatMap(({ streamIndex }) => {
        if (!Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 128)
            throw new Error('SUBTITLE_INDEX_INVALID');
        const base = path.join(root, `committed_${streamIndex}`);
        return [...seek, '-map', `0:${streamIndex}`, '-c:s', 'webvtt', '-f', 'tee',
            `[f=webvtt:flush_packets=1]${base}.vtt|[f=framecrc:flush_packets=1]${base}.commit`];
    });
}

async function readBoundedFile(file, assertAccess, filesystem = io) {
    assertAccess();
    const handle = await filesystem.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_BYTES)
            throw new Error('SUBTITLE_SNAPSHOT_LIMIT');
        const bytes = Buffer.alloc(stat.size);
        let at = 0;
        while (at < bytes.length) {
            assertAccess();
            const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
            if (!bytesRead) throw new Error('SUBTITLE_SNAPSHOT_TRUNCATED');
            at += bytesRead;
        }
        assertAccess();
        return bytes;
    } finally { await handle.close(); }
}

function stamp(seconds) {
    const ms = Math.round(seconds * 1000);
    return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60]
        .map(n => String(n).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
}

async function readCommittedSubtitle(root, streamIndex, assertAccess, filesystem = io) {
    if (!Number.isInteger(streamIndex) || streamIndex < 0 || streamIndex > 128)
        throw new Error('SUBTITLE_INDEX_INVALID');
    const base = path.join(root, `committed_${streamIndex}`);
    // Journal first: the VTT may advance afterwards, but an uncommitted suffix
    // cannot escape. Reads are bounded even when a producer is still appending.
    const journal = await readBoundedFile(`${base}.commit`, assertAccess, filesystem);
    const bytes = await readBoundedFile(`${base}.vtt`, assertAccess, filesystem);
    const snapshot = committedSubtitleSnapshot(bytes, journal);
    assertAccess();
    if (!snapshot) throw new Error('SUBTITLE_SNAPSHOT_PENDING');
    return 'WEBVTT\n\n' + snapshot.cues.map(c => `${c.id ? c.id + '\n' : ''}${stamp(c.start)} --> ${stamp(c.end)}${c.settings ? ' ' + c.settings : ''}\n${c.text}\n`).join('\n');
}

module.exports = { committedSubtitleOutputArgs, readCommittedSubtitle, readBoundedFile };

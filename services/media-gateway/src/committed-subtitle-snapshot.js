'use strict';

// A live-view snapshot of encoded WebVTT packets. The second tee output is a
// commit journal: FFmpeg writes it after the flushed WebVTT output. This is
// packet publication, never a certificate of subtitle silence/time coverage.
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CUES = 20000;
function adler32(bytes) {
    let a = 0, b = 0;
    for (const value of bytes) { a = (a + value) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
}
function utf8(value) {
    if (!Buffer.isBuffer(value) || value.length > MAX_BYTES) return null;
    const text = value.toString('utf8');
    return Buffer.from(text).equals(value) ? text : null;
}
function milliseconds(value) {
    const m = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
    if (!m || +m[2] > 59 || +m[3] > 59) return null;
    const result = ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
    return Number.isSafeInteger(result) ? result : null;
}
function committedSubtitleSnapshot(vttBytes, journalBytes) {
    const vtt = utf8(vttBytes), journal = utf8(journalBytes);
    if (vtt === null || journal === null || !vtt.startsWith('WEBVTT\n\n')) return null;
    // A trailing partial journal line cannot commit a packet.
    const lines = journal.slice(0, journal.lastIndexOf('\n') + 1).split('\n');
    const tbLines = lines.filter(l => l.startsWith('#tb '));
    const tb = tbLines.length === 1 && /^#tb 0: (\d+)\/(\d+)$/.exec(tbLines[0]);
    if (!tb || !Number.isSafeInteger(+tb[1]) || !Number.isSafeInteger(+tb[2])
        || +tb[1] < 1 || +tb[2] < 1 || !lines.includes('#codec_id 0: webvtt')
        || !lines.includes('#media_type 0: subtitle')) return null;
    const packets = [];
    for (const line of lines) {
        if (!line || line.startsWith('#')) continue;
        const p = /^0,\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+),\s*0x([0-9a-f]{8})$/i.exec(line);
        if (!p || packets.length >= MAX_CUES || p.slice(1, 5).some(n => !Number.isSafeInteger(+n))
            || +p[1] !== +p[2] || +p[3] <= 0 || +p[4] > MAX_BYTES) return null;
        const start = Math.round(+p[2] * +tb[1] * 1000 / +tb[2]);
        const duration = Math.round(+p[3] * +tb[1] * 1000 / +tb[2]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(duration)
            || !Number.isSafeInteger(start + duration) || start < 0) return null;
        packets.push({ start, end: start + duration, size: +p[4], checksum: parseInt(p[5], 16) });
    }
    const blocks = vtt.slice(8).split('\n\n');
    const cues = [];
    for (let i = 0; i < packets.length; i++) {
        const block = blocks[i];
        if (typeof block !== 'string') return null;
        const split = block.split('\n');
        const timing = split.findIndex(l => l.includes('-->'));
        if (timing < 0 || timing > 1) return null;
        const m = /^(\S+) --> (\S+)(?: (.*))?$/.exec(split[timing]);
        if (!m) return null;
        // WebVTT muxer adds one final LF outside the encoded payload.
        let payload = split.slice(timing + 1).join('\n');
        if (i === blocks.length - 1 && payload.endsWith('\n')) payload = payload.slice(0, -1);
        const bytes = Buffer.from(payload), packet = packets[i];
        if (milliseconds(m[1]) !== packet.start || milliseconds(m[2]) !== packet.end
            || bytes.length !== packet.size || adler32(bytes) !== packet.checksum) return null;
        cues.push(Object.freeze({ start: packet.start / 1000, end: packet.end / 1000,
            text: payload, ...(timing ? { id: split[0] } : {}), ...(m[3] ? { settings: m[3] } : {}) }));
    }
    return Object.freeze({ cues: Object.freeze(cues), timeCoverage: false, complete: false });
}

module.exports = { committedSubtitleSnapshot, adler32, MAX_BYTES, MAX_CUES };

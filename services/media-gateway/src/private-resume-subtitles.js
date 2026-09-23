'use strict';

const clock = value => {
    const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
    if (!match || +match[2] > 59 || +match[3] > 59) return NaN;
    return (+match[1] || 0) * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000;
};

function videoTimestampOrigin(bytes, segmentStart) {
    if (!Buffer.isBuffer(bytes) || !Number.isFinite(segmentStart)) return null;
    // Finalized, locally produced HLS TS only. Read the first video PES clock;
    // no ffprobe subprocess and no additional provider request are necessary.
    for (let i = 0; i + 188 <= Math.min(bytes.length, 262144); i += 188) {
        const b = bytes.subarray(i, i + 188), control = (b[3] >> 4) & 3;
        if (b[0] !== 0x47) return null;
        if (!(b[1] & 64) || (b[1] & 128) || (b[3] & 192) || !(control & 1)) continue;
        const at = 4 + ((control & 2) ? 1 + b[4] : 0);
        if (at + 14 > 188) continue;
        const p = b.subarray(at), prefix = p[7] >> 6;
        if (p.readUIntBE(0, 3) !== 1 || p[3] < 0xe0 || p[3] > 0xef || (p[6] & 192) !== 128
            || ![2, 3].includes(prefix) || p[8] < 5 || (p[9] >> 4) !== prefix
            || !(p[9] & 1) || !(p[11] & 1) || !(p[13] & 1)) continue;
        const pts = ((p[9] >> 1) & 7) * 2 ** 30 + p[10] * 2 ** 22
            + (p[11] >> 1) * 2 ** 15 + p[12] * 128 + (p[13] >> 1);
        const wrap = 2 ** 33;
        return ((pts - Math.round(segmentStart * 90000)) % wrap + wrap) % wrap;
    }
    return null;
}

function parseSubtitlePlaylist(text) {
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024 || !text.startsWith('#EXTM3U')
        || /#EXT-X-(?:STREAM-INF|MEDIA:|KEY:|MAP:|BYTERANGE:|DISCONTINUITY)/.test(text)) return null;
    let duration = null, elapsed = 0; const segments = [];
    for (const line of text.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
        if (line.startsWith('#EXTINF:')) {
            if (duration !== null) return null;
            duration = Number(line.slice(8).split(',')[0]);
            if (!(duration > 0 && duration <= 86400)) return null;
        } else if (!line.startsWith('#')) {
            if (duration === null || !/^subtitle_\d+-\d{5}\.vtt$/.test(line)) return null;
            segments.push({ name: line, start: elapsed, end: elapsed + duration });
            elapsed += duration; duration = null;
        }
    }
    return duration === null && segments.length ? { segments, bootstrap: text.includes('#EXT-X-NORVA-BOOTSTRAP:'),
        ended: /^#EXT-X-ENDLIST\s*$/m.test(text) } : null;
}

function parseWebVtt(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024) return null;
    const blocks = bytes.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
    if (!/^WEBVTT(?:\s|$)/.test(blocks[0])) return null;
    const header = blocks.shift();
    // The FFmpeg subtitle lane currently emits the default zero-to-zero PES
    // map. Never reinterpret a foreign nonzero clock without a measured map.
    if (/X-TIMESTAMP-MAP/.test(header) && !/X-TIMESTAMP-MAP=LOCAL:00:00:00\.000,MPEGTS:0(?:\n|$)/.test(header)) return null;
    const cues = [], styles = [];
    for (const block of blocks.filter(x => x.trim())) {
        if (/^(STYLE|REGION)(?:\n|$)/.test(block)) { styles.push(block); continue; }
        if (/^NOTE(?:\s|$)/.test(block)) continue;
        const timing = block.split('\n').find(line => line.includes(' --> '));
        if (!timing) return null;
        const match = /^(\S+) --> (\S+)(?:\s.*)?$/.exec(timing);
        const start = match && clock(match[1]), end = match && clock(match[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        cues.push({ start, end, block });
    }
    return { header, styles, cues };
}

// All video-aligned subtitle fragments retain the original cue/PES clock.
// The HLS discontinuity handles the next encoder's clock; cue text is never
// translated, shifted, or dropped simply to make a cache window admissible.
async function captureSubtitleWindow({ renditions, videoSegments, readAsset, maxBytes = 4 * 1024 * 1024, prefix = 'resume', startIndex = 0 }) {
    if (!Array.isArray(renditions) || renditions.length > 32) return null;
    if (!['resume', 'continuation'].includes(prefix) || !videoSegments?.length
        || !Number.isSafeInteger(startIndex) || startIndex < 0) return null;
    const assets = new Map(), playlists = new Map(); let bytes = 0;
    const origin = renditions.length ? videoTimestampOrigin(
        await readAsset(videoSegments[0].name, 32 * 1024 * 1024), videoSegments[0].start) : 0;
    if (origin === null) return null;
    for (const rendition of renditions) {
        const name = rendition.playlistName;
        if (!/^subtitle_\d+\.m3u8$/.test(name)) return null;
        const raw = await readAsset(name, 2 * 1024 * 1024);
        const parsed = raw && parseSubtitlePlaylist(raw.toString('utf8'));
        if (!parsed || parsed.bootstrap) return null; // empty bootstrap is not proof of coverage
        const from = videoSegments[0].start, to = videoSegments.at(-1).end;
        if (!parsed.ended && parsed.segments.at(-1).end < to) return null;
        const cues = new Map(), styles = new Set(); let header;
        for (const segment of parsed.segments.filter(s => s.end > from && s.start < to)) {
            const data = await readAsset(segment.name, 4 * 1024 * 1024);
            const vtt = parseWebVtt(data);
            if (!vtt || (header && header !== vtt.header)) return null;
            header = vtt.header;
            for (const style of vtt.styles) styles.add(style);
            for (const cue of vtt.cues) cues.set(cue.block, cue);
        }
        if (!header) return null;
        const fragments = [];
        for (const [index, segment] of videoSegments.entries()) {
            const asset = `${prefix}-${name.slice(0, -5)}-${startIndex + index}.vtt`;
            const mappedHeader = header.replace(/\nX-TIMESTAMP-MAP[^\n]*/g, '')
                + `\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${origin}`;
            const payload = Buffer.from([mappedHeader, ...styles,
                ...[...cues.values()].filter(c => c.end > segment.start && c.start < segment.end).map(c => c.block), ''].join('\n\n'));
            if (bytes + payload.length > maxBytes) return null;
            assets.set(asset, payload); bytes += payload.length;
            fragments.push({ name: asset, duration: segment.duration });
        }
        playlists.set(name, fragments);
    }
    return { assets, playlists, bytes };
}

module.exports = { parseSubtitlePlaylist, parseWebVtt, captureSubtitleWindow, videoTimestampOrigin };

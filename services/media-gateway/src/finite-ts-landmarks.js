'use strict';

// Passive MPEG-TS navigation metadata. Only complete, identity-checked provider
// windows enter this parser. No network, decoder, media cache or bitrate guess.
const crypto = require('node:crypto');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const PACKET = 188;
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0);
    }
    return crc >>> 0;
}
function section(payload, table) {
    const start = 1 + payload[0];
    if (start + 8 > payload.length || payload[start] !== table) return null;
    const size = 3 + ((payload[start + 1] & 15) << 8) + payload[start + 2];
    const result = payload.subarray(start, start + size);
    // Multi-packet/multi-section PSI remains on the ordinary FFmpeg path.
    if (result.length !== size || size < 12 || !(result[5] & 1) || result[6] || result[7] || crc32(result)) return null;
    return result;
}
function timestamp(b, start, prefix) {
    if (start + 5 > b.length || (b[start] >> 4) !== prefix
        || !(b[start] & 1) || !(b[start + 2] & 1) || !(b[start + 4] & 1)) return null;
    return ((b[start] >> 1) & 7) * 2 ** 30 + b[start + 1] * 2 ** 22
        + (b[start + 2] >> 1) * 2 ** 15 + b[start + 3] * 128 + (b[start + 4] >> 1);
}

class TsLandmarks {
    constructor({ onPoint, onInvalid = () => {} } = {}) {
        this.onPoint = onPoint || (() => {}); this.onInvalid = onInvalid;
        this.next = null; this.pending = Buffer.alloc(0); this.signature = null;
        this.reset();
    }
    reset() {
        this.pmtPid = null; this.videoPid = null; this.audioPids = [];
        this.pat = null; this.pmt = null; this.patOffset = null; this.pmtOffset = null;
        this.cc = new Map(); this.pes = null; this.lastDts = null;
    }
    invalid() { this.onInvalid(); this.reset(); }
    push(start, bytes) {
        if (!Number.isSafeInteger(start) || start < 0 || !Buffer.isBuffer(bytes)) return;
        if (this.next !== start) { this.pending = Buffer.alloc(0); this.reset(); }
        const offset = start - this.pending.length;
        const data = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
        this.next = start + bytes.length;
        let i = 0;
        while (i + PACKET <= data.length) {
            if (data[i] !== 0x47 || (i + 2 * PACKET < data.length
                && (data[i + PACKET] !== 0x47 || data[i + 2 * PACKET] !== 0x47))) {
                // Resynchronization after an arbitrary HTTP window boundary is
                // allowed; corruption inside a contiguous observed run is not.
                if (this.videoPid !== null) this.invalid();
                i++; continue;
            }
            this.packet(data.subarray(i, i + PACKET), offset + i); i += PACKET;
        }
        this.pending = Buffer.from(data.subarray(i));
    }
    packet(b, pos) {
        const pid = ((b[1] & 31) << 8) | b[2], start = Boolean(b[1] & 64);
        const control = (b[3] >> 4) & 3;
        if ((b[1] & 128) || (b[3] & 192) || !control) { this.invalid(); return; }
        let at = 4;
        if (control & 2) {
            const len = b[at++];
            if (len > 183 || at + len > 188) { this.invalid(); return; }
            if (len && (b[at] & 128)) { this.invalid(); return; }
            at += len;
        }
        if (!(control & 1) || at >= 188 || pid === 8191) return;
        // Continuity is relevant only to the PSI and elementary streams which
        // prove this graph; private/other-program PIDs never become evidence.
        if (pid === 0 || pid === this.pmtPid || pid === this.videoPid || this.audioPids.includes(pid)) {
            const previous = this.cc.get(pid), cc = b[3] & 15;
            if (previous !== undefined && cc !== ((previous + 1) & 15)) {
                this.invalid(); return;
            }
            this.cc.set(pid, cc);
        }
        const payload = b.subarray(at);
        if (pid === 0 && start) {
            const pat = section(payload, 0);
            if (!pat) { this.invalid(); return; }
            const programs = [];
            for (let i = 8; i < pat.length - 4; i += 4) {
                if (pat.readUInt16BE(i)) programs.push(pat.readUInt16BE(i + 2) & 8191);
            }
            if (programs.length !== 1) { this.invalid(); return; }
            if (this.pat && !this.pat.equals(pat)) { this.invalid(); return; }
            this.pat = Buffer.from(pat); this.pmtPid = programs[0]; this.patOffset = pos;
        } else if (pid === this.pmtPid && start) {
            const pmt = section(payload, 2);
            if (!pmt || !this.pat) { this.invalid(); return; }
            const videos = [], audios = [];
            let i = 12 + (pmt.readUInt16BE(10) & 4095);
            while (i + 5 <= pmt.length - 4) {
                const type = pmt[i], id = pmt.readUInt16BE(i + 1) & 8191;
                if (type === 0x1b) videos.push(id);
                else if ([3, 4, 15, 17, 0x81, 0x87].includes(type)) audios.push(id);
                else if (type === 0x15) { /* timed ID3 metadata, not an A/V or subtitle rendition */ }
                else { this.invalid(); return; } // subtitles/private/multiple graphs: fallback
                i += 5 + (pmt.readUInt16BE(i + 3) & 4095);
            }
            if (i !== pmt.length - 4 || videos.length !== 1 || audios.length !== 1) { this.invalid(); return; }
            const signature = hash(Buffer.concat([this.pat, pmt]));
            if (this.signature && this.signature !== signature) { this.invalid(); this.signature = null; return; }
            this.signature = signature; this.pmt = Buffer.from(pmt);
            this.pmtOffset = pos;
            this.videoPid = videos[0]; this.audioPids = audios;
        } else if (pid === this.videoPid) {
            if (start) {
                this.finishPes();
                if (payload.length < 19 || payload.readUIntBE(0, 3) !== 1
                    || payload[3] < 0xe0 || payload[3] > 0xef || (payload[6] & 192) !== 128) return;
                const flags = payload[7] >> 6;
                const pts = timestamp(payload, 9, flags === 3 ? 3 : 2);
                const dts = flags === 3 ? timestamp(payload, 14, 1) : pts;
                if (![2, 3].includes(flags) || pts === null || dts === null || pts < dts
                    || pts - dts > 90000 * 2 || 9 + payload[8] > payload.length) return;
                if (this.lastDts !== null && (dts <= this.lastDts || dts - this.lastDts > 90000 * 10)) {
                    this.invalid(); return; // wraps/discontinuities are not linear navigation
                }
                this.lastDts = dts;
                this.pes = { pos, pts, dts, anchor: this.patOffset, signature: this.signature,
                    chunks: [], length: 0, overflow: this.pmtOffset === null || this.pmtOffset < this.patOffset };
                this.addPes(payload.subarray(9 + payload[8]));
            } else this.addPes(payload);
        }
    }
    addPes(bytes) {
        if (!this.pes || this.pes.overflow) return;
        if (this.pes.length + bytes.length > 256 * 1024) { this.pes.overflow = true; this.pes.chunks = []; return; }
        this.pes.chunks.push(Buffer.from(bytes)); this.pes.length += bytes.length;
    }
    finishPes() {
        const p = this.pes; this.pes = null;
        if (!p || p.overflow || !p.signature || !Number.isSafeInteger(p.anchor)
            || p.pos < p.anchor || p.pos - p.anchor > 65536) return;
        const payload = Buffer.concat(p.chunks, p.length);
        let sps = false, pps = false, idr = false;
        for (let i = 0; i + 4 < payload.length; i++) {
            if (payload[i] || payload[i + 1] || payload[i + 2] !== 1) continue;
            const nal = payload[i + 3];
            if (nal & 128) return;
            if ((nal & 31) === 7) sps = true;
            if ((nal & 31) === 8) pps = sps;
            if ((nal & 31) === 5) idr = sps && pps;
        }
        if (idr) this.onPoint({ byteOffset: p.anchor, packetOffset: p.pos, pts: p.pts, dts: p.dts,
            signature: p.signature, videoPid: this.videoPid, audioPid: this.audioPids[0] });
    }
}
module.exports = { TsLandmarks, crc32 };

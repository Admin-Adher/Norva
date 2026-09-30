'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { decodeStartupSegments } = require('./finite-ts-startup');

const SEGMENT = /^segment-(\d{5,8})\.ts$/;

function parseLivePlaylist(text) {
    const header = [], tail = [], segments = [];
    let pending = [], duration = null, sequence = 0;
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            sequence = Number(line.slice(22));
            if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('LIVE_TS_PLAYLIST_SCOPE');
            continue;
        }
        if (line.startsWith('#EXTINF:')) {
            duration = Number(line.slice(8).split(',')[0]); pending.push(line); continue;
        }
        if (line === '#EXT-X-DISCONTINUITY' || line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
            pending.push(line); continue;
        }
        if (line === '#EXT-X-ENDLIST') { tail.push(line); continue; }
        if (line.startsWith('#')) {
            if (!/^#(?:EXTM3U|EXT-X-(?:VERSION|TARGETDURATION|PLAYLIST-TYPE|INDEPENDENT-SEGMENTS|DISCONTINUITY-SEQUENCE|START))(?::|$)/.test(line))
                throw new Error('LIVE_TS_PLAYLIST_SCOPE');
            header.push(line); continue;
        }
        const match = SEGMENT.exec(line);
        if (!match || !Number.isFinite(duration) || duration <= 0
            || Number(match[1]) !== sequence + segments.length) throw new Error('LIVE_TS_PLAYLIST_SCOPE');
        segments.push({ name: line, sequence: sequence + segments.length, lines: [...pending, line] });
        pending = []; duration = null;
    }
    if (header[0] !== '#EXTM3U' || pending.length) throw new Error('LIVE_TS_PLAYLIST_SCOPE');
    return { header, tail, segments, sequence };
}

function projectLivePlaylist(text, minimum) {
    if (!Number.isSafeInteger(minimum) || minimum < 0) throw new Error('LIVE_TS_STARTUP_UNVERIFIED');
    const parsed = parseLivePlaylist(text);
    const removed = parsed.segments.filter(segment => segment.sequence < minimum);
    const kept = parsed.segments.filter(segment => segment.sequence >= minimum);
    if (!kept.length) throw new Error('LIVE_TS_STARTUP_UNVERIFIED');
    const discontinuities = removed.reduce((sum, segment) => sum + segment.lines.filter(line => line === '#EXT-X-DISCONTINUITY').length, 0);
    let oldDiscontinuity = 0;
    const header = parsed.header.filter(line => {
        if (!line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) return true;
        oldDiscontinuity = Number(line.slice(30)); return false;
    });
    if (!Number.isSafeInteger(oldDiscontinuity) || oldDiscontinuity < 0) throw new Error('LIVE_TS_PLAYLIST_SCOPE');
    header.push(`#EXT-X-MEDIA-SEQUENCE:${kept[0].sequence}`);
    if (discontinuities || oldDiscontinuity) header.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${oldDiscontinuity + discontinuities}`);
    return [...header, ...kept.flatMap(segment => segment.lines), ...parsed.tail, ''].join('\n');
}

function crcValid(section) {
    let crc = 0xffffffff;
    for (const byte of section) {
        crc = (crc ^ (byte << 24)) >>> 0;
        for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)) >>> 0;
    }
    return crc === 0;
}

// Inspect the producer's actual PAT/PMT, not channel names or a failed video
// decode. A PMT that declares H.264 remains a video service even without SPS.
function declaredTsTracks(bytes) {
    const partial = new Map();
    let pmtPid = null, program = null;
    for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
        const packet = bytes.subarray(offset, offset + 188);
        if (packet[0] !== 0x47 || (packet[1] & 0x80) || (packet[3] & 0xc0)) return null;
        const pid = ((packet[1] & 0x1f) << 8) | packet[2];
        if (pid !== 0 && pid !== pmtPid) continue;
        const control = (packet[3] >> 4) & 3;
        if (!(control & 1)) continue;
        let start = 4 + ((control & 2) ? packet[4] + 1 : 0);
        if (start >= 188) continue;
        const cc = packet[3] & 15;
        if (packet[1] & 0x40) {
            start += 1 + packet[start];
            if (start >= 188) continue;
            partial.set(pid, { bytes: Buffer.from(packet.subarray(start)), cc });
        } else {
            const prior = partial.get(pid);
            if (!prior || ((prior.cc + 1) & 15) !== cc) { partial.delete(pid); continue; }
            prior.bytes = Buffer.concat([prior.bytes, packet.subarray(start)]); prior.cc = cc;
        }
        const entry = partial.get(pid);
        if (!entry || entry.bytes.length < 3) continue;
        const size = 3 + (((entry.bytes[1] & 15) << 8) | entry.bytes[2]);
        if (size < 12 || size > 1024) { partial.delete(pid); continue; }
        if (entry.bytes.length < size) continue;
        const section = entry.bytes.subarray(0, size); partial.delete(pid);
        if (!crcValid(section) || !(section[5] & 1) || section[6] !== 0 || section[7] !== 0) continue;
        if (pid === 0 && section[0] === 0) {
            const programs = [];
            for (let i = 8; i + 4 <= size - 4; i += 4) {
                const id = section.readUInt16BE(i);
                if (id) programs.push({ id, pid: ((section[i + 2] & 31) << 8) | section[i + 3] });
            }
            if (programs.length !== 1) return null;
            program = programs[0].id; pmtPid = programs[0].pid;
        } else if (pid === pmtPid && section[0] === 2 && section.readUInt16BE(3) === program) {
            const types = [];
            let i = 12 + (((section[10] & 15) << 8) | section[11]);
            while (i + 5 <= size - 4) {
                types.push(section[i]); i += 5 + (((section[i + 3] & 15) << 8) | section[i + 4]);
            }
            if (i !== size - 4 || !types.length) return null;
            const video = types.filter(type => type === 0x1b).length;
            const audio = types.filter(type => [0x03, 0x04, 0x0f, 0x11, 0x81].includes(type)).length;
            if (video > 1 || types.length !== video + audio) return { scope: 'other' };
            return video === 1 ? { scope: 'h264', tracks: audio ? ['video', 'audio'] : ['video'] }
                : { scope: 'audio-only' };
        }
    }
    return null;
}

function createLiveTsStartupGate({ root, bin, signal, decode = decodeStartupSegments }) {
    let minimum = null, bypass = false, verified = false, attempts = 0, reason = 'pending', proofMs = 0;
    let inFlight = null, expectedTracks = null;
    const results = new Map(), rejected = new Set();
    const exhausted = () => {
        reason = 'invalid-prefix-limit';
        const error = new Error('Live H.264 startup has no independently decodable segment');
        error.code = 'LIVE_TS_STARTUP_INVALID';
        throw error;
    };
    async function inspect(name) {
        let handle;
        try {
            if (signal?.aborted) return { verified: false, reason: 'aborted' };
            const directory = await fsp.lstat(root);
            if (!path.isAbsolute(root) || !directory.isDirectory() || directory.isSymbolicLink()
                || await fsp.realpath(root) !== path.resolve(root)) return { verified: false, reason: 'invalid-file' };
            const file = path.join(root, name), linked = await fsp.lstat(file);
            if (!linked.isFile() || linked.isSymbolicLink()) return { verified: false, reason: 'invalid-file' };
            handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            const before = await handle.stat();
            if (before.ino !== linked.ino || before.dev !== linked.dev || before.nlink !== 1
                || before.size <= 0 || before.size > 32 * 1024 * 1024) return { verified: false, reason: 'invalid-file' };
            const prefix = Buffer.alloc(Math.min(before.size, 256 * 1024));
            const read = await handle.read(prefix, 0, prefix.length, 0);
            const program = declaredTsTracks(prefix.subarray(0, read.bytesRead));
            if (!program) return { verified: false, reason: 'unproven-program' };
            if (expectedTracks && (program.scope !== 'h264' || program.tracks.join() !== expectedTracks.join()))
                return { verified: false, reason: 'program-changed' };
            if (program.scope === 'h264') expectedTracks = program.tracks;
            const result = program.scope === 'h264'
                ? await decode(bin, [handle.fd], { signal, tracks: program.tracks, diagnostics: true })
                : { bypass: true, reason: program.scope };
            const after = await handle.stat();
            if (signal?.aborted) return { verified: false, reason: 'aborted' };
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1)
                return { verified: false, reason: 'changed-file' };
            return result;
        } catch (_) { return { verified: false, reason: 'unavailable-file' }; }
        finally { await handle?.close().catch(() => {}); }
    }
    async function check(playlist) {
            if (signal?.aborted) { reason = 'aborted'; return false; }
            if (verified || bypass) return true;
            if (rejected.size >= 3) exhausted();
            let parsed;
            try { parsed = parseLivePlaylist(playlist); }
            catch (error) {
                if (!rejected.size) { reason = 'playlist-out-of-scope'; bypass = true; return true; }
                error.code = 'LIVE_TS_STARTUP_PROOF_CHANGED'; throw error;
            }
            for (const segment of parsed.segments) {
                let result = results.get(segment.name);
                if (!result) {
                    if (attempts >= 3) exhausted();
                    attempts++;
                    const started = Date.now();
                    result = await inspect(segment.name);
                    proofMs += Math.max(0, Date.now() - started); results.set(segment.name, result);
                }
                reason = result.reason;
                if (result.reason === 'aborted' || signal?.aborted) return false;
                if (result.verified) { minimum = segment.sequence; verified = true; reason = 'decoded'; return true; }
                if (['invalid-bitstream', 'delayed-track-start'].includes(result.reason)) {
                    rejected.add(segment.name); minimum = segment.sequence + 1;
                    // Three proven corrupt prefixes do not authorize an untested
                    // fourth segment. The session may take its bounded encoder
                    // fallback; no unusable stream is advertised as ready.
                    if (rejected.size >= 3) exhausted();
                    continue;
                }
                // A timeout, unknown PMT or process/host issue is not proof of
                // corrupt media. Preserve the existing route, only retaining a
                // cutoff for any explicitly rejected prefix. Never claim decoded.
                bypass = true; return true;
            }
            return false;
    }
    return {
        check(playlist) {
            if (!inFlight) inFlight = check(playlist).finally(() => { inFlight = null; });
            return inFlight;
        },
        project(playlist) {
            if (!rejected.size && (bypass || verified)) return playlist;
            try { return projectLivePlaylist(playlist, minimum); }
            catch (error) {
                if (error.message === 'LIVE_TS_PLAYLIST_SCOPE') error.code = 'LIVE_TS_STARTUP_PROOF_CHANGED';
                throw error;
            }
        },
        allows(name) {
            const match = SEGMENT.exec(name);
            return !match || ((bypass || verified) && (minimum === null || Number(match[1]) >= minimum));
        },
        snapshot() { return { verified, bypass, minimum, attempts, rejected: rejected.size, reason, proofMs }; },
    };
}

module.exports = { createLiveTsStartupGate, parseLivePlaylist, projectLivePlaylist, declaredTsTracks };

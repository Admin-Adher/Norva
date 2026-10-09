'use strict';

const crypto = require('node:crypto');
const { parseResumeMediaPlaylist } = require('./private-resume-hls-cache');

const eligibleName = name => ['playlist.m3u8', 'video.m3u8'].includes(name);
// A stopped encoder can append ENDLIST without completing the source. It has
// no effect on the clock, and cache capture independently removes that marker.
const digest = text => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')
    .replace(/^#EXT-X-ENDLIST\s*$/gm, '').trimEnd()).digest('hex');

function timedPlaylist(text) {
    const parsed = parseResumeMediaPlaylist(text);
    if (!parsed || parsed.segments.length > 512) return null;
    const sequence = parsed.sequence;
    let elapsed = 0;
    const segments = parsed.segments.map(segment => {
        const duration = Math.round(segment.duration * 1e6);
        const entry = { name: segment.name, duration, start: elapsed };
        elapsed += duration;
        return entry;
    });
    return { sequence, segments, duration: elapsed, digest: digest(text) };
}

// One instance per output producer, fed only AFTER atomic playlist publication.
// Keep the current bounded window, not an ever-growing index of the whole film.
// Missing history, changed overlaps, rollback or a discontinuity disable reuse
// for this producer; they never interrupt its ordinary playback.
class ResumePlaylistClock {
    constructor({ retentionSeconds = 0 } = {}) {
        this.states = new Map();
        this.retentionUs = Math.min(300, Math.max(0, Number(retentionSeconds) || 0)) * 1e6;
    }
    observe(name, text) {
        if (!eligibleName(name)) return false;
        const previous = this.states.get(name);
        if (previous === null) return false;
        const next = timedPlaylist(text);
        const reject = () => { this.states.set(name, null); return false; };
        if (!next) return reject();
        let origin = 0;
        if (!previous) {
            if (next.sequence !== 0) return reject();
        } else {
            const delta = next.sequence - previous.sequence;
            if (delta < 0 || delta > previous.segments.length
                || delta + next.segments.length < previous.segments.length) return reject();
            origin = previous.origin + (delta === previous.segments.length
                ? previous.duration : previous.segments[delta].start);
            for (let i = delta; i < previous.segments.length; i++) {
                const old = previous.segments[i], current = next.segments[i - delta];
                if (old.name !== current.name || old.duration !== current.duration) return reject();
            }
        }
        if (!Number.isSafeInteger(origin) || !Number.isSafeInteger(origin + next.duration)) return reject();
        const history = previous && this.retentionUs > 0 ? [...previous.history,
            ...previous.segments.slice(0, next.sequence - previous.sequence)
                .map(s => ({ ...s, start: previous.origin + s.start }))]
            .filter(s => s.start + s.duration > origin - this.retentionUs).slice(-512) : [];
        this.states.set(name, { ...next, origin, history });
        return true;
    }
    originFor(name, text) {
        const state = this.states.get(name);
        return state && typeof text === 'string' && text.length <= 2 * 1024 * 1024
            && state.digest === digest(text) ? state.origin / 1e6 : null;
    }
    sequenceAt(name, seconds) {
        const state = this.states.get(name);
        if (!state || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
        const at = Math.round(seconds * 1e6) - state.origin;
        // Only the current published window can acknowledge playback. History
        // is an index for optional cache capture, not proof its files survive.
        const index = state.segments.findIndex(s => at >= s.start && at < s.start + s.duration);
        return index < 0 ? null : state.sequence + index;
    }
    captureWindow(name, text) {
        if (this.originFor(name, text) === null) return null;
        const state = this.states.get(name);
        return [...state.history, ...state.segments.map(s => ({ ...s, start: state.origin + s.start }))]
            .map(s => ({ name: s.name, duration: s.duration / 1e6, start: s.start / 1e6, end: (s.start + s.duration) / 1e6 }));
    }
    keepsAsset(name) {
        for (const state of this.states.values()) if (state && [...state.history, ...state.segments].some(s => s.name === name)) return true;
        return false;
    }
}

module.exports = { ResumePlaylistClock };

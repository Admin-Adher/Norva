'use strict';

// Intrinsic file metadata (dimensions, pixel format, codec aliases, sample
// rate) is not a playback preference. It can be enriched between two visits.
// File identity is separately checked by a fresh strong ETag + exact size +
// resolved target. Bind the choices that affect the requested rendition, not
// an evolving descriptive metadata record.
function privateResumeProfile({ format, audio, audioMode, clientAudioPassthrough, encoder, subtitles = [], subtitleClock, subtitleInputClock }) {
    if (!['mp4', 'mkv', 'mpegts'].includes(format) || !Number.isInteger(audio?.index)
        || audio.index < 0 || !Array.isArray(subtitles)) return null;
    const mode = String(audioMode || '').toLowerCase();
    if (mode && !['auto', 'copy', 'transcode', 'encode'].includes(mode)) return null;
    if (subtitleClock !== undefined && subtitleClock !== 'source-pes-v1') return null;
    if (subtitleInputClock !== undefined && (!['absolute-v1', 'absolute-v2'].includes(subtitleInputClock)
        || subtitleClock !== 'source-pes-v1')) return null;
    return JSON.stringify({ protocol: 'hls-window-2', format, audioIndex: audio.index,
        audioMode: mode === 'encode' ? 'transcode' : (mode === 'auto' ? '' : mode),
        clientAudioPassthrough: clientAudioPassthrough !== false,
        encoder: String(encoder || ''), subtitles, ...(subtitleClock ? { subtitleClock } : {}),
        ...(subtitleInputClock ? { subtitleInputClock } : {}) });
}

// PostgreSQL JSONB and an in-band probe enumerate the same facts in different
// key orders. Arrays remain ordered: rendition membership/order is significant.
function canonicalResumeProfile(value) {
    const ordered = item => Array.isArray(item) ? item.map(ordered)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])]))
            : item;
    return JSON.stringify(ordered(value));
}

module.exports = { privateResumeProfile, canonicalResumeProfile };

'use strict';

// Intrinsic file metadata (dimensions, pixel format, codec aliases, sample
// rate) is not a playback preference. It can be enriched between two visits.
// File identity is separately checked by a fresh strong ETag + exact size +
// resolved target. Bind the choices that affect the requested rendition, not
// an evolving descriptive metadata record.
function privateResumeProfile({ format, audio, audioMode, clientAudioPassthrough, encoder, subtitles = [] }) {
    if (!['mp4', 'mkv', 'mpegts'].includes(format) || !Number.isInteger(audio?.index)
        || audio.index < 0 || !Array.isArray(subtitles)) return null;
    const mode = String(audioMode || '').toLowerCase();
    if (mode && !['auto', 'copy', 'transcode', 'encode'].includes(mode)) return null;
    return JSON.stringify({ protocol: 'hls-window-2', format, audioIndex: audio.index,
        audioMode: mode === 'encode' ? 'transcode' : (mode === 'auto' ? '' : mode),
        clientAudioPassthrough: clientAudioPassthrough !== false,
        encoder: String(encoder || ''), subtitles });
}

module.exports = { privateResumeProfile };

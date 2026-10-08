'use strict';

// The retained decoder and WebVTT output share the pre-mux PES clock.
// HLS nests a MPEG-TS muxer: setting only the outer muxer leaves its default
// 1.4 s delay (and B-frame negative-timestamp shift) in the video lane.
const SOURCE_CLOCK = 'source-pes-v1';
function retainedSubtitleClock(session) {
    return Boolean(session?.retainedRequestBinding
        && session?.exactSubtitleHls?.enabled === true
        && session?.multiAudioHls?.enabled !== true
        && !session?.mediaCacheProducer && !session?.completeHlsCacheLease);
}
function retainedSubtitleClockArgs(enabled) {
    return enabled ? ['-avoid_negative_ts', 'disabled', '-muxdelay', '0', '-muxpreload', '0',
        '-hls_segment_options', 'mpegts_copyts=1:avoid_negative_ts=disabled'] : [];
}
module.exports = { SOURCE_CLOCK, retainedSubtitleClock, retainedSubtitleClockArgs };

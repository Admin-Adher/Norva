const { strictLidTimelineOffsets } = require('./strict-lid-batch');

const STRICT_LID_SPEECH_SELECTION_PROTOCOL = 1;
const STRICT_LID_SPEECH_SAMPLE_MS = 20_000;
const STRICT_LID_SPEECH_SEARCH_MS = 60_000;

// The search region is chosen before language inference: at most 20 seconds on
// either side of the existing 20-second anchor clip, contained in its original
// temporal stratum. A short film therefore never borrows evidence from another
// ordinal. Boundaries share the existing anchor's millisecond precision: rounding
// both sides of a shared boundary identically preserves disjoint strata without
// losing a millisecond on near-minimum-duration files.
function planStrictSpeechWindow(durationSeconds, windowOrdinal) {
    const anchors = strictLidTimelineOffsets(durationSeconds);
    if (!anchors || !Number.isSafeInteger(windowOrdinal)
        || windowOrdinal < 1 || windowOrdinal > anchors.length) return null;
    const ordinalIndex = windowOrdinal - 1;
    const durationMilliseconds = durationSeconds * 1000;
    const anchorOffsetMilliseconds = Math.round(anchors[ordinalIndex] * 1000);
    const stratumStartMilliseconds = Math.round(ordinalIndex * durationMilliseconds / anchors.length);
    const stratumEndMilliseconds = Math.round(windowOrdinal * durationMilliseconds / anchors.length);
    const marginMilliseconds = (STRICT_LID_SPEECH_SEARCH_MS - STRICT_LID_SPEECH_SAMPLE_MS) / 2;
    const searchStartMilliseconds = Math.max(
        stratumStartMilliseconds,
        anchorOffsetMilliseconds - marginMilliseconds,
    );
    const searchEndMilliseconds = Math.min(
        stratumEndMilliseconds,
        anchorOffsetMilliseconds + STRICT_LID_SPEECH_SAMPLE_MS + marginMilliseconds,
    );
    const searchDurationMilliseconds = searchEndMilliseconds - searchStartMilliseconds;
    if (searchDurationMilliseconds < STRICT_LID_SPEECH_SAMPLE_MS
        || anchorOffsetMilliseconds < searchStartMilliseconds
        || anchorOffsetMilliseconds + STRICT_LID_SPEECH_SAMPLE_MS > searchEndMilliseconds) return null;
    const preferredStartMilliseconds = anchorOffsetMilliseconds - searchStartMilliseconds;
    return Object.freeze({
        selectionProtocol: STRICT_LID_SPEECH_SELECTION_PROTOCOL,
        windowOrdinal,
        windowCount: anchors.length,
        anchorOffsetSeconds: anchorOffsetMilliseconds / 1000,
        searchStartSeconds: searchStartMilliseconds / 1000,
        searchDurationSeconds: searchDurationMilliseconds / 1000,
        stratumStartSeconds: stratumStartMilliseconds / 1000,
        stratumEndSeconds: stratumEndMilliseconds / 1000,
        preferredStartSeconds: preferredStartMilliseconds / 1000,
        sampleDurationSeconds: STRICT_LID_SPEECH_SAMPLE_MS / 1000,
        anchorOffsetMilliseconds,
        searchStartMilliseconds,
        searchDurationMilliseconds,
        stratumStartMilliseconds,
        stratumEndMilliseconds,
        preferredStartMilliseconds,
        sampleDurationMilliseconds: STRICT_LID_SPEECH_SAMPLE_MS,
    });
}

module.exports = {
    STRICT_LID_SPEECH_SELECTION_PROTOCOL,
    STRICT_LID_SPEECH_SAMPLE_MS,
    STRICT_LID_SPEECH_SEARCH_MS,
    planStrictSpeechWindow,
};

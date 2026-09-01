'use strict';

function finiteMkvLinearSeekBridgePlan({
    enabled,
    finiteMkv,
    indexedInput,
    linearFallbacks,
    seekOffsetSeconds,
    prerollSeconds,
}) {
    const requestedSeekOffsetSeconds = Number.isFinite(Number(seekOffsetSeconds))
        ? Math.max(0, Math.floor(Number(seekOffsetSeconds)))
        : 0;
    const normalizedPrerollSeconds = Number.isFinite(Number(prerollSeconds))
        ? Math.max(1, Math.floor(Number(prerollSeconds)))
        : 30;
    if (
        enabled !== true ||
        finiteMkv !== true ||
        indexedInput === true ||
        Number(linearFallbacks || 0) < 1 ||
        requestedSeekOffsetSeconds <= normalizedPrerollSeconds
    ) return null;

    const bridgeSeekOffsetSeconds = requestedSeekOffsetSeconds - normalizedPrerollSeconds;
    return {
        requestedSeekOffsetSeconds,
        bridgeSeekOffsetSeconds,
        fineSeekOffsetSeconds: requestedSeekOffsetSeconds - bridgeSeekOffsetSeconds,
        prerollSeconds: normalizedPrerollSeconds,
    };
}

function finiteMkvLinearSeekBridgeArgs(plan, inputProbeArgs = []) {
    if (!plan || !Number.isFinite(Number(plan.bridgeSeekOffsetSeconds))) {
        throw new TypeError('A finite MKV linear seek bridge plan is required');
    }
    return [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',
        '-y',
        '-fflags', '+genpts',
        ...inputProbeArgs,
        '-i', 'pipe:0',
        '-ss', String(Math.max(0, Math.floor(Number(plan.bridgeSeekOffsetSeconds)))),
        // Preserve the complete Matroska stream order. The main FFmpeg graph
        // consumes exact absolute indexes from the already-verified profile;
        // regrouping video/audio/subtitles here would silently invalidate them.
        '-map', '0',
        '-copy_unknown',
        '-map_metadata', '0',
        '-map_chapters', '0',
        '-c', 'copy',
        '-max_muxing_queue_size', '4096',
        '-avoid_negative_ts', 'make_non_negative',
        '-f', 'matroska',
        'pipe:1',
    ];
}

module.exports = {
    finiteMkvLinearSeekBridgeArgs,
    finiteMkvLinearSeekBridgePlan,
};

'use strict';

// Explicit allowlists only. This is retained after a failed startup, when its
// broker and FFmpeg have already disappeared. Never retain provider URLs,
// headers, validators, proxy settings, session credentials or arbitrary errors.
function startupFailureDiagnostics(session) {
    const numbers = (source, names) => Object.fromEntries(names.flatMap(name => {
        const value = source?.[name];
        return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'
            ? [[name, value]] : [];
    }));
    const timings = numbers(session?.startupTimings, [
        'codecProfileMs', 'providerGetPreopenMs', 'inbandCodecProfileMs',
        'slotReleaseWaitMs', 'ffmpegReadyMs', 'firstSegmentReadyMs',
        'playlistSegmentCount', 'playlistBufferSeconds', 'playlistProductionSpanMs',
        'sustainedMediaProductionRateX', 'ffmpegSpawnCount', 'fastInputProbeFallbacks',
        'finiteTsFastInput', 'finiteTsDurationScanSkipped', 'finiteTsIndexUsed',
    ]);
    const broker = session?.finiteMkvSeekBroker;
    return {
        protocol: 1,
        code: ['PLAYLIST_TIMEOUT', 'INPUT_FAILED', 'FFMPEG_FAILED'].includes(session?.startupFailureCode)
            ? session.startupFailureCode : 'STARTUP_FAILED',
        timings,
        broker: numbers(broker, ['providerFetches', 'completedProviderFetches',
            'interruptedProviderFetches', 'cacheHits', 'cacheMisses', 'resumeRangeReusedBytes']),
        windows: (Array.isArray(broker?.windowTrace) ? broker.windowTrace : []).slice(-12)
            .map(window => ({
                ...numbers(window, ['localStart', 'localEnd', 'providerStart', 'providerEnd',
                    'bytes', 'responseHeadersMs', 'firstByteMs', 'durationMs', 'redirects', 'resolvedTargetReused']),
                outcome: ['active', 'completed', 'superseded', 'aborted', 'failed'].includes(window?.outcome)
                    ? window.outcome : 'other',
            })),
    };
}

module.exports = { startupFailureDiagnostics };

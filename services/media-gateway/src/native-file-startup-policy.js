'use strict';

// Android reads the header, closes that request, then asks for the index/seek
// location. Completing a small first window preserves the provider connection
// and avoids the release grace caused by aborting a speculative 8 MiB read.
function nativeFileStartupOptions(scope, hasRetainedRanges = false) {
    const native = scope === 'native-vod-recovery';
    return {
        finiteWarmupWindowBytes: native || hasRetainedRanges ? 64 * 1024 : 0,
        finiteWarmupCueGraceMs: native ? 75 : 0,
    };
}

module.exports = { nativeFileStartupOptions };

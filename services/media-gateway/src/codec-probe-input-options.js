'use strict';

function codecProbeInputOptions(sourceUrl) {
    let protocol;
    try { protocol = new URL(sourceUrl).protocol; } catch { return []; }
    if (protocol !== 'http:' && protocol !== 'https:') return [];
    // Providers may name real HLS segments without a media extension. Relax
    // that heuristic, but forbid nested file/data/pipe/concat access explicitly.
    return [
        '-protocol_whitelist', 'http,https,tcp,tls,httpproxy,crypto',
        '-extension_picky', '0'
    ];
}

module.exports = { codecProbeInputOptions };

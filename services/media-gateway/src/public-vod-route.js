'use strict';

// These public, credential-free Selection paths were replayed directly from the
// Gateway. Never extend this decision to arbitrary provider hosts or accounts.
function publicVodDirectRoute(sourceUrl) {
    try {
        const url = new URL(sourceUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || url.search || url.hash) return null;
        const oracle = url.hostname === 'objectstorage.us-phoenix-1.oraclecloud.com'
            && url.pathname.startsWith('/n/axa4wow3dcia/b/bucket-20201001-1658/o/')
            && /\.mp4$/i.test(url.pathname);
        const sandro = url.hostname === 'sandroflix.sandrostoreps3.workers.dev'
            && url.pathname.startsWith('/content/filmes/')
            && /\.(?:mp4|mkv)$/i.test(url.pathname);
        if (!oracle && !sandro) return null;
        return { slot: 0, ffmpegSlot: 0, nodeTransport: 'direct', ffmpegTransport: 'direct',
            selectionReason: 'qualified-public-vod', controlStatus: 'public-direct' };
    } catch (_) { return null; }
}

function isPublicDirectRoute(route) {
    return route?.nodeTransport === 'direct' && route.slot === 0
        && route.selectionReason === 'qualified-public-vod' && route.controlStatus === 'public-direct';
}

module.exports = { publicVodDirectRoute, isPublicDirectRoute };

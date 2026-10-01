'use strict';

// This public, credential-free Selection bucket was replayed directly from the
// Gateway. Never extend this decision to arbitrary provider hosts or accounts.
function publicVodDirectRoute(sourceUrl) {
    try {
        const url = new URL(sourceUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.port
            || url.search || url.hash
            || url.hostname !== 'objectstorage.us-phoenix-1.oraclecloud.com'
            || !url.pathname.startsWith('/n/axa4wow3dcia/b/bucket-20201001-1658/o/')
            || !/\.mp4$/i.test(url.pathname)) return null;
        return { slot: 0, ffmpegSlot: 0, nodeTransport: 'direct', ffmpegTransport: 'direct',
            selectionReason: 'qualified-public-vod', controlStatus: 'public-direct' };
    } catch (_) { return null; }
}

function isPublicDirectRoute(route) {
    return route?.nodeTransport === 'direct' && route.slot === 0
        && route.selectionReason === 'qualified-public-vod' && route.controlStatus === 'public-direct';
}

module.exports = { publicVodDirectRoute, isPublicDirectRoute };

/**
 * Chromecast sender (web) — Google Cast SDK wrapper for the VOD player.
 *
 * The receiver (Default Media Receiver) fetches the stream URL itself, so only
 * server-served absolute URLs are castable: gateway HLS sessions, gateway
 * transcode playlists and relay MP4s. The in-browser engine's MSE blob is not —
 * WatchPage re-resolves those titles through a gateway transcode before casting.
 *
 * The SDK script is injected lazily on first use of a Chromium browser; every
 * call is a safe no-op elsewhere (Firefox/Safari never see a cast button).
 */

window.NorvaCast = (() => {
    // The Cast sender only exists in Chromium browsers, and never inside the
    // native APK shells (they have their own Cast integration).
    const supported = !!window.chrome && !/NorvaTV-Android/i.test(navigator.userAgent || '');

    let sdkInjected = false;
    let frameworkReady = false;
    const stateListeners = new Set();

    function notify() {
        for (const fn of stateListeners) {
            try { fn(); } catch (_) { /* listener errors stay local */ }
        }
    }

    function initFramework() {
        try {
            const ctx = cast.framework.CastContext.getInstance();
            ctx.setOptions({
                receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
            });
            ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, notify);
            ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, notify);
            frameworkReady = true;
            notify();
        } catch (_) { /* framework unavailable — stays a no-op */ }
    }

    function ensureSdk() {
        if (!supported || sdkInjected) return;
        sdkInjected = true;
        window.__onGCastApiAvailable = (isAvailable) => { if (isAvailable) initFramework(); };
        const s = document.createElement('script');
        s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
        s.onerror = () => { /* offline/blocked: cast simply unavailable */ };
        document.head.appendChild(s);
    }

    function context() {
        return frameworkReady ? cast.framework.CastContext.getInstance() : null;
    }

    function devicesAvailable() {
        const ctx = context();
        if (!ctx) return false;
        const state = ctx.getCastState();
        return state && state !== cast.framework.CastState.NO_DEVICES_AVAILABLE;
    }

    function isCasting() {
        const ctx = context();
        return !!ctx && ctx.getSessionState() === cast.framework.SessionState.SESSION_STARTED
            || !!ctx && ctx.getSessionState() === cast.framework.SessionState.SESSION_RESUMED;
    }

    function deviceName() {
        try {
            return context()?.getCurrentSession()?.getCastDevice()?.friendlyName || 'Chromecast';
        } catch (_) {
            return 'Chromecast';
        }
    }

    function contentTypeFor(url) {
        let path = String(url || '').toLowerCase();
        const q = path.indexOf('?');
        if (q > 0) path = path.slice(0, q);
        if (path.endsWith('.m3u8')) return 'application/x-mpegURL';
        if (path.endsWith('.webm')) return 'video/webm';
        if (path.endsWith('.mkv')) return 'video/x-matroska';
        if (path.endsWith('.ts')) return 'video/mp2t';
        return 'video/mp4';
    }

    /** Open the device picker (if needed) and load the media on the receiver. */
    async function castMedia({ url, title, poster, currentTime = 0, live = false }) {
        const ctx = context();
        if (!ctx || !url) throw new Error('Cast unavailable');
        if (!ctx.getCurrentSession()) {
            await ctx.requestSession(); // shows the browser's device picker
        }
        const session = ctx.getCurrentSession();
        if (!session) throw new Error('No cast session');

        const mediaInfo = new chrome.cast.media.MediaInfo(url, contentTypeFor(url));
        mediaInfo.streamType = live
            ? chrome.cast.media.StreamType.LIVE
            : chrome.cast.media.StreamType.BUFFERED;
        const meta = new chrome.cast.media.MovieMediaMetadata();
        meta.title = title || 'Norva';
        if (poster) {
            try { meta.images = [new chrome.cast.Image(new URL(poster, location.origin).href)]; } catch (_) { }
        }
        mediaInfo.metadata = meta;

        const request = new chrome.cast.media.LoadRequest(mediaInfo);
        request.autoplay = true;
        request.currentTime = Math.max(0, Math.floor(currentTime));
        await session.loadMedia(request);
        return deviceName();
    }

    function remotePosition() {
        try {
            const media = context()?.getCurrentSession()?.getMediaSession();
            if (!media) return 0;
            return Math.max(0, media.getEstimatedTime ? media.getEstimatedTime() : (media.currentTime || 0));
        } catch (_) {
            return 0;
        }
    }

    function togglePlayback() {
        try {
            const media = context()?.getCurrentSession()?.getMediaSession();
            if (!media) return;
            const paused = media.playerState === chrome.cast.media.PlayerState.PAUSED;
            const req = paused ? new chrome.cast.media.PlayRequest() : new chrome.cast.media.PauseRequest();
            paused ? media.play(req, () => { }, () => { }) : media.pause(req, () => { }, () => { });
        } catch (_) { /* remote transport is best-effort */ }
    }

    function endSession() {
        try { context()?.endCurrentSession(true); } catch (_) { }
    }

    function onStateChange(fn) {
        stateListeners.add(fn);
        return () => stateListeners.delete(fn);
    }

    return {
        supported,
        ensureSdk,
        devicesAvailable,
        isCasting,
        deviceName,
        castMedia,
        remotePosition,
        togglePlayback,
        endSession,
        onStateChange
    };
})();

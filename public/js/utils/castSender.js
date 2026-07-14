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
        return !!ctx && (
            ctx.getSessionState() === cast.framework.SessionState.SESSION_STARTED
            || ctx.getSessionState() === cast.framework.SessionState.SESSION_RESUMED
        );
    }

    async function requestSession() {
        const ctx = context();
        if (!ctx) throw new Error('Cast unavailable');
        if (ctx.getCurrentSession()) return deviceName();
        try {
            await ctx.requestSession(); // shows the browser's device picker
            return deviceName();
        } catch (err) {
            if (isCancel(err)) { const e = new Error('cast-cancelled'); e.code = 'cancel'; throw e; }
            throw (err instanceof Error) ? err : new Error(String(err?.description || err || 'Cast session failed'));
        }
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

    // Normalise the picker-cancel case: chrome.cast rejects requestSession() with
    // the bare string 'cancel' (or an error whose .code is 'cancel') when the user
    // dismisses the device sheet. Surface it with a stable .code so callers can stay
    // silent instead of showing a spurious "cast failed" error.
    function isCancel(err) {
        if (!err) return false;
        if (err === 'cancel' || err.code === 'cancel') return true;
        return chrome.cast.ErrorCode && err.code === chrome.cast.ErrorCode.CANCEL;
    }

    /**
     * Open the device picker (if needed) and load the media on the receiver.
     * `subtitles` (optional): [{ url, lang, name }] — VTT side-loaded as receiver
     * text tracks and activated, so Norva's embedded/AI subtitles survive casting.
     */
    async function castMedia({ url, title, poster, currentTime = 0, live = false, subtitles = [] }) {
        const ctx = context();
        if (!ctx || !url) throw new Error('Cast unavailable');
        if (!ctx.getCurrentSession()) await requestSession();
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

        // Side-load subtitle tracks (VTT). The receiver fetches each trackContentId
        // itself, so only absolute URLs / data: URIs are usable — WatchPage resolves
        // those before calling. Text tracks default OFF unless we activate them below.
        const wanted = (Array.isArray(subtitles) ? subtitles : []).filter(s => s && s.url);
        const builtTracks = wanted.map((s, i) => {
            const t = new chrome.cast.media.Track(i + 1, chrome.cast.media.TrackType.TEXT);
            t.trackContentId = s.url;
            t.trackContentType = 'text/vtt';
            t.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
            t.name = s.name || 'Subtitles';
            t.language = s.lang || 'und';
            return t;
        });

        const load = async (withSubs) => {
            mediaInfo.tracks = withSubs ? builtTracks : undefined;
            const request = new chrome.cast.media.LoadRequest(mediaInfo);
            request.autoplay = true;
            request.currentTime = Math.max(0, Math.floor(currentTime));
            if (withSubs && builtTracks.length) request.activeTrackIds = [1]; // the track the user had on
            await session.loadMedia(request);
        };

        // Subtitles must never break playback: if a receiver rejects a side-loaded
        // track (some can't fetch the VTT / data: URI), retry once with media only.
        try {
            await load(builtTracks.length > 0);
        } catch (err) {
            if (!builtTracks.length) throw err;
            await load(false);
        }
        return deviceName();
    }

    function currentMedia() {
        try { return context()?.getCurrentSession()?.getMediaSession() || null; } catch (_) { return null; }
    }

    /** Duration the receiver reports for the loaded media (playlist-relative). */
    function remoteDuration() {
        try { return Math.max(0, currentMedia()?.media?.duration || 0); } catch (_) { return 0; }
    }

    function remoteIsPaused() {
        try { return currentMedia()?.playerState === chrome.cast.media.PlayerState.PAUSED; } catch (_) { return false; }
    }

    /** Seek the receiver to an absolute (playlist-relative) second. */
    function seekTo(seconds) {
        try {
            const media = currentMedia();
            if (!media) return;
            const req = new chrome.cast.media.SeekRequest();
            req.currentTime = Math.max(0, Math.floor(seconds || 0));
            media.seek(req, () => { }, () => { });
        } catch (_) { /* best-effort */ }
    }

    function remotePosition() {
        try {
            const media = currentMedia();
            if (!media) return 0;
            return Math.max(0, media.getEstimatedTime ? media.getEstimatedTime() : (media.currentTime || 0));
        } catch (_) {
            return 0;
        }
    }

    function togglePlayback() {
        try {
            const media = currentMedia();
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
        requestSession,
        castMedia,
        remotePosition,
        remoteDuration,
        remoteIsPaused,
        seekTo,
        togglePlayback,
        endSession,
        onStateChange
    };
})();

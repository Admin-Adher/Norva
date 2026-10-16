// Windows uses the existing native playback/history/session lifecycle, with a
// dedicated LibVLC process for media. No DOM video element or HLS conversion.
(() => {
    const bridge = window.NorvaDesktop?.nativePlayer;
    if (bridge?.protocol !== 1) return;
    const progress = new Map();
    const renderedPosition = (id) => {
        const event=progress.get(id)?.latest;
        if (!event || !['movie','episode','series'].includes(event.itemType)
            || !Number.isFinite(event.positionSeconds) || event.positionSeconds<0 || event.positionSeconds>=86400
            || !(event.decodedVideo>0 || event.displayedPictures>0)
            || !Number.isFinite(event.savedAtMs) || Date.now()-event.savedAtMs<0 || Date.now()-event.savedAtMs>10000)return undefined;
        return event.positionSeconds;
    };
    window.__norvaNative = window.__norvaNative || {};
    window.__norvaNative.renderedPosition = renderedPosition;
    const publish = (entry) => {
        const event=entry?.latest;if(!event || event.durationSeconds<=0)return;
        window.__norvaNative?.onProgress?.(event.sourceId,event.itemType,event.itemId,event.positionSeconds,event.durationSeconds,event.savedAtMs);
        entry.publishedAt=Date.now();
    };
    const replayCloses = async () => {
        if (!window.__norvaNative?.onPlaybackClosed) return;
        try {
            // Keep protocol 1's UUID-only close response for older renderers.
            const closes = typeof bridge.pendingPlaybackCloseDetails === 'function'
                ? await bridge.pendingPlaybackCloseDetails() : await bridge.pendingPlaybackCloses();
            for (const entry of closes) {
                const id=typeof entry==='string' ? entry : entry?.sessionId;
                const position=Number.isFinite(entry?.resumePosition) && entry.resumePosition>=0 && entry.resumePosition<86400
                    ? entry.resumePosition : undefined;
                window.__norvaNative.onPlaybackClosed(id, 'player_exited', position);
            }
        } catch { /* Exact cloud acknowledgement remains required before reopening. */ }
    };
    bridge.onEvent(event => {
        const hooks = window.__norvaNative;
        if (event.type === 'progress' && event.durationSeconds > 0) {
            const entry=progress.get(event.sessionId)||{publishedAt:0};entry.latest=event;progress.set(event.sessionId,entry);
            if(Date.now()-entry.publishedAt>=15000)publish(entry);
        }
        if (event.type === 'preferences') {
            hooks?.onTrackPreferences?.(event.sourceId,event.itemType,event.itemId,event.preferences);
            const entry=progress.get(event.sessionId);if(entry)entry.publishedAt=0;
        }
        if (event.type === 'ended') hooks?.onEnded?.(event.sourceId,event.itemType,event.itemId);
        if (event.type === 'closed') {
            const position=Number.isFinite(event.resumePosition) && event.resumePosition>=0 && event.resumePosition<86400
                ? event.resumePosition : renderedPosition(event.sessionId);
            publish(progress.get(event.sessionId));progress.delete(event.sessionId);
            hooks?.onPlaybackClosed?.(event.sessionId,event.reason,position);
        }
    });
    window.addEventListener('load', () => { void replayCloses(); });
    window.addEventListener('focus', () => { void replayCloses(); });
    window.addEventListener('norva:native-launch-failed', () => {
        const watch = window.app?.pages?.watch;
        void watch?.stopCloudPlaybackSessions?.();
        window.app?.showToast?.(window.NorvaI18n?.t('ui_web_0535388758c1', { defaultValue:'Playback failed' }) || 'Playback failed', 'error');
    });
})();

// Windows uses the existing native playback/history/session lifecycle, with a
// dedicated LibVLC process for media. No DOM video element or HLS conversion.
(() => {
    const bridge = window.NorvaDesktop?.nativePlayer;
    if (bridge?.protocol !== 1) return;
    const progress = new Map();
    const publish = (entry) => {
        const event=entry?.latest;if(!event || event.durationSeconds<=0)return;
        window.__norvaNative?.onProgress?.(event.sourceId,event.itemType,event.itemId,event.positionSeconds,event.durationSeconds,event.savedAtMs);
        entry.publishedAt=Date.now();
    };
    const replayCloses = async () => {
        if (!window.__norvaNative?.onPlaybackClosed) return;
        try {
            for (const id of await bridge.pendingPlaybackCloses()) {
                window.__norvaNative.onPlaybackClosed(id, 'player_exited');
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
            publish(progress.get(event.sessionId));progress.delete(event.sessionId);
            hooks?.onPlaybackClosed?.(event.sessionId,event.reason);
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

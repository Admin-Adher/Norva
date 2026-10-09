// Windows uses the existing native playback/history/session lifecycle, with a
// dedicated LibVLC process for media. No DOM video element or HLS conversion.
(() => {
    const bridge = window.NorvaDesktop?.nativePlayer;
    if (bridge?.protocol !== 1) return;
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
        if (event.type === 'progress') hooks?.onProgress?.(event.sourceId,event.itemType,event.itemId,
            event.positionSeconds,event.durationSeconds,event.savedAtMs);
        if (event.type === 'closed') hooks?.onPlaybackClosed?.(event.sessionId,event.reason);
    });
    window.addEventListener('load', () => { void replayCloses(); });
    window.addEventListener('focus', () => { void replayCloses(); });
    window.addEventListener('norva:native-launch-failed', () => {
        const watch = window.app?.pages?.watch;
        void watch?.stopCloudPlaybackSessions?.();
        window.app?.showToast?.(window.NorvaI18n?.t('ui_web_0535388758c1', { defaultValue:'Playback failed' }) || 'Playback failed', 'error');
    });
})();

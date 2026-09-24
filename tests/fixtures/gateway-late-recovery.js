/* Shared by Node and the Android WebView runtime gate. No network or provider. */
async function verifyGatewayLateRecovery(WatchPage, Hls, tick) {
    for (const userPaused of [false, true]) {
        let plays = 0, waits = 0;
        const page = Object.create(WatchPage.prototype);
        Object.assign(page, {
            video: { currentTime: 12, paused: true, play() { plays++; this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } },
            _playbackAttemptId: 1,
            isGatewayPlaybackUrl: () => true,
            isStalePlaybackAttempt: id => id !== page._playbackAttemptId,
            gatewayStartupBufferOptions: () => ({ minimumSeconds: 6 }),
            gatewayRecoveryBufferOptions: () => ({ minimumSeconds: 12 }),
            waitForGatewayStartupBuffer: async () => true,
            waitForGatewayRecoveryBuffer: async () => ++waits > 1,
            gatewayBufferedAheadSeconds: () => 0,
            _reattachAiTrackIfActive() {}, updateBufferedTimeline() {}, updateAudioTracks() {},
            restorePendingAudioPreference() {}, showLoading() {}, hideLoading() {}, showOverlay() {},
        });
        const check = (value, message) => { if (!value) throw new Error(message); };
        page.playHls('/gateway/test/playlist.m3u8', { playbackAttemptId: 1 });
        const hls = page.hls;
        await hls.emit(Hls.Events.MANIFEST_PARSED, {});
        hls.emit(Hls.Events.ERROR, { fatal: false, type: Hls.ErrorTypes.MEDIA_ERROR, details: 'bufferStalledError' });
        await tick();
        check(waits === 1 && plays === 1 && page.video.paused, 'first recovery must exhaust its wait without playing');
        check(page._gatewayAutomaticRebuffering, 'automatic intent must survive the wait timeout');
        if (userPaused) { page._gatewayUserPaused = true; page._gatewayAutomaticRebuffering = false; }
        hls.emit(Hls.Events.BUFFER_APPENDED, {});
        hls.emit(Hls.Events.BUFFER_APPENDED, {});
        await tick();
        check(plays === (userPaused ? 1 : 2), 'late data must resume exactly once, unless the viewer paused');
        check(waits === (userPaused ? 1 : 2), 'duplicate appends must not schedule duplicate waits');
        page._playbackAttemptId++;
        hls.emit(Hls.Events.BUFFER_APPENDED, {});
        await tick();
        check(plays === (userPaused ? 1 : 2), 'an obsolete pipeline cannot resume');
    }
    return 'ok';
}
if (typeof module !== 'undefined') module.exports = verifyGatewayLateRecovery;

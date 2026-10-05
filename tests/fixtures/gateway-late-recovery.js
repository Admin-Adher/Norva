/* Shared by Node and the Android WebView runtime gate. No network or provider. */
async function verifyGatewayLateRecovery(WatchPage, Hls, tick) {
    // Runtime regression for the observed Bolt resume: a paused origin at zero
    // with 18 seconds buffered from 0.880333 must not wait until timeout.
    const startup = Object.create(WatchPage.prototype);
    const startupHls = { levels: [{ details: { live: true, totalduration: 100 } }] };
    Object.assign(startup, {
        video: { paused: true, currentTime: 0, readyState: 4,
            buffered: { length: 1, start: () => 0.880333, end: () => 18.899333 } },
        hls: startupHls, isStalePlaybackAttempt: () => false,
    });
    if (!await startup.waitForGatewayStartupBuffer(1, startupHls, { minimumSeconds: 6, timeoutMs: 1000 })
        || startup.video.currentTime !== 0.880333 || startup.gatewayBufferedAheadSeconds() < 6) {
        throw Error('positive initial timestamp deadlocked the startup gate');
    }
    // A Breed Apart: a fresh paused timeline begins at 3.569333, not zero.
    startup.video.played = { length: 0 };
    startup.video.currentTime = 0;
    startup.video.seekable = { length: 1, start: () => 0, end: () => 100 };
    startup.video.buffered = { length: 1, start: () => 3.569333, end: () => 100 };
    startupHls.levels[0].details = { live: true, startSN: 0,
        fragments: [{ sn: 0, start: 3.569333, duration: 2 }] };
    if (!await startup.waitForGatewayStartupBuffer(1, startupHls, { minimumSeconds: 96, timeoutMs: 1000 })
        || startup.video.currentTime !== 3.569333) {
        throw Error('attested first-fragment origin did not unblock the full reserve');
    }
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

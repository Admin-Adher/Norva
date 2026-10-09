/* Shared by Node and the Android WebView runtime gate. No network or provider. */
async function verifyGatewayLateRecovery(WatchPage, Hls, tick) {
    // Recommencer from an evicted position replaces the Gateway graph. The
    // button expresses Play intent; it must not bypass the new graph's gate.
    for (const paused of [false, true]) for (const outcome of ['ready', 'paused', 'stale', 'failed']) {
        let plays = 0, releaseGate;
        const gate = new Promise(resolve => { releaseGate = resolve; });
        const page = Object.create(WatchPage.prototype);
        Object.assign(page, {
            currentPlaybackMode: 'gateway-session', _playbackAttemptId: 1,
            _gatewayUserPaused: paused,
            video: { currentTime: 0, paused, play() { plays++; this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; } },
            canRestartForSeek: () => true,
            isGatewayPlaybackUrl: () => true,
            isStalePlaybackAttempt: id => id !== page._playbackAttemptId,
            gatewayStartupBufferOptions: () => ({ minimumSeconds: 96 }),
            waitForGatewayStartupBuffer: () => gate,
            _reattachAiTrackIfActive() {}, updateAudioTracks() {},
            restorePendingAudioPreference() {}, showLoading() {}, hideLoading() {}, showOverlay() {},
            releasePlaybackPipelineForRetry: async () => {}, showPlaybackError() {},
            async seekToTime(target) {
                if (target !== 0) throw Error('restart changed its target');
                const autoplay = this.captureGatewaySeekAutoplayIntent();
                this.video.pause();
                this.playHls('/gateway/test/playlist.m3u8', { playbackAttemptId: 1, autoplay });
            },
        });
        await page.restartFromStart();
        if (plays) throw Error('restart bypassed the replacement startup gate');
        const parsed = page.hls.emit(Hls.Events.MANIFEST_PARSED, {});
        await tick();
        if (plays) throw Error('restart played before its reserve was ready');
        if (outcome === 'paused') page._gatewayUserPaused = true;
        if (outcome === 'stale') page._playbackAttemptId++;
        releaseGate(outcome !== 'failed');
        await parsed;
        if (plays !== (outcome === 'ready' ? 1 : 0)) throw Error('restart ignored readiness or current viewer intent: ' + outcome);
    }
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
    // Internal MKV warmup must never appear before the requested local target.
    startup.video.currentTime = 0;
    startup.video.buffered = { length: 1, start: () => 0, end: () => 24 };
    startup._pendingLocalSeekTarget = 15;
    let admitted = false;
    const warmupGate = startup.waitForGatewayStartupBuffer(1, startupHls,
        { minimumSeconds: 6, timeoutMs: 1000 }).then(value => { admitted = value; return value; });
    await tick();
    if (admitted) throw Error('warmup was admitted before the requested position');
    startup.video.currentTime = 15;
    startup._pendingLocalSeekTarget = null;
    if (!await warmupGate || startup.video.currentTime !== 15) throw Error('local warmup target did not retain its reserve');

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
    const seeks = Object.create(WatchPage.prototype);
    Object.assign(seeks, { _playbackAttemptId: 10, video: { paused: false } });
    if (!seeks.captureGatewaySeekAutoplayIntent()) throw Error('playing seek lost intent');
    seeks.video.paused = true; // release of the old lane, not a viewer action
    if (!seeks.captureGatewaySeekAutoplayIntent()) throw Error('successive seek lost play intent');
    seeks._gatewayUserPaused = true;
    if (seeks.captureGatewaySeekAutoplayIntent()) throw Error('seek overrode viewer pause');
    seeks._gatewayUserPaused = false;
    seeks._playbackAttemptId++;
    if (seeks.captureGatewaySeekAutoplayIntent()) throw Error('new title inherited old play intent');
    seeks._gatewayPendingSeekIntent = null;
    seeks._gatewayAutomaticRebuffering = true;
    if (!seeks.captureGatewaySeekAutoplayIntent()) throw Error('buffer recovery seek lost intent');
    // Actual Android WebView execution of the fresh positive-preroll gate.
    const began = Date.now();
    startup.video.currentTime = 15;
    startup.video.played = { length: 0 };
    startup.video.buffered = { length: 1, start: () => 0,
        end: () => 21 + 4 * Math.floor((Date.now() - began) / 400) };
    startup.video.videoWidth = 1920;
    startupHls.levels[0].details.fragments = [0,1,2].map(sn => ({sn, start: sn * 2, duration: 2}));
    if (!await startup.waitForGatewayStartupBuffer(1, startupHls,
        { minimumSeconds: 96, adaptive: true, timeoutMs: 4000 })
        || !(startup._gatewayStartupAdaptiveEvidence?.rateX >= 2)) throw Error('fresh preroll cannot earn growth proof');
    const shortPolicy = { protocol: 2, eligible: false, pipeline: 'video-transcode', targetBufferSeconds: null,
        minimumEncodeRateX: 2, observedEncodeRateX: 20, reason: 'encode-rate-observation-too-short' };
    const observedOptions = startup.gatewayStartupBufferOptions(shortPolicy);
    if (!observedOptions.sustainedObservation || !observedOptions.adaptive) throw Error('brief burst bypasses observation');
    const observedAt = Date.now();
    startup.video.buffered.end = () => 21 + 2 * Math.floor((Date.now() - observedAt) / 400);
    if (!await startup.waitForGatewayStartupBuffer(1, startupHls, { ...observedOptions, timeoutMs: 8500 })
        || startup._gatewayStartupAdaptiveEvidence?.elapsedMs < 6000) throw Error('brief burst admitted too soon');
    startup.video.buffered.end = () => 45;
    if (await startup.waitForGatewayStartupBuffer(1, startupHls, { ...observedOptions, timeoutMs: 1500 })) {
        throw Error('stationary burst admitted');
    }
    startup.video.buffered.end = () => 111;
    if (!await startup.waitForGatewayStartupBuffer(1, startupHls, { ...observedOptions, timeoutMs: 1000 })) {
        throw Error('resident reserve delayed');
    }
    startup.contentType = 'series'; startup.currentCloudPlaybackSessionId = 'fixture';
    startup.streamStartOffset = 300; startup.video.videoWidth = 1920;
    if (startup.captureCloudResumePosition() !== 315) throw Error('resume clock lost its absolute origin');
    const feedback = Object.create(WatchPage.prototype);
    Object.assign(feedback, { video: { currentTime: 15, paused: false, seeking: false, readyState: 4 },
        _firstFrameReported: true, _rebufferPresentationActive: true, _rebufferMediaTime: 171,
        hasCurrentMedia: () => true, _playbackStatusOkReported: true,
        hideLoading() { this._rebufferPresentationActive = false; }, hidePlaybackError() {}, reportObservedAudioLanguages() {} });
    feedback.markPlaybackUsable({ allowPlaybackProgressFallback: true });
    if (!feedback._rebufferPresentationActive) throw Error('a seek alone dismissed loading');
    feedback.video.currentTime = 15.25;
    feedback.markPlaybackUsable({ allowPlaybackProgressFallback: true });
    if (feedback._rebufferPresentationActive) throw Error('old stall clock masked progressing video');
    return 'ok';
}
if (typeof module !== 'undefined') module.exports = verifyGatewayLateRecovery;

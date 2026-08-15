const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const watchSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'WatchPage.js'), 'utf8');

function makeErrorDom() {
    const classes = new Set(['hidden']);
    const errorEl = {
        id: 'watch-error',
        className: 'watch-error hidden',
        innerHTML: '',
        attributes: {},
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
            contains: (name) => classes.has(name),
        },
        setAttribute(name, value) { this.attributes[name] = value; },
    };
    const refreshButton = { addEventListener() {} };
    const document = {
        getElementById(id) {
            if (id === 'watch-error') return errorEl;
            if (id === 'watch-error-refresh-btn') return refreshButton;
            return null;
        },
        createElement: () => errorEl,
        querySelector: () => ({ appendChild() {} }),
    };
    return { document, errorEl };
}

function loadWatchPage(options = {}) {
    const context = {
        window: options.window || {},
        document: options.document,
        console,
        setTimeout: options.setTimeout || setTimeout,
        clearTimeout,
    };
    vm.runInNewContext(watchSource, context, { filename: 'WatchPage.js' });
    return context.window.WatchPage;
}

test('startup provider busy keeps one persisted engine failure across Engine report and load catch', async () => {
    for (const stage of ['startup:provider-busy', 'pump:startup']) {
      for (const mediaActive of [false, true]) {
        const calls = {
            playbackErrors: 0,
            providerEvents: 0,
            releases: 0,
            spinnerHidden: 0,
            engineLoads: 0,
            engineDestroys: 0,
            gateway: 0,
        };
        const terminalError = new Error('BLOCK_HTTP_458:provider slot busy');
        Object.defineProperties(terminalError, {
            _norvaPlaybackFailureReported: { value: true, configurable: true },
            _norvaPlaybackFailureReportStage: { value: stage, configurable: true },
        });

        let createdOptions = null;
        class FakeNorvaEngine {
            constructor(_video, options) {
                createdOptions = options;
                this.vName = 'h264';
                this.aName = 'aac';
            }
            async load() {
                calls.engineLoads += 1;
                createdOptions.report({ stage, message: terminalError.message });
                throw terminalError;
            }
            destroy() { calls.engineDestroys += 1; }
            engineSnapshot() { return null; }
        }

        const dom = makeErrorDom();
        const WatchPage = loadWatchPage({
            window: { NorvaEngine: FakeNorvaEngine },
            document: dom.document,
            setTimeout: () => 1,
        });
        const page = Object.create(WatchPage.prototype);
        page.video = {};
        page.hls = null;
        page.norvaEngine = null;
        page._playbackAttemptId = 91;
        page._handlingPlaybackFailure = false;
        page._diagCodecProfile = null;
        page.currentStreamInfo = { video: 'h264' };
        page.containerExtension = 'mkv';
        page.currentCloudPlaybackSessionId = 'session-redacted';
        page._inbandSubsEnabled = () => false;
        page.updateTranscodeStatus = () => {};
        page.isProviderBusyError = (value) => /(?:BLOCK_HTTP_458|\b458\b)/i.test(String(value || ''));
        page.isConnectionLimitError = () => false;
        page.isPlaybackSupersededError = () => false;
        page.isStalePlaybackAttempt = () => false;
        page.isCloudPlaybackMode = () => true;
        page.hasCurrentMedia = () => mediaActive;
        page.sanitizePlaybackMessage = (value) => String(value || '');
        page.getFriendlyPlaybackError = (value) => value;
        page.providerAccountConflictCopy = () => ({
            title: 'Provider busy', message: 'Provider busy', hint: 'Try later', retry: 'Retry',
        });
        page.escapeHtml = (value) => String(value || '');
        page.clearDeferredPlaybackError = () => {};
        page.clearPlaybackErrorRefreshTimer = () => {};
        page.shouldDeferPlaybackError = () => false;
        page.hideLoading = () => { calls.spinnerHidden += 1; };
        page.markPlaybackUsable = () => {};
        page.sendPlaybackEvent = (type) => {
            if (type === 'playback_error') calls.playbackErrors += 1;
        };
        page.reportProviderPlaybackFailure = async (reason) => {
            calls.providerEvents += 1;
            assert.strictEqual(reason, terminalError.message);
        };
        page.releasePlaybackPipelineForRetry = async () => { calls.releases += 1; };
        page.fallbackEngineToTranscode = async () => { calls.gateway += 1; return true; };
        page.destroyEngine = () => {
            const engine = page.norvaEngine;
            page.norvaEngine = null;
            if (engine) engine.destroy();
        };

        await page.playWithEngine('https://media.invalid/startup-458.mkv', {
            startTime: 132,
            playbackAttemptId: 91,
        });

        const label = `${stage}/${mediaActive ? 'active-media' : 'empty-media'}`;
        assert.strictEqual(calls.engineLoads, 1, `${label}: no engine retry`);
        assert.strictEqual(calls.playbackErrors, 1, `${label}: one persisted playback_error`);
        assert.strictEqual(calls.providerEvents, 1, `${label}: one provider circuit event`);
        assert.strictEqual(calls.releases, 1, `${label}: one terminal pipeline release`);
        assert.strictEqual(calls.spinnerHidden, 1, `${label}: terminal UI stops the spinner`);
        assert.strictEqual(dom.errorEl.classList.contains('hidden'), false,
            `${label}: provider-busy UI stays visible even with buffered media`);
        assert.strictEqual(calls.engineDestroys, 1, `${label}: one active engine cleanup`);
        assert.strictEqual(calls.gateway, 0, `${label}: no gateway fallback`);
      }
    }
});

test('startup timeout owns one failure, releases one cloud lane, and offers explicit conversion', async () => {
  for (const engineReportSucceeded of [true, false]) {
    for (const mediaActive of [false, true]) {
        const calls = {
            playbackErrors: 0,
            releases: 0,
            spinnerHidden: 0,
            engineLoads: 0,
            engineDestroys: 0,
            gateway: 0,
            videoPauses: 0,
            videoLoads: 0,
            videoSrcRemovals: 0,
            transcodeStops: 0,
            cloudStops: 0,
            teardownMediaErrors: 0,
        };
        const terminalError = new Error('ENGINE_STARTUP_TIMEOUT:global:15000');
        terminalError.code = 'ENGINE_STARTUP_TIMEOUT';
        if (engineReportSucceeded) {
            Object.defineProperties(terminalError, {
                _norvaPlaybackFailureReported: { value: true, configurable: true },
                _norvaPlaybackFailureReportStage: { value: 'startup:global', configurable: true },
            });
        }

        let createdOptions = null;
        class FakeNorvaEngine {
            constructor(_video, options) {
                createdOptions = options;
                this.vName = 'h264';
                this.aName = 'aac';
            }
            async load() {
                calls.engineLoads += 1;
                if (engineReportSucceeded) {
                    createdOptions.report({ stage: 'startup:global', message: terminalError.message });
                }
                throw terminalError;
            }
            destroy() { calls.engineDestroys += 1; }
            engineSnapshot() { return null; }
        }

        const dom = makeErrorDom();
        const WatchPage = loadWatchPage({
            window: { NorvaEngine: FakeNorvaEngine },
            document: dom.document,
            setTimeout: () => 1,
        });
        const page = Object.create(WatchPage.prototype);
        page.video = {
            currentTime: 63,
            readyState: 2,
            paused: false,
            src: 'blob:engine-media',
            pause() { calls.videoPauses += 1; this.paused = true; },
            removeAttribute(name) {
                if (name === 'src') {
                    calls.videoSrcRemovals += 1;
                    delete this.src;
                }
            },
            load() {
                calls.videoLoads += 1;
                this.readyState = 0;
            },
        };
        page.hls = null;
        page.norvaEngine = null;
        page._playbackAttemptId = 92;
        page._handlingPlaybackFailure = false;
        page._diagCodecProfile = null;
        page._preferredExplicitCloudMode = null;
        page.currentStreamInfo = { video: 'h264' };
        page.containerExtension = 'mkv';
        page.currentCloudPlaybackSessionId = 'session-redacted';
        page.content = { type: 'movie', sourceId: 'source-redacted', id: 'title-redacted' };
        page._inbandSubsEnabled = () => false;
        page.updateTranscodeStatus = () => {};
        page.isProviderBusyError = () => false;
        page.isConnectionLimitError = () => false;
        page.isPlaybackSupersededError = () => false;
        page.isStalePlaybackAttempt = () => false;
        page.isCloudPlaybackMode = () => true;
        page.hasOpenedCloudPlaybackLaneForAttempt = () => true;
        page.hasCurrentMedia = () => mediaActive;
        page.sanitizePlaybackMessage = (value) => String(value || '');
        page.getFriendlyPlaybackError = (value) => value;
        page.cloudTranscodeRecoveryCopy = () => ({
            title: 'Server conversion required',
            message: 'The first lane was released.',
            hint: 'Start one new lane explicitly.',
            retry: 'Convert and play',
        });
        page.escapeHtml = (value) => String(value || '');
        page.clearDeferredPlaybackError = () => {};
        page.clearPlaybackErrorRefreshTimer = () => {};
        page.shouldDeferPlaybackError = () => false;
        page.hidePlaybackError = () => {};
        page.hideLoading = () => { calls.spinnerHidden += 1; };
        page.markPlaybackUsable = () => {};
        page.sendPlaybackEvent = (type) => {
            if (type === 'playback_error') calls.playbackErrors += 1;
        };
        page.stopTranscodeSession = async () => { calls.transcodeStops += 1; };
        page.stopCloudPlaybackSessions = async () => { calls.cloudStops += 1; };
        const releasePlaybackPipelineForRetry = page.releasePlaybackPipelineForRetry.bind(page);
        page.releasePlaybackPipelineForRetry = async () => {
            calls.releases += 1;
            return releasePlaybackPipelineForRetry();
        };
        page.fallbackEngineToTranscode = async () => { calls.gateway += 1; return true; };
        page.destroyEngine = () => {
            const engine = page.norvaEngine;
            page.norvaEngine = null;
            if (engine) engine.destroy();
        };

        await page.playWithEngine('https://media.invalid/project-resume.mkv', {
            startTime: 63,
            playbackAttemptId: 92,
        });

        const label = `${engineReportSucceeded ? 'engine-owned' : 'outer-fallback'}/`
            + (mediaActive ? 'partial-media' : 'empty-media');
        assert.strictEqual(calls.engineLoads, 1, `${label}: no engine retry`);
        assert.strictEqual(calls.playbackErrors, 1, `${label}: one persisted playback_error`);
        assert.strictEqual(calls.releases, 1, `${label}: one terminal cloud-lane release`);
        assert.strictEqual(calls.engineDestroys, 1, `${label}: one engine cleanup`);
        assert.strictEqual(calls.gateway, 0, `${label}: no automatic second lane`);
        assert.strictEqual(calls.videoPauses, 1, `${label}: media element paused once`);
        assert.strictEqual(calls.videoSrcRemovals, 1, `${label}: media source removed once`);
        assert.strictEqual(calls.videoLoads, 1, `${label}: media element reset once`);
        assert.strictEqual(page.video.src, undefined, `${label}: no stale media URL remains`);
        assert.strictEqual(page.video.readyState, 0, `${label}: media element is empty after release`);
        assert.strictEqual(page.video.paused, true, `${label}: media element remains paused`);
        assert.strictEqual(page.video.currentTime, 63,
            `${label}: a residual currentTime is harmless once src and readyState are cleared`);
        assert.strictEqual(calls.transcodeStops, 1, `${label}: transcode cleanup runs once`);
        assert.strictEqual(calls.cloudStops, 1, `${label}: cloud-session cleanup runs once`);
        assert.strictEqual(calls.spinnerHidden, 1, `${label}: terminal UI stops the spinner`);
        assert.strictEqual(dom.errorEl.classList.contains('hidden'), false,
            `${label}: timeout UI remains visible even if a partial buffer exists`);
        assert.match(dom.errorEl.innerHTML, /Convert and play/,
            `${label}: recovery must require an explicit server-conversion action`);
        page.handleEngineRuntimeFailure = async () => { calls.teardownMediaErrors += 1; };
        page.video.error = { code: 3, message: 'late teardown decode error' };
        page.onError({});
        await Promise.resolve();
        assert.strictEqual(calls.teardownMediaErrors, 0,
            `${label}: a source-less teardown MediaError must not reopen recovery or telemetry`);
    }
  }
});

test('local startup timeout keeps one report and hands the exact resume point to one gateway fallback', async () => {
    for (const engineReportSucceeded of [true, false]) {
        const calls = {
            playbackErrors: 0,
            engineLoads: 0,
            engineDestroys: 0,
            gateway: 0,
            terminalHandles: 0,
        };
        const timeoutError = new Error('ENGINE_STARTUP_TIMEOUT:global:15000');
        timeoutError.code = 'ENGINE_STARTUP_TIMEOUT';
        if (engineReportSucceeded) {
            Object.defineProperties(timeoutError, {
                _norvaPlaybackFailureReported: { value: true, configurable: true },
                _norvaPlaybackFailureReportStage: { value: 'startup:global', configurable: true },
            });
        }

        let createdOptions = null;
        class FakeNorvaEngine {
            constructor(_video, options) {
                createdOptions = options;
                this.vName = 'h264';
                this.aName = 'aac';
            }
            async load() {
                calls.engineLoads += 1;
                if (engineReportSucceeded) {
                    createdOptions.report({ stage: 'startup:global', message: timeoutError.message });
                }
                throw timeoutError;
            }
            destroy() { calls.engineDestroys += 1; }
            engineSnapshot() { return null; }
        }

        const dom = makeErrorDom();
        const WatchPage = loadWatchPage({
            window: { NorvaEngine: FakeNorvaEngine },
            document: dom.document,
        });
        const page = Object.create(WatchPage.prototype);
        page.video = {};
        page.hls = null;
        page.norvaEngine = null;
        page._playbackAttemptId = 93;
        page._diagCodecProfile = null;
        page.currentStreamInfo = { video: 'h264' };
        page.containerExtension = 'mkv';
        page._inbandSubsEnabled = () => false;
        page.updateTranscodeStatus = () => {};
        page.isProviderBusyError = () => false;
        page.isConnectionLimitError = () => false;
        page.isPlaybackSupersededError = () => false;
        page.isStalePlaybackAttempt = () => false;
        page.isCloudPlaybackMode = () => false;
        page.sendPlaybackEvent = (type) => {
            if (type === 'playback_error') calls.playbackErrors += 1;
        };
        page.destroyEngine = () => {
            const engine = page.norvaEngine;
            page.norvaEngine = null;
            if (engine) engine.destroy();
        };
        page.fallbackEngineToTranscode = async (attemptId, startTime) => {
            calls.gateway += 1;
            assert.strictEqual(attemptId, 93);
            assert.strictEqual(startTime, 63);
            return true;
        };
        page.handlePlaybackFailure = async () => { calls.terminalHandles += 1; };

        await page.playWithEngine('https://media.invalid/local-project-resume.mkv', {
            startTime: 63,
            playbackAttemptId: 93,
        });

        const label = engineReportSucceeded ? 'engine-owned' : 'outer-fallback';
        assert.strictEqual(calls.playbackErrors, 1, `${label}: exactly one report persists`);
        assert.strictEqual(calls.engineLoads, 1, `${label}: engine is not retried`);
        assert.strictEqual(calls.engineDestroys, 1, `${label}: failed engine is destroyed once`);
        assert.strictEqual(calls.gateway, 1, `${label}: one local gateway fallback receives resume=63`);
        assert.strictEqual(calls.terminalHandles, 0,
            `${label}: a successful local fallback must not surface a competing terminal path`);
    }
});

test('a post-startup engine 458 stops playback and surfaces one terminal error without retry or gateway', async () => {
    const dom = makeErrorDom();
    const WatchPage = loadWatchPage({ document: dom.document, setTimeout: () => 1 });
    const page = Object.create(WatchPage.prototype);
    const calls = {
        destroyed: 0,
        released: 0,
        playbackErrors: 0,
        spinnerHidden: 0,
        reported: 0,
        retried: 0,
        gateway: 0,
    };

    page._playbackAttemptId = 73;
    page._engineRuntimeRecoveryAttemptId = null;
    page._handlingPlaybackFailure = false;
    page.currentPlaybackMode = 'engine';
    page.currentCloudPlaybackSessionId = 'session-redacted';
    page.norvaEngine = {
        engineSnapshot: () => ({ looksLikeMpegTs: false }),
        destroy: () => { calls.destroyed += 1; },
    };
    // This deliberately models the post-startup state: usable media still exists
    // when the provider rejects the next byte range.
    page.hasCurrentMedia = () => true;
    page.isStalePlaybackAttempt = () => false;
    page.isPlaybackSupersededError = () => false;
    page.isCloudPlaybackMode = () => true;
    page.getPlaybackPosition = () => 42;
    page.getResumeSnapshotPosition = () => 42;
    page.trackPlaybackPosition = () => {};
    page.saveResumeSnapshotThrottled = () => {};
    page.sendPlaybackEvent = (type) => {
        if (type === 'playback_error') calls.playbackErrors += 1;
    };
    page.reportProviderPlaybackFailure = async () => { calls.reported += 1; };
    page.releasePlaybackPipelineForRetry = async () => { calls.released += 1; };
    page.isConnectionLimitError = () => false;
    page.sanitizePlaybackMessage = (value) => String(value || '');
    page.getFriendlyPlaybackError = (value) => value;
    page.providerAccountConflictCopy = () => ({
        title: 'Provider busy', message: 'Provider busy', hint: 'Try later', retry: 'Retry',
    });
    page.escapeHtml = (value) => String(value || '');
    page.clearDeferredPlaybackError = () => {};
    page.clearPlaybackErrorRefreshTimer = () => {};
    page.shouldDeferPlaybackError = () => false;
    page.hideLoading = () => { calls.spinnerHidden += 1; };
    page.updateTranscodeStatus = () => {};
    page.markPlaybackUsable = () => {};
    page.playWithEngine = async () => { calls.retried += 1; };
    page.fallbackEngineToTranscode = async () => { calls.gateway += 1; return true; };

    page.reportEngineFailure({ stage: 'pump:provider-busy', message: 'BLOCK_HTTP_458' });

    const first = page.handleEngineRuntimeFailure(new Error('BLOCK_HTTP_458'), 73, {
        alreadyReported: true,
    });
    const duplicate = page.handleEngineRuntimeFailure(new Error('BLOCK_HTTP_458'), 73, {
        alreadyReported: true,
    });
    const [handled, deduplicated] = await Promise.all([first, duplicate]);

    assert.strictEqual(handled, true);
    assert.strictEqual(deduplicated, true);
    assert.strictEqual(calls.destroyed, 1, 'the active engine must stop exactly once');
    assert.strictEqual(calls.playbackErrors, 1, 'the Engine-owned runtime report must not be duplicated');
    assert.strictEqual(calls.reported, 1, 'the provider circuit must receive one failure signal');
    assert.strictEqual(calls.released, 1, 'the active media/provider session must be released once');
    assert.strictEqual(calls.spinnerHidden, 1, 'the terminal provider-busy UI must stop loading');
    assert.strictEqual(dom.errorEl.classList.contains('hidden'), false,
        'forceTerminal must keep the provider-busy UI visible over buffered media');
    assert.strictEqual(calls.retried, 0, 'HTTP 458 must not reopen the browser engine');
    assert.strictEqual(calls.gateway, 0, 'HTTP 458 must not cascade into Gateway');
});

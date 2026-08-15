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

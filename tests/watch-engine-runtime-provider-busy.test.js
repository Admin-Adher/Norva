const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const watchSource = fs.readFileSync(path.join(ROOT, 'public', 'js', 'pages', 'WatchPage.js'), 'utf8');

function loadWatchPage() {
    const context = {
        window: {},
        console,
        setTimeout,
        clearTimeout,
    };
    vm.runInNewContext(watchSource, context, { filename: 'WatchPage.js' });
    return context.window.WatchPage;
}

test('a post-startup engine 458 stops playback and surfaces one terminal error without retry or gateway', async () => {
    const WatchPage = loadWatchPage();
    const page = Object.create(WatchPage.prototype);
    const calls = {
        destroyed: 0,
        released: 0,
        shown: 0,
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
    page.sendPlaybackEvent = () => {};
    page.reportProviderPlaybackFailure = async () => { calls.reported += 1; };
    page.releasePlaybackPipelineForRetry = async () => { calls.released += 1; };
    page.showPlaybackError = (message, options) => {
        calls.shown += 1;
        page.visibleError = { message, options };
    };
    page.playWithEngine = async () => { calls.retried += 1; };
    page.fallbackEngineToTranscode = async () => { calls.gateway += 1; return true; };

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
    assert.strictEqual(calls.reported, 1, 'the provider circuit must receive one failure signal');
    assert.strictEqual(calls.released, 1, 'the active media/provider session must be released once');
    assert.strictEqual(calls.shown, 1, 'the terminal provider-busy UI must appear exactly once');
    assert.strictEqual(page.visibleError.message, 'BLOCK_HTTP_458');
    assert.strictEqual(page.visibleError.options.immediate, true);
    assert.strictEqual(calls.retried, 0, 'HTTP 458 must not reopen the browser engine');
    assert.strictEqual(calls.gateway, 0, 'HTTP 458 must not cascade into Gateway');
});

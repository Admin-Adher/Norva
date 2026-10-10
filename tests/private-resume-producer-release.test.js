'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
const released = source.slice(source.indexOf('function privateResumeProducerReleased('),
    source.indexOf('function privateResumeHlsBindingForSession('));
const stop = source.slice(source.indexOf('async function stopSession('),
    source.indexOf('function touchViewerSessionClientAccess('));

function fixture(abandonState = 'abandoned') {
    const events = [], session = { id: 'fixture', status: 'ready', mediaCacheProducer: {},
        privateResumeStopPosition: 10, outputDir: 'fixture', ffmpeg: {},
        hlsOutputAdmission: { stop: async () => events.push('output-drained') } };
    const context = { console: { warn() {} }, sessions: new Map([[session.id, session]]),
        retainedSessionTransfer: { forget() {} },
        closePreopenedBoundedMkvInput: async () => events.push('preopen-drained'),
        stopBoundedMkvInputPump: async () => events.push('pump-drained'),
        stopFiniteMkvLinearSeekBridge: async () => {}, anchorFiniteResumeRangeAtStop() {},
        closeFiniteMkvSeekBroker: async () => events.push('broker-drained'),
        stopChildProcess: async () => events.push('encoder-drained'),
        releaseVideoEncoderAdmission: () => events.push('encoder-released'),
        mediaCacheProducerControl: { detach: () => events.push('detached'), abandon: async s => {
            events.push('abandon');
            if (abandonState === 'error') throw new Error('unavailable');
            s.mediaCacheProducerAbandoned = abandonState === 'abandoned';
            s.mediaCacheProducerCompleted = abandonState === 'completed';
            return abandonState;
        } },
        capturePrivateResumeWindow: async s => events.push(context.privateResumeProducerReleased(s)
            ? 'capture-allowed' : 'capture-refused'),
        capturePrivateStartupWindow: async () => false,
        wakePlaybackBlockedQueues() {}, removeSessionDir: async () => events.push('directory-removed') };
    vm.createContext(context); vm.runInContext(released + stop, context);
    return { context, session, events };
}

test('shared producer teardown drains and abandons before owner-private capture', async () => {
    const { context, session, events } = fixture();
    assert.equal(context.privateResumeProducerReleased(session), false);
    await context.stopSession(session);
    assert.ok(events.indexOf('pump-drained') < events.indexOf('abandon'));
    assert.ok(events.indexOf('encoder-drained') < events.indexOf('abandon'));
    assert.ok(events.indexOf('abandon') < events.indexOf('capture-allowed'));
    assert.ok(events.indexOf('capture-allowed') < events.indexOf('directory-removed'));
    assert.equal(session.status, 'ended');
    assert.equal(context.sessions.size, 0);
    assert.equal(context.privateResumeProducerReleased(session), false, 'ended context cannot become a new capture grant');
});

test('publication settles before abandonment and cannot race private capture', async () => {
    const { context, session, events } = fixture();
    let finish;
    session.sharedMediaCachePublicationPromise = new Promise(resolve => { finish = resolve; });
    session.sharedMediaCachePublicationPending = true;
    const stopping = context.stopSession(session);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.includes('encoder-released'));
    assert.ok(!events.includes('abandon'));
    assert.ok(!events.includes('capture-allowed'));
    session.mediaCacheProducerCompleted = true;
    session.sharedMediaCachePublicationPending = false;
    finish(); await stopping;
    assert.ok(!events.includes('abandon'));
    assert.ok(events.includes('capture-refused'));
});

test('missing, completed or failed abandonment never authorizes private producer capture', async () => {
    for (const state of ['missing', 'completed', 'error']) {
        const { context, session, events } = fixture(state);
        await context.stopSession(session);
        assert.ok(events.includes('capture-refused'), state);
        assert.ok(!events.includes('capture-allowed'), state);
        assert.equal(context.sessions.size, 0, 'failed cache capture must not leak playback resources');
    }
});

test('producer acknowledgement applies only to stopping unpublished work', () => {
    const { context, session } = fixture();
    session.mediaCacheProducerAbandoned = true;
    assert.equal(context.privateResumeProducerReleased(session), false);
    session.status = 'stopping';
    assert.equal(context.privateResumeProducerReleased(session), true);
    session.sharedMediaCachePublicationPending = true;
    assert.equal(context.privateResumeProducerReleased(session), false);
    assert.equal(context.privateResumeProducerReleased({}), true, 'ordinary private path unchanged');
});

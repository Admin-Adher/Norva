const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    MAX_VAD_OUTPUT_BYTES, parseStrictLidVadSegments, runStrictLidVadProcess, prepareStrictLidSpeechSample,
} = require('../services/media-gateway/src/strict-lid-speech-sampler');
const { analyzePcm16Wav } = require('../services/media-gateway/src/strict-lid-audio-evidence');
const { planStrictSpeechWindow } = require('../services/media-gateway/src/strict-lid-speech-window');

function output(segments) {
    return `\nDetected ${segments.length} speech segments:\n${segments.map(([start, end], index) => `Speech segment ${index}: start = ${(start * 100).toFixed(2)}, end = ${(end * 100).toFixed(2)}`).join('\n')}\n`;
}

function childFixture({ closeOnKill = true } = {}) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    child.kill = (signal) => {
        child.kills.push(signal);
        if (closeOnKill) queueMicrotask(() => child.emit('close', null));
        return true;
    };
    return child;
}

const processInput = { bin: '/local/whisper-vad-speech-segments', model: '/local/silero.bin', wavPath: '/local/sample.wav', timeoutMs: 500, killGraceMs: 10 };

function wave(seconds = 60) {
    const samples = Math.round(seconds * 16000);
    const result = Buffer.alloc(44 + samples * 2);
    result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4);
    result.write('WAVEfmt ', 8); result.writeUInt32LE(16, 16);
    result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
    result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28);
    result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
    result.write('data', 36); result.writeUInt32LE(samples * 2, 40);
    for (let index = 0; index < samples; index++) result.writeInt16LE(1 + Math.floor(index / 16000), 44 + index * 2);
    return result;
}

async function wavFixture(t, seconds = 60) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'norva-strict-vad-test-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('norva-strict-vad-test-'));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const wavPath = path.join(directory, 'sample.wav');
    const bytes = wave(seconds);
    await fs.writeFile(wavPath, bytes);
    return { wavPath, bytes, plan: planStrictSpeechWindow(7200, 2) };
}

test('pinned standalone VAD parser converts centiseconds to seconds and accepts zero segments', () => {
    assert.deepEqual(parseStrictLidVadSegments(output([[0.1234, 2.5678], [30, 50]])), [
        { start: 0.1234, end: 2.5678 }, { start: 30, end: 50 },
    ]);
    assert.deepEqual(parseStrictLidVadSegments('\nDetected 0 speech segments:\n\n'), []);
    assert.ok(Object.isFrozen(parseStrictLidVadSegments(output([[1, 2]]))));
});

test('VAD parser rejects malformed, mismatched, foreign, overflow or ambiguous output', () => {
    const valid = output([[1, 2]]);
    const invalid = [
        '', null, Buffer.from(valid), 'private URL',
        valid.replace('Detected 1', 'Detected 2'), valid.replace('segment 0:', 'segment 1:'),
        valid.replace('100.00', '-100.00'), valid.replace('100.00', 'NaN'),
        valid.replace('200.00', 'Infinity'), valid.replace('200.00', '1.00'),
        valid.replace('100.00', '100'), valid.replace('100.00', '1e2'),
        `${valid}\nsecret extra log`, `${valid}${valid}`, output([[0, 91]]), output([[1, 1]]),
        `Detected 2049 speech segments:\n`, ' '.repeat(MAX_VAD_OUTPUT_BYTES + 1),
        'Detected 01 speech segments:\nSpeech segment 0: start = 100.00, end = 200.00',
    ];
    for (const value of invalid) assert.equal(parseStrictLidVadSegments(value), null);
});

test('VAD process uses CPU two threads, safe argv, stdout-only evidence, and waits for close', async () => {
    const child = childFixture();
    let finished = false;
    let hookCalled = false;
    const promise = runStrictLidVadProcess({ ...processInput,
        onSpawn: (actual) => { assert.equal(actual, child); hookCalled = true; },
        spawnImpl: (bin, args, options) => {
            assert.equal(bin, processInput.bin);
            assert.deepEqual(args, ['-np', '-vm', processInput.model, '-f', processInput.wavPath, '-t', '2']);
            assert.equal(options.windowsHide, true);
            assert.equal(options.shell, undefined);
            return child;
        },
    }).then((result) => { finished = true; return result; });
    child.stdout.write(output([[12, 30]]));
    child.stderr.write('private file path, ignored');
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(hookCalled, true);
    child.emit('exit', 0);
    await Promise.resolve();
    assert.equal(finished, false);
    child.emit('close', 0);
    const result = await promise;
    assert.equal(result.ok, true);
    assert.deepEqual(result.segments, [{ start: 12, end: 30 }]);
    assert.ok(!JSON.stringify(result).includes('private'));
});

test('VAD never accepts a report from stderr or a nonzero exit', async () => {
    for (const [stream, exitCode, expected] of [['stderr', 0, 'invalid-output'], ['stdout', 2, 'failed']]) {
        const child = childFixture();
        const promise = runStrictLidVadProcess({ ...processInput, spawnImpl: () => child });
        child[stream].write(output([[1, 2]]));
        child.emit('close', exitCode);
        const result = await promise;
        assert.equal(result.ok, false);
        assert.equal(result.outcome, expected);
        assert.equal(result.segments, null);
    }
});

test('VAD output cap counts both streams, kills the process, and discards partial evidence', async () => {
    const child = childFixture();
    const promise = runStrictLidVadProcess({ ...processInput, spawnImpl: () => child });
    child.stdout.write(output([[1, 2]]));
    child.stderr.write(Buffer.alloc(MAX_VAD_OUTPUT_BYTES));
    const result = await promise;
    assert.equal(result.outcome, 'output-limit');
    assert.equal(result.ok, false);
    assert.equal(result.segments, null);
    assert.deepEqual(child.kills, ['SIGKILL']);
});

test('VAD timeout waits bounded kill grace, including a child that never closes', async () => {
    const child = childFixture({ closeOnKill: false });
    const start = Date.now();
    const result = await runStrictLidVadProcess({ ...processInput, timeoutMs: 5, killGraceMs: 10, spawnImpl: () => child });
    assert.equal(result.outcome, 'timed-out');
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.ok(Date.now() - start < 5000);
    child.stdout.write(output([[1, 2]]));
    child.emit('close', 0);
});

test('VAD cancellation and preemption always block otherwise successful output', async () => {
    const controller = new AbortController();
    const child = childFixture({ closeOnKill: false });
    const promise = runStrictLidVadProcess({ ...processInput, abortSignal: controller.signal, spawnImpl: () => child });
    child.stdout.write(output([[1, 2]]));
    controller.abort();
    child.emit('close', 0);
    const aborted = await promise;
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.ok, false);
    const preemptChild = childFixture();
    let preempted = false;
    const pending = runStrictLidVadProcess({ ...processInput, isPreempted: () => preempted, spawnImpl: () => preemptChild });
    preempted = true;
    const result = await pending;
    assert.equal(result.preempted, true);
    assert.equal(result.ok, false);
    assert.deepEqual(preemptChild.kills, ['SIGKILL']);
});

test('VAD pre-cancel, missing configuration, spawn errors and spawn hook failure are sanitized', async () => {
    const controller = new AbortController(); controller.abort();
    assert.equal((await runStrictLidVadProcess({ ...processInput, abortSignal: controller.signal, spawnImpl: () => assert.fail() })).aborted, true);
    assert.equal((await runStrictLidVadProcess({ ...processInput, isPreempted: () => true, spawnImpl: () => assert.fail() })).preempted, true);
    assert.equal((await runStrictLidVadProcess({ ...processInput, model: '', spawnImpl: () => assert.fail() })).outcome, 'unavailable');
    const failed = await runStrictLidVadProcess({ ...processInput, spawnImpl: () => { throw new Error('http://credentials'); } });
    assert.equal(failed.outcome, 'failed');
    assert.ok(!JSON.stringify(failed).includes('credentials'));
    const child = childFixture();
    const hook = await runStrictLidVadProcess({ ...processInput, spawnImpl: () => child, onSpawn: () => { throw new Error('private path'); } });
    assert.equal(hook.outcome, 'failed');
    assert.deepEqual(child.kills, ['SIGKILL']);
});

test('sampler selects and writes exactly one 20-second local spoken clip with receipt coordinates', async (t) => {
    const fixture = await wavFixture(t);
    const result = await prepareStrictLidSpeechSample({ ...fixture, bin: '/bin/vad', model: '/model',
        runVadImpl: async (options) => {
            assert.equal(options.wavPath, fixture.wavPath);
            return { ok: true, outcome: 'succeeded', segments: [{ start: 30, end: 50 }] };
        },
    });
    assert.equal(result.ok, true);
    assert.equal(result.offset, fixture.plan.searchStartSeconds + 30);
    assert.equal(result.selection.selector, 'silero-vad-max-speech-v1');
    assert.equal(result.selection.speechMilliseconds, 20000);
    assert.equal(result.selection.selectedDurationMilliseconds, 20000);
    assert.equal(result.selection.searchStartMilliseconds, fixture.plan.searchStartMilliseconds);
    assert.equal(result.diagnostic.vadOutcome, 'succeeded');
    assert.equal(result.diagnostic.durationSeconds, 60);
    assert.equal(result.diagnostic.selectionStartSeconds, 30);
    assert.equal(result.diagnostic.selectionSpeechSeconds, 20);
    assert.equal(result.diagnostic.repetitionRatio, null);
    const cropped = await fs.readFile(fixture.wavPath);
    assert.equal(analyzePcm16Wav(cropped).durationSeconds, 20);
    assert.equal(cropped.readInt16LE(44), 31);
    assert.equal(cropped.readInt16LE(cropped.length - 2), 50);
    assert.ok(!JSON.stringify(result).includes(fixture.wavPath));
});

test('sampler snaps selection to integer milliseconds and recomputes speech after snapping', async (t) => {
    const fixture = await wavFixture(t);
    const result = await prepareStrictLidSpeechSample({ ...fixture, bin: '/bin/vad', model: '/model',
        runVadImpl: async () => ({ ok: true, outcome: 'succeeded', segments: [{ start: 30.0004, end: 50.0004 }] }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.selection.selectedOffsetMilliseconds, fixture.plan.searchStartMilliseconds + 30000);
    assert.equal(result.selection.speechMilliseconds, 19999);
    assert.equal(analyzePcm16Wav(await fs.readFile(fixture.wavPath)).sampleCount, 320000);
});

test('missing VAD config and failed or timed-out local VAD use the exact anchor, never invented zero speech', async (t) => {
    for (const scenario of ['unavailable', 'failed', 'timed-out', 'invalid-output']) {
        const fixture = await wavFixture(t);
        const result = await prepareStrictLidSpeechSample({ ...fixture,
            ...(scenario === 'unavailable' ? {} : { bin: '/bin/vad', model: '/model' }),
            runVadImpl: async () => ({ ok: false, outcome: scenario, timedOut: scenario === 'timed-out' }),
        });
        assert.equal(result.ok, true);
        assert.equal(result.offset, fixture.plan.anchorOffsetSeconds);
        assert.equal(result.selection.selector, 'anchor-fallback');
        assert.equal(result.selection.speechMilliseconds, null);
        assert.equal(result.diagnostic.vadSpeechSeconds, null);
        assert.equal(result.diagnostic.vadOutcome, scenario);
        assert.equal(result.timedOut, scenario === 'timed-out');
        assert.equal((await fs.readFile(fixture.wavPath)).readInt16LE(44), 1 + fixture.plan.preferredStartSeconds);
    }
});

test('successful VAD with no speech reports measured zero and stays at the exact anchor', async (t) => {
    const fixture = await wavFixture(t);
    const result = await prepareStrictLidSpeechSample({ ...fixture, bin: '/bin/vad', model: '/model',
        runVadImpl: async () => ({ ok: true, outcome: 'succeeded', segments: [] }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.selection.selector, 'anchor-fallback');
    assert.equal(result.selection.speechMilliseconds, 0);
    assert.equal(result.diagnostic.vadSpeechSeconds, 0);
    assert.equal(result.diagnostic.vadOutcome, 'succeeded');
});

test('short WAV clips are not padded, and fallback fails if the anchor is unavailable', async (t) => {
    for (const seconds of [19.99, 30]) {
        const fixture = await wavFixture(t, seconds);
        const result = await prepareStrictLidSpeechSample(fixture);
        assert.equal(result.ok, false);
        assert.equal(result.selection, null);
        assert.equal(result.diagnostic.outcome, 'invalid-audio');
        assert.deepEqual(await fs.readFile(fixture.wavPath), fixture.bytes);
    }
    const fixture = await wavFixture(t, 30);
    const result = await prepareStrictLidSpeechSample({ ...fixture, bin: '/bin/vad', model: '/model',
        runVadImpl: async () => ({ ok: true, outcome: 'succeeded', segments: [{ start: 0, end: 20 }] }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.selection.selectedOffsetMilliseconds, fixture.plan.searchStartMilliseconds);
    assert.equal(analyzePcm16Wav(await fs.readFile(fixture.wavPath)).durationSeconds, 20);
});

test('invalid WAV and plan are rejected without invoking VAD or overwriting the input', async (t) => {
    const fixture = await wavFixture(t);
    const wrongPlan = { ...fixture.plan, searchDurationMilliseconds: 90000 };
    const invalidPlan = await prepareStrictLidSpeechSample({ ...fixture, plan: wrongPlan, runVadImpl: () => assert.fail() });
    assert.equal(invalidPlan.ok, false);
    assert.deepEqual(await fs.readFile(fixture.wavPath), fixture.bytes);
    const malformed = Buffer.from(fixture.bytes); malformed.writeUInt32LE(0xffffffff, 40);
    await fs.writeFile(fixture.wavPath, malformed);
    const invalidWav = await prepareStrictLidSpeechSample({ ...fixture, bin: '/bin/vad', model: '/model', runVadImpl: () => assert.fail() });
    assert.equal(invalidWav.ok, false);
    assert.deepEqual(await fs.readFile(fixture.wavPath), malformed);
});

test('global abort or preemption blocks sampler success and leaves the original WAV untouched', async (t) => {
    for (const mode of ['abort', 'preempt']) {
        const fixture = await wavFixture(t);
        const controller = new AbortController();
        let preempted = false;
        const result = await prepareStrictLidSpeechSample({ ...fixture, bin: '/bin/vad', model: '/model', abortSignal: controller.signal,
            isPreempted: () => preempted,
            runVadImpl: async () => {
                if (mode === 'abort') controller.abort(); else preempted = true;
                return { ok: true, outcome: 'succeeded', segments: [{ start: 30, end: 50 }] };
            },
        });
        assert.equal(result.ok, false);
        assert.equal(mode === 'abort' ? result.aborted : result.preempted, true);
        assert.equal(result.selection, null);
        assert.deepEqual(await fs.readFile(fixture.wavPath), fixture.bytes);
    }
});

test('sampler refuses concurrently changed audio and sanitizes invalid injected VAD output', async (t) => {
    const fixture = await wavFixture(t);
    const altered = Buffer.concat([fixture.bytes, Buffer.from('private appended data')]);
    const result = await prepareStrictLidSpeechSample({ ...fixture, bin: '/bin/vad', model: '/model',
        runVadImpl: async () => {
            await fs.writeFile(fixture.wavPath, altered);
            return { ok: true, outcome: 'succeeded', segments: [{ start: 30, end: 50 }] };
        },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(await fs.readFile(fixture.wavPath), altered);
    const other = await wavFixture(t);
    const invalid = await prepareStrictLidSpeechSample({ ...other, bin: '/bin/vad', model: '/model',
        runVadImpl: async () => ({ ok: true, outcome: 'succeeded', segments: [{ start: NaN, end: 50 }], error: 'private error' }),
    });
    assert.equal(invalid.ok, true);
    assert.equal(invalid.selection.selector, 'anchor-fallback');
    assert.equal(invalid.selection.speechMilliseconds, null);
    assert.equal(invalid.diagnostic.vadOutcome, 'invalid-output');
    assert.ok(!JSON.stringify(invalid).includes('private'));
});

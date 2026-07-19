const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
    MAX_ERROR_CHARS,
    SHERPA_LID_PROTOCOL,
    SherpaLidBridge,
    boundedError,
    inspectPcm16MonoWav,
} = require('../services/media-gateway/src/sherpa-lid-bridge');
const {
    inspectPcm16MonoWavSync,
    resolveAllowedRegularFileSync,
} = require('../services/media-gateway/src/sherpa-lid-worker');

function pcm16MonoWav({ seconds = 1, sampleRate = 16_000, channels = 1 } = {}) {
    const bitsPerSample = 16;
    const blockAlign = channels * bitsPerSample / 8;
    const byteRate = sampleRate * blockAlign;
    const dataBytes = Math.floor(seconds * byteRate);
    const wav = Buffer.alloc(44 + dataBytes);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVE', 8, 'ascii');
    wav.write('fmt ', 12, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(channels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(byteRate, 28);
    wav.writeUInt16LE(blockAlign, 32);
    wav.writeUInt16LE(bitsPerSample, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(dataBytes, 40);
    return wav;
}

async function fixture() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'norva-sherpa-test-'));
    const modelRoot = path.join(root, 'models');
    const wavRoot = path.join(root, 'wav');
    await Promise.all([
        fsp.mkdir(modelRoot),
        fsp.mkdir(wavRoot),
    ]);
    const encoderPath = path.join(modelRoot, 'tiny-encoder.int8.onnx');
    const decoderPath = path.join(modelRoot, 'tiny-decoder.int8.onnx');
    const wavPath = path.join(wavRoot, 'sample.wav');
    await Promise.all([
        fsp.writeFile(encoderPath, 'encoder'),
        fsp.writeFile(decoderPath, 'decoder'),
        fsp.writeFile(wavPath, pcm16MonoWav()),
    ]);
    return {
        root,
        modelRoot,
        wavRoot,
        wavPath,
        encoderPath,
        decoderPath,
        async cleanup() {
            await fsp.rm(root, { recursive: true, force: true });
        },
    };
}

class FakeWorker extends EventEmitter {
    constructor({ onPostMessage, ready = true, readyOverrides = {} } = {}) {
        super();
        this.onPostMessage = onPostMessage;
        this.terminateCalls = 0;
        this.workerData = null;
        if (ready) {
            queueMicrotask(() => this.emit('message', {
                type: 'ready',
                protocol: SHERPA_LID_PROTOCOL,
                packageVersion: '1.13.4',
                encoderSha256: 'a'.repeat(64),
                decoderSha256: 'b'.repeat(64),
                initMs: 100,
                requireMs: 10,
                modelLoadMs: 80,
                rssBytesBefore: 1_000,
                rssBytesAfter: 2_000,
                ...readyOverrides,
            }));
        }
    }

    postMessage(message) {
        this.onPostMessage?.(message, this);
    }

    unref() {}

    terminate() {
        this.terminateCalls += 1;
        queueMicrotask(() => this.emit('exit', 0));
        return Promise.resolve(0);
    }
}

function bridgeConfig(fx, overrides = {}) {
    return {
        encoderPath: fx.encoderPath,
        decoderPath: fx.decoderPath,
        modelRoot: fx.modelRoot,
        allowedWavRoot: fx.wavRoot,
        workerPath: path.join(
            __dirname,
            '../services/media-gateway/src/sherpa-lid-worker.js',
        ),
        timeoutMs: 100,
        startupTimeoutMs: 100,
        terminateGraceMs: 20,
        ...overrides,
    };
}

test('WAV inspection accepts only bounded mono 16 kHz PCM16 files under the allowed root', async () => {
    const fx = await fixture();
    try {
        const info = await inspectPcm16MonoWav(fx.wavPath, fx.wavRoot);
        assert.equal(info.sampleRate, 16_000);
        assert.equal(info.channels, 1);
        assert.equal(info.bitsPerSample, 16);
        assert.equal(info.audioSec, 1);

        const stereoPath = path.join(fx.wavRoot, 'stereo.wav');
        await fsp.writeFile(stereoPath, pcm16MonoWav({ channels: 2 }));
        await assert.rejects(
            inspectPcm16MonoWav(stereoPath, fx.wavRoot),
            /mono 16 kHz PCM signed 16-bit/,
        );

        const outside = path.join(fx.root, 'outside.wav');
        await fsp.writeFile(outside, pcm16MonoWav());
        await assert.rejects(
            inspectPcm16MonoWav(outside, fx.wavRoot),
            /outside the allowed root/,
        );
    } finally {
        await fx.cleanup();
    }
});

test('bridge stays optional and reports persistent-worker metrics without a probability', async () => {
    const fx = await fixture();
    let created = 0;
    let seenWorkerData = null;
    let worker = null;
    const bridge = new SherpaLidBridge(bridgeConfig(fx, {
        workerFactory: (_filename, options) => {
            created += 1;
            seenWorkerData = options.workerData;
            worker = new FakeWorker({
                onPostMessage(message, instance) {
                    assert.equal(message.type, 'detect');
                    assert.equal(message.expected.sampleRate, 16_000);
                    assert.match(message.expected.sha256, /^[a-f0-9]{64}$/);
                    queueMicrotask(() => instance.emit('message', {
                        type: 'result',
                        protocol: SHERPA_LID_PROTOCOL,
                        requestId: message.requestId,
                        ok: true,
                        lang: 'it',
                        metrics: {
                            audioSec: 1,
                            inferenceMs: 25,
                            totalWorkerMs: 30,
                            rtf: 0.025,
                            processCpuMs: 20,
                            threadCpuMs: 18,
                            rssBytesBefore: 2_000,
                            rssBytesAfter: 2_100,
                        },
                    }));
                },
            });
            return worker;
        },
    }));
    try {
        assert.equal(created, 0, 'constructing the bridge must not load the optional addon');
        const first = await bridge.detect(fx.wavPath);
        assert.equal(first.ok, true, JSON.stringify(first));
        const second = await bridge.detect(fx.wavPath);
        assert.equal(second.ok, true, JSON.stringify(second));
        assert.equal(created, 1, 'the initialized worker must be reused');
        assert.equal(seenWorkerData.numThreads, 1);
        assert.equal(seenWorkerData.tailPaddings, 300);
        assert.equal(first.lang, 'it');
        assert.equal(first.probability, null);
        assert.equal(first.engine.packageVersion, '1.13.4');
        assert.equal(first.engine.encoderSha256, 'a'.repeat(64));
        assert.equal(first.metrics.inferenceMs, 25);
        assert.equal(first.metrics.rtf, 0.025);
        assert.equal(first.metrics.workerColdStart, true);
        assert.match(first.sample.sha256, /^[a-f0-9]{64}$/);
        assert.equal(second.metrics.workerColdStart, false);
        assert.equal(second.generation, first.generation);
        assert.equal(bridge.status().ready, true);
    } finally {
        await bridge.close();
        await fx.cleanup();
    }
});

test('invalid WAV input fails before a worker or native package is loaded', async () => {
    const fx = await fixture();
    let created = 0;
    const bridge = new SherpaLidBridge(bridgeConfig(fx, {
        workerFactory: () => {
            created += 1;
            return new FakeWorker();
        },
    }));
    try {
        const outside = path.join(fx.root, 'outside.wav');
        await fsp.writeFile(outside, pcm16MonoWav());
        const result = await bridge.detect(outside);
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, 'invalid-wav');
        assert.equal(created, 0);
    } finally {
        await bridge.close();
        await fx.cleanup();
    }
});

test('worker repeats path and WAV validation without loading the optional native addon', async () => {
    const fx = await fixture();
    try {
        const resolved = resolveAllowedRegularFileSync(fx.wavPath, fx.wavRoot);
        assert.equal(path.basename(resolved), 'sample.wav');
        assert.equal(path.isAbsolute(resolved), true);
        const info = inspectPcm16MonoWavSync(resolved, 35);
        assert.equal(info.sampleRate, 16_000);
        assert.equal(info.audioSec, 1);

        const outside = path.join(fx.root, 'outside.wav');
        await fsp.writeFile(outside, pcm16MonoWav());
        assert.throws(
            () => resolveAllowedRegularFileSync(outside, fx.wavRoot),
            /outside the allowed root/,
        );
    } finally {
        await fx.cleanup();
    }
});

test('timeout terminates the worker and the next request starts a fresh generation', async () => {
    const fx = await fixture();
    const workers = [];
    const bridge = new SherpaLidBridge(bridgeConfig(fx, {
        timeoutMs: 5,
        workerFactory: () => {
            const generation = workers.length + 1;
            const worker = new FakeWorker({
                onPostMessage(message, instance) {
                    if (generation === 1) return;
                    queueMicrotask(() => instance.emit('message', {
                        type: 'result',
                        protocol: SHERPA_LID_PROTOCOL,
                        requestId: message.requestId,
                        ok: true,
                        lang: 'fr',
                        metrics: { audioSec: 1, inferenceMs: 2, rtf: 0.002 },
                    }));
                },
            });
            workers.push(worker);
            return worker;
        },
    }));
    try {
        const timedOut = await bridge.detect(fx.wavPath);
        assert.equal(timedOut.ok, false);
        assert.equal(timedOut.timedOut, true);
        assert.equal(timedOut.errorCode, 'timeout');
        assert.equal(timedOut.metrics.terminationConfirmed, true);
        assert.equal(workers[0].terminateCalls, 1);

        const recovered = await bridge.detect(fx.wavPath);
        assert.equal(recovered.ok, true);
        assert.equal(recovered.lang, 'fr');
        assert.equal(recovered.generation, 2);
        assert.equal(workers.length, 2);
    } finally {
        await bridge.close();
        await fx.cleanup();
    }
});

test('worker errors are bounded and malformed language codes fail closed', async () => {
    const fx = await fixture();
    let worker = null;
    const bridge = new SherpaLidBridge(bridgeConfig(fx, {
        workerFactory: () => {
            worker = new FakeWorker({
                onPostMessage(message, instance) {
                    queueMicrotask(() => instance.emit('message', {
                        type: 'result',
                        protocol: SHERPA_LID_PROTOCOL,
                        requestId: message.requestId,
                        ok: false,
                        lang: '../../../../etc/passwd',
                        errorCode: 'inference-failed',
                        error: `failure ${'x'.repeat(5_000)}`,
                    }));
                },
            });
            return worker;
        },
    }));
    try {
        const result = await bridge.detect(fx.wavPath);
        assert.equal(result.ok, false);
        assert.equal(result.lang, null);
        assert.ok(result.error.length <= MAX_ERROR_CHARS);
        assert.ok(boundedError('x'.repeat(5_000)).length <= MAX_ERROR_CHARS);
    } finally {
        await bridge.close();
        await fx.cleanup();
    }
});

test('prototype keeps the optional native import isolated to the worker', () => {
    const root = path.join(__dirname, '..');
    const bridge = fs.readFileSync(
        path.join(root, 'services/media-gateway/src/sherpa-lid-bridge.js'),
        'utf8',
    );
    const worker = fs.readFileSync(
        path.join(root, 'services/media-gateway/src/sherpa-lid-worker.js'),
        'utf8',
    );
    assert.doesNotMatch(bridge, /require\(['"]sherpa-onnx-node['"]\)/);
    assert.match(worker, /sherpa = require\('sherpa-onnx-node'\)/);
    assert.match(worker, /sherpa\.readWaveFromBinary\(wavBinary\)/);
});

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
    isMainThread,
    parentPort,
    workerData,
} = require('node:worker_threads');

const PROTOCOL_VERSION = 1;
const SAMPLE_RATE = 16_000;
const PCM_BYTES_PER_SAMPLE = 2;

function boundedError(value) {
    return String(value?.message || value || 'VAD failed')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200) || 'VAD failed';
}

function isInsideRoot(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative !== ''
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function resolveInput(filePath, allowedRoot) {
    if (
        typeof filePath !== 'string'
        || !path.isAbsolute(filePath)
        || path.extname(filePath).toLowerCase() !== '.wav'
    ) {
        throw new Error('input must be an absolute WAV path');
    }
    const requested = path.resolve(filePath);
    const stat = fs.lstatSync(requested);
    if (stat.isSymbolicLink()) throw new Error('symbolic-link input is rejected');
    const realPath = fs.realpathSync(requested);
    if (!isInsideRoot(allowedRoot, realPath) || !fs.statSync(realPath).isFile()) {
        throw new Error('input is outside the sample root');
    }
    return realPath;
}

function resolveOutput(filePath, allowedRoot) {
    if (
        typeof filePath !== 'string'
        || !path.isAbsolute(filePath)
        || path.extname(filePath).toLowerCase() !== '.wav'
    ) {
        throw new Error('output must be an absolute WAV path');
    }
    const candidate = path.resolve(filePath);
    if (!isInsideRoot(allowedRoot, candidate)) {
        throw new Error('output is outside the sample root');
    }
    if (fs.existsSync(candidate)) throw new Error('output already exists');
    return candidate;
}

function parsePcm16MonoWav(buffer, maxAudioSeconds) {
    if (
        !Buffer.isBuffer(buffer)
        || buffer.length < 44
        || buffer.toString('ascii', 0, 4) !== 'RIFF'
        || buffer.toString('ascii', 8, 12) !== 'WAVE'
    ) {
        throw new Error('only RIFF/WAVE input is accepted');
    }
    let format = null;
    let data = null;
    for (let offset = 12; offset + 8 <= buffer.length;) {
        const id = buffer.toString('ascii', offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const bodyOffset = offset + 8;
        if (bodyOffset + size > buffer.length) throw new Error('truncated WAV chunk');
        if (id === 'fmt ') {
            if (size < 16) throw new Error('invalid WAV format chunk');
            format = {
                audioFormat: buffer.readUInt16LE(bodyOffset),
                channels: buffer.readUInt16LE(bodyOffset + 2),
                sampleRate: buffer.readUInt32LE(bodyOffset + 4),
                byteRate: buffer.readUInt32LE(bodyOffset + 8),
                blockAlign: buffer.readUInt16LE(bodyOffset + 12),
                bitsPerSample: buffer.readUInt16LE(bodyOffset + 14),
            };
        } else if (id === 'data') {
            data = { offset: bodyOffset, bytes: size };
            break;
        }
        const next = bodyOffset + size + (size % 2);
        if (next <= offset) throw new Error('invalid WAV chunk length');
        offset = next;
    }
    if (!format || !data) throw new Error('required WAV chunks are missing');
    if (
        format.audioFormat !== 1
        || format.channels !== 1
        || format.sampleRate !== SAMPLE_RATE
        || format.bitsPerSample !== 16
        || format.blockAlign !== PCM_BYTES_PER_SAMPLE
        || format.byteRate !== SAMPLE_RATE * PCM_BYTES_PER_SAMPLE
    ) {
        throw new Error('WAV must be mono 16 kHz signed PCM16');
    }
    if (data.bytes < SAMPLE_RATE * PCM_BYTES_PER_SAMPLE) {
        throw new Error('WAV contains less than one second of audio');
    }
    const audioSeconds = data.bytes / format.byteRate;
    if (!Number.isFinite(audioSeconds) || audioSeconds > maxAudioSeconds) {
        throw new Error('WAV duration is outside the bounded range');
    }
    return { ...data, audioSeconds };
}

function decodePcm16(buffer, offset, bytes) {
    const samples = new Float32Array(bytes / PCM_BYTES_PER_SAMPLE);
    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = buffer.readInt16LE(offset + index * PCM_BYTES_PER_SAMPLE) / 32768;
    }
    return samples;
}

function encodePcm16Wav(samples) {
    const dataBytes = samples.length * PCM_BYTES_PER_SAMPLE;
    const output = Buffer.allocUnsafe(44 + dataBytes);
    output.write('RIFF', 0, 4, 'ascii');
    output.writeUInt32LE(36 + dataBytes, 4);
    output.write('WAVE', 8, 4, 'ascii');
    output.write('fmt ', 12, 4, 'ascii');
    output.writeUInt32LE(16, 16);
    output.writeUInt16LE(1, 20);
    output.writeUInt16LE(1, 22);
    output.writeUInt32LE(SAMPLE_RATE, 24);
    output.writeUInt32LE(SAMPLE_RATE * PCM_BYTES_PER_SAMPLE, 28);
    output.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32);
    output.writeUInt16LE(16, 34);
    output.write('data', 36, 4, 'ascii');
    output.writeUInt32LE(dataBytes, 40);
    for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, Number(samples[index]) || 0));
        const pcm = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
        output.writeInt16LE(pcm, 44 + index * PCM_BYTES_PER_SAMPLE);
    }
    return output;
}

function concatenateSpeech(segments, maxSamples) {
    const totalSamples = Math.min(
        maxSamples,
        segments.reduce((sum, segment) => sum + segment.length, 0),
    );
    const output = new Float32Array(totalSamples);
    let offset = 0;
    for (const segment of segments) {
        if (offset >= output.length) break;
        const take = Math.min(segment.length, output.length - offset);
        output.set(segment.subarray(0, take), offset);
        offset += take;
    }
    return output;
}

async function startWorker() {
    if (!parentPort || workerData?.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error('VAD worker protocol mismatch');
    }
    const sampleRoot = fs.realpathSync(workerData.sampleRoot);
    const modelPath = fs.realpathSync(workerData.modelPath);
    if (
        !isInsideRoot(fs.realpathSync(workerData.modelRoot), modelPath)
        || !fs.statSync(modelPath).isFile()
    ) {
        throw new Error('VAD model is outside the pinned model root');
    }
    const modelSha256 = crypto.createHash('sha256')
        .update(fs.readFileSync(modelPath))
        .digest('hex');
    if (modelSha256 !== workerData.modelSha256) {
        throw new Error('VAD model digest mismatch');
    }

    const { Vad } = require('sherpa-onnx-node');
    if (typeof Vad !== 'function') throw new Error('sherpa VAD API is unavailable');
    const vad = new Vad({
        sileroVad: {
            model: modelPath,
            threshold: workerData.threshold,
            minSilenceDuration: workerData.minSilenceDuration,
            minSpeechDuration: workerData.minSpeechDuration,
            windowSize: workerData.windowSize,
            maxSpeechDuration: workerData.maxSpeechSeconds,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: workerData.numThreads,
        provider: 'cpu',
        debug: false,
    }, workerData.maxInputSeconds + 5);

    parentPort.postMessage({
        type: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        modelSha256,
    });

    let busy = false;
    parentPort.on('message', (message) => {
        if (
            message?.type !== 'extract'
            || message.protocolVersion !== PROTOCOL_VERSION
            || !Number.isSafeInteger(message.requestId)
        ) {
            return;
        }
        if (busy) {
            parentPort.postMessage({
                type: 'result',
                requestId: message.requestId,
                ok: false,
                errorCode: 'worker-busy',
                error: 'VAD worker accepts one request at a time',
            });
            return;
        }
        busy = true;
        const startedAt = performance.now();
        let wav = null;
        let samples = null;
        let speech = null;
        let outputWav = null;
        const segments = [];
        try {
            const inputPath = resolveInput(message.inputPath, sampleRoot);
            const outputPath = resolveOutput(message.outputPath, sampleRoot);
            wav = fs.readFileSync(inputPath);
            const sha256 = crypto.createHash('sha256').update(wav).digest('hex');
            if (sha256 !== message.expectedSha256) {
                throw new Error('input WAV changed after request validation');
            }
            const info = parsePcm16MonoWav(wav, workerData.maxInputSeconds);
            samples = decodePcm16(wav, info.offset, info.bytes);

            vad.reset();
            for (let offset = 0; offset < samples.length; offset += workerData.windowSize) {
                vad.acceptWaveform(samples.subarray(
                    offset,
                    Math.min(samples.length, offset + workerData.windowSize),
                ));
            }
            vad.flush();
            while (!vad.isEmpty()) {
                const segment = vad.front(false);
                if (segment?.samples instanceof Float32Array && segment.samples.length > 0) {
                    segments.push(segment.samples);
                }
                vad.pop();
            }
            vad.reset();

            const detectedSamples = segments.reduce(
                (sum, segment) => sum + segment.length,
                0,
            );
            if (detectedSamples < workerData.minSpeechSeconds * SAMPLE_RATE) {
                parentPort.postMessage({
                    type: 'result',
                    requestId: message.requestId,
                    ok: true,
                    hasSpeech: false,
                    inputSeconds: Math.round(info.audioSeconds * 1000) / 1000,
                    speechSeconds: Math.round((detectedSamples / SAMPLE_RATE) * 1000) / 1000,
                    segmentCount: Math.min(100, segments.length),
                    wallMs: Math.round((performance.now() - startedAt) * 100) / 100,
                });
                return;
            }

            speech = concatenateSpeech(
                segments,
                Math.floor(workerData.maxSpeechSeconds * SAMPLE_RATE),
            );
            outputWav = encodePcm16Wav(speech);
            fs.writeFileSync(outputPath, outputWav, {
                mode: 0o600,
                flag: 'wx',
            });
            const speechSha256 = crypto.createHash('sha256').update(outputWav).digest('hex');
            parentPort.postMessage({
                type: 'result',
                requestId: message.requestId,
                ok: true,
                hasSpeech: true,
                inputSeconds: Math.round(info.audioSeconds * 1000) / 1000,
                speechSeconds: Math.round((speech.length / SAMPLE_RATE) * 1000) / 1000,
                segmentCount: Math.min(100, segments.length),
                outputBytes: outputWav.length,
                speechSha256,
                wallMs: Math.round((performance.now() - startedAt) * 100) / 100,
            });
        } catch (error) {
            parentPort.postMessage({
                type: 'result',
                requestId: message.requestId,
                ok: false,
                hasSpeech: false,
                errorCode: 'vad-failed',
                error: boundedError(error),
                wallMs: Math.round((performance.now() - startedAt) * 100) / 100,
            });
        } finally {
            try { vad.reset(); } catch (_) {}
            if (wav) wav.fill(0);
            if (samples) samples.fill(0);
            if (speech) speech.fill(0);
            if (outputWav) outputWav.fill(0);
            for (const segment of segments) segment.fill(0);
            busy = false;
        }
    });
}

if (!isMainThread) {
    startWorker().catch((error) => {
        parentPort?.postMessage({
            type: 'init-error',
            protocolVersion: PROTOCOL_VERSION,
            errorCode: 'vad-init-failed',
            error: boundedError(error),
        });
        parentPort?.close();
    });
}

module.exports = {
    PROTOCOL_VERSION,
    concatenateSpeech,
    encodePcm16Wav,
    parsePcm16MonoWav,
};

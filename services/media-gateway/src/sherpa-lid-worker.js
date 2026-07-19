const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
    isMainThread,
    parentPort,
    workerData,
} = require('node:worker_threads');

const PROTOCOL = 1;
const MAX_ERROR_CHARS = 512;

function boundedError(value, maxChars = MAX_ERROR_CHARS) {
    const text = String(value?.message || value || 'unknown error')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return 'unknown error';
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function isInsideRoot(rootPath, filePath) {
    const relative = path.relative(rootPath, filePath);
    return relative !== ''
        && !relative.startsWith(`..${path.sep}`)
        && relative !== '..'
        && !path.isAbsolute(relative);
}

function resolveAllowedRegularFileSync(filePath, allowedRoot) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new Error('file path must be absolute');
    }
    const realRoot = fs.realpathSync(allowedRoot);
    const realFile = fs.realpathSync(filePath);
    if (!isInsideRoot(realRoot, realFile)) {
        throw new Error('file is outside the allowed root');
    }
    if (!fs.statSync(realFile).isFile()) throw new Error('path is not a regular file');
    return realFile;
}

function inspectPcm16MonoWavSync(wavPath, maxAudioSec) {
    const stat = fs.statSync(wavPath);
    const headerBytes = Math.min(stat.size, 1024 * 1024);
    const fd = fs.openSync(wavPath, 'r');
    let buffer;
    try {
        buffer = Buffer.alloc(headerBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, headerBytes, 0);
        buffer = buffer.subarray(0, bytesRead);
    } finally {
        fs.closeSync(fd);
    }

    if (buffer.length < 44) throw new Error('WAV header is missing or truncated');
    if (
        buffer.toString('ascii', 0, 4) !== 'RIFF'
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
        if (id === 'fmt ') {
            if (size < 16 || bodyOffset + 16 > buffer.length) {
                throw new Error('invalid WAV fmt chunk');
            }
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
        if (next <= offset) throw new Error('invalid WAV chunk size');
        offset = next;
    }
    if (!format || !data) throw new Error('required WAV chunks are missing');
    if (
        format.audioFormat !== 1
        || format.channels !== 1
        || format.sampleRate !== 16_000
        || format.bitsPerSample !== 16
        || format.blockAlign !== 2
        || format.byteRate !== 32_000
    ) {
        throw new Error('WAV must be mono 16 kHz PCM signed 16-bit');
    }
    if (data.bytes < 8_000 || data.offset + data.bytes > stat.size) {
        throw new Error('WAV data is empty, too short, or truncated');
    }
    const audioSec = data.bytes / format.byteRate;
    if (!Number.isFinite(audioSec) || audioSec > maxAudioSec) {
        throw new Error('WAV exceeds the benchmark duration limit');
    }
    return { ...format, dataBytes: data.bytes, audioSec };
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function cpuMs(delta) {
    if (!delta) return null;
    return Math.round(((delta.user + delta.system) / 1000) * 100) / 100;
}

function deltaCpu(after, before) {
    if (!after || !before) return null;
    return {
        user: Math.max(0, Number(after.user || 0) - Number(before.user || 0)),
        system: Math.max(0, Number(after.system || 0) - Number(before.system || 0)),
    };
}

async function readPackageVersion() {
    try {
        const packageJson = require.resolve('sherpa-onnx-node/package.json');
        const parsed = JSON.parse(await fsp.readFile(packageJson, 'utf8'));
        return String(parsed.version || 'unknown');
    } catch (_) {
        return 'unknown';
    }
}

async function startWorker() {
    const initStartedAt = performance.now();
    const rssBytesBefore = process.memoryUsage().rss;
    try {
        if (!parentPort || workerData?.protocol !== PROTOCOL) {
            throw Object.assign(new Error('worker protocol mismatch'), {
                code: 'protocol-mismatch',
            });
        }
        const modelRoot = fs.realpathSync(workerData.modelRoot);
        const allowedWavRoot = fs.realpathSync(workerData.allowedWavRoot);
        const encoderPath = resolveAllowedRegularFileSync(
            workerData.encoderPath,
            modelRoot,
        );
        const decoderPath = resolveAllowedRegularFileSync(
            workerData.decoderPath,
            modelRoot,
        );
        if (!encoderPath.endsWith('.onnx') || !decoderPath.endsWith('.onnx')) {
            throw Object.assign(new Error('model files must use the ONNX format'), {
                code: 'invalid-model',
            });
        }

        const [encoderSha256, decoderSha256] = await Promise.all([
            sha256File(encoderPath),
            sha256File(decoderPath),
        ]);

        // Deliberately lazy and optional. Requiring the bridge never loads this native addon;
        // only a configured benchmark worker attempts it.
        const requireStartedAt = performance.now();
        let sherpa;
        try {
            sherpa = require('sherpa-onnx-node');
        } catch (error) {
            throw Object.assign(
                new Error(`optional sherpa-onnx-node dependency is unavailable: ${boundedError(error)}`),
                { code: 'dependency-unavailable' },
            );
        }
        const requireMs = performance.now() - requireStartedAt;
        if (
            typeof sherpa.SpokenLanguageIdentification !== 'function'
            || typeof sherpa.readWaveFromBinary !== 'function'
        ) {
            throw Object.assign(new Error('sherpa addon does not expose the required API'), {
                code: 'api-unavailable',
            });
        }

        const modelStartedAt = performance.now();
        const identifier = new sherpa.SpokenLanguageIdentification({
            whisper: {
                encoder: encoderPath,
                decoder: decoderPath,
                tailPaddings: workerData.tailPaddings,
            },
            numThreads: workerData.numThreads,
            debug: false,
            provider: 'cpu',
        });
        const modelLoadMs = performance.now() - modelStartedAt;
        const packageVersion = await readPackageVersion();

        parentPort.postMessage({
            type: 'ready',
            protocol: PROTOCOL,
            generation: workerData.generation,
            packageVersion,
            encoderSha256,
            decoderSha256,
            initMs: Math.round((performance.now() - initStartedAt) * 100) / 100,
            requireMs: Math.round(requireMs * 100) / 100,
            modelLoadMs: Math.round(modelLoadMs * 100) / 100,
            rssBytesBefore,
            rssBytesAfter: process.memoryUsage().rss,
        });

        let busy = false;
        parentPort.on('message', (message) => {
            if (
                message?.type !== 'detect'
                || message.protocol !== PROTOCOL
                || !Number.isSafeInteger(message.requestId)
            ) {
                return;
            }
            if (busy) {
                parentPort.postMessage({
                    type: 'result',
                    protocol: PROTOCOL,
                    requestId: message.requestId,
                    ok: false,
                    errorCode: 'worker-busy',
                    error: 'sherpa worker accepts one inference at a time',
                });
                return;
            }

            busy = true;
            const startedAt = performance.now();
            const processCpuBefore = process.cpuUsage();
            const threadCpuBefore = typeof process.threadCpuUsage === 'function'
                ? process.threadCpuUsage()
                : null;
            const rssBefore = process.memoryUsage().rss;
            try {
                const realWavPath = resolveAllowedRegularFileSync(
                    message.wavPath,
                    allowedWavRoot,
                );
                const wavInfo = inspectPcm16MonoWavSync(
                    realWavPath,
                    workerData.maxAudioSec,
                );
                const readFileStartedAt = performance.now();
                const wavBinary = fs.readFileSync(realWavPath);
                const readFileMs = performance.now() - readFileStartedAt;
                const digestStartedAt = performance.now();
                const wavSha256 = sha256Buffer(wavBinary);
                const digestMs = performance.now() - digestStartedAt;
                const expected = message.expected || {};
                if (
                    expected.sampleRate !== wavInfo.sampleRate
                    || expected.channels !== wavInfo.channels
                    || expected.bitsPerSample !== wavInfo.bitsPerSample
                    || expected.dataBytes !== wavInfo.dataBytes
                    || expected.sha256 !== wavSha256
                ) {
                    throw Object.assign(new Error('WAV changed after bridge validation'), {
                        code: 'wav-changed',
                    });
                }

                const readStartedAt = performance.now();
                // Decode the exact bytes just hashed. Using the path again here would reopen a
                // TOCTOU window where a same-size WAV could change between validation and LID.
                const wave = sherpa.readWaveFromBinary(wavBinary);
                const readWaveMs = performance.now() - readStartedAt;
                if (
                    Number(wave?.sampleRate) !== 16_000
                    || !wave?.samples
                    || typeof wave.samples.length !== 'number'
                    || wave.samples.length !== wavInfo.dataBytes / 2
                ) {
                    throw Object.assign(new Error('sherpa decoded an invalid waveform'), {
                        code: 'wave-decode-failed',
                    });
                }

                const stream = identifier.createStream();
                stream.acceptWaveform({
                    sampleRate: wave.sampleRate,
                    samples: wave.samples,
                });
                const inferenceStartedAt = performance.now();
                const lang = String(identifier.compute(stream) || '').toLowerCase();
                const inferenceMs = performance.now() - inferenceStartedAt;
                if (!/^[a-z]{2,3}$/.test(lang)) {
                    throw Object.assign(new Error('sherpa returned no valid language code'), {
                        code: 'invalid-language',
                    });
                }

                const processCpuAfter = process.cpuUsage();
                const threadCpuAfter = typeof process.threadCpuUsage === 'function'
                    ? process.threadCpuUsage()
                    : null;
                const totalWorkerMs = performance.now() - startedAt;
                parentPort.postMessage({
                    type: 'result',
                    protocol: PROTOCOL,
                    requestId: message.requestId,
                    dispatchedAt: Number(message.dispatchedAt || 0),
                    ok: true,
                    lang,
                    metrics: {
                        audioSec: Math.round(wavInfo.audioSec * 1000) / 1000,
                        readFileMs: Math.round(readFileMs * 100) / 100,
                        digestMs: Math.round(digestMs * 100) / 100,
                        readWaveMs: Math.round(readWaveMs * 100) / 100,
                        inferenceMs: Math.round(inferenceMs * 100) / 100,
                        totalWorkerMs: Math.round(totalWorkerMs * 100) / 100,
                        rtf: wavInfo.audioSec > 0
                            ? Math.round((inferenceMs / 1000 / wavInfo.audioSec) * 100_000) / 100_000
                            : null,
                        processCpuMs: cpuMs(deltaCpu(processCpuAfter, processCpuBefore)),
                        threadCpuMs: cpuMs(deltaCpu(threadCpuAfter, threadCpuBefore)),
                        rssBytesBefore: rssBefore,
                        rssBytesAfter: process.memoryUsage().rss,
                    },
                });
            } catch (error) {
                parentPort.postMessage({
                    type: 'result',
                    protocol: PROTOCOL,
                    requestId: message.requestId,
                    ok: false,
                    errorCode: boundedError(error?.code || 'inference-failed', 64),
                    error: boundedError(error),
                    metrics: {
                        totalWorkerMs: Math.round((performance.now() - startedAt) * 100) / 100,
                    },
                });
            } finally {
                busy = false;
            }
        });
    } catch (error) {
        parentPort?.postMessage({
            type: 'init-error',
            protocol: PROTOCOL,
            errorCode: boundedError(error?.code || 'initialization-failed', 64),
            error: boundedError(error),
        });
        parentPort?.close();
    }
}

if (!isMainThread) {
    void startWorker();
}

module.exports = {
    PROTOCOL,
    boundedError,
    deltaCpu,
    inspectPcm16MonoWavSync,
    resolveAllowedRegularFileSync,
};

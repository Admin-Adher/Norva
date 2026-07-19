const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

const SHERPA_LID_PROTOCOL = 1;
const MAX_ERROR_CHARS = 512;
const DEFAULT_MAX_AUDIO_SEC = 35;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;

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

async function resolveAllowedRegularFile(filePath, allowedRoot) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
        throw new Error('file path must be absolute');
    }
    if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) {
        throw new Error('allowed root must be absolute');
    }

    const [realRoot, realFile] = await Promise.all([
        fsp.realpath(allowedRoot),
        fsp.realpath(filePath),
    ]);
    if (!isInsideRoot(realRoot, realFile)) {
        throw new Error('file is outside the allowed root');
    }
    const stat = await fsp.stat(realFile);
    if (!stat.isFile()) throw new Error('path is not a regular file');
    return { path: realFile, root: realRoot, stat };
}

function parsePcm16MonoWavHeader(buffer, fileSize, maxAudioSec) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
        throw new Error('WAV header is missing or truncated');
    }
    if (
        buffer.toString('ascii', 0, 4) !== 'RIFF'
        || buffer.toString('ascii', 8, 12) !== 'WAVE'
    ) {
        throw new Error('only RIFF/WAVE input is accepted');
    }

    let format = null;
    let data = null;
    let offset = 12;
    while (offset + 8 <= buffer.length) {
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

    if (!format) throw new Error('WAV fmt chunk is missing');
    if (!data) throw new Error('WAV data chunk is missing from the bounded header');
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
    if (data.bytes < format.byteRate / 4) {
        throw new Error('WAV contains less than 250 ms of audio');
    }
    if (data.offset + data.bytes > fileSize) {
        throw new Error('WAV data chunk exceeds the file size');
    }

    const audioSec = data.bytes / format.byteRate;
    if (!Number.isFinite(audioSec) || audioSec > maxAudioSec) {
        throw new Error(`WAV exceeds the ${maxAudioSec}s benchmark limit`);
    }
    return {
        sampleRate: format.sampleRate,
        channels: format.channels,
        bitsPerSample: format.bitsPerSample,
        dataBytes: data.bytes,
        audioSec,
    };
}

async function inspectPcm16MonoWav(
    wavPath,
    allowedRoot,
    { maxAudioSec = DEFAULT_MAX_AUDIO_SEC, maxHeaderBytes = 1024 * 1024 } = {},
) {
    const allowed = await resolveAllowedRegularFile(wavPath, allowedRoot);
    const fileBuffer = await fsp.readFile(allowed.path);
    if (fileBuffer.length !== allowed.stat.size) {
        throw new Error('WAV changed while it was being validated');
    }
    const header = fileBuffer.subarray(0, Math.min(fileBuffer.length, maxHeaderBytes));
    const parsed = parsePcm16MonoWavHeader(
        header,
        fileBuffer.length,
        maxAudioSec,
    );
    return {
        path: allowed.path,
        fileBytes: fileBuffer.length,
        ...parsed,
        sha256: crypto.createHash('sha256')
            .update(fileBuffer)
            .digest('hex'),
    };
}

function failureResult(errorCode, error, extra = {}) {
    return {
        ok: false,
        lang: null,
        probability: null,
        timedOut: errorCode === 'timeout',
        errorCode,
        error: boundedError(error),
        ...extra,
    };
}

class SherpaLidBridge {
    constructor({
        encoderPath,
        decoderPath,
        modelRoot,
        allowedWavRoot,
        numThreads = 1,
        tailPaddings = 300,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
        terminateGraceMs = DEFAULT_TERMINATE_GRACE_MS,
        maxAudioSec = DEFAULT_MAX_AUDIO_SEC,
        workerPath = path.join(__dirname, 'sherpa-lid-worker.js'),
        workerFactory = (filename, options) => new Worker(filename, options),
        now = () => performance.now(),
    }) {
        for (const [name, value] of Object.entries({
            encoderPath,
            decoderPath,
            modelRoot,
            allowedWavRoot,
            workerPath,
        })) {
            if (typeof value !== 'string' || !path.isAbsolute(value)) {
                throw new TypeError(`${name} must be an absolute path`);
            }
        }
        if (!Number.isInteger(numThreads) || numThreads < 1 || numThreads > 16) {
            throw new RangeError('numThreads must be an integer between 1 and 16');
        }
        if (!Number.isInteger(tailPaddings) || tailPaddings < 0 || tailPaddings > 10_000) {
            throw new RangeError('tailPaddings must be an integer between 0 and 10000');
        }
        for (const [name, value, max] of [
            ['timeoutMs', timeoutMs, 120_000],
            ['startupTimeoutMs', startupTimeoutMs, 300_000],
            ['terminateGraceMs', terminateGraceMs, 30_000],
        ]) {
            if (!Number.isFinite(value) || value < 1 || value > max) {
                throw new RangeError(`${name} must be between 1 and ${max}`);
            }
        }
        if (!Number.isFinite(maxAudioSec) || maxAudioSec < 1 || maxAudioSec > 300) {
            throw new RangeError('maxAudioSec must be between 1 and 300');
        }

        this.config = Object.freeze({
            encoderPath,
            decoderPath,
            modelRoot,
            allowedWavRoot,
            numThreads,
            tailPaddings,
            timeoutMs,
            startupTimeoutMs,
            terminateGraceMs,
            maxAudioSec,
            workerPath,
        });
        this.workerFactory = workerFactory;
        this.now = now;
        this.worker = null;
        this.workerGeneration = 0;
        this.readyInfo = null;
        this.readyPromise = null;
        this.readyResolve = null;
        this.readyReject = null;
        this.pending = null;
        this.restartBarrier = null;
        this.closed = false;
        this.state = 'stopped';
        this.nextRequestId = 1;
        this.queue = Promise.resolve();
    }

    status() {
        return {
            protocol: SHERPA_LID_PROTOCOL,
            state: this.state,
            generation: this.workerGeneration,
            ready: Boolean(this.worker && this.readyInfo),
            busy: Boolean(this.pending),
            model: this.readyInfo ? {
                family: 'whisper',
                variant: 'tiny-int8',
                packageVersion: this.readyInfo.packageVersion,
                encoderSha256: this.readyInfo.encoderSha256,
                decoderSha256: this.readyInfo.decoderSha256,
            } : null,
        };
    }

    async start() {
        if (this.closed) return failureResult('closed', 'sherpa bridge is closed');
        try {
            const ready = await this._ensureWorker();
            return {
                ok: true,
                error: null,
                generation: this.workerGeneration,
                init: ready,
            };
        } catch (error) {
            return failureResult('unavailable', error, {
                generation: this.workerGeneration,
            });
        }
    }

    async detect(wavPath) {
        const requestedAt = this.now();
        if (this.closed) return failureResult('closed', 'sherpa bridge is closed');

        let wav;
        const validationStartedAt = this.now();
        try {
            wav = await inspectPcm16MonoWav(
                wavPath,
                this.config.allowedWavRoot,
                { maxAudioSec: this.config.maxAudioSec },
            );
        } catch (error) {
            return failureResult('invalid-wav', error, {
                metrics: {
                    validationMs: this._elapsed(validationStartedAt),
                    queueMs: 0,
                },
            });
        }
        const validationMs = this._elapsed(validationStartedAt);

        const run = this.queue
            .catch(() => {})
            .then(() => this._detectValidated(wav, {
                requestedAt,
                validationMs,
            }));
        this.queue = run.catch(() => {});
        return run;
    }

    async close() {
        this.closed = true;
        this.state = 'closed';
        if (this.pending) {
            this.pending.finish(failureResult('closed', 'sherpa bridge closed during inference'));
        }
        const worker = this.worker;
        if (worker) await this._retireWorker(worker);
        if (this.restartBarrier) {
            await Promise.race([
                this.restartBarrier,
                new Promise((resolve) => setTimeout(resolve, this.config.terminateGraceMs)),
            ]);
        }
    }

    _elapsed(startedAt) {
        return Math.round((this.now() - startedAt) * 100) / 100;
    }

    async _detectValidated(wav, baseMetrics) {
        const queueMs = this._elapsed(baseMetrics.requestedAt) - baseMetrics.validationMs;
        const workerWasReady = Boolean(this.worker && this.readyInfo);
        const startupStartedAt = this.now();
        let ready;
        try {
            ready = await this._ensureWorker();
        } catch (error) {
            return failureResult('unavailable', error, {
                generation: this.workerGeneration,
                metrics: {
                    validationMs: baseMetrics.validationMs,
                    queueMs: Math.max(0, Math.round(queueMs * 100) / 100),
                    workerStartupMs: this._elapsed(startupStartedAt),
                    workerColdStart: !workerWasReady,
                },
            });
        }
        const workerStartupMs = this._elapsed(startupStartedAt);

        const worker = this.worker;
        const generation = this.workerGeneration;
        if (!worker || !ready) {
            return failureResult('unavailable', 'sherpa worker is not ready');
        }

        const requestId = this.nextRequestId++;
        const dispatchStartedAt = this.now();
        this.state = 'busy';
        const response = await new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(async () => {
                if (settled) return;
                settled = true;
                this.pending = null;
                const terminationConfirmed = await this._retireWorker(worker);
                resolve(failureResult('timeout', 'sherpa inference timed out', {
                    generation,
                    metrics: {
                        validationMs: baseMetrics.validationMs,
                        queueMs: Math.max(0, Math.round(queueMs * 100) / 100),
                        workerStartupMs,
                        workerColdStart: !workerWasReady,
                        bridgeWallMs: this._elapsed(dispatchStartedAt),
                        requestWallMs: this._elapsed(baseMetrics.requestedAt),
                        terminationConfirmed,
                    },
                    sample: {
                        sha256: wav.sha256,
                        audioSec: wav.audioSec,
                        dataBytes: wav.dataBytes,
                    },
                }));
            }, this.config.timeoutMs);

            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.pending = null;
                if (!this.closed && this.worker === worker) this.state = 'ready';
                resolve(value);
            };
            this.pending = {
                requestId,
                generation,
                worker,
                finish,
                dispatchStartedAt,
                requestStartedAt: baseMetrics.requestedAt,
                validationMs: baseMetrics.validationMs,
                queueMs: Math.max(0, Math.round(queueMs * 100) / 100),
                workerStartupMs,
                workerColdStart: !workerWasReady,
                sample: {
                    sha256: wav.sha256,
                    audioSec: wav.audioSec,
                    dataBytes: wav.dataBytes,
                },
            };
            try {
                worker.postMessage({
                    type: 'detect',
                    protocol: SHERPA_LID_PROTOCOL,
                    requestId,
                    wavPath: wav.path,
                    expected: {
                        sampleRate: wav.sampleRate,
                        channels: wav.channels,
                        bitsPerSample: wav.bitsPerSample,
                        dataBytes: wav.dataBytes,
                        audioSec: wav.audioSec,
                        sha256: wav.sha256,
                    },
                });
            } catch (error) {
                finish(failureResult('worker-send-failed', error, {
                    generation,
                    metrics: {
                        validationMs: baseMetrics.validationMs,
                        queueMs: Math.max(0, Math.round(queueMs * 100) / 100),
                        workerStartupMs,
                        workerColdStart: !workerWasReady,
                        bridgeWallMs: this._elapsed(dispatchStartedAt),
                        requestWallMs: this._elapsed(baseMetrics.requestedAt),
                    },
                    sample: {
                        sha256: wav.sha256,
                        audioSec: wav.audioSec,
                        dataBytes: wav.dataBytes,
                    },
                }));
                void this._retireWorker(worker);
            }
        });
        return response;
    }

    async _ensureWorker() {
        if (this.closed) throw new Error('sherpa bridge is closed');
        if (this.worker && this.readyInfo) return this.readyInfo;
        if (this.readyPromise) return this.readyPromise;
        if (this.restartBarrier) {
            const stopped = await Promise.race([
                this.restartBarrier.then(() => true),
                new Promise((resolve) =>
                    setTimeout(() => resolve(false), this.config.startupTimeoutMs)),
            ]);
            if (!stopped) throw new Error('previous sherpa worker is still terminating');
        }

        this.state = 'starting';
        this.workerGeneration += 1;
        const generation = this.workerGeneration;
        let worker;
        try {
            worker = this.workerFactory(this.config.workerPath, {
                workerData: {
                    protocol: SHERPA_LID_PROTOCOL,
                    generation,
                    encoderPath: this.config.encoderPath,
                    decoderPath: this.config.decoderPath,
                    modelRoot: this.config.modelRoot,
                    allowedWavRoot: this.config.allowedWavRoot,
                    numThreads: this.config.numThreads,
                    tailPaddings: this.config.tailPaddings,
                    maxAudioSec: this.config.maxAudioSec,
                },
            });
        } catch (error) {
            this.state = 'unavailable';
            throw new Error(`unable to create sherpa worker: ${boundedError(error)}`);
        }
        this.worker = worker;
        worker.unref?.();

        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        const startupTimer = setTimeout(() => {
            if (this.worker !== worker || this.readyInfo) return;
            this.readyReject?.(new Error('sherpa worker startup timed out'));
            void this._retireWorker(worker);
        }, this.config.startupTimeoutMs);

        worker.on('message', (message) => {
            if (this.worker !== worker || message?.protocol !== SHERPA_LID_PROTOCOL) return;
            if (message.type === 'ready') {
                clearTimeout(startupTimer);
                this.readyInfo = Object.freeze({
                    packageVersion: boundedError(message.packageVersion || 'unknown', 64),
                    encoderSha256: String(message.encoderSha256 || ''),
                    decoderSha256: String(message.decoderSha256 || ''),
                    initMs: Number(message.initMs || 0),
                    requireMs: Number(message.requireMs || 0),
                    modelLoadMs: Number(message.modelLoadMs || 0),
                    rssBytesBefore: Number(message.rssBytesBefore || 0),
                    rssBytesAfter: Number(message.rssBytesAfter || 0),
                });
                this.state = 'ready';
                this.readyResolve?.(this.readyInfo);
                return;
            }
            if (message.type === 'init-error') {
                clearTimeout(startupTimer);
                this.state = 'unavailable';
                this.readyReject?.(new Error(
                    `${boundedError(message.errorCode, 64)}: ${boundedError(message.error)}`,
                ));
                void this._retireWorker(worker);
                return;
            }
            if (message.type === 'result') this._handleResult(worker, message);
        });
        worker.on('error', (error) => {
            clearTimeout(startupTimer);
            this._handleWorkerFailure(worker, `worker error: ${boundedError(error)}`);
        });
        worker.on('exit', (code) => {
            clearTimeout(startupTimer);
            if (this.worker === worker) {
                this._handleWorkerFailure(worker, `worker exited with code ${code}`);
            }
        });

        return this.readyPromise;
    }

    _handleResult(worker, message) {
        const pending = this.pending;
        if (
            !pending
            || pending.worker !== worker
            || pending.requestId !== message.requestId
            || pending.generation !== this.workerGeneration
        ) {
            return;
        }
        const workerMetrics = message.metrics && typeof message.metrics === 'object'
            ? message.metrics
            : {};
        const common = {
            generation: this.workerGeneration,
            engine: {
                family: 'sherpa-onnx',
                model: 'whisper-tiny-int8',
                packageVersion: this.readyInfo?.packageVersion || 'unknown',
                encoderSha256: this.readyInfo?.encoderSha256 || null,
                decoderSha256: this.readyInfo?.decoderSha256 || null,
                numThreads: this.config.numThreads,
            },
            metrics: {
                validationMs: pending.validationMs,
                queueMs: pending.queueMs,
                workerStartupMs: pending.workerStartupMs,
                workerColdStart: pending.workerColdStart,
                ...workerMetrics,
                bridgeWallMs: this._elapsed(pending.dispatchStartedAt),
                requestWallMs: this._elapsed(pending.requestStartedAt),
            },
            sample: pending.sample,
        };
        if (message.ok !== true || !/^[a-z]{2,3}$/.test(String(message.lang || ''))) {
            pending.finish(failureResult(
                boundedError(message.errorCode || 'inference-failed', 64),
                message.error || 'sherpa returned no valid language',
                common,
            ));
            return;
        }
        pending.finish({
            ok: true,
            lang: String(message.lang).toLowerCase(),
            probability: null,
            timedOut: false,
            errorCode: null,
            error: null,
            ...common,
        });
    }

    _handleWorkerFailure(worker, error) {
        if (this.worker !== worker) return;
        this.readyReject?.(new Error(error));
        if (this.pending?.worker === worker) {
            this.pending.finish(failureResult('worker-crashed', error, {
                generation: this.workerGeneration,
            }));
        }
        this.worker = null;
        this.readyInfo = null;
        this.readyPromise = null;
        this.readyResolve = null;
        this.readyReject = null;
        if (!this.closed) this.state = 'stopped';
    }

    async _retireWorker(worker) {
        if (!worker) return true;
        if (this.worker === worker) {
            this.worker = null;
            this.readyInfo = null;
            this.readyPromise = null;
            this.readyResolve = null;
            this.readyReject = null;
        }
        if (!this.closed) this.state = 'restarting';

        let termination;
        try {
            termination = Promise.resolve(worker.terminate());
        } catch (_) {
            termination = Promise.resolve();
        }
        const barrier = termination
            .catch(() => {})
            .finally(() => {
                if (this.restartBarrier === barrier) {
                    this.restartBarrier = null;
                    if (!this.closed && !this.worker) this.state = 'stopped';
                }
            });
        this.restartBarrier = barrier;
        return Promise.race([
            barrier.then(() => true),
            new Promise((resolve) =>
                setTimeout(() => resolve(false), this.config.terminateGraceMs)),
        ]);
    }
}

module.exports = {
    DEFAULT_MAX_AUDIO_SEC,
    MAX_ERROR_CHARS,
    SHERPA_LID_PROTOCOL,
    SherpaLidBridge,
    boundedError,
    inspectPcm16MonoWav,
    parsePcm16MonoWavHeader,
    resolveAllowedRegularFile,
};

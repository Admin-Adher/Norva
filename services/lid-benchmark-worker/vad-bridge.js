'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');

const PROTOCOL_VERSION = 1;

function boundedError(value) {
    return String(value?.message || value || 'VAD bridge failed')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200) || 'VAD bridge failed';
}

class VadBridge {
    constructor({
        workerPath = path.join(__dirname, 'vad-worker.js'),
        modelPath,
        modelRoot,
        modelSha256,
        sampleRoot,
        threshold = 0.25,
        minSilenceDuration = 0.5,
        minSpeechDuration = 0.25,
        minSpeechSeconds = 4,
        maxSpeechSeconds = 15,
        maxInputSeconds = 35,
        windowSize = 512,
        numThreads = 1,
        timeoutMs = 30_000,
        startupTimeoutMs = 120_000,
        WorkerImpl = Worker,
    }) {
        this.config = {
            workerPath: path.resolve(workerPath),
            modelPath: path.resolve(modelPath),
            modelRoot: path.resolve(modelRoot),
            modelSha256,
            sampleRoot: path.resolve(sampleRoot),
            threshold,
            minSilenceDuration,
            minSpeechDuration,
            minSpeechSeconds,
            maxSpeechSeconds,
            maxInputSeconds,
            windowSize,
            numThreads,
            timeoutMs,
            startupTimeoutMs,
        };
        this.WorkerImpl = WorkerImpl;
        this.worker = null;
        this.readyInfo = null;
        this.startPromise = null;
        this.pending = null;
        this.nextRequestId = 1;
        this.closed = false;
        this.generation = 0;
        this.lastError = null;
    }

    status() {
        return {
            protocol: PROTOCOL_VERSION,
            ready: Boolean(this.worker && this.readyInfo),
            busy: Boolean(this.pending),
            generation: this.generation,
            modelSha256: this.readyInfo?.modelSha256 || null,
            lastError: this.lastError,
        };
    }

    start() {
        if (this.closed) return Promise.reject(new Error('VAD bridge is closed'));
        if (this.worker && this.readyInfo) return Promise.resolve(this.readyInfo);
        if (this.startPromise) return this.startPromise;

        let worker;
        try {
            worker = new this.WorkerImpl(this.config.workerPath, {
                workerData: {
                    protocolVersion: PROTOCOL_VERSION,
                    modelPath: this.config.modelPath,
                    modelRoot: this.config.modelRoot,
                    modelSha256: this.config.modelSha256,
                    sampleRoot: this.config.sampleRoot,
                    threshold: this.config.threshold,
                    minSilenceDuration: this.config.minSilenceDuration,
                    minSpeechDuration: this.config.minSpeechDuration,
                    minSpeechSeconds: this.config.minSpeechSeconds,
                    maxSpeechSeconds: this.config.maxSpeechSeconds,
                    maxInputSeconds: this.config.maxInputSeconds,
                    windowSize: this.config.windowSize,
                    numThreads: this.config.numThreads,
                },
            });
        } catch (error) {
            return Promise.reject(error);
        }
        this.worker = worker;
        this.readyInfo = null;
        this.generation += 1;
        this.startPromise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('VAD startup timed out'));
                this._retire(worker);
            }, this.config.startupTimeoutMs);
            const settleReady = (message) => {
                clearTimeout(timer);
                this.readyInfo = {
                    modelSha256: String(message.modelSha256 || ''),
                };
                this.startPromise = null;
                this.lastError = null;
                resolve(this.readyInfo);
            };
            const settleError = (error) => {
                clearTimeout(timer);
                this.startPromise = null;
                this.lastError = boundedError(error);
                reject(error instanceof Error ? error : new Error(this.lastError));
            };
            worker.on('message', (message) => {
                if (this.worker !== worker) return;
                if (
                    message?.type === 'ready'
                    && message.protocolVersion === PROTOCOL_VERSION
                    && message.modelSha256 === this.config.modelSha256
                ) {
                    settleReady(message);
                    return;
                }
                if (message?.type === 'init-error') {
                    settleError(new Error(boundedError(message.error)));
                    this._retire(worker);
                    return;
                }
                if (message?.type === 'result') this._handleResult(worker, message);
            });
            worker.on('error', (error) => {
                settleError(error);
                this._handleFailure(worker, error);
            });
            worker.on('exit', (code) => {
                if (this.worker === worker) {
                    const error = new Error(`VAD worker exited with code ${code}`);
                    settleError(error);
                    this._handleFailure(worker, error);
                }
            });
        });
        return this.startPromise;
    }

    async extract(inputPath, outputPath, expectedSha256) {
        await this.start();
        if (!this.worker || !this.readyInfo) {
            throw new Error('VAD worker is unavailable');
        }
        if (this.pending) throw new Error('VAD worker is busy');
        const requestId = this.nextRequestId;
        this.nextRequestId = (this.nextRequestId % Number.MAX_SAFE_INTEGER) + 1;
        const worker = this.worker;
        const startedAt = performance.now();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.pending?.requestId !== requestId) return;
                this.pending = null;
                this.lastError = 'VAD request timed out';
                resolve({
                    ok: false,
                    hasSpeech: false,
                    errorCode: 'timeout',
                    error: this.lastError,
                    wallMs: Math.round((performance.now() - startedAt) * 100) / 100,
                });
                this._retire(worker);
            }, this.config.timeoutMs);
            this.pending = {
                worker,
                requestId,
                timer,
                resolve,
                startedAt,
            };
            worker.postMessage({
                type: 'extract',
                protocolVersion: PROTOCOL_VERSION,
                requestId,
                inputPath,
                outputPath,
                expectedSha256,
            });
        });
    }

    _handleResult(worker, message) {
        const pending = this.pending;
        if (
            !pending
            || pending.worker !== worker
            || pending.requestId !== message.requestId
        ) {
            return;
        }
        clearTimeout(pending.timer);
        this.pending = null;
        const common = {
            wallMs: Number.isFinite(message.wallMs)
                ? Math.round(message.wallMs * 100) / 100
                : Math.round((performance.now() - pending.startedAt) * 100) / 100,
        };
        if (message.ok !== true) {
            this.lastError = boundedError(message.error);
            pending.resolve({
                ok: false,
                hasSpeech: false,
                errorCode: String(message.errorCode || 'vad-failed').slice(0, 64),
                error: this.lastError,
                ...common,
            });
            return;
        }
        this.lastError = null;
        pending.resolve({
            ok: true,
            hasSpeech: message.hasSpeech === true,
            inputSeconds: Number(message.inputSeconds || 0),
            speechSeconds: Number(message.speechSeconds || 0),
            segmentCount: Number(message.segmentCount || 0),
            outputBytes: message.hasSpeech === true ? Number(message.outputBytes || 0) : 0,
            speechSha256: message.hasSpeech === true
                ? String(message.speechSha256 || '')
                : null,
            ...common,
        });
    }

    _handleFailure(worker, error) {
        if (this.worker !== worker) return;
        this.lastError = boundedError(error);
        if (this.pending?.worker === worker) {
            clearTimeout(this.pending.timer);
            this.pending.resolve({
                ok: false,
                hasSpeech: false,
                errorCode: 'worker-exited',
                error: this.lastError,
                wallMs: Math.round(
                    (performance.now() - this.pending.startedAt) * 100,
                ) / 100,
            });
            this.pending = null;
        }
        this.worker = null;
        this.readyInfo = null;
        this.startPromise = null;
    }

    _retire(worker) {
        if (!worker) return;
        if (this.worker === worker) {
            this.worker = null;
            this.readyInfo = null;
            this.startPromise = null;
        }
        try { worker.terminate(); } catch (_) {}
    }

    async close() {
        this.closed = true;
        const worker = this.worker;
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.resolve({
                ok: false,
                hasSpeech: false,
                errorCode: 'closed',
                error: 'VAD bridge closed',
                wallMs: 0,
            });
            this.pending = null;
        }
        this._retire(worker);
    }
}

module.exports = {
    PROTOCOL_VERSION,
    VadBridge,
};

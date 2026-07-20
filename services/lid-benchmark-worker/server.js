'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { EcapaLidWorker } = require('./engines/ecapa-lid');
const { SherpaLidBridge } = require('./engines/sherpa-lid-bridge');
const {
    POLICY_VERSION,
    PROTOCOL_VERSION,
    ROUTES,
    calibratedAgreement,
    calibrationFromEnv,
    fullFallbackLanguage,
    routeConfidence,
    whisperTiebreakLanguage,
} = require('./production-policy');
const { VadBridge } = require('./vad-bridge');
const { parsePcm16MonoWav } = require('./vad-worker');
const {
    runWhisperDetectOnly,
    runWhisperFull,
} = require('./whisper-runner');

const PORT = boundedInt(process.env.PORT, 8091, 1024, 65535);
const SAMPLE_ROOT = path.resolve(process.env.LID_SAMPLE_ROOT || '/tmp/norva-lid-samples');
const MODEL_ROOT = path.resolve(process.env.LID_MODEL_ROOT || '/opt/lid-models');
const WHISPER_BIN = path.resolve(process.env.WHISPER_BIN || '/usr/local/bin/whisper-cli');
const WHISPER_MODEL = path.resolve(
    process.env.WHISPER_MODEL || '/opt/whisper/ggml-model.bin',
);
const WHISPER_ROOT = path.dirname(WHISPER_MODEL);
const TOKEN = String(
    process.env.LID_WORKER_TOKEN
    || process.env.LID_BENCHMARK_WORKER_TOKEN
    || '',
);
const MAX_WAV_BYTES = boundedInt(
    process.env.LID_MAX_WAV_BYTES,
    1_200_000,
    64 * 1024,
    2 * 1024 * 1024,
);
const REQUEST_TIMEOUT_MS = boundedInt(
    process.env.LID_REQUEST_TIMEOUT_MS,
    120_000,
    5_000,
    300_000,
);
const WHISPER_DETECT_TIMEOUT_MS = boundedInt(
    process.env.LID_WHISPER_DETECT_TIMEOUT_MS,
    45_000,
    5_000,
    180_000,
);
const WHISPER_FULL_TIMEOUT_MS = boundedInt(
    process.env.LID_WHISPER_FULL_TIMEOUT_MS,
    120_000,
    10_000,
    300_000,
);
const WHISPER_THREADS = boundedInt(process.env.WHISPER_THREADS, 2, 1, 4);
const MAX_QUEUE = boundedInt(process.env.LID_MAX_QUEUE, 4, 1, 16);
const TIEBREAK_MIN_PROBABILITY = Math.max(
    0.95,
    boundedNumber(process.env.LID_WHISPER_TIEBREAK_MIN_PROBABILITY, 0.95, 0, 1),
);
const FULL_MIN_PROBABILITY = boundedNumber(
    process.env.LID_WHISPER_FULL_MIN_PROBABILITY,
    0.75,
    0.5,
    1,
);
const FULL_MIN_WORDS = boundedInt(process.env.LID_WHISPER_FULL_MIN_WORDS, 4, 1, 50);
const FULL_MIN_UNIQUE_WORDS = boundedInt(
    process.env.LID_WHISPER_FULL_MIN_UNIQUE_WORDS,
    2,
    1,
    50,
);
const ECAPA_REVISION = '0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9';
const SHERPA_REVISION = '65176e2deb88badc814a94058666cadccc29b61c';
const VAD_SHA256 = '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6';
const VAD_BYTES = 643_854;
const WHISPER_CPP_COMMIT = '080bbbe85230f624f0b52127f1ae1218247989f9';
const WHISPER_MODEL_SHA256 =
    '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b';
const VALID_MODES = new Set(['shadow', 'canary', 'primary']);
const calibration = calibrationFromEnv();

if (TOKEN.length < 32) {
    throw new Error(
        'LID_WORKER_TOKEN or LID_BENCHMARK_WORKER_TOKEN must contain at least 32 characters',
    );
}

function boundedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function boundedNumber(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function roundMs(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function boundedMetric(value, max = 3_600_000) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= max
        ? Math.round(number * 100) / 100
        : null;
}

function safeError(error) {
    return String(error?.message || error || 'engine failed')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replaceAll(SAMPLE_ROOT, '[sample-root]')
        .replaceAll(MODEL_ROOT, '[model-root]')
        .replaceAll(WHISPER_ROOT, '[whisper-root]')
        .trim()
        .slice(0, 200) || 'engine failed';
}

function timingCall(fn) {
    const startedAt = performance.now();
    return Promise.resolve()
        .then(fn)
        .then((result) => ({
            result,
            wallMs: roundMs(performance.now() - startedAt),
        }))
        .catch((error) => ({
            result: {
                ok: false,
                errorCode: String(error?.code || 'engine-failed').slice(0, 64),
                error: safeError(error),
            },
            wallMs: roundMs(performance.now() - startedAt),
        }));
}

function authorized(req, res, next) {
    const match = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    const supplied = Buffer.from(match?.[1] || '');
    const expected = Buffer.from(TOKEN);
    if (
        supplied.length !== expected.length
        || !crypto.timingSafeEqual(supplied, expected)
    ) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
}

function readManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(MODEL_ROOT, 'manifest.json'), 'utf8'));
    } catch (_) {
        return null;
    }
}

const manifest = readManifest();
const vadManifestFile = manifest?.vad?.files?.find(
    (entry) => entry?.name === 'silero_vad.onnx',
);
if (
    manifest?.ecapa?.revision !== ECAPA_REVISION
    || manifest?.sherpa?.revision !== SHERPA_REVISION
    || manifest?.vad?.revision !== VAD_SHA256
    || vadManifestFile?.sha256 !== VAD_SHA256
    || vadManifestFile?.bytes !== VAD_BYTES
) {
    throw new Error('Pinned model manifest is missing or has an unexpected revision');
}

async function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
}

async function readDigestFile(filePath) {
    const value = (await fsp.readFile(filePath, 'utf8')).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid build digest');
    return value;
}

async function verifyWhisperRuntime() {
    const [
        expectedBinSha256,
        expectedModelSha256,
        actualBinSha256,
        actualModelSha256,
        commit,
        modelName,
    ] = await Promise.all([
        readDigestFile(path.join(WHISPER_ROOT, 'bin.sha256')),
        readDigestFile(path.join(WHISPER_ROOT, 'model.sha256')),
        sha256File(WHISPER_BIN),
        sha256File(WHISPER_MODEL),
        fsp.readFile(path.join(WHISPER_ROOT, 'commit'), 'utf8'),
        fsp.readFile(path.join(WHISPER_ROOT, 'model-name'), 'utf8'),
    ]);
    if (
        actualBinSha256 !== expectedBinSha256
        || actualModelSha256 !== expectedModelSha256
        || actualModelSha256 !== WHISPER_MODEL_SHA256
        || commit.trim() !== WHISPER_CPP_COMMIT
        || modelName.trim() !== 'small'
    ) {
        throw new Error('pinned whisper runtime verification failed');
    }
    return Object.freeze({
        ready: true,
        commit: WHISPER_CPP_COMMIT,
        model: 'small',
        binarySha256: actualBinSha256,
        modelSha256: actualModelSha256,
    });
}

const ecapa = new EcapaLidWorker({
    pythonBin: process.env.ECAPA_PYTHON_BIN || '/opt/ecapa-venv/bin/python3',
    scriptPath: path.join(__dirname, 'engines/ecapa_lid_worker.py'),
    modelDir: path.join(MODEL_ROOT, 'ecapa'),
    modelRevision: ECAPA_REVISION,
    allowedRoot: SAMPLE_ROOT,
    threads: boundedInt(process.env.ECAPA_THREADS, 1, 1, 4),
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    startupTimeoutMs: REQUEST_TIMEOUT_MS,
    maxQueue: 1,
    maxWavBytes: MAX_WAV_BYTES,
});
const sherpa = new SherpaLidBridge({
    encoderPath: path.join(MODEL_ROOT, 'sherpa/tiny-encoder.int8.onnx'),
    decoderPath: path.join(MODEL_ROOT, 'sherpa/tiny-decoder.int8.onnx'),
    modelRoot: path.join(MODEL_ROOT, 'sherpa'),
    allowedWavRoot: SAMPLE_ROOT,
    numThreads: boundedInt(process.env.SHERPA_THREADS, 1, 1, 4),
    timeoutMs: REQUEST_TIMEOUT_MS,
    startupTimeoutMs: REQUEST_TIMEOUT_MS,
    maxAudioSec: 35,
});
const vad = new VadBridge({
    modelPath: process.env.LID_VAD_MODEL || path.join(MODEL_ROOT, 'vad/silero_vad.onnx'),
    modelRoot: MODEL_ROOT,
    modelSha256: VAD_SHA256,
    sampleRoot: SAMPLE_ROOT,
    threshold: boundedNumber(process.env.LID_VAD_THRESHOLD, 0.25, 0.01, 0.99),
    minSilenceDuration: boundedNumber(
        process.env.LID_VAD_MIN_SILENCE_SECONDS,
        0.5,
        0.1,
        3,
    ),
    minSpeechDuration: boundedNumber(
        process.env.LID_VAD_MIN_SEGMENT_SECONDS,
        0.25,
        0.05,
        2,
    ),
    minSpeechSeconds: 4,
    maxSpeechSeconds: 15,
    maxInputSeconds: 35,
    windowSize: 512,
    numThreads: 1,
    timeoutMs: boundedInt(process.env.LID_VAD_TIMEOUT_MS, 30_000, 5_000, 60_000),
    startupTimeoutMs: REQUEST_TIMEOUT_MS,
});

class QueueFullError extends Error {
    constructor() {
        super('Production LID queue is full');
        this.code = 'QUEUE_FULL';
    }
}

class BoundedSerialQueue {
    constructor(capacity) {
        this.capacity = capacity;
        this.active = false;
        this.items = [];
        this.completed = 0;
        this.failed = 0;
    }

    get size() {
        return this.items.length + (this.active ? 1 : 0);
    }

    submit(run) {
        if (this.size >= this.capacity) return Promise.reject(new QueueFullError());
        return new Promise((resolve, reject) => {
            this.items.push({ run, resolve, reject });
            this._drain();
        });
    }

    _drain() {
        if (this.active || !this.items.length) return;
        this.active = true;
        const item = this.items.shift();
        Promise.resolve()
            .then(item.run)
            .then((result) => {
                this.completed += 1;
                item.resolve(result);
            })
            .catch((error) => {
                this.failed += 1;
                item.reject(error);
            })
            .finally(() => {
                this.active = false;
                this._drain();
            });
    }

    status() {
        return {
            active: this.active,
            depth: this.items.length,
            capacity: this.capacity,
            completed: this.completed,
            failed: this.failed,
        };
    }
}

const productionQueue = new BoundedSerialQueue(MAX_QUEUE);
const app = express();
app.disable('x-powered-by');
let benchmarkBusy = false;
let benchmarkCompleted = 0;
let benchmarkFailed = 0;
let startupError = null;
let whisperRuntime = null;
let httpServer = null;

function isReady() {
    return Boolean(
        startupError === null
        && whisperRuntime?.ready === true
        && ecapa.health().ready === true
        && sherpa.status().ready === true
        && vad.status().ready === true
    );
}

function publicCalibration() {
    return {
        revision: calibration.revision,
        fastEligible: calibration.fastEligible,
        ecapaMinProbability: calibration.ecapaMinProbability,
        ecapaMinMargin: calibration.ecapaMinMargin,
        ecapaMaxEntropy: calibration.ecapaMaxEntropy,
    };
}

app.get('/livez', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        ok: true,
        service: 'norva-lid-worker',
        protocolVersion: PROTOCOL_VERSION,
    });
});

app.get('/readyz', (_req, res) => {
    const ready = isReady();
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({
        ok: ready,
        service: 'norva-lid-worker',
        protocolVersion: PROTOCOL_VERSION,
        policyVersion: POLICY_VERSION,
        calibration: publicCalibration(),
        queue: productionQueue.status(),
    });
});

app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        ok: isReady(),
        service: 'norva-lid-worker',
        schemaVersion: 2,
        protocolVersion: PROTOCOL_VERSION,
        policyVersion: POLICY_VERSION,
        benchmarkBusy,
        startupError,
        models: manifest,
        calibration: publicCalibration(),
        queue: productionQueue.status(),
        engines: {
            ecapa: ecapa.health(),
            sherpa: sherpa.status(),
            vad: vad.status(),
            whisper: whisperRuntime,
        },
        benchmark: {
            completed: benchmarkCompleted,
            failed: benchmarkFailed,
        },
        system: {
            load: os.loadavg(),
            rssBytes: process.memoryUsage().rss,
        },
    });
});

function sanitizeEcapa(result) {
    return {
        ok: result?.ok === true,
        language: result?.ok === true ? String(result.candidateLanguage || '') : null,
        probability: result?.ok === true ? boundedMetric(result.probability, 1) : null,
        margin: result?.ok === true ? boundedMetric(result.margin, 10) : null,
        entropy: result?.ok === true ? boundedMetric(result.entropy, 20) : null,
        inferenceMs: boundedMetric(result?.metrics?.inferenceMs),
        errorCode: result?.ok === true
            ? null
            : String(result?.errorCode || 'engine-failed').slice(0, 64),
    };
}

function sanitizeSherpa(result) {
    return {
        ok: result?.ok === true,
        language: result?.ok === true ? String(result.lang || '') : null,
        inferenceMs: boundedMetric(result?.metrics?.inferenceMs),
        errorCode: result?.ok === true
            ? null
            : String(result?.errorCode || 'engine-failed').slice(0, 64),
    };
}

function sanitizeWhisper(result) {
    return {
        ok: result?.ok === true,
        language: result?.ok === true ? String(result.lang || '') : null,
        probability: result?.ok === true ? boundedMetric(result.prob, 1) : null,
        wordCount: Number.isSafeInteger(result?.wordCount) ? result.wordCount : null,
        uniqueWordCount: Number.isSafeInteger(result?.uniqueWordCount)
            ? result.uniqueWordCount
            : null,
        timedOut: result?.timedOut === true,
        errorCode: result?.ok === true
            ? null
            : String(result?.errorCode || 'engine-failed').slice(0, 64),
    };
}

async function wipeAndUnlink(filePath) {
    let handle = null;
    try {
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) return;
        handle = await fsp.open(filePath, 'r+');
        const zeroes = Buffer.alloc(Math.min(64 * 1024, Math.max(1, stat.size)));
        for (let offset = 0; offset < stat.size; offset += zeroes.length) {
            await handle.write(zeroes, 0, Math.min(zeroes.length, stat.size - offset), offset);
        }
        await handle.sync();
        zeroes.fill(0);
    } catch (_) {
        // The file may never have been created; unlink below is still attempted.
    } finally {
        if (handle) await handle.close().catch(() => {});
        await fsp.unlink(filePath).catch(() => {});
    }
}

async function classifyProduction({
    body,
    digest,
    attemptId,
    policyVersion,
    mode,
}) {
    const requestStartedAt = performance.now();
    const inputBytes = body.length;
    const inputPath = path.join(SAMPLE_ROOT, `${crypto.randomUUID()}.wav`);
    const speechPath = path.join(SAMPLE_ROOT, `${crypto.randomUUID()}.speech.wav`);
    let vadCall = null;
    let ecapaCall = null;
    let sherpaCall = null;
    let detectOnlyCall = null;
    let fullCall = null;
    try {
        await fsp.writeFile(inputPath, body, { mode: 0o600, flag: 'wx' });
        body.fill(0);
        vadCall = await timingCall(() => vad.extract(inputPath, speechPath, digest));
        const vadResult = vadCall.result;
        if (vadResult?.ok !== true || vadResult?.hasSpeech !== true) {
            const cleanNoSpeech = vadResult?.ok === true && vadResult?.hasSpeech === false;
            return {
                ok: true,
                protocolVersion: PROTOCOL_VERSION,
                attemptId,
                policyVersion,
                mode,
                method: POLICY_VERSION,
                route: cleanNoSpeech ? 'pending-no-speech' : 'pending-disagreement',
                language: null,
                verified: false,
                persisted: false,
                sampleSha256: digest,
                sampleBytes: inputBytes,
                timings: {
                    totalMs: roundMs(performance.now() - requestStartedAt),
                    vadMs: vadCall.wallMs,
                    ecapaMs: null,
                    sherpaMs: null,
                    whisperDetectMs: null,
                    whisperFullMs: null,
                },
                evidence: {
                    confidence: null,
                    calibration: publicCalibration(),
                    vad: {
                        ok: vadResult?.ok === true,
                        hasSpeech: false,
                        inputSeconds: boundedMetric(vadResult?.inputSeconds, 35),
                        speechSeconds: boundedMetric(vadResult?.speechSeconds, 15),
                        segmentCount: Number.isSafeInteger(vadResult?.segmentCount)
                            ? Math.min(100, vadResult.segmentCount)
                            : null,
                        speechBytes: 0,
                        speechSha256: null,
                        modelSha256: VAD_SHA256,
                        errorCode: vadResult?.ok === true
                            ? null
                            : String(vadResult?.errorCode || 'vad-failed').slice(0, 64),
                    },
                    ecapa: null,
                    sherpa: null,
                    whisperDetectOnly: null,
                    whisperFull: null,
                    shadow: mode === 'shadow'
                        ? { baselineRan: false, selectedMatchesBaseline: null }
                        : null,
                },
            };
        }

        [ecapaCall, sherpaCall] = await Promise.all([
            timingCall(() => ecapa.classify(speechPath)),
            timingCall(() => sherpa.detect(speechPath)),
        ]);
        const ecapaResult = ecapaCall.result;
        const sherpaResult = sherpaCall.result;
        const consensusLanguage = calibratedAgreement(
            ecapaResult,
            sherpaResult,
            calibration,
        );
        let route = null;
        let language = null;

        if (consensusLanguage) {
            route = 'fast-consensus';
            language = consensusLanguage;
        } else {
            detectOnlyCall = await timingCall(() => runWhisperDetectOnly({
                bin: WHISPER_BIN,
                model: WHISPER_MODEL,
                wavPath: speechPath,
                threads: WHISPER_THREADS,
                timeoutMs: WHISPER_DETECT_TIMEOUT_MS,
            }));
            const tiebreakLanguage = whisperTiebreakLanguage(
                detectOnlyCall.result,
                ecapaResult,
                sherpaResult,
                calibration,
                TIEBREAK_MIN_PROBABILITY,
            );
            if (tiebreakLanguage) {
                route = 'whisper-tiebreak';
                language = tiebreakLanguage;
            }
        }

        const ensureFull = async () => {
            if (!fullCall) {
                fullCall = await timingCall(() => runWhisperFull({
                    bin: WHISPER_BIN,
                    model: WHISPER_MODEL,
                    wavPath: speechPath,
                    threads: WHISPER_THREADS,
                    timeoutMs: WHISPER_FULL_TIMEOUT_MS,
                }));
            }
            return fullCall;
        };

        if (!language) {
            const fallback = await ensureFull();
            const fallbackLanguage = fullFallbackLanguage(
                fallback.result,
                FULL_MIN_PROBABILITY,
                FULL_MIN_WORDS,
                FULL_MIN_UNIQUE_WORDS,
            );
            if (fallbackLanguage) {
                route = 'full-transcript-fallback';
                language = fallbackLanguage;
            } else {
                route = 'pending-disagreement';
                language = null;
            }
        }
        if (mode === 'shadow') await ensureFull();

        const baselineLanguage = fullCall
            ? fullFallbackLanguage(
                fullCall.result,
                FULL_MIN_PROBABILITY,
                FULL_MIN_WORDS,
                FULL_MIN_UNIQUE_WORDS,
            )
            : null;
        return {
            ok: true,
            protocolVersion: PROTOCOL_VERSION,
            attemptId,
            policyVersion,
            mode,
            method: POLICY_VERSION,
            route,
            language,
            verified: false,
            persisted: false,
            sampleSha256: digest,
            sampleBytes: inputBytes,
            timings: {
                totalMs: roundMs(performance.now() - requestStartedAt),
                vadMs: vadCall.wallMs,
                ecapaMs: ecapaCall.wallMs,
                sherpaMs: sherpaCall.wallMs,
                whisperDetectMs: detectOnlyCall?.wallMs ?? null,
                whisperFullMs: fullCall?.wallMs ?? null,
            },
            evidence: {
                confidence: routeConfidence(
                    route,
                    ecapaResult,
                    detectOnlyCall?.result,
                    fullCall?.result,
                ),
                calibration: publicCalibration(),
                vad: {
                    ok: true,
                    hasSpeech: true,
                    inputSeconds: boundedMetric(vadResult.inputSeconds, 35),
                    speechSeconds: boundedMetric(vadResult.speechSeconds, 15),
                    segmentCount: Number.isSafeInteger(vadResult.segmentCount)
                        ? Math.min(100, vadResult.segmentCount)
                        : null,
                    speechBytes: Number(vadResult.outputBytes || 0),
                    speechSha256: String(vadResult.speechSha256 || ''),
                    modelSha256: VAD_SHA256,
                    errorCode: null,
                },
                ecapa: sanitizeEcapa(ecapaResult),
                sherpa: sanitizeSherpa(sherpaResult),
                whisperDetectOnly: detectOnlyCall
                    ? sanitizeWhisper(detectOnlyCall.result)
                    : null,
                whisperFull: fullCall ? sanitizeWhisper(fullCall.result) : null,
                shadow: mode === 'shadow'
                    ? {
                        baselineRan: Boolean(fullCall),
                        baselineLanguage,
                        selectedMatchesBaseline: Boolean(
                            language
                            && baselineLanguage
                            && language === baselineLanguage
                        ),
                    }
                    : null,
            },
        };
    } finally {
        body.fill(0);
        await Promise.allSettled([
            wipeAndUnlink(inputPath),
            wipeAndUnlink(speechPath),
        ]);
    }
}

app.post(
    '/v1/classify',
    authorized,
    express.raw({
        type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'],
        limit: MAX_WAV_BYTES,
    }),
    async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            if (!isReady()) {
                res.setHeader('Retry-After', '30');
                return res.status(503).json({ error: 'LID worker is not ready' });
            }
            if (benchmarkBusy) {
                res.setHeader('Retry-After', '10');
                return res.status(429).json({ error: 'LID worker is busy' });
            }
            if (!Buffer.isBuffer(req.body) || req.body.length < 44) {
                return res.status(400).json({ error: 'A bounded WAV body is required' });
            }
            try {
                parsePcm16MonoWav(req.body, 35);
            } catch (_) {
                return res.status(400).json({
                    error: 'WAV must be bounded mono 16 kHz signed PCM16',
                });
            }

            const attemptId = String(req.get('x-norva-lid-attempt') || '');
            const policyVersion = String(req.get('x-norva-lid-policy') || '');
            const mode = String(req.get('x-norva-lid-mode') || '');
            const expectedDigest = String(
                req.get('x-norva-sample-sha256') || '',
            ).toLowerCase();
            if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId)) {
                return res.status(400).json({ error: 'Invalid LID attempt identifier' });
            }
            if (policyVersion !== POLICY_VERSION) {
                return res.status(400).json({ error: 'Unsupported LID policy' });
            }
            if (!VALID_MODES.has(mode)) {
                return res.status(400).json({ error: 'Unsupported LID mode' });
            }
            const digest = crypto.createHash('sha256').update(req.body).digest('hex');
            if (!/^[a-f0-9]{64}$/.test(expectedDigest) || expectedDigest !== digest) {
                return res.status(400).json({ error: 'WAV digest mismatch' });
            }

            const result = await productionQueue.submit(() => classifyProduction({
                body: req.body,
                digest,
                attemptId,
                policyVersion,
                mode,
            }));
            if (!ROUTES.includes(result.route)) {
                throw new Error('Internal route is outside the protocol allowlist');
            }
            return res.json(result);
        } catch (error) {
            if (error?.code === 'QUEUE_FULL') {
                res.setHeader('Retry-After', '10');
                return res.status(429).json({ error: 'Production LID queue is full' });
            }
            return res.status(500).json({
                error: 'LID classification failed',
                details: safeError(error),
            });
        } finally {
            if (Buffer.isBuffer(req.body)) req.body.fill(0);
        }
    },
);

app.post(
    '/benchmark',
    authorized,
    express.raw({
        type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'],
        limit: MAX_WAV_BYTES,
    }),
    async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (benchmarkBusy || productionQueue.size > 0) {
            res.setHeader('Retry-After', '10');
            if (Buffer.isBuffer(req.body)) req.body.fill(0);
            return res.status(429).json({ error: 'Benchmark worker is busy' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length < 44) {
            return res.status(400).json({ error: 'A bounded WAV body is required' });
        }
        const digest = crypto.createHash('sha256').update(req.body).digest('hex');
        const expectedDigest = String(req.get('x-norva-sample-sha256') || '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expectedDigest) || expectedDigest !== digest) {
            req.body.fill(0);
            return res.status(400).json({ error: 'WAV digest mismatch' });
        }

        benchmarkBusy = true;
        const requestStartedAt = performance.now();
        const wavPath = path.join(SAMPLE_ROOT, `${crypto.randomUUID()}.wav`);
        try {
            await fsp.writeFile(wavPath, req.body, { mode: 0o600, flag: 'wx' });
            req.body.fill(0);
            const requestedOrder = String(req.query.order || '');
            const order = requestedOrder === 'sherpa-first'
                ? ['sherpa', 'ecapa']
                : requestedOrder === 'ecapa-first'
                    ? ['ecapa', 'sherpa']
                    : benchmarkCompleted % 2 === 0
                        ? ['ecapa', 'sherpa']
                        : ['sherpa', 'ecapa'];
            const results = {};
            const run = {
                ecapa: () => ecapa.classify(wavPath),
                sherpa: () => sherpa.detect(wavPath),
            };
            for (const engine of order) {
                results[engine] = await timingCall(run[engine]);
            }
            benchmarkCompleted += 1;
            return res.json({
                ok: true,
                schemaVersion: 1,
                persisted: false,
                sample: {
                    sha256: digest,
                    wavBytes: Number(req.get('content-length') || 0) || null,
                },
                models: manifest,
                order,
                timings: {
                    totalMs: roundMs(performance.now() - requestStartedAt),
                    ecapaWallMs: results.ecapa.wallMs,
                    sherpaWallMs: results.sherpa.wallMs,
                },
                ecapa: results.ecapa.result,
                sherpa: results.sherpa.result,
                agreement: Boolean(
                    results.ecapa.result?.ok
                    && results.sherpa.result?.ok
                    && results.ecapa.result.candidateLanguage
                        === results.sherpa.result.lang
                ),
                system: {
                    load: os.loadavg(),
                    rssBytes: process.memoryUsage().rss,
                },
            });
        } catch (error) {
            benchmarkFailed += 1;
            return res.status(500).json({
                ok: false,
                persisted: false,
                error: safeError(error),
            });
        } finally {
            benchmarkBusy = false;
            if (Buffer.isBuffer(req.body)) req.body.fill(0);
            await wipeAndUnlink(wavPath);
        }
    },
);

app.use((error, req, res, _next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (Buffer.isBuffer(req.body)) req.body.fill(0);
    const tooLarge = error?.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'WAV exceeds the worker limit' : 'Invalid request body',
    });
});

app.use((_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: 'Not found' });
});

async function shutdown() {
    await Promise.allSettled([
        Promise.resolve(ecapa.close()),
        sherpa.close(),
        vad.close(),
    ]);
    if (httpServer) {
        await new Promise((resolve) => httpServer.close(resolve));
    }
    process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

fsp.mkdir(SAMPLE_ROOT, { recursive: true, mode: 0o700 })
    .then(async () => {
        whisperRuntime = await verifyWhisperRuntime();
        const [, sherpaResult] = await Promise.all([
            ecapa.start(),
            sherpa.start(),
            vad.start(),
        ]);
        if (sherpaResult?.ok !== true) {
            throw new Error(safeError(sherpaResult?.error));
        }
    })
    .catch((error) => {
        startupError = safeError(error);
        console.error(`[lid-worker] startup warning: ${startupError}`);
    })
    .finally(() => {
        httpServer = app.listen(PORT, '0.0.0.0', () => {
            console.log(`[lid-worker] listening on ${PORT}`);
        });
    });

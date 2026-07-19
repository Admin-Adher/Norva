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

const PORT = boundedInt(process.env.PORT, 8091, 1024, 65535);
const SAMPLE_ROOT = path.resolve(process.env.LID_SAMPLE_ROOT || '/tmp/norva-lid-samples');
const MODEL_ROOT = path.resolve(process.env.LID_MODEL_ROOT || '/opt/lid-models');
const TOKEN = String(process.env.LID_BENCHMARK_WORKER_TOKEN || '');
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
const ECAPA_REVISION = '0253049ae131d6a4be1c4f0d8b0ff483a0f8c8e9';
const SHERPA_REVISION = '65176e2deb88badc814a94058666cadccc29b61c';

if (TOKEN.length < 32) {
    throw new Error('LID_BENCHMARK_WORKER_TOKEN must contain at least 32 characters');
}

function boundedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function roundMs(value) {
    return Math.round(Number(value || 0) * 100) / 100;
}

function safeError(error) {
    return String(error?.message || error || 'engine failed')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replaceAll(SAMPLE_ROOT, '[sample-root]')
        .replaceAll(MODEL_ROOT, '[model-root]')
        .trim()
        .slice(0, 240) || 'engine failed';
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
if (
    manifest?.ecapa?.revision !== ECAPA_REVISION
    || manifest?.sherpa?.revision !== SHERPA_REVISION
) {
    throw new Error('Pinned model manifest is missing or has an unexpected revision');
}

const ecapa = new EcapaLidWorker({
    pythonBin: process.env.ECAPA_PYTHON_BIN || '/opt/ecapa-venv/bin/python3',
    scriptPath: path.join(__dirname, 'engines/ecapa_lid_worker.py'),
    modelDir: path.join(MODEL_ROOT, 'ecapa'),
    modelRevision: ECAPA_REVISION,
    allowedRoot: SAMPLE_ROOT,
    threads: boundedInt(process.env.ECAPA_THREADS, 2, 1, 8),
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
    numThreads: boundedInt(process.env.SHERPA_THREADS, 2, 1, 8),
    timeoutMs: REQUEST_TIMEOUT_MS,
    startupTimeoutMs: REQUEST_TIMEOUT_MS,
    maxAudioSec: 35,
});

const app = express();
app.disable('x-powered-by');
let busy = false;
let completed = 0;
let failed = 0;

app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        ok: true,
        service: 'norva-lid-benchmark-worker',
        schemaVersion: 1,
        busy,
        completed,
        failed,
        models: manifest,
        engines: {
            ecapa: ecapa.health(),
            sherpa: sherpa.status(),
        },
        system: {
            load: os.loadavg(),
            rssBytes: process.memoryUsage().rss,
        },
    });
});

app.post(
    '/benchmark',
    authorized,
    express.raw({
        type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'],
        limit: MAX_WAV_BYTES,
    }),
    async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (busy) {
            res.setHeader('Retry-After', '10');
            return res.status(429).json({ error: 'Benchmark worker is busy' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length < 44) {
            return res.status(400).json({ error: 'A bounded WAV body is required' });
        }
        const digest = crypto.createHash('sha256').update(req.body).digest('hex');
        const expectedDigest = String(req.get('x-norva-sample-sha256') || '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expectedDigest) || expectedDigest !== digest) {
            return res.status(400).json({ error: 'WAV digest mismatch' });
        }

        busy = true;
        const requestStartedAt = performance.now();
        const wavPath = path.join(SAMPLE_ROOT, `${crypto.randomUUID()}.wav`);
        try {
            await fsp.mkdir(SAMPLE_ROOT, { recursive: true, mode: 0o700 });
            await fsp.writeFile(wavPath, req.body, { mode: 0o600, flag: 'wx' });
            req.body.fill(0);

            const requestedOrder = String(req.query.order || '');
            const order = requestedOrder === 'sherpa-first'
                ? ['sherpa', 'ecapa']
                : requestedOrder === 'ecapa-first'
                    ? ['ecapa', 'sherpa']
                    : completed % 2 === 0
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
            completed += 1;
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
            failed += 1;
            return res.status(500).json({
                ok: false,
                persisted: false,
                error: safeError(error),
            });
        } finally {
            busy = false;
            await fsp.unlink(wavPath).catch(() => {});
        }
    },
);

app.use((error, _req, res, _next) => {
    res.setHeader('Cache-Control', 'no-store');
    const tooLarge = error?.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'WAV exceeds the benchmark limit' : 'Invalid request body',
    });
});

async function shutdown() {
    await Promise.allSettled([Promise.resolve(ecapa.close()), sherpa.close()]);
    process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

fsp.mkdir(SAMPLE_ROOT, { recursive: true, mode: 0o700 })
    .then(() => sherpa.start())
    .catch((error) => {
        console.error(`[lid-benchmark-worker] startup warning: ${safeError(error)}`);
    })
    .finally(() => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`[lid-benchmark-worker] listening on ${PORT}`);
        });
    });

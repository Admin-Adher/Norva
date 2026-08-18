'use strict';

const { PROTOCOL } = require('./fixture-registry');

const MAX_RESPONSE_BYTES = 64 * 1024;
const STATUSES = new Set(['pass', 'fail', 'blocked', 'cancelled']);
const PIPELINES = new Set([
    'cache-hit',
    'video-copy-audio-copy',
    'video-copy-audio-transcode',
    'video-transcode',
    'terminal-458',
]);
const METRICS = Object.freeze({
    ttffMs: [600_000, false],
    manifestReadyMs: [600_000, false],
    firstSegmentMs: [600_000, false],
    bufferedAheadSeconds: [3_600, false],
    productionRateX: [100, false],
    browserBufferRateX: [100, false],
    rebufferCount: [1_000, true],
    rebufferMs: [600_000, false],
    ffmpegSpawns: [8, true],
    analyzerSpawns: [8, true],
    seekPassed: [1, false],
    audioPassed: [1, false],
});

function configurationUrl(value) {
    let parsed;
    try { parsed = new URL(String(value || '')); } catch (_) { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash) throw new Error('MEDIA_LAB_PHYSICAL_ADAPTER_URL_INVALID');
    return parsed.toString().replace(/\/+$/, '');
}

function boundedToken(value) {
    const token = String(value || '');
    if (token.length < 32 || token.length > 8_192 || /\s/.test(token)) {
        throw new Error('MEDIA_LAB_PHYSICAL_ADAPTER_TOKEN_INVALID');
    }
    return token;
}

function boundedReason(value) {
    return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value) ? value : null;
}

function boundedMetric(value, maximum, integer) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum
        || (integer && !Number.isInteger(value))) return null;
    return value;
}

function projectPhysicalEvidence(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || value.protocol !== PROTOCOL || value.kind !== 'norva-media-lab-physical-v1'
        || !STATUSES.has(value.status) || !PIPELINES.has(value.pipeline)) {
        throw new Error('MEDIA_LAB_PHYSICAL_EVIDENCE_INVALID');
    }
    const reason = boundedReason(value.reason);
    if (!reason) throw new Error('MEDIA_LAB_PHYSICAL_EVIDENCE_INVALID');
    const rawMetrics = value.metrics && typeof value.metrics === 'object' && !Array.isArray(value.metrics)
        ? value.metrics
        : {};
    const metrics = {};
    for (const [name, [maximum, integer]] of Object.entries(METRICS)) {
        if (name === 'seekPassed' || name === 'audioPassed') {
            metrics[name] = rawMetrics[name] === true;
            continue;
        }
        metrics[name] = boundedMetric(rawMetrics[name], maximum, integer);
    }
    if ((value.status === 'pass' || value.status === 'fail')
        && Object.entries(metrics).some(([name, metric]) => !['seekPassed', 'audioPassed'].includes(name) && metric === null)) {
        throw new Error('MEDIA_LAB_PHYSICAL_EVIDENCE_INVALID');
    }
    return Object.freeze({
        protocol: PROTOCOL,
        kind: 'norva-media-lab-physical-v1',
        status: value.status,
        pipeline: value.pipeline,
        reason,
        gatewayObserved: value.gatewayObserved === true,
        browserObserved: value.browserObserved === true,
        cleanupObserved: value.cleanupObserved === true,
        metrics: Object.freeze(metrics),
    });
}

async function boundedJson(response) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error('MEDIA_LAB_PHYSICAL_RESPONSE_TOO_LARGE');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('MEDIA_LAB_PHYSICAL_RESPONSE_TOO_LARGE');
    try { return JSON.parse(bytes.toString('utf8')); } catch (_) {
        throw new Error('MEDIA_LAB_PHYSICAL_RESPONSE_INVALID');
    }
}

class HttpPhysicalAdapter {
    constructor({ url, token, fetchImpl = globalThis.fetch } = {}) {
        this.url = configurationUrl(url);
        this.token = boundedToken(token);
        if (typeof fetchImpl !== 'function') throw new Error('MEDIA_LAB_PHYSICAL_FETCH_INVALID');
        this.fetchImpl = fetchImpl;
    }

    async runPhysicalCase({ protocol, fixture, providerUrl, signal }) {
        if (protocol !== PROTOCOL || !fixture?.id || (providerUrl !== null && typeof providerUrl !== 'string')) {
            throw new Error('MEDIA_LAB_PHYSICAL_REQUEST_INVALID');
        }
        const response = await this.fetchImpl(`${this.url}/v1/run`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ protocol: PROTOCOL, fixtureId: fixture.id, providerUrl }),
            signal,
            redirect: 'error',
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new Error('MEDIA_LAB_PHYSICAL_ADAPTER_REFUSED');
        }
        return projectPhysicalEvidence(await boundedJson(response));
    }
}

module.exports = Object.freeze({
    HttpPhysicalAdapter,
    projectPhysicalEvidence,
});

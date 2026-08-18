'use strict';

const { PROTOCOL } = require('./fixture-registry');

const PIPELINES = new Set([
    'cache-hit',
    'video-copy-audio-copy',
    'video-copy-audio-transcode',
    'video-transcode',
    'terminal-458',
]);
const STATUSES = new Set(['pass', 'fail', 'blocked', 'cancelled']);
const METRICS = Object.freeze({
    ttffMs: [600_000, false],
    manifestReadyMs: [600_000, false],
    firstSegmentMs: [600_000, false],
    bufferedAheadSeconds: [3_600, false],
    productionRateX: [100, false],
    browserBufferRateX: [100, false],
    rebufferCount: [1_000, true],
    rebufferMs: [600_000, false],
    providerGets: [32, true],
    maximumConcurrentProviderGets: [32, true],
    ffmpegSpawns: [8, true],
    analyzerSpawns: [8, true],
    http458: [8, true],
    retriesAfter458: [8, true],
});

function safeReason(value) {
    return typeof value === 'string'
        && value.length <= 64
        && /^[a-z0-9][a-z0-9._-]*$/.test(value)
        ? value
        : null;
}

function metric(value, maximum, integer) {
    if (value === undefined || value === null) return null;
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || value < 0
        || value > maximum
        || (integer && !Number.isInteger(value))
    ) {
        throw new Error('INVALID_MEDIA_LAB_RESULT');
    }
    return integer ? value : Math.round(value * 1_000) / 1_000;
}

function projectResult(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('INVALID_MEDIA_LAB_RESULT');
    }
    const status = STATUSES.has(value.status) ? value.status : null;
    const pipeline = PIPELINES.has(value.pipeline) ? value.pipeline : null;
    const reason = safeReason(value.reason);
    if (!status || !pipeline || !reason) throw new Error('INVALID_MEDIA_LAB_RESULT');

    const projected = {
        protocol: PROTOCOL,
        status,
        pipeline,
        reason,
    };
    for (const [name, [maximum, integer]] of Object.entries(METRICS)) {
        projected[name] = metric(value[name], maximum, integer);
    }
    if ((status === 'pass' || status === 'fail') && Object.keys(METRICS).some((name) => projected[name] === null)) {
        throw new Error('INVALID_MEDIA_LAB_RESULT');
    }
    projected.seekPassed = value.seekPassed === true;
    projected.audioPassed = value.audioPassed === true;
    projected.cleanupPassed = value.cleanupPassed === true;
    return Object.freeze(projected);
}

function blockedResult(fixture, reason) {
    return projectResult({
        status: 'blocked',
        pipeline: fixture.expected.pipeline,
        reason,
    });
}

module.exports = Object.freeze({ projectResult, blockedResult });

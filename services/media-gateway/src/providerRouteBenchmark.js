'use strict';

const { performance } = require('node:perf_hooks');
const {
    MAX_RESUME_RANGE_START_BYTES,
    MIB,
    benchmarkProviderRoutesSequentially,
} = require('./providerAdaptiveRoute');

const BENCHMARK_PROTOCOL = 1;
const MAX_BENCHMARK_RANGE_START_BYTES = MAX_RESUME_RANGE_START_BYTES;
const MEASUREMENT_KEYS = Object.freeze([
    'first16MiBMs',
    'first4MiBMs',
    'http5xx',
    'nodeTransport',
    'phase',
    'provider458',
    'proxy407',
    'rangeStartBytes',
    'rangeSeekOk',
    'resets',
    'sampleBytes',
    'slot',
    'success',
    'throughputBytesPerSecond',
    'timeouts',
    'ttfbMs',
    'varianceRatio',
]);

function boundedInteger(value, fallback, minimum, maximum) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function boundedNumber(value, fallback, minimum, maximum) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
}

function abortError() {
    const error = new Error('Provider route benchmark aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}

function combinedAbortController(parentSignal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort(parentSignal?.reason || abortError());
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Provider route benchmark timeout'));
    }, timeoutMs);
    return {
        signal: controller.signal,
        timedOut: () => timedOut,
        dispose() {
            clearTimeout(timer);
            parentSignal?.removeEventListener('abort', abortFromParent);
        },
    };
}

function safeHeader(headers, name) {
    try { return String(headers?.get?.(name) || ''); } catch (_) { return ''; }
}

function parsedContentRange(value) {
    const match = String(value || '').trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = match[3] === '*' ? null : Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
    if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
    return { start, end, total };
}

function coefficientOfVariation(samples) {
    const values = samples.filter((value) => Number.isFinite(value) && value >= 0);
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (mean <= 0) return 0;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
    return Number(Math.min(100, Math.sqrt(variance) / mean).toFixed(5));
}

function emptyMeasurement(candidate, sampleBytes, rangeStartBytes = 0) {
    return {
        slot: candidate.slot,
        nodeTransport: candidate.nodeTransport,
        phase: null,
        sampleBytes,
        rangeStartBytes,
        success: false,
        ttfbMs: null,
        first4MiBMs: null,
        first16MiBMs: null,
        throughputBytesPerSecond: 0,
        varianceRatio: 0,
        rangeSeekOk: false,
        resets: 0,
        timeouts: 0,
        proxy407: 0,
        provider458: 0,
        http5xx: 0,
    };
}

function classifyBenchmarkFailure(measurement, status, error, timedOut) {
    if (status === 407) measurement.proxy407 = 1;
    else if (status === 458) measurement.provider458 = 1;
    else if (status >= 500 && status <= 599) measurement.http5xx = 1;
    if (timedOut) measurement.timeouts = 1;
    else if (error && error.name !== 'AbortError') measurement.resets = 1;
    return measurement;
}

async function cancelResponseBody(response) {
    try { await response?.body?.cancel?.(); } catch (_) { /* best effort */ }
}

async function measureProviderRoute({
    candidate,
    createDispatcher,
    fetchImpl = globalThis.fetch,
    sampleBytes,
    rangeStartBytes = 0,
    signal = null,
    sourceUrl,
    timeoutMs = 60_000,
    userAgent = 'VLC/3.0.20 LibVLC/3.0.20',
} = {}) {
    if (!candidate || typeof createDispatcher !== 'function' || typeof fetchImpl !== 'function') {
        throw new TypeError('Provider route benchmark dependencies are required');
    }
    const boundedSampleBytes = boundedInteger(sampleBytes, MIB, 256 * 1024, 16 * MIB);
    const boundedRangeStartBytes = boundedInteger(
        rangeStartBytes,
        0,
        0,
        MAX_BENCHMARK_RANGE_START_BYTES,
    );
    const boundedTimeoutMs = boundedInteger(timeoutMs, 60_000, 1_000, 180_000);
    const measurement = emptyMeasurement(candidate, boundedSampleBytes, boundedRangeStartBytes);
    const guard = combinedAbortController(signal, boundedTimeoutMs);
    const dispatcher = createDispatcher(candidate);
    const startedAt = performance.now();
    let response = null;
    let reader = null;
    try {
        if (guard.signal.aborted) throw abortError();
        response = await fetchImpl(sourceUrl, {
            method: 'GET',
            headers: {
                accept: '*/*',
                'accept-encoding': 'identity',
                connection: 'keep-alive',
                range: `bytes=${boundedRangeStartBytes}-${boundedRangeStartBytes + boundedSampleBytes - 1}`,
                'user-agent': userAgent,
            },
            redirect: 'follow',
            signal: guard.signal,
            dispatcher,
        });
        measurement.ttfbMs = Math.max(0, Math.round(performance.now() - startedAt));
        const status = Number(response?.status || 0);
        if (status !== 200 && status !== 206) {
            classifyBenchmarkFailure(measurement, status, null, false);
            await cancelResponseBody(response);
            response = null;
            return measurement;
        }
        const contentRange = parsedContentRange(safeHeader(response.headers, 'content-range'));
        measurement.rangeSeekOk = status === 206 && contentRange?.start === boundedRangeStartBytes;
        measurement.resourceSizeBytes = contentRange?.total || null;
        if (!response.body || typeof response.body.getReader !== 'function') {
            measurement.resets = 1;
            return measurement;
        }
        reader = response.body.getReader();
        let received = 0;
        let lastCheckpointBytes = 0;
        let lastCheckpointAt = performance.now();
        const throughputWindows = [];
        while (received < boundedSampleBytes) {
            if (guard.signal.aborted) throw abortError();
            const { value, done } = await reader.read();
            if (done) break;
            const bytes = Math.min(Number(value?.byteLength || 0), boundedSampleBytes - received);
            if (bytes <= 0) continue;
            received += bytes;
            const elapsed = Math.max(0, Math.round(performance.now() - startedAt));
            if (measurement.first4MiBMs === null && received >= 4 * MIB) measurement.first4MiBMs = elapsed;
            if (measurement.first16MiBMs === null && received >= 16 * MIB) measurement.first16MiBMs = elapsed;
            if (received - lastCheckpointBytes >= MIB || received >= boundedSampleBytes) {
                const now = performance.now();
                const seconds = Math.max(0.001, (now - lastCheckpointAt) / 1000);
                throughputWindows.push((received - lastCheckpointBytes) / seconds);
                lastCheckpointAt = now;
                lastCheckpointBytes = received;
            }
        }
        try { await reader.cancel(); } catch (_) { /* bounded sample complete */ }
        const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
        measurement.throughputBytesPerSecond = Math.max(0, Math.round(received / elapsedSeconds));
        measurement.varianceRatio = coefficientOfVariation(throughputWindows);
        measurement.success = received >= Math.min(boundedSampleBytes, MIB);
        if (!measurement.success) measurement.resets = 1;
        return measurement;
    } catch (error) {
        if (signal?.aborted) throw abortError();
        classifyBenchmarkFailure(measurement, Number(response?.status || 0), error, guard.timedOut());
        return measurement;
    } finally {
        if (reader) {
            try { reader.releaseLock(); } catch (_) { /* already released */ }
        } else {
            await cancelResponseBody(response);
        }
        try { await dispatcher?.close?.(); } catch (_) { /* isolated dispatcher */ }
        guard.dispose();
    }
}

function normalizePolicy(value = {}) {
    return {
        routeTtlMs: boundedInteger(value.routeTtlSeconds, 604_800, 300, 2_592_000) * 1000,
        minimumConfidence: boundedNumber(value.minimumConfidence, 0.65, 0, 1),
        minimumRelativeGain: boundedNumber(value.minimumRelativeGain, 0.2, 0.05, 2),
        sustainedCandidateWins: boundedInteger(value.sustainedCandidateWins, 3, 2, 12),
        consecutiveFailureThreshold: boundedInteger(value.consecutiveFailureThreshold, 3, 2, 12),
        tinyProbeBytes: boundedInteger(value.tinyProbeBytes, MIB, 256 * 1024, 4 * MIB),
        sustainedProbeBytes: boundedInteger(value.sustainedProbeBytes, 16 * MIB, 4 * MIB, 16 * MIB),
        resumeProbeBytes: boundedInteger(value.resumeProbeBytes, MIB, 256 * 1024, 4 * MIB),
        topCandidateCount: boundedInteger(value.topCandidateCount, 2, 1, 4),
        benchmarkLeaseSeconds: boundedInteger(value.benchmarkLeaseSeconds, 120, 15, 600),
    };
}

function serializableMeasurements(measurements) {
    return (Array.isArray(measurements) ? measurements : []).map((measurement) => {
        const normalized = {};
        for (const key of MEASUREMENT_KEYS) normalized[key] = measurement[key] ?? null;
        return normalized;
    });
}

async function runLeasedProviderRouteBenchmark({
    accountFingerprint,
    candidates,
    control,
    hostFingerprint,
    isAccountIdle,
    onLeaseAcquired = null,
    onLeaseReleased = null,
    ownerInstanceFingerprint,
    probe,
    pulseIntervalMs = 1_000,
    signal = null,
} = {}) {
    if (typeof control !== 'function' || typeof probe !== 'function' || typeof isAccountIdle !== 'function') {
        throw new TypeError('Provider route benchmark control callbacks are required');
    }
    const claim = await control('claim', {
        accountFingerprint,
        hostFingerprint,
        ownerInstanceFingerprint,
    }, { signal });
    if (!claim?.granted || !claim.leaseToken) {
        return { status: claim?.reason || 'lease-unavailable', measurements: [], rankings: [] };
    }
    const leaseToken = claim.leaseToken;
    const policy = normalizePolicy(claim.policy);
    let preempted = false;
    const benchmarkController = new AbortController();
    const abortFromParent = () => benchmarkController.abort(signal?.reason || abortError());
    if (signal?.aborted) abortFromParent();
    else signal?.addEventListener('abort', abortFromParent, { once: true });
    let pulseInFlight = null;
    const pulseLease = async () => {
        if (benchmarkController.signal.aborted) return false;
        if (!pulseInFlight) {
            pulseInFlight = control('pulse', {
                accountFingerprint,
                leaseToken,
            }, { signal: benchmarkController.signal }).finally(() => { pulseInFlight = null; });
        }
        let pulse;
        try { pulse = await pulseInFlight; } catch (_) { pulse = null; }
        if (!pulse?.active || pulse.preemptRequested === true) {
            preempted = true;
            benchmarkController.abort(abortError());
            return false;
        }
        return true;
    };
    const pulseTimer = setInterval(
        () => { pulseLease().catch(() => {}); },
        Math.max(10, Math.min(5_000, Number(pulseIntervalMs) || 1_000)),
    );
    const leasedIdleCheck = async () => {
        if (benchmarkController.signal.aborted || !await isAccountIdle()) return false;
        return pulseLease();
    };
    try {
        if (typeof onLeaseAcquired === 'function') {
            await onLeaseAcquired({ accountFingerprint, hostFingerprint, leaseToken, policy });
        }
        let result;
        try {
            result = await benchmarkProviderRoutesSequentially({
                candidates,
                probe,
                isAccountIdle: leasedIdleCheck,
                signal: benchmarkController.signal,
                policy,
            });
        } catch (error) {
            if (benchmarkController.signal.aborted || error?.name === 'AbortError') {
                result = { status: 'preempted', measurements: [], rankings: [] };
            } else {
                throw error;
            }
        }
        clearInterval(pulseTimer);
        if (result.status !== 'completed' || preempted || benchmarkController.signal.aborted) {
            return { ...result, status: 'preempted' };
        }
        const report = await control('report', {
            accountFingerprint,
            hostFingerprint,
            leaseToken,
            measurements: serializableMeasurements(result.measurements),
        }, { signal });
        return {
            ...result,
            status: report?.accepted === true ? 'completed' : 'report-rejected',
            appliedDecision: report?.decision || null,
        };
    } finally {
        clearInterval(pulseTimer);
        signal?.removeEventListener('abort', abortFromParent);
        if (typeof onLeaseReleased === 'function') {
            await onLeaseReleased({ accountFingerprint, hostFingerprint, leaseToken }).catch(() => null);
        }
        await control('release', { accountFingerprint, leaseToken }, {}).catch(() => null);
    }
}

module.exports = {
    BENCHMARK_PROTOCOL,
    MAX_BENCHMARK_RANGE_START_BYTES,
    MEASUREMENT_KEYS,
    coefficientOfVariation,
    measureProviderRoute,
    normalizePolicy,
    runLeasedProviderRouteBenchmark,
    serializableMeasurements,
};

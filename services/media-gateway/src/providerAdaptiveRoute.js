'use strict';

const crypto = require('node:crypto');

const MIB = 1024 * 1024;
const MAX_RESUME_RANGE_START_BYTES = (128 * 1024 * MIB) - 1;
const NODE_TRANSPORTS = new Set(['http', 'socks5']);
const DEFAULT_ROUTE_POLICY = Object.freeze({
    routeTtlMs: 7 * 24 * 60 * 60 * 1000,
    minimumConfidence: 0.65,
    minimumRelativeGain: 0.2,
    sustainedCandidateWins: 3,
    consecutiveFailureThreshold: 3,
    tinyProbeBytes: 1 * MIB,
    sustainedProbeBytes: 16 * MIB,
    resumeProbeBytes: 1 * MIB,
    topCandidateCount: 2,
});

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInteger(value) {
    return Math.max(0, Math.trunc(finiteNumber(value, 0)));
}

function routeId(route) {
    const slot = Number(route?.slot);
    const nodeTransport = String(route?.nodeTransport || '');
    if (!Number.isInteger(slot) || slot < 1 || slot > 32 || !NODE_TRANSPORTS.has(nodeTransport)) {
        throw new TypeError('Provider route is invalid');
    }
    return `${slot}:${nodeTransport}`;
}

function buildProviderRouteCandidates({ httpProxyUrls = [], socksProxyUrls = [] } = {}) {
    if (!Array.isArray(httpProxyUrls) || !Array.isArray(socksProxyUrls)) {
        throw new TypeError('Provider proxy pools must be arrays');
    }
    if (!httpProxyUrls.length) return [];
    if (socksProxyUrls.length && socksProxyUrls.length !== httpProxyUrls.length) {
        throw new TypeError('SOCKS5 and HTTP provider proxy pools must have matching slots');
    }

    const candidates = [];
    for (let index = 0; index < httpProxyUrls.length; index += 1) {
        candidates.push(Object.freeze({
            id: `${index + 1}:http`,
            slot: index + 1,
            nodeTransport: 'http',
            ffmpegTransport: 'http',
            ffmpegSlot: index + 1,
        }));
        if (socksProxyUrls.length) {
            candidates.push(Object.freeze({
                id: `${index + 1}:socks5`,
                slot: index + 1,
                nodeTransport: 'socks5',
                ffmpegTransport: 'http',
                ffmpegSlot: index + 1,
            }));
        }
    }
    return candidates;
}

function decodeOnce(value) {
    try {
        return decodeURIComponent(String(value || ''));
    } catch (_) {
        return String(value || '');
    }
}

function providerCapabilityParts(sourceUrl) {
    let parsed;
    try {
        parsed = new URL(sourceUrl);
    } catch (_) {
        throw new TypeError('Provider capability URL is invalid');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) {
        throw new TypeError('Provider capability URL is invalid');
    }

    let username = parsed.searchParams.get('username') || '';
    let password = parsed.searchParams.get('password') || '';
    const segments = parsed.pathname.split('/').filter(Boolean);
    const streamTypeIndex = segments.findIndex((segment) =>
        ['movie', 'series', 'live'].includes(String(segment || '').toLowerCase()));
    if ((!username || !password) && streamTypeIndex >= 0) {
        username = username || decodeOnce(segments[streamTypeIndex + 1]);
        password = password || decodeOnce(segments[streamTypeIndex + 2]);
    }

    const host = parsed.host.toLowerCase();
    if (username && password) return { host, capability: `${host}\0${username}\0${password}` };

    // Opaque playlist capabilities have no reusable account tuple. Hash the exact
    // capability rather than grouping unrelated signed URLs under a host-only key.
    parsed.hash = '';
    return { host, capability: `${host}\0opaque\0${parsed.href}` };
}

function assertFingerprintKey(key) {
    const bytes = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ''), 'utf8');
    if (bytes.length < 32) throw new TypeError('Provider route fingerprint key must be at least 32 bytes');
    return bytes;
}

function providerRouteFingerprints(sourceUrl, fingerprintKey) {
    const key = assertFingerprintKey(fingerprintKey);
    const parts = providerCapabilityParts(sourceUrl);
    const digest = (domain, value) => crypto.createHmac('sha256', key)
        .update(domain)
        .update('\0')
        .update(value)
        .digest('hex');
    return Object.freeze({
        protocol: 1,
        accountFingerprint: digest('norva-provider-route-account-v1', parts.capability),
        hostFingerprint: digest('norva-provider-route-host-v1', parts.host),
    });
}

function scoreProviderRouteMeasurement(measurement = {}) {
    const proxy407 = nonNegativeInteger(measurement.proxy407);
    if (proxy407 > 0 || measurement.success === false) return 0;

    const ttfbMs = Math.max(0, finiteNumber(measurement.ttfbMs, 30_000));
    const first4MiBMs = Math.max(ttfbMs, finiteNumber(measurement.first4MiBMs, 60_000));
    const first16MiBMs = Math.max(first4MiBMs, finiteNumber(measurement.first16MiBMs, 120_000));
    const throughputBytesPerSecond = Math.max(0, finiteNumber(measurement.throughputBytesPerSecond, 0));
    const varianceRatio = clamp(finiteNumber(measurement.varianceRatio, 1), 0, 4);
    const resets = nonNegativeInteger(measurement.resets);
    const timeouts = nonNegativeInteger(measurement.timeouts);
    const http5xx = nonNegativeInteger(measurement.http5xx);
    const provider458 = nonNegativeInteger(measurement.provider458);

    const ttfbScore = Math.exp(-ttfbMs / 3_000);
    const first4Score = Math.exp(-first4MiBMs / 8_000);
    const first16Score = Math.exp(-first16MiBMs / 20_000);
    const throughputScore = clamp(
        Math.log2(1 + throughputBytesPerSecond / MIB) / Math.log2(65),
        0,
        1,
    );
    const stabilityScore = 1 - clamp(varianceRatio, 0, 1);
    const rangeScore = measurement.rangeSeekOk === true ? 1 : 0;
    const base = (
        0.2 * ttfbScore +
        0.18 * first4Score +
        0.2 * first16Score +
        0.27 * throughputScore +
        0.1 * stabilityScore +
        0.05 * rangeScore
    );
    // 458 is retained for diagnosis but is commonly an account-concurrency signal,
    // so it cannot independently rotate a residential route.
    const penalty = Math.min(0.95,
        resets * 0.12 + timeouts * 0.3 + http5xx * 0.16 + provider458 * 0.01);
    return Number((100 * Math.max(0, base - penalty)).toFixed(3));
}

function confidenceForMeasurements(measurements) {
    const samples = Array.isArray(measurements) ? measurements : [];
    if (!samples.length) return 0;
    const completeSustained = samples.filter((measurement) =>
        measurement.phase === 'sustained' && measurement.success !== false &&
        finiteNumber(measurement.first16MiBMs, 0) > 0 &&
        finiteNumber(measurement.throughputBytesPerSecond, 0) > 0 &&
        measurement.rangeSeekOk === true).length;
    const resumeSamples = samples.filter((measurement) => measurement.phase === 'resume-seek');
    const successfulResumeSamples = resumeSamples.filter((measurement) =>
        measurement.success !== false && measurement.rangeSeekOk === true &&
        finiteNumber(measurement.rangeStartBytes, 0) > 0 &&
        finiteNumber(measurement.throughputBytesPerSecond, 0) > 0).length;
    const sampleConfidence = clamp(samples.length / 5, 0, 1);
    const completeness = completeSustained / samples.length;
    const sustainedEvidence = completeSustained > 0 ? 0.2 : 0;
    const resumeEvidence = resumeSamples.length > 0 && successfulResumeSamples === resumeSamples.length
        ? 0.25
        : 0;
    return Number(clamp(
        0.2 + sampleConfidence * 0.2 + completeness * 0.15 + sustainedEvidence + resumeEvidence,
        0,
        1,
    ).toFixed(4));
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregateProviderRouteMeasurements(route, measurements) {
    const id = routeId(route);
    const matching = (Array.isArray(measurements) ? measurements : [])
        .filter((measurement) => routeId(measurement) === id);
    if (!matching.length) return null;
    const sustained = matching.filter((item) => item.phase === 'sustained');
    const resume = matching.filter((item) => item.phase === 'resume-seek');
    const throughputEvidence = sustained.length ? sustained : matching.filter((item) => item.phase !== 'resume-seek');
    const ttfbEvidence = [...throughputEvidence, ...resume];
    const resumePassed = resume.length === 0 || resume.every((item) =>
        item.success !== false && item.rangeSeekOk === true && finiteNumber(item.rangeStartBytes, 0) > 0);
    const aggregate = {
        slot: route.slot,
        nodeTransport: route.nodeTransport,
        success: throughputEvidence.some((item) => item.success !== false) && resumePassed,
        ttfbMs: median(ttfbEvidence.map((item) => finiteNumber(item.ttfbMs, 30_000))),
        first4MiBMs: median(throughputEvidence.map((item) => finiteNumber(item.first4MiBMs, 60_000))),
        first16MiBMs: median(throughputEvidence.map((item) => finiteNumber(item.first16MiBMs, 120_000))),
        throughputBytesPerSecond: median(throughputEvidence.map((item) => finiteNumber(item.throughputBytesPerSecond, 0))),
        varianceRatio: median(throughputEvidence.map((item) => finiteNumber(item.varianceRatio, 1))),
        rangeSeekOk: resume.length > 0
            ? resumePassed
            : matching.filter((item) => item.rangeSeekOk === true).length >= Math.ceil(matching.length / 2),
        resets: matching.reduce((sum, item) => sum + nonNegativeInteger(item.resets), 0),
        timeouts: matching.reduce((sum, item) => sum + nonNegativeInteger(item.timeouts), 0),
        proxy407: matching.reduce((sum, item) => sum + nonNegativeInteger(item.proxy407), 0),
        provider458: matching.reduce((sum, item) => sum + nonNegativeInteger(item.provider458), 0),
        http5xx: matching.reduce((sum, item) => sum + nonNegativeInteger(item.http5xx), 0),
    };
    return Object.freeze({
        ...route,
        id,
        score: scoreProviderRouteMeasurement(aggregate),
        confidence: confidenceForMeasurements(matching),
        sampleCount: matching.length,
        metrics: Object.freeze(aggregate),
    });
}

function resumeSeekOffsets(resourceSizeBytes, sampleBytes) {
    const size = Math.max(0, Math.trunc(finiteNumber(resourceSizeBytes, 0)));
    const sample = Math.max(256 * 1024, Math.trunc(finiteNumber(sampleBytes, MIB)));
    if (size <= sample) return [];
    const maximumStart = Math.min(size - sample, MAX_RESUME_RANGE_START_BYTES);
    const align = (value) => Math.floor(Math.min(maximumStart, Math.max(MIB, value)) / MIB) * MIB;
    return [...new Set([
        align(size * 0.05),
        align(size * 0.5),
    ].filter((value) => value > 0 && value <= maximumStart))];
}

function routeHasCompleteResumeEvidence(route, measurements) {
    const id = routeId(route);
    const matching = measurements.filter((measurement) => routeId(measurement) === id);
    const sustained = matching.filter((measurement) => measurement.phase === 'sustained');
    const resume = matching.filter((measurement) => measurement.phase === 'resume-seek');
    return sustained.some((measurement) =>
        measurement.success !== false && measurement.rangeSeekOk === true &&
        finiteNumber(measurement.first16MiBMs, 0) > 0) &&
        resume.length > 0 && resume.every((measurement) =>
            measurement.success !== false && measurement.rangeSeekOk === true &&
            finiteNumber(measurement.rangeStartBytes, 0) > 0);
}

function rankProviderRoutes(candidates, measurements) {
    return candidates
        .map((route) => aggregateProviderRouteMeasurements(route, measurements))
        .filter(Boolean)
        .sort((left, right) => right.score - left.score || right.confidence - left.confidence || left.id.localeCompare(right.id));
}

function normalizeStoredRoute(route, candidates) {
    if (!route) return null;
    let id;
    try { id = routeId(route); } catch (_) { return null; }
    const candidate = candidates.find((item) => item.id === id);
    return candidate ? { ...candidate, ...route, id } : null;
}

function selectInitialProviderRoute({
    candidates,
    accountState = null,
    hostRankings = [],
    deterministicIndex = 0,
    nowMs = Date.now(),
} = {}) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    const accountRoute = normalizeStoredRoute(accountState, candidates);
    const accountExpiresAt = Date.parse(String(accountState?.expiresAt || ''));
    if (accountRoute && Number.isFinite(accountExpiresAt) && accountExpiresAt > nowMs) {
        return { ...accountRoute, selectionReason: 'account-sticky' };
    }
    for (const ranking of Array.isArray(hostRankings) ? hostRankings : []) {
        const hostRoute = normalizeStoredRoute(ranking, candidates);
        if (hostRoute) return { ...hostRoute, selectionReason: 'host-learned' };
    }
    const index = Math.abs(Math.trunc(finiteNumber(deterministicIndex, 0))) % candidates.length;
    return { ...candidates[index], selectionReason: 'deterministic-fallback' };
}

function evaluateProviderRouteTransition({ current, candidate, policy = {}, nowMs = Date.now() } = {}) {
    const effective = { ...DEFAULT_ROUTE_POLICY, ...policy };
    if (!candidate) return { switch: false, reason: 'no-candidate' };
    if (!current) return { switch: true, reason: 'no-current-route' };
    if (routeId(current) === routeId(candidate)) return { switch: false, reason: 'same-route' };

    const expiresAt = Date.parse(String(current.expiresAt || ''));
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs && candidate.confidence >= effective.minimumConfidence) {
        return { switch: true, reason: 'current-expired' };
    }
    const consecutiveFailures = nonNegativeInteger(current.consecutiveFailures);
    if (consecutiveFailures >= effective.consecutiveFailureThreshold
        && candidate.confidence >= effective.minimumConfidence
        && candidate.score > 0) {
        return { switch: true, reason: 'repeated-route-degradation' };
    }

    const currentScore = Math.max(1, finiteNumber(current.score, 0));
    const candidateScore = Math.max(0, finiteNumber(candidate.score, 0));
    const relativeGain = (candidateScore - currentScore) / currentScore;
    if (candidate.confidence >= effective.minimumConfidence
        && nonNegativeInteger(candidate.consecutiveWins) >= effective.sustainedCandidateWins
        && relativeGain >= effective.minimumRelativeGain) {
        return { switch: true, reason: 'sustained-significant-gain', relativeGain };
    }
    return { switch: false, reason: 'hysteresis-hold', relativeGain };
}

function aborted(signal) {
    return Boolean(signal?.aborted);
}

async function benchmarkProviderRoutesSequentially({
    candidates,
    probe,
    isAccountIdle,
    signal = null,
    policy = {},
} = {}) {
    if (!Array.isArray(candidates) || !candidates.length) throw new TypeError('Provider route candidates are required');
    if (typeof probe !== 'function' || typeof isAccountIdle !== 'function') {
        throw new TypeError('Provider route benchmark callbacks are required');
    }
    const effective = { ...DEFAULT_ROUTE_POLICY, ...policy };
    const measurements = [];

    const mayContinue = async () => !aborted(signal) && await isAccountIdle();
    for (const candidate of candidates) {
        if (!await mayContinue()) return { status: 'preempted', measurements, rankings: rankProviderRoutes(candidates, measurements) };
        const measurement = await probe(candidate, {
            phase: 'tiny',
            sampleBytes: effective.tinyProbeBytes,
            signal,
        });
        measurements.push({ ...measurement, slot: candidate.slot, nodeTransport: candidate.nodeTransport, phase: 'tiny' });
    }

    const tinyRankings = rankProviderRoutes(candidates, measurements);
    const finalists = tinyRankings.slice(0, effective.topCandidateCount);
    for (const finalist of finalists) {
        if (!await mayContinue()) return { status: 'preempted', measurements, rankings: rankProviderRoutes(candidates, measurements) };
        const candidate = candidates.find((item) => item.id === finalist.id);
        const measurement = await probe(candidate, {
            phase: 'sustained',
            sampleBytes: effective.sustainedProbeBytes,
            checkpoints: [4 * MIB, 16 * MIB],
            signal,
        });
        measurements.push({ ...measurement, slot: candidate.slot, nodeTransport: candidate.nodeTransport, phase: 'sustained' });
    }

    const finalistCandidates = candidates.filter((candidate) =>
        finalists.some((finalist) => finalist.id === candidate.id));
    const finalistRankings = rankProviderRoutes(finalistCandidates, measurements);
    for (const finalist of finalistRankings) {
        const candidate = candidates.find((item) => item.id === finalist.id);
        const resourceSizeBytes = measurements
            .filter((measurement) => routeId(measurement) === finalist.id)
            .map((measurement) => finiteNumber(measurement.resourceSizeBytes, 0))
            .find((value) => value > effective.resumeProbeBytes) || 0;
        const offsets = resumeSeekOffsets(resourceSizeBytes, effective.resumeProbeBytes);
        for (const rangeStartBytes of offsets) {
            if (!await mayContinue()) {
                return { status: 'preempted', measurements, rankings: rankProviderRoutes(candidates, measurements) };
            }
            const measurement = await probe(candidate, {
                phase: 'resume-seek',
                sampleBytes: effective.resumeProbeBytes,
                rangeStartBytes,
                signal,
            });
            measurements.push({
                ...measurement,
                slot: candidate.slot,
                nodeTransport: candidate.nodeTransport,
                phase: 'resume-seek',
                rangeStartBytes,
            });
        }
    }

    const qualifiedCandidates = finalistCandidates.filter((candidate) =>
        routeHasCompleteResumeEvidence(candidate, measurements));
    const rankings = rankProviderRoutes(qualifiedCandidates, measurements);
    return {
        status: aborted(signal) ? 'preempted' : 'completed',
        measurements,
        rankings,
        recommendation: rankings[0] || null,
    };
}

module.exports = {
    DEFAULT_ROUTE_POLICY,
    MAX_RESUME_RANGE_START_BYTES,
    MIB,
    aggregateProviderRouteMeasurements,
    benchmarkProviderRoutesSequentially,
    buildProviderRouteCandidates,
    confidenceForMeasurements,
    evaluateProviderRouteTransition,
    providerRouteFingerprints,
    rankProviderRoutes,
    resumeSeekOffsets,
    routeId,
    routeHasCompleteResumeEvidence,
    scoreProviderRouteMeasurement,
    selectInitialProviderRoute,
};

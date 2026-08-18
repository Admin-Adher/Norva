'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const {
    PROTOCOL,
    parseRunRequest,
} = require('./fixture-registry');
const { MonoSlotCoordinator } = require('./mono-slot');
const { blockedResult, projectResult } = require('./result-projection');

const PHYSICAL_EVIDENCE_KIND = 'norva-media-lab-physical-v1';

function evidenceMetrics(evidence) {
    return evidence && typeof evidence.metrics === 'object' && !Array.isArray(evidence.metrics)
        ? evidence.metrics
        : {};
}

function provisionalResult(fixture, evidence, providerStats) {
    const metrics = evidenceMetrics(evidence);
    const providerGets = providerStats?.providerGets || 0;
    const maximumConcurrentProviderGets = providerStats?.maximumConcurrentProviderGets || 0;
    const http458 = providerStats?.http458 || 0;
    const retriesAfter458 = fixture.provider.first458 && http458 > 0
        ? Math.max(0, providerGets - 1)
        : 0;
    const common = {
        pipeline: fixture.expected.pipeline,
        ttffMs: metrics.ttffMs,
        manifestReadyMs: metrics.manifestReadyMs,
        firstSegmentMs: metrics.firstSegmentMs,
        bufferedAheadSeconds: metrics.bufferedAheadSeconds,
        productionRateX: metrics.productionRateX,
        browserBufferRateX: metrics.browserBufferRateX,
        rebufferCount: metrics.rebufferCount,
        rebufferMs: metrics.rebufferMs,
        providerGets,
        maximumConcurrentProviderGets,
        ffmpegSpawns: metrics.ffmpegSpawns,
        analyzerSpawns: metrics.analyzerSpawns,
        http458,
        retriesAfter458,
        seekPassed: metrics.seekPassed,
        audioPassed: metrics.audioPassed,
        cleanupPassed: evidence?.cleanupObserved === true,
    };

    if (
        !evidence
        || evidence.protocol !== PROTOCOL
        || evidence.kind !== PHYSICAL_EVIDENCE_KIND
        || !['pass', 'fail', 'blocked', 'cancelled'].includes(evidence.status)
    ) {
        return { ...common, status: 'fail', reason: 'physical-evidence-invalid' };
    }
    if (evidence.status !== 'pass') {
        const reason = typeof evidence.reason === 'string' ? evidence.reason : 'physical-runner-failed';
        return { ...common, status: evidence.status, reason };
    }
    const browserRequired = fixture.expected.pipeline !== 'terminal-458';
    if (
        evidence.gatewayObserved !== true
        || (browserRequired && evidence.browserObserved !== true)
        || evidence.cleanupObserved !== true
    ) {
        return { ...common, status: 'fail', reason: 'physical-evidence-incomplete' };
    }
    if (evidence.pipeline !== fixture.expected.pipeline) {
        return { ...common, status: 'fail', reason: 'pipeline-mismatch' };
    }
    const acceptedRuntimeReasons = Array.isArray(fixture.expected.runtimeReasons)
        ? fixture.expected.runtimeReasons
        : [fixture.expected.runtimeReason];
    if (!acceptedRuntimeReasons.includes(evidence.reason)) {
        return { ...common, status: 'fail', reason: 'runtime-policy-mismatch' };
    }
    if (maximumConcurrentProviderGets > 1) {
        return { ...common, status: 'fail', reason: 'provider-concurrency-drift' };
    }
    const expectedProviderGets = fixture.provider.expectedGets;
    const expectedMaximumConcurrent = expectedProviderGets > 0 ? 1 : 0;
    if (providerGets !== expectedProviderGets || maximumConcurrentProviderGets !== expectedMaximumConcurrent) {
        return { ...common, status: 'fail', reason: 'provider-count-drift' };
    }

    if (fixture.expected.pipeline === 'cache-hit') {
        if (providerGets !== 0 || http458 !== 0) {
            return { ...common, status: 'fail', reason: 'cache-provider-contacted' };
        }
        if (metrics.ffmpegSpawns !== 0) {
            return { ...common, status: 'fail', reason: 'ffmpeg-count-drift' };
        }
    } else if (fixture.expected.pipeline === 'terminal-458') {
        if (providerGets !== 1 || http458 !== 1 || retriesAfter458 !== 0) {
            return { ...common, status: 'fail', reason: 'terminal-458-retried' };
        }
        if (metrics.ffmpegSpawns !== 0) {
            return { ...common, status: 'fail', reason: 'ffmpeg-count-drift' };
        }
    } else {
        if (metrics.ffmpegSpawns !== 1) {
            return { ...common, status: 'fail', reason: 'ffmpeg-count-drift' };
        }
    }

    if (fixture.expected.under10Seconds && (typeof metrics.ttffMs !== 'number' || metrics.ttffMs > 10_000)) {
        return { ...common, status: 'fail', reason: 'latency-target-missed' };
    }
    if (
        fixture.expected.pipeline !== 'terminal-458'
        && (
            metrics.seekPassed !== true
            || metrics.audioPassed !== true
            || metrics.rebufferCount !== 0
        )
    ) {
        return { ...common, status: 'fail', reason: 'playback-validation-failed' };
    }
    return { ...common, status: 'pass', reason: fixture.expected.reason };
}

function aborted(signal) {
    return signal?.aborted === true;
}

async function runWithDeadline(workFactory, externalSignal, timeoutMs) {
    const controller = new AbortController();
    let abortCode = null;
    const abort = (code, reason) => {
        if (controller.signal.aborted) return;
        abortCode = code;
        controller.abort(reason);
    };
    const onExternalAbort = () => abort('ABORT_ERR', externalSignal.reason);
    if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    if (externalSignal?.aborted) onExternalAbort();
    const timer = setTimeout(() => abort('MEDIA_LAB_RUN_TIMEOUT', new Error('MEDIA_LAB_RUN_TIMEOUT')), timeoutMs);
    const work = Promise.resolve()
        .then(() => workFactory(controller.signal))
        .then(
            (value) => Object.freeze({ settled: true, value }),
            (error) => Object.freeze({ settled: true, error }),
        );
    const abortedWork = new Promise((resolve) => {
        if (controller.signal.aborted) resolve(Object.freeze({ aborted: true }));
        else controller.signal.addEventListener('abort', () => resolve(Object.freeze({ aborted: true })), { once: true });
    });
    try {
        const first = await Promise.race([work, abortedWork]);
        if (first.settled) {
            if (first.error) throw first.error;
            return first.value;
        }

        const grace = await Promise.race([
            work,
            delay(1_000).then(() => Object.freeze({ settled: false })),
        ]);
        const error = Object.assign(
            new Error(abortCode || 'ABORT_ERR'),
            { code: abortCode || 'ABORT_ERR' },
        );
        if (!grace.settled) error.pendingWork = work;
        throw error;
    } finally {
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    }
}

class MediaLabRunner {
    constructor({
        providerSimulator,
        getProviderBaseUrl,
        adapter = null,
        coordinator = new MonoSlotCoordinator(),
        runTimeoutMs = 600_000,
    }) {
        if (!providerSimulator || typeof providerSimulator.openFixture !== 'function') {
            throw new Error('MEDIA_LAB_PROVIDER_SIMULATOR_REQUIRED');
        }
        if (typeof getProviderBaseUrl !== 'function') {
            throw new Error('MEDIA_LAB_PROVIDER_ORIGIN_REQUIRED');
        }
        if (adapter && typeof adapter.runPhysicalCase !== 'function') {
            throw new Error('MEDIA_LAB_ADAPTER_INVALID');
        }
        this.providerSimulator = providerSimulator;
        this.getProviderBaseUrl = getProviderBaseUrl;
        this.adapter = adapter;
        this.coordinator = coordinator;
        this.runTimeoutMs = Math.max(1_000, Math.min(600_000, Number(runTimeoutMs) || 600_000));
    }

    get busy() {
        return this.coordinator.busy;
    }

    async runCase(request, { signal } = {}) {
        const fixture = parseRunRequest(request);
        const lease = this.coordinator.tryAcquire();
        if (!lease) return blockedResult(fixture, 'runner-busy');
        if (aborted(signal)) {
            lease.release();
            return projectResult({ status: 'cancelled', pipeline: fixture.expected.pipeline, reason: 'run-cancelled' });
        }

        let providerRun = null;
        let localCleanup = true;
        let provisional = null;
        let deferredCleanup = false;
        try {
            if (!this.adapter) return blockedResult(fixture, 'dedicated-gateway-unavailable');
            if (fixture.provider.assetRequired && !(await this.providerSimulator.fixtureAvailable(fixture))) {
                return blockedResult(fixture, 'fixture-asset-unavailable');
            }
            if (fixture.provider.providerExpected || fixture.provider.seedBeforeMeasure) {
                providerRun = await this.providerSimulator.openFixture(fixture, this.getProviderBaseUrl());
            }
            const evidence = await runWithDeadline(
                (runSignal) => this.adapter.runPhysicalCase(Object.freeze({
                    protocol: PROTOCOL,
                    fixture,
                    providerUrl: providerRun?.mediaUrl || null,
                    resetProviderCounters: providerRun?.resetCounters || null,
                    signal: runSignal,
                })),
                signal,
                this.runTimeoutMs,
            );
            provisional = provisionalResult(fixture, evidence, providerRun?.snapshot() || null);
        } catch (error) {
            const cancelled = error?.code === 'ABORT_ERR' || aborted(signal);
            provisional = {
                status: cancelled ? 'cancelled' : 'fail',
                pipeline: fixture.expected.pipeline,
                reason: cancelled ? 'run-cancelled' : (error?.code === 'MEDIA_LAB_RUN_TIMEOUT' ? 'run-timeout' : 'physical-runner-failed'),
                ...(providerRun?.snapshot() || {}),
            };
            if (error?.pendingWork) {
                deferredCleanup = true;
                error.pendingWork.finally(() => {
                    if (providerRun) providerRun.close();
                    lease.release();
                });
            }
        } finally {
            if (!deferredCleanup) {
                if (providerRun) localCleanup = providerRun.close() && !providerRun.capabilityActive();
                lease.release();
            }
        }
        if (!provisional) return blockedResult(fixture, 'physical-runner-unavailable');
        provisional.cleanupPassed = provisional.cleanupPassed !== false && localCleanup;
        if (provisional.status === 'pass' && !provisional.cleanupPassed) {
            provisional.status = 'fail';
            provisional.reason = 'cleanup-failed';
        }
        return projectResult(provisional);
    }
}

module.exports = Object.freeze({
    MediaLabRunner,
    PHYSICAL_EVIDENCE_KIND,
    provisionalResult,
    runWithDeadline,
});

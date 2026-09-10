// VAD is an optional preprocessing accelerator, never a language verdict.
// Both paths use the same full Whisper model and strict transcript evaluator.
// Retries reuse local WAVs: this module cannot access a provider or publish data.
const SAMPLE_DISPOSITIONS = new Set(['accepted', 'conflict', 'weak', 'insufficient']);

function evaluateBatchSamples(samples, evaluateSample, indices) {
    return samples.map((sample, index) => {
        const evaluated = evaluateSample(sample, indices ? indices[index] : index);
        if (!evaluated || !SAMPLE_DISPOSITIONS.has(evaluated.disposition)
            || !evaluated.result || typeof evaluated.result !== 'object') {
            throw new Error('invalid strict sample evaluation');
        }
        return evaluated;
    });
}

// `weak` means the strict evaluator found enough diverse transcript evidence but the
// model probability was low. That transcript must not be erased by a more confident
// second pass in another language. Insufficient/repeated text is not credible evidence.
function richSampleLanguages(evaluated) {
    if (!['accepted', 'weak', 'conflict'].includes(evaluated.disposition)) return [];
    return [...new Set(['language', 'candidate', 'whisperLang', 'transcriptLang']
        .map((key) => evaluated.result[key])
        .filter((value) => typeof value === 'string' && /^[a-z]{2,3}$/.test(value)))];
}

function mergeQualityEvidence(initial, fallback) {
    const initialLanguages = richSampleLanguages(initial);
    const fallbackLanguages = richSampleLanguages(fallback);
    const differentRichLanguages = initialLanguages.length > 0 && fallbackLanguages.length > 0
        && new Set([...initialLanguages, ...fallbackLanguages]).size > 1;
    if (fallback.disposition === 'conflict') return fallback;
    if (differentRichLanguages) {
        return {
            ...initial,
            disposition: 'conflict',
            result: {
                ...initial.result,
                language: null,
                confident: false,
                verified: false,
                validationStatus: 'pending',
                qualityFallbackConflict: true,
            },
        };
    }
    // A second model score alone is not an improvement. Full strict acceptance may
    // recover a sample; rich-but-weak text may replace insufficient text for diagnostics
    // only. Neither operation creates an additional result or a second vote per WAV.
    return fallback.disposition === 'accepted'
        || (initial.disposition === 'insufficient' && fallback.disposition === 'weak')
        ? fallback : initial;
}

function createStrictLidInference({ now = Date.now, cooldownMs = 300000 } = {}) {
    let disabledUntil = 0;
    const stats = { vadAttempts: 0, vadSuccesses: 0, vadFailures: 0,
        baselineRuns: 0, fallbackRuns: 0, baselineFailures: 0, preemptions: 0,
        totalVadMs: 0, totalBaselineMs: 0, lastBaselineFailureAt: 0, lastBaselineSuccessAt: 0,
        qualityFallbackRuns: 0, qualityFallbackFailures: 0, qualityFallbackRecoveredSamples: 0,
        qualityFallbackConflictSamples: 0, qualityFallbackBudgetExhaustions: 0,
        qualityEvaluationFailures: 0, totalQualityFallbackMs: 0 };
    const cancelled = (options) => options.abortSignal?.aborted || options.isPreempted?.();
    const stopped = (options) => ({ ok: false, samples: [],
        aborted: options.abortSignal?.aborted === true,
        preempted: options.isPreempted?.() === true, error: 'strict inference cancelled' });
    async function qualityFallback(options, initial, deadline, runBatch) {
        if (typeof options.evaluateSample !== 'function') return initial;
        const diagnostics = { protocol: 1, eligibleCount: 0, attemptedCount: 0,
            recoveredCount: 0, conflictCount: 0, outcome: 'not-needed' };
        const failure = (outcome) => ({ ok: false, samples: [], evaluatedSamples: [],
            error: 'strict inference evidence evaluation failed',
            qualityFallback: Object.freeze({ ...diagnostics, outcome }) });
        const inputs = options.wavPaths;
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 64
            || !Array.isArray(initial.samples)
            || inputs.length !== initial.samples.length) {
            stats.qualityEvaluationFailures++;
            return failure('invalid-sample-count');
        }
        let evaluated;
        try { evaluated = evaluateBatchSamples(initial.samples, options.evaluateSample); }
        catch (_) {
            stats.qualityEvaluationFailures++;
            return failure('evaluation-failed');
        }
        const eligible = evaluated.flatMap((sample, index) => (
            sample.disposition === 'insufficient' || sample.disposition === 'weak' ? [index] : []
        ));
        diagnostics.eligibleCount = eligible.length;
        const completed = (samples = initial.samples, evidence = evaluated) => ({
            ...initial, samples, evaluatedSamples: evidence,
            qualityFallback: Object.freeze({ ...diagnostics }),
        });
        if (eligible.length === 0) return completed();
        if (cancelled(options)) {
            stats.preemptions++;
            return { ...stopped(options), evaluatedSamples: [],
                qualityFallback: Object.freeze({ ...diagnostics, outcome: options.abortSignal?.aborted
                    ? 'aborted' : 'preempted' }) };
        }
        const remaining = Math.floor(deadline - now());
        if (remaining <= 0) {
            stats.qualityFallbackBudgetExhaustions++;
            diagnostics.outcome = 'budget-exhausted';
            return completed();
        }
        stats.qualityFallbackRuns++;
        stats.baselineRuns++;
        diagnostics.attemptedCount = eligible.length;
        const started = now();
        let fallback;
        try {
            fallback = await runBatch({ ...options, vadModel: null, timeoutMs: remaining,
                wavPaths: eligible.map((index) => inputs[index]),
                // A caller may supply test/private output prefixes. Keep the subset mapping
                // exact; never retain a full-batch prefix list for a shorter retry batch.
                ...(Array.isArray(options.outputPrefixes)
                    ? { outputPrefixes: eligible.map((index) => options.outputPrefixes[index]) } : {}),
            });
        } catch (_) { fallback = { ok: false, samples: [] }; }
        const elapsed = Math.max(0, now() - started);
        stats.totalBaselineMs += elapsed;
        stats.totalQualityFallbackMs += elapsed;
        if (cancelled(options) || fallback?.aborted || fallback?.preempted) {
            stats.preemptions++;
            const aborted = fallback?.aborted === true || options.abortSignal?.aborted === true;
            const preempted = fallback?.preempted === true || options.isPreempted?.() === true;
            return { ...stopped(options), aborted, preempted, evaluatedSamples: [],
                qualityFallback: Object.freeze({ ...diagnostics,
                    outcome: aborted ? 'aborted' : 'preempted' }) };
        }
        if (fallback?.timedOut === true || now() > deadline) {
            stats.baselineFailures++;
            stats.qualityFallbackFailures++;
            stats.lastBaselineFailureAt = now();
            return { ok: false, samples: [], evaluatedSamples: [], timedOut: true,
                error: 'strict inference budget exhausted',
                qualityFallback: Object.freeze({ ...diagnostics, outcome: 'timed-out' }) };
        }
        if (fallback?.ok !== true || !Array.isArray(fallback.samples)
            || fallback.samples.length !== eligible.length) {
            stats.baselineFailures++;
            stats.qualityFallbackFailures++;
            stats.lastBaselineFailureAt = now();
            diagnostics.outcome = 'failed';
            return completed();
        }
        stats.lastBaselineSuccessAt = now();
        let fallbackEvaluated;
        try { fallbackEvaluated = evaluateBatchSamples(fallback.samples, options.evaluateSample, eligible); }
        catch (_) {
            stats.qualityEvaluationFailures++;
            return failure('evaluation-failed');
        }
        const samples = [...initial.samples];
        const merged = [...evaluated];
        for (const [fallbackIndex, originalIndex] of eligible.entries()) {
            const next = mergeQualityEvidence(evaluated[originalIndex], fallbackEvaluated[fallbackIndex]);
            merged[originalIndex] = next;
            if (next.disposition === 'conflict') diagnostics.conflictCount++;
            if (next === fallbackEvaluated[fallbackIndex] && next.disposition !== 'conflict') {
                samples[originalIndex] = fallback.samples[fallbackIndex];
            }
            if (next.disposition === 'accepted') {
                diagnostics.recoveredCount++;
            }
        }
        stats.qualityFallbackRecoveredSamples += diagnostics.recoveredCount;
        stats.qualityFallbackConflictSamples += diagnostics.conflictCount;
        diagnostics.outcome = 'succeeded';
        return completed(samples, merged);
    }
    async function run(options, runBatch) {
        const deadline = now() + Math.max(1, Number(options.timeoutMs) || 1);
        if (cancelled(options)) return stopped(options);
        const fast = Boolean(options.vadModel) && now() >= disabledUntil;
        let result;
        if (fast) {
            stats.vadAttempts++;
            const started = now();
            // Preserve the existing full inference budget (including valid 31s batches).
            // A quick VAD failure may fall back; a timeout never gets a fresh budget.
            try { result = await runBatch({ ...options, timeoutMs: Math.max(1, Math.floor(deadline - now())) }); }
            catch (_) { result = { ok: false, samples: [], error: 'VAD inference failed' }; }
            stats.totalVadMs += Math.max(0, now() - started);
            if (cancelled(options) || result.aborted || result.preempted) {
                stats.preemptions++;
                return { ...result, ...stopped(options), aborted: result.aborted || options.abortSignal?.aborted === true, preempted: result.preempted || options.isPreempted?.() === true };
            }
            if (result.ok === true) {
                stats.vadSuccesses++;
                return qualityFallback(options, result, deadline, runBatch);
            }
            stats.vadFailures++;
            disabledUntil = now() + cooldownMs;
        }
        if (cancelled(options)) return stopped(options);
        const remaining = Math.floor(deadline - now());
        if (remaining <= 0) return result || { ok: false, samples: [], timedOut: true, error: 'strict inference budget exhausted' };
        stats.baselineRuns++;
        if (fast) stats.fallbackRuns++;
        const started = now();
        try { result = await runBatch({ ...options, vadModel: null, timeoutMs: remaining }); }
        catch (_) { result = { ok: false, samples: [], error: 'Whisper inference failed' }; }
        stats.totalBaselineMs += Math.max(0, now() - started);
        if (cancelled(options) || result.aborted || result.preempted) {
            stats.preemptions++;
            return { ...result, ...stopped(options), aborted: result.aborted || options.abortSignal?.aborted === true, preempted: result.preempted || options.isPreempted?.() === true };
        }
        if (result.ok !== true) { stats.baselineFailures++; stats.lastBaselineFailureAt = now(); }
        else stats.lastBaselineSuccessAt = now();
        return result;
    }
    function health() {
        return { protocol: 1, mode: 'strict-whisper-vad-with-full-fallback',
            expiryRequired: false, circuitOpen: now() < disabledUntil,
            retryAfterMs: Math.max(0, disabledUntil - now()), ...stats };
    }
    return { run, health };
}
module.exports = { createStrictLidInference };

// VAD is an optional preprocessing accelerator, never a language verdict.
// Both paths use the same full Whisper model and strict transcript evaluator.
// Retries reuse local WAVs: this module cannot access a provider or publish data.
function createStrictLidInference({ now = Date.now, cooldownMs = 300000 } = {}) {
    let disabledUntil = 0;
    const stats = { vadAttempts: 0, vadSuccesses: 0, vadFailures: 0,
        baselineRuns: 0, fallbackRuns: 0, baselineFailures: 0, preemptions: 0,
        totalVadMs: 0, totalBaselineMs: 0, lastBaselineFailureAt: 0, lastBaselineSuccessAt: 0 };
    const cancelled = (options) => options.abortSignal?.aborted || options.isPreempted?.();
    const stopped = (options) => ({ ok: false, samples: [],
        aborted: options.abortSignal?.aborted === true,
        preempted: options.isPreempted?.() === true, error: 'strict inference cancelled' });
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
            if (result.ok === true) { stats.vadSuccesses++; return result; }
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

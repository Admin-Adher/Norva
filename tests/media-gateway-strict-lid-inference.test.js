const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStrictLidInference } = require('../services/media-gateway/src/strict-lid-inference');
const { resolveStrictLidConsensus } = require('../services/media-gateway/src/strict-lid-batch');

function sample(disposition, lang = 'en', id = 'sample') {
    return { text: `private transcript ${id}`, lang, prob: disposition === 'weak' ? 0.4 : 0.999,
        disposition, id };
}
function evaluate(value, index) {
    return {
        disposition: value.disposition,
        diversity: {
            fingerprint: crypto.createHash('sha256').update(value.id).digest('hex'),
            shingles: [`unique-${value.id}`],
        },
        result: {
            language: value.disposition === 'accepted' ? value.lang : null,
            candidate: value.lang,
            whisperLang: value.lang,
            transcriptLang: value.disposition === 'insufficient' ? null : value.lang,
            confident: value.disposition === 'accepted',
            confidence: value.prob,
            wordCount: value.disposition === 'insufficient' ? 1 : 30,
            uniqueWordCount: value.disposition === 'insufficient' ? 1 : 25,
            transcriptEvidenceBasis: value.disposition === 'insufficient' ? 'insufficient' : 'whitespace-words',
            transcriptAgrees: value.disposition !== 'insufficient',
            verified: false,
            validationStatus: 'pending',
            offset: index * 100,
        },
    };
}
function options(count, overrides = {}) {
    return { vadModel: '/private/vad', timeoutMs: 1000,
        wavPaths: Array.from({ length: count }, (_, index) => `/private/audio-${index}.wav`),
        evaluateSample: evaluate, ...overrides };
}

test('quality retry maps only insufficient/weak WAVs to original indices and keeps one evidence per WAV', async () => {
    let time = 1000;
    const engine = createStrictLidInference({ now: () => time });
    const initial = [sample('accepted', 'en', 'kept'), sample('insufficient', 'fr', 'short'),
        sample('conflict', 'fr', 'veto'), sample('weak', 'en', 'weak')];
    const retries = [sample('accepted', 'en', 'recovered-1'), sample('accepted', 'en', 'recovered-2')];
    const calls = [];
    const evaluatedInitial = [];
    const input = options(4, { outputPrefixes: ['o0', 'o1', 'o2', 'o3'],
        evaluateSample: (value, index) => {
            const result = evaluate(value, index);
            if (initial.includes(value)) evaluatedInitial[index] = result;
            return result;
        } });
    const value = await engine.run(input, async (args) => {
        calls.push(args);
        time += 120;
        return { ok: true, samples: calls.length === 1 ? initial : retries };
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].timeoutMs, 1000);
    assert.equal(calls[1].timeoutMs, 880);
    assert.equal(calls[1].vadModel, null);
    assert.deepEqual(calls[1].wavPaths, [input.wavPaths[1], input.wavPaths[3]]);
    assert.deepEqual(calls[1].outputPrefixes, ['o1', 'o3']);
    assert.equal(value.samples.length, 4);
    assert.equal(value.evaluatedSamples.length, 4);
    assert.equal(value.samples[0], initial[0]);
    assert.equal(value.samples[2], initial[2]);
    assert.equal(value.evaluatedSamples[0], evaluatedInitial[0]);
    assert.equal(value.evaluatedSamples[2], evaluatedInitial[2]);
    assert.equal(value.samples[1], retries[0]);
    assert.equal(value.samples[3], retries[1]);
    assert.equal(value.evaluatedSamples[1].result.offset, 100);
    assert.equal(value.evaluatedSamples[3].result.offset, 300);
    assert.deepEqual(value.qualityFallback, { protocol: 1, eligibleCount: 2, attemptedCount: 2,
        recoveredCount: 2, conflictCount: 0, outcome: 'succeeded' });
    assert.equal(resolveStrictLidConsensus(value.evaluatedSamples, 4).verified, false);
    assert.equal(engine.health().circuitOpen, false);
    assert.equal(engine.health().vadSuccesses, 1);
    assert.equal(engine.health().qualityFallbackRecoveredSamples, 2);
});

test('accepted/conflict samples never trigger a quality retry and remain reference-identical', async () => {
    const initial = [sample('accepted'), sample('conflict')];
    let calls = 0;
    const value = await createStrictLidInference().run(options(2), async () => {
        calls++;
        return { ok: true, samples: initial };
    });
    assert.equal(calls, 1);
    assert.equal(value.samples, initial);
    assert.equal(value.qualityFallback.outcome, 'not-needed');
});

test('an absent evaluator preserves the legacy no-quality-retry contract exactly', async () => {
    const initial = { ok: true, samples: [sample('insufficient')] };
    let calls = 0;
    const value = await createStrictLidInference().run(options(1, { evaluateSample: null }), async () => {
        calls++;
        return initial;
    });
    assert.equal(value, initial);
    assert.equal(calls, 1);
});

test('no VAD and the technical VAD circuit fallback cannot cause a third full pass', async () => {
    for (const vadModel of [null, '/private/vad']) {
        const engine = createStrictLidInference();
        let calls = 0;
        const value = await engine.run(options(1, { vadModel }), async (args) => {
            calls++;
            return args.vadModel ? { ok: false, samples: [] }
                : { ok: true, samples: [sample('insufficient')] };
        });
        assert.equal(value.ok, true);
        assert.equal(calls, vadModel ? 2 : 1);
        assert.equal(engine.health().qualityFallbackRuns, 0);
    }
});

test('exhausted remaining quality budget keeps initial evidence without refreshing deadline or circuit', async () => {
    let time = 10;
    const initial = [sample('insufficient')];
    const engine = createStrictLidInference({ now: () => time });
    let calls = 0;
    const value = await engine.run(options(1, { timeoutMs: 50 }), async () => {
        calls++;
        time += 50;
        return { ok: true, samples: initial };
    });
    assert.equal(calls, 1);
    assert.equal(value.ok, true);
    assert.equal(value.samples, initial);
    assert.equal(value.qualityFallback.outcome, 'budget-exhausted');
    assert.equal(engine.health().qualityFallbackBudgetExhaustions, 1);
    assert.equal(engine.health().circuitOpen, false);
});

test('poor baseline quality causes exactly one retry, no circuit opening and no invented recovery', async () => {
    const engine = createStrictLidInference();
    const initial = [sample('insufficient')];
    let calls = 0;
    const value = await engine.run(options(1), async () => {
        calls++;
        return { ok: true, samples: calls === 1 ? initial : [sample('insufficient', 'fr')] };
    });
    assert.equal(calls, 2);
    assert.equal(value.samples[0], initial[0]);
    assert.equal(value.evaluatedSamples[0].disposition, 'insufficient');
    assert.equal(value.qualityFallback.recoveredCount, 0);
    assert.equal(engine.health().vadFailures, 0);
    assert.equal(engine.health().circuitOpen, false);
});

test('rich first-pass language disagreement vetoes a confident retry instead of cherry-picking', async () => {
    const initial = [sample('accepted', 'en', 'one'), sample('accepted', 'en', 'two'),
        sample('accepted', 'en', 'three'), sample('accepted', 'en', 'four'),
        sample('weak', 'fr', 'rich-french')];
    let calls = 0;
    const value = await createStrictLidInference().run(options(5), async () => ({
        ok: true, samples: ++calls === 1 ? initial : [sample('accepted', 'en', 'high-score')],
    }));
    const verdict = resolveStrictLidConsensus(value.evaluatedSamples, 4);
    assert.equal(value.evaluatedSamples.length, 5);
    assert.equal(value.samples[4], initial[4]);
    assert.equal(value.evaluatedSamples[4].disposition, 'conflict');
    assert.equal(value.evaluatedSamples[4].result.qualityFallbackConflict, true);
    assert.equal(value.evaluatedSamples[4].result.language, null);
    assert.equal(value.evaluatedSamples[4].result.confident, false);
    assert.equal(verdict.acceptedSamples.length, 4);
    assert.equal(verdict.verified, false);
    assert.equal(verdict.rejectedSpeechSampleCount, 1);
    assert.equal(value.qualityFallback.conflictCount, 1);
    assert.equal(value.qualityFallback.recoveredCount, 0);
});

test('a confident transcript disagreement hidden under weak model confidence is never washed out', async () => {
    let calls = 0;
    const value = await createStrictLidInference().run(options(1, { evaluateSample: (value, index) => {
        const entry = evaluate(value, index);
        if (value.disposition === 'weak') entry.result.transcriptLang = 'fr';
        return entry;
    } }), async () => ({ ok: true, samples: [++calls === 1
        ? sample('weak', 'en', 'rich-first') : sample('accepted', 'en', 'second')] }));
    assert.equal(value.evaluatedSamples[0].disposition, 'conflict');
});

test('a conflict newly found by the second pass is retained as one veto, not ignored', async () => {
    let calls = 0;
    const value = await createStrictLidInference().run(options(1), async () => ({ ok: true,
        samples: [sample(++calls === 1 ? 'insufficient' : 'conflict')],
    }));
    assert.equal(value.evaluatedSamples.length, 1);
    assert.equal(value.evaluatedSamples[0].disposition, 'conflict');
    assert.equal(value.qualityFallback.conflictCount, 1);
});

test('one recovered WAV is one vote even if both passes return matching language', async () => {
    let calls = 0;
    const value = await createStrictLidInference().run(options(1), async () => ({ ok: true,
        samples: [sample(++calls === 1 ? 'weak' : 'accepted', 'en', `pass-${calls}`)],
    }));
    const verdict = resolveStrictLidConsensus(value.evaluatedSamples, 4);
    assert.equal(value.samples.length, 1);
    assert.equal(value.evaluatedSamples.length, 1);
    assert.equal(verdict.acceptedSamples.length, 1);
    assert.equal(verdict.votes.get('en'), 1);
    assert.equal(verdict.verified, false);
});

test('rich but weak fallback improves diagnostics without manufacturing an accepted vote', async () => {
    let calls = 0;
    const weak = sample('weak', 'fr', 'rich-french');
    const value = await createStrictLidInference().run(options(1), async () => ({ ok: true,
        samples: [++calls === 1 ? sample('insufficient', 'en') : weak],
    }));
    const verdict = resolveStrictLidConsensus(value.evaluatedSamples, 4);
    assert.equal(value.samples[0], weak);
    assert.equal(value.evaluatedSamples[0].disposition, 'weak');
    assert.equal(verdict.ignoredWeakSpeechSampleCount, 1);
    assert.equal(verdict.acceptedSamples.length, 0);
    assert.equal(value.qualityFallback.recoveredCount, 0);
});

test('a rich weak disagreement between both nonaccepted passes still supplies a veto', async () => {
    let calls = 0;
    const value = await createStrictLidInference().run(options(1), async () => ({ ok: true,
        samples: [sample('weak', ++calls === 1 ? 'fr' : 'en', `pass-${calls}`)],
    }));
    assert.equal(value.evaluatedSamples[0].disposition, 'conflict');
    assert.equal(value.qualityFallback.conflictCount, 1);
    assert.equal(value.qualityFallback.recoveredCount, 0);
});

test('cancellation during initial quality evaluation never launches the second pass', async () => {
    const abort = new AbortController();
    let calls = 0;
    const engine = createStrictLidInference();
    const value = await engine.run(options(1, { abortSignal: abort.signal,
        evaluateSample: (value, index) => { abort.abort(); return evaluate(value, index); },
    }), async () => { calls++; return { ok: true, samples: [sample('insufficient')] }; });
    assert.equal(calls, 1);
    assert.equal(value.ok, false);
    assert.equal(value.aborted, true);
    assert.equal(engine.health().preemptions, 1);
});

test('quality failure or malformed subset cardinality never shifts or replaces initial evidence', async (t) => {
    for (const failure of ['throw', 'failed', 'short', 'long', 'missing']) {
        await t.test(failure, async () => {
            const engine = createStrictLidInference();
            const initial = [sample('accepted'), sample('insufficient')];
            let calls = 0;
            const value = await engine.run(options(2), async () => {
                if (++calls === 1) return { ok: true, samples: initial };
                if (failure === 'throw') throw Error('PRIVATE provider credentials');
                if (failure === 'failed') return { ok: false, error: 'PRIVATE error' };
                if (failure === 'missing') return undefined;
                return { ok: true, samples: failure === 'short' ? [] : [sample('accepted'), sample('accepted')] };
            });
            assert.equal(calls, 2);
            assert.equal(value.ok, true);
            assert.equal(value.samples, initial);
            assert.equal(value.evaluatedSamples[1].disposition, 'insufficient');
            assert.equal(value.qualityFallback.outcome, 'failed');
            assert.equal(engine.health().circuitOpen, false);
            assert.equal(engine.health().vadFailures, 0);
            assert.equal(engine.health().qualityFallbackFailures, 1);
            assert.ok(!JSON.stringify(value.qualityFallback).includes('PRIVATE'));
        });
    }
});

test('quality retry timeout, cancellation and preemption discard all evidence without another pass', async (t) => {
    for (const outcome of ['timedOut', 'aborted', 'preempted', 'elapsed', 'signal']) {
        await t.test(outcome, async () => {
            let time = 100;
            const abort = new AbortController();
            const engine = createStrictLidInference({ now: () => time });
            let calls = 0;
            const value = await engine.run(options(1, { abortSignal: abort.signal }), async (args) => {
                if (++calls === 1) {
                    time += 200;
                    return { ok: true, samples: [sample('insufficient')] };
                }
                assert.equal(args.timeoutMs, 800);
                if (outcome === 'elapsed') time += 801;
                if (outcome === 'signal') abort.abort();
                return { ok: true, samples: [sample('accepted')], [outcome]: true };
            });
            assert.equal(calls, 2);
            assert.equal(value.ok, false);
            assert.deepEqual(value.samples, []);
            assert.deepEqual(value.evaluatedSamples, []);
            assert.equal(engine.health().circuitOpen, false);
            assert.equal(value[outcome === 'elapsed' ? 'timedOut' : outcome === 'signal' ? 'aborted' : outcome], true);
        });
    }
});

test('invalid initial cardinality and throwing evaluator fail closed without leaking input', async () => {
    for (const badEvaluator of [false, true]) {
        let calls = 0;
        const value = await createStrictLidInference().run(options(2, badEvaluator
            ? { evaluateSample: () => { throw Error('PRIVATE'); } } : {}), async () => {
            calls++;
            return { ok: true, samples: [sample('insufficient'), ...(badEvaluator ? [sample('accepted')] : [])] };
        });
        assert.equal(calls, 1);
        assert.equal(value.ok, false);
        assert.deepEqual(value.samples, []);
        assert.ok(!JSON.stringify(value).includes('PRIVATE'));
    }
});

test('a malformed second evaluation fails closed rather than retaining an unchecked verdict', async () => {
    let calls = 0;
    const value = await createStrictLidInference().run(options(1, {
        evaluateSample: (value, index) => value.disposition === 'accepted' ? { disposition: 'accepted' }
            : evaluate(value, index),
    }), async () => ({ ok: true, samples: [sample(++calls === 1 ? 'insufficient' : 'accepted')] }));
    assert.equal(calls, 2);
    assert.equal(value.ok, false);
    assert.deepEqual(value.evaluatedSamples, []);
    assert.equal(value.qualityFallback.outcome, 'evaluation-failed');
});

test('quality diagnostics are bounded before evaluating unexpected oversized or empty batches', async () => {
    for (const count of [0, 65]) {
        let evaluations = 0;
        const value = await createStrictLidInference().run(options(count, {
            evaluateSample: () => { evaluations++; return evaluate(sample('insufficient'), 0); },
        }), async () => ({ ok: true, samples: Array.from({ length: count }, () => sample('insufficient')) }));
        assert.equal(value.ok, false);
        assert.equal(evaluations, 0);
        assert.equal(value.qualityFallback.eligibleCount, 0);
    }
});

test('quality observability contains only closed aggregate counters and enum values', async () => {
    let calls = 0;
    const engine = createStrictLidInference();
    const value = await engine.run(options(1), async () => ({ ok: true,
        samples: [sample(++calls === 1 ? 'insufficient' : 'accepted')],
        url: 'https://private.invalid/path', error: 'private',
    }));
    assert.deepEqual(Object.keys(value.qualityFallback).sort(), [
        'protocol', 'eligibleCount', 'attemptedCount', 'recoveredCount', 'conflictCount', 'outcome',
    ].sort());
    assert.equal(Object.isFrozen(value.qualityFallback), true);
    assert.ok(!JSON.stringify(value.qualityFallback).includes('private'));
    assert.ok(!JSON.stringify(engine.health()).includes('private'));
});

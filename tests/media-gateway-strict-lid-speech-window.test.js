const assert = require('node:assert/strict');
const test = require('node:test');
const { strictLidTimelineOffsets } = require('../services/media-gateway/src/strict-lid-batch');
const {
    planStrictSpeechWindow,
} = require('../services/media-gateway/src/strict-lid-speech-window');

test('speech search keeps the original anchor and gives a bounded sixty-second neighborhood', () => {
    const plan = planStrictSpeechWindow(7248.048, 1);
    assert.equal(plan.anchorOffsetSeconds, 594.004);
    assert.equal(plan.searchStartSeconds, 574.004);
    assert.equal(plan.searchDurationSeconds, 60);
    assert.equal(plan.preferredStartSeconds, 20);
    assert.equal(plan.sampleDurationSeconds, 20);
    assert.equal(plan.selectionProtocol, 1);
    assert.equal(Object.isFrozen(plan), true);
});

test('short media use their own disjoint strata instead of borrowing a neighbor', () => {
    assert.deepEqual([1, 2, 3, 4].map((ordinal) => {
        const plan = planStrictSpeechWindow(80, ordinal);
        return [plan.searchStartSeconds, plan.searchDurationSeconds, plan.preferredStartSeconds];
    }), [[0, 20, 0], [20, 20, 0], [40, 20, 0], [60, 20, 0]]);
    const plan = planStrictSpeechWindow(100, 2);
    assert.equal(plan.searchStartSeconds, 25);
    assert.equal(plan.searchDurationSeconds, 25);
    assert.equal(plan.preferredStartSeconds, 2.5);
});

test('every plan retains integral bounded coordinates and non-overlap at fractional boundaries', () => {
    const durations = [80, 80.001, 80.005, 99.999, 100, 119.999, 120, 120.001,
        120.005, 121.123, 300, 7248.048, 86400];
    for (const duration of durations) {
        const anchors = strictLidTimelineOffsets(duration);
        let priorSearchEnd = 0;
        for (let ordinal = 1; ordinal <= anchors.length; ordinal++) {
            const plan = planStrictSpeechWindow(duration, ordinal);
            assert.ok(plan, `${duration}/${ordinal}`);
            for (const [key, value] of Object.entries(plan)) {
                if (key.endsWith('Milliseconds')) assert.ok(Number.isSafeInteger(value), key);
            }
            assert.equal(plan.anchorOffsetSeconds, anchors[ordinal - 1]);
            const searchEnd = plan.searchStartMilliseconds + plan.searchDurationMilliseconds;
            assert.ok(plan.searchDurationMilliseconds >= 20_000);
            assert.ok(plan.searchDurationMilliseconds <= 60_000);
            assert.ok(plan.searchStartMilliseconds >= plan.stratumStartMilliseconds);
            assert.ok(searchEnd <= plan.stratumEndMilliseconds);
            assert.ok(plan.searchStartMilliseconds >= priorSearchEnd);
            assert.ok(plan.anchorOffsetMilliseconds >= plan.searchStartMilliseconds);
            assert.ok(plan.anchorOffsetMilliseconds + 20_000 <= searchEnd);
            priorSearchEnd = searchEnd;
        }
    }
});

test('invalid duration or ordinal fails before any source access', () => {
    for (const duration of [null, undefined, '120', NaN, Infinity, -1, 0, 79.999, 86400.001]) {
        assert.equal(planStrictSpeechWindow(duration, 1), null);
    }
    for (const ordinal of [null, undefined, '1', NaN, Infinity, -1, 0, 1.1, 7]) {
        assert.equal(planStrictSpeechWindow(600, ordinal), null);
    }
    assert.equal(planStrictSpeechWindow(100, 5), null);
});

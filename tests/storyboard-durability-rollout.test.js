'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createStoryboardDurabilityPolicy: policy } = require('../services/media-gateway/src/storyboard-durability');
const owner = crypto.randomUUID(), source = crypto.randomUUID(), other = crypto.randomUUID();
const base = { STORYBOARD_PRIVATE_DIR: path.join(os.tmpdir(), 'storyboard-rollout-test') };

test('durability remains dormant without a persistent directory and explicit admission', () => {
    for (const config of [{}, base, { STORYBOARD_DURABLE_ROLLOUT_BPS: '10000' },
        { STORYBOARD_PRIVATE_DIR: 'relative', STORYBOARD_DURABLE_SOURCE_IDS: source }]) {
        assert.equal(policy(config).admits(owner, source), false);
        assert.equal(policy(config).publicStatus().enabled, false);
    }
});
test('source canary admits its source and rejects unlisted or malformed identities', () => {
    const p = policy({ ...base, STORYBOARD_DURABLE_SOURCE_IDS: source });
    assert.equal(p.admits(owner, source), true);
    assert.equal(p.admits(owner, other), false);
    assert.equal(p.admits('', source), false);
    assert.equal(p.admits(owner, '../source'), false);
    assert.equal(p.publicStatus().scope, 'selected-sources');
});
test('rollout cohorts are stable across processes and sources, and expand monotonically', () => {
    const small = policy({ ...base, STORYBOARD_DURABLE_ROLLOUT_BPS: '2000' });
    const repeat = policy({ ...base, STORYBOARD_DURABLE_ROLLOUT_BPS: '2000' });
    const large = policy({ ...base, STORYBOARD_DURABLE_ROLLOUT_BPS: '5000' });
    let admitted = 0;
    for (let i = 0; i < 200; i++) {
        const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        const selected = small.admits(id, source);
        assert.equal(selected, repeat.admits(id, other));
        assert.ok(!selected || large.admits(id, other));
        admitted += Number(selected);
    }
    assert.ok(admitted > 0 && admitted < 200);
});
test('global persistence needs no source exception, but does not admit invalid owners', () => {
    const p = policy({ ...base, STORYBOARD_DURABLE_ROLLOUT_BPS: '10000' });
    assert.equal(p.admits(owner, source), true);
    assert.equal(p.admits(crypto.randomUUID(), other), true);
    assert.equal(p.admits('anonymous', source), false);
    assert.equal(p.publicStatus().scope, 'all-authenticated-owners');
    assert.equal(p.publicStatus().providerScoped, false);
});
test('invalid rollout configuration fails closed instead of widening the cohort', () => {
    for (const raw of ['-1', '10001', '20%', '2000junk', 'NaN']) {
        assert.equal(policy({ ...base, STORYBOARD_DURABLE_ROLLOUT_BPS: raw }).enabled, false);
    }
    assert.equal(policy({ ...base, STORYBOARD_DURABLE_SOURCE_IDS: source + ',*',
        STORYBOARD_DURABLE_ROLLOUT_BPS: '10000' }).enabled, false);
});

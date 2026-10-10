const test = require('node:test'), assert = require('node:assert/strict');
const target = { userId: '00000000-0000-4000-8000-000000000001', sourceId: '00000000-0000-4000-8000-000000000002', itemType: 'movie', itemId: '1' };
const load = () => import('../ops/hetzner/media/startup-cache-worker.mjs');
test('startup worker accepts only a bounded private catalogue queue', async () => {
  const { startupTargets } = await load();
  assert.deepEqual(startupTargets([target]), [target]);
  for (const input of [[], Array(9).fill(target), [{ ...target, sourceUrl: 'secret' }], [{ ...target, itemType: 'live' }]])
    assert.throws(() => startupTargets(input));
});
test('worker serializes files, skips fresh entries and never logs provider text', async () => {
  const { runStartupCycle } = await load(); let active = 0, maximum = 0; const results = [];
  assert.equal(await runStartupCycle({ targets: [target, { ...target, itemId: '2' }, { ...target, itemId: '3' }],
    endpoint: 'https://edge.invalid/startup-cache/prepare', token: 'private', eligible: i => i !== 1,
    fetchImpl: async () => { maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 2)); active--;
      return { ok: true, json: async () => ({ protocol: 1, prepared: true, refreshAfterSeconds: 99999, reason: 'credentials' }) }; },
    onResult: (i,r) => results.push([i,r]) }), true);
  assert.equal(maximum, 1); assert.deepEqual(results.map(x => x[0]), [0,2]);
  assert.equal(results[0][1].refreshAfterSeconds, 300); assert.doesNotMatch(JSON.stringify(results), /credentials|private/);
});
test('uncertain service response stops the worker cycle before another account acquisition', async () => {
  const { runStartupCycle } = await load(); let calls = 0;
  assert.equal(await runStartupCycle({ targets: [target, target], endpoint: 'https://edge.invalid/startup-cache/prepare', token: 'private',
    fetchImpl: async () => { calls++; throw Error('provider credentials'); } }), false);
  assert.equal(calls, 1);
});

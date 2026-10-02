const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../services/media-gateway/src/index.js'), 'utf8');
const start = source.indexOf('async function stopProviderAffinities(');
const end = source.indexOf('\nasync function stopConflictingSourceSessions(', start);

function harness({ failedMetadataDrain = false } = {}) {
  const stopped = [], closed = [], aborted = [];
  const sessions = new Map([
    ['primary', { id: 'primary', sourceUrl: 'same', status: 'ready' }],
    ['joined', { id: 'joined', sourceUrl: 'same', status: 'ready', primaryViewerAttached: false,
      viewerAttachments: { snapshot: () => ({ count: 1 }) } }],
    ['other', { id: 'other', sourceUrl: 'other', status: 'ready' }],
  ]);
  const rawPumps = new Set([{ proxyKey: 'same' }, { proxyKey: 'other' }]);
  const metadata = { preempted: false, child: { providerMetadataTransport: true,
    async stopAndDrain() { if (failedMetadataDrain) return false; metadata.drained = true; return true; } } };
  const extraction = { preempted: false, child: { name: 'probe' } };
  const unrelated = { preempted: false, child: { name: 'unrelated' } };
  const strictLidBrokers = new Map();
  const broker = { async close(reason) { closed.push(reason); strictLidBrokers.delete(broker); } };
  strictLidBrokers.set(broker, 'same');
  const context = {
    sessions, rawPumps, strictLidBrokers,
    accountExtractions: new Map([['same', new Set([metadata, extraction])], ['other', new Set([unrelated])]]),
    providerMetadataPriorityFence: { reserve() {} },
    providerAffinityHashForGatewayKey: key => key, proxyKeyFromUrl: url => url,
    isSessionBlockingProviderSlot: session => session.status === 'ready',
    stopSession: async session => { stopped.push(session.id); session.status = 'stopped'; },
    abortRawPumps: predicate => { for (const pump of rawPumps) if (predicate(pump)) {
      aborted.push(pump); rawPumps.delete(pump);
    } return aborted.length; },
    stopChildProcess: async child => { closed.push(child.name); },
    isUndrainedProviderMetadata: entry => Boolean(entry.child?.providerMetadataTransport && !entry.drained),
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.stop = stopProviderAffinities;', context);
  return { context, stopped, aborted, closed, metadata, extraction, unrelated };
}

test('ordinary viewer startup drains auxiliary work but preserves primary, joined and raw viewers', async () => {
  const h = harness();
  const result = await h.context.stop(['same'], { backgroundOnly: true });
  assert.equal(result.providerDrained, true);
  assert.equal(result.stoppedSessions, 0);
  assert.equal(result.abortedRawPumps, 0);
  assert.deepEqual(h.stopped, []);
  assert.deepEqual(h.aborted, []);
  assert.equal(h.context.sessions.get('joined').status, 'ready');
  assert.equal(h.context.rawPumps.size, 2);
  assert.equal(h.metadata.drained, true);
  assert.equal(h.extraction.preempted, true);
  assert.equal(h.unrelated.preempted, false);
  assert.deepEqual(h.closed, ['probe', 'viewer-preempted']);
});

test('failed auxiliary socket drain fails closed without evicting viewers', async () => {
  const h = harness({ failedMetadataDrain: true });
  const result = await h.context.stop(['same'], { backgroundOnly: true });
  assert.equal(result.providerDrained, false);
  assert.deepEqual(h.stopped, []);
  assert.equal(h.context.rawPumps.size, 2);
});

test('account deletion retains its full scoped transport revocation', async () => {
  const h = harness();
  const result = await h.context.stop(['same']);
  assert.equal(result.providerDrained, true);
  assert.deepEqual(h.stopped, ['primary', 'joined']);
  assert.equal(h.aborted.length, 1);
  assert.equal(h.context.sessions.get('other').status, 'ready');
  assert.equal(h.unrelated.preempted, false);
});

test('startup endpoint is authenticated, explicit and never reuses the account deletion route', () => {
  const routeStart = source.indexOf("app.post('/sessions/preempt-background-provider-affinities'");
  const route = source.slice(routeStart, source.indexOf("app.post('/sessions/stop-provider-affinities'", routeStart));
  assert.match(route, /requireGatewayAuth/);
  assert.match(route, /backgroundOnly: true/);
  assert.match(route, /scope: 'auxiliary-only'/);
  assert.match(route, /backgroundDrained: outcome.providerDrained/);
});

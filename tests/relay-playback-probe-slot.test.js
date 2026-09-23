const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'services/norva-relay/src/index.js'), 'utf8');
const start = source.indexOf('async function relayProbeAudio(');
const end = source.indexOf('// In-isolate hint:', start);

async function harness(cached = null) {
  const { classifyRelaySessionClaims } = await import(pathToFileURL(path.join(
    root, 'services/norva-relay/src/relayPlaybackSessionPolicy.mjs')).href);
  const calls = { provider: 0, probe: 0, cacheWrite: 0 };
  const run = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
    URL, Request, Response, classifyRelaySessionClaims,
    caches: { default: {
      match: async () => cached ? Response.json(cached) : undefined,
      put: async () => { calls.cacheWrite++; },
    } },
    json: (_request, _env, value) => value,
    fetch: async () => { calls.provider++; return Response.json({}); },
    probeContainerTracks: async () => {
      calls.probe++;
      return { audioTracks: [{ index: 1, lang: 'ar' }], subtitleTracks: [] };
    },
    normalizeRelayLang: () => null,
  });
  return { calls, run: claims => run({}, {}, {
    url: 'https://provider.example/series/test-user/test-password/1.mp4', ...claims,
  }, { waitUntil: () => {} }) };
}

const viewer = {
  v: 2, purpose: 'playback', sid: 'b2c7ccfa-f438-4b84-9ed3-28d2c4a2d5fb', coord: 'A'.repeat(43),
};

test('cold viewer audio enrichment opens no competing provider connection', async () => {
  const h = await harness();
  const result = await h.run(viewer);
  assert.equal(result.deferred, true);
  assert.equal(result.audioProbeComplete, false);
  assert.equal(result.subtitleProbeComplete, false);
  assert.deepEqual(h.calls, { provider: 0, probe: 0, cacheWrite: 0 });
});

test('sealed and invalid playback claims cannot acquire an auxiliary media slot', async () => {
  for (const claims of [{ ...viewer, coord: undefined, route: 'B'.repeat(95) }, { v: 2 }]) {
    const h = await harness();
    assert.equal((await h.run(claims)).deferred, true);
    assert.equal(h.calls.probe, 0);
  }
});

test('viewer retains exact cached audio and subtitle evidence without provider I/O', async () => {
  const evidence = { audioTracks: [{ index: 1, lang: 'ar' }], subtitles: [],
    audioProbeComplete: true, subtitleProbeComplete: true };
  const h = await harness(evidence);
  assert.deepEqual(await h.run(viewer), evidence);
  assert.deepEqual(h.calls, { provider: 0, probe: 0, cacheWrite: 0 });
});

test('scheduled service probes still discover and cache exact tracks', async () => {
  const h = await harness();
  const result = await h.run({ v: 1, sid: 'provider-check', uid: 'service-user' });
  assert.equal(result.audioProbeComplete, true);
  assert.equal(result.audioTracks[0].lang, 'ar');
  assert.equal(h.calls.probe, 1);
  assert.equal(h.calls.cacheWrite, 1);
});

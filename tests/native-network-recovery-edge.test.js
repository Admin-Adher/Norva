const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8').replace(/\r\n/g, '\n');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
test('native raw recovery preserves the input container even when its codecs need browser conversion', () => {
  const policy = section('const nativeNetworkRecovery =', '\n  const serverOwnedEpisodeGateway');
  const routing = section('const serverPromotedRelay =', '\n  if (serverPromotedRelay');
  for (const container of ['mkv', 'ts', 'avi']) for (const tier of ['video_transcode', 'audio_transcode']) {
    for (const recovery of [false, true]) {
      const result = vm.runInNewContext(`${policy}\n${routing}\n({mode,nativeNetworkRecovery})`, {
        body: {enginePipe: true, nativeNetworkRecovery: recovery}, itemType: 'movie', clientMode: 'relay',
        browserNativeMp4: false, authoritativeVodTier: tier, authoritativeVodContainer: container,
        serverOwnedEpisodeGateway: false, serverDirectPublicHls: false, serverNativeProviderMp4: false,
        serverPromotedProviderMp4: false, serverDemotedAutomaticMp4: false, serverSelectionVodRelay: false,
      });
      assert.equal(result.mode, recovery ? 'relay' : 'transcode');
    }
  }
});
test('native recovery uses a committed, owned raw session before returning and fences exact episode preparation', () => {
  const raw = section('let nativeAccessProof =', '\n    // In-browser engine:');
  assert.match(raw, /nativeVodFileProof\(resolved\.playbackHint\)/);
  assert.match(raw, /nativeNetworkRecovery && !nativeAccessProof/);
  assert.match(raw, /if \(!nativeCoordination\?\.lockId\)/);
  assert.match(raw, /const capability = await createBytePipeCapability\(session\.id, userId, targetUrl,/);
  assert.match(raw, /nativeNetworkRecovery \? "native-vod-recovery" : "native-browser-mp4"/);
  assert.match(raw, /validNativeMp4Grant\(grant, session\.id, capability\.gatewayPublicBaseUrl\)/);
  assert.match(raw, /if \(!committed\?\.ok\)/);
  assert.match(raw, /await bindPreparedPlaybackReceipt/);
  assert.match(raw, /transport: nativeNetworkRecovery \? "native-raw-recovery"/);
  assert.match(raw, /url: access\.toString\(\)/);
  assert.doesNotMatch(raw, /url: pipe\.url|\/detect-language|\/probe/);
  assert.ok(raw.indexOf("if (nativeCoordination.waitMs)") < raw.indexOf("await loadNativeEpisodeAccessProof"));
  assert.match(raw, /itemType === "movie" \|\| nativeEpisodeRecovery/);
});

test('native recovery receives the same renewable lease marker as browser native playback', () => {
  const marker = source.match(/__norvaNativeMp4SessionV1:\s*([^\n]+),/)[1];
  for (const serverNativeProviderMp4 of [false, true]) for (const nativeNetworkRecovery of [false, true]) {
    const value = vm.runInNewContext(marker, {serverNativeProviderMp4,nativeNetworkRecovery});
    assert.equal(value, serverNativeProviderMp4 || nativeNetworkRecovery ? true : undefined);
  }
  const binding = section('requestedPlaybackHint = compactRecord({\n    ...stripMkvH264FastStartInternalHints', '\n  const entitlement');
  assert.ok(binding.indexOf('stripMkvH264FastStartInternalHints') < binding.indexOf('__norvaNativeMp4SessionV1'));
});

for (const scenario of ['missing', 'cached', 'coordinator-refused', 'probe-failed']) {
  test(`native movie preparation is fenced by the session coordinator (${scenario})`, async () => {
    const body = section('let nativeAccessProof =', '\n    // In-browser engine:');
    const events = [];
    const proof = { fileSizeBytes: 123456, durationSeconds: 120 };
    class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
    const context = {
      HttpError, URL, AbortSignal, performance, console: { info() {} },
      nativeNetworkRecovery: true, itemType: 'movie', itemId: 'movie', mode: 'relay',
      resolved: { playbackHint: {} }, nativeMp4Proof: null, serverNativeProviderMp4: false,
      episodeCoordinates: null, userId: 'owner', sourceId: 'source', deviceId: 'device',
      providerAccountHash: 'account-hash', targetUrlHash: 'target-hash', targetUrl: 'https://owned.test/movie.mkv',
      playbackCreatedAt: 'created', supersededSessionIds: ['old'], transportExpiresAt: 'expires',
      session: { id: 'session' }, db: {}, userAgent: 'native-agent',
      startupTrace: {}, startupTraceAt: 'now', startupTraceStarted: performance.now(), markStartup() {},
      nativeVodFileProof: () => null,
      loadNativeMovieAccessProof: async () => { events.push('cached'); return scenario === 'cached' ? proof : null; },
      prepareEdgeSessionCoordinator: async () => {
        events.push('coordinate'); return scenario === 'coordinator-refused' ? null : { lockId: 'lock', waitMs: 50 };
      },
      sleep: async ms => { assert.equal(ms, 50); events.push('drain'); },
      prepareNativeMovieAccessProof: async options => {
        assert.equal(options.userId, 'owner'); assert.equal(options.sourceId, 'source');
        assert.equal(options.itemId, 'movie'); assert.equal(options.targetUrl, 'https://owned.test/movie.mkv');
        events.push('probe'); if (scenario === 'probe-failed') throw new HttpError(503, 'no proof'); return proof;
      },
      loadSourceConfigRevision: async () => 1, createSharedFragmentGrant: async () => null,
      createBytePipeCapability: async (_id, _user, url, _exp, _db, _ua, scope, size) => {
        assert.equal(url, 'https://owned.test/movie.mkv'); assert.equal(scope, 'native-vod-recovery');
        assert.equal(size, 123456); events.push('capability');
        return { gatewayUrl: 'https://gateway.test', gatewayPublicBaseUrl: 'https://gateway.test', capability: 'private', serviceToken: 'secret' };
      },
      fetch: async url => {
        assert.equal(url, 'https://gateway.test/native-sessions'); events.push('grant');
        return { ok: true, json: async () => ({ url: 'https://gateway.test/native.mp4' }) };
      },
      validNativeMp4Grant: () => true,
      commitEdgeSessionCoordinator: async () => { events.push('commit'); return { ok: true }; },
      bindPreparedPlaybackReceipt: async () => events.push('receipt'),
      expirePlaybackSession: async () => events.push('expire'),
      abortEdgeSessionCoordinator: async () => events.push('abort'),
      publicPlaybackSession: value => value,
    };
    const run = vm.runInNewContext(stripTypeScriptTypes(`(async function(){${body}})`), context);
    if (scenario === 'coordinator-refused' || scenario === 'probe-failed') {
      await assert.rejects(run(), error => error.status === 503);
      assert.deepEqual(events, scenario === 'coordinator-refused'
        ? ['cached', 'coordinate', 'expire'] : ['cached', 'coordinate', 'drain', 'probe', 'expire', 'abort']);
    } else {
      const result = await run(); assert.equal(result.playback.transport, 'native-raw-recovery');
      assert.deepEqual(events, ['cached', 'coordinate', 'drain', ...(scenario === 'missing' ? ['probe'] : []),
        'capability', 'grant', 'commit', 'receipt']);
    }
  });
}

test('explicit native Live recovery bypasses browser TS promotion without selecting finite native playback', () => {
  const policy = section('const nativeNetworkRecovery =', '\n  const serverOwnedEpisodeGateway');
  const routing = section('const serverPromotedRelay =', '\n  if (serverPromotedRelay');
  const marker = source.match(/__norvaNativeMp4SessionV1:\s*([^\n]+),/)[1];
  for (const recovery of [false, true]) for (const enginePipe of [false, true]) {
    const result = vm.runInNewContext(`${policy}\n${routing}\n({mode,nativeNetworkRecovery,nativeLiveNetworkRecovery,marker:${marker}})`, {
      body: { enginePipe, nativeNetworkRecovery: recovery }, itemType: 'live', clientMode: 'relay',
      browserNativeMp4: false, authoritativeVodTier: null, authoritativeVodContainer: 'ts',
      serverOwnedEpisodeGateway: false, serverDirectPublicHls: false, serverNativeProviderMp4: false,
      serverPromotedProviderMp4: false, serverDemotedAutomaticMp4: false, serverSelectionVodRelay: false,
    });
    assert.equal(result.mode, recovery && enginePipe ? 'relay' : 'transcode');
    assert.equal(result.nativeNetworkRecovery, false, 'Live cannot select the native finite-file route');
    assert.equal(result.nativeLiveNetworkRecovery, recovery && enginePipe);
    assert.equal(result.marker, undefined, 'Live cannot gain the MP4 liveness lease');
  }
});

for (const preparationState of ['legacy', 'active', 'cancelled']) test(`native Live recovery preserves ${preparationState} preparation through the actual raw branch`, async () => {
  const policy = section('const nativeNetworkRecovery =', '\n  const serverOwnedEpisodeGateway');
  const routing = section('const serverPromotedRelay =', '\n  if (serverPromotedRelay');
  const start = source.indexOf('  if (mode === "relay") {\n    let nativeAccessProof');
  const end = source.indexOf('\n    // Browser-safe relay traffic', start);
  assert.ok(start > 0 && end > start);
  const raw = source.slice(start, end) + '\n  }';
  const events = [];
  const ownedUrl = 'https://owned-provider.invalid/live/authorized/channel.ts';
  const session = { id: 'owned-live-session' };
  const controller = new AbortController();
  const cancelled = Object.assign(new Error('exact preparation cancelled'), { name: 'AbortError' });
  const preparation = preparationState === 'legacy' ? null : {
    id: 'exact-live-preparation', playbackSessionId: session.id, signal: controller.signal,
    async assertCurrent() {
      events.push('assert-preparation');
      if (controller.signal.aborted) throw cancelled;
    },
  };
  const context = {
    body: { enginePipe: true, nativeNetworkRecovery: true }, itemType: 'live', itemId: 'channel',
    clientMode: 'relay', browserNativeMp4: false, authoritativeVodTier: null, authoritativeVodContainer: 'ts',
    serverOwnedEpisodeGateway: false, serverDirectPublicHls: false, serverNativeProviderMp4: false,
    serverPromotedProviderMp4: false, serverDemotedAutomaticMp4: false, serverSelectionVodRelay: false,
    nativeMp4Proof: null, episodeCoordinates: null, userId: 'owner', sourceId: 'owned-source', deviceId: 'device',
    providerAccountHash: 'provider-hash', targetUrlHash: 'exact-target-hash', targetUrl: ownedUrl,
    playbackCreatedAt: 'created', supersededSessionIds: ['old-session'], requestedPlaybackHint: { container: 'ts' },
    ttlSeconds: 900, expiresAt: 'expires', userAgent: 'native-user-agent', session, selectionFileSnapshot: {}, preparation,
    db: { from() { throw new Error('Live must not open a finite-file metadata/probe route'); } },
    engineRawTokenExpiresAt: () => 'raw-expires',
    prepareEdgeSessionCoordinator: async claim => {
      assert.equal(claim.userId, 'owner'); assert.equal(claim.sourceId, 'owned-source');
      assert.equal(claim.deviceId, 'device'); assert.equal(claim.itemType, 'live');
      assert.equal(claim.targetUrlHash, 'exact-target-hash');
      events.push('coordinate'); return { lockId: 'lock', waitMs: 25 };
    },
    sleep: async ms => { assert.equal(ms, 25); events.push('release-wait'); },
    createBytePipeAccess: async (id, owner, url, expiry, _db, _ua, scope, size, canary, receivedPreparation, publicPlayback) => {
      assert.equal(id, session.id); assert.equal(owner, 'owner'); assert.equal(url, ownedUrl);
      assert.equal(expiry, 'raw-expires'); events.push('raw-grant');
      assert.equal(scope, null); assert.equal(size, null); assert.equal(canary, true);
      assert.equal(receivedPreparation, preparation, 'the exact preparation accompanies the raw capability');
      assert.equal(publicPlayback, true, 'a native client requires the public ingress of that same route');
      if (preparationState === 'cancelled') controller.abort();
      return { url: 'https://gateway.invalid/raw/exact-grant' };
    },
    commitEdgeSessionCoordinator: async (claim, info) => {
      assert.equal(claim.lockId, 'lock'); assert.equal(info.lane, 'raw');
      assert.equal(info.playbackSessionId, session.id); events.push('commit'); return { ok: true };
    },
    resolveEngineAudioTitleRow: async () => null, resolveFileTracksKey: async () => null,
    recordOrEmpty: value => value || {}, stringOr: (value, fallback) => value || fallback,
    bindPreparedPlaybackReceipt: async cleanup => {
      assert.equal(typeof cleanup, 'function'); events.push('receipt');
    },
    publicPlaybackSession: value => value,
  };
  const execute = vm.runInNewContext(stripTypeScriptTypes(`(async function(){${policy}\n${routing}\n${raw}\nthrow new Error('unexpected transport');})`), context);
  if (preparationState === 'cancelled') {
    await assert.rejects(execute(), error => error === cancelled);
    assert.deepEqual(events, ['coordinate', 'release-wait', 'raw-grant', 'assert-preparation']);
    return;
  }
  const result = await execute();
  assert.deepEqual(events, ['coordinate', 'release-wait', 'raw-grant',
    ...(preparation ? ['assert-preparation'] : []), 'commit', 'receipt']);
  assert.equal(result.session, session);
  assert.equal(result.playback.mode, 'relay');
  assert.equal(result.playback.url, 'https://gateway.invalid/raw/exact-grant');
  assert.equal(result.playback.transport, undefined, 'not a native-MP4 session');
});

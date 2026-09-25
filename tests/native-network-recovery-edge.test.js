const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
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
test('native recovery uses a committed, owned raw session before returning and never opens a track probe', () => {
  const raw = section('const nativeAccessProof =', '\n    // In-browser engine:');
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

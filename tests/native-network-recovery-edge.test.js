const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../supabase/functions/norva-playback/index.ts'), 'utf8');
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
  const raw = section('const rawCoordination =', '\n      // Name the audio');
  assert.match(raw, /nativeNetworkRecovery && !rawCoordination\?\.lockId/);
  assert.match(raw, /const pipe = await createBytePipeAccess\([\s\S]*session\.id,[\s\S]*userId,[\s\S]*targetUrl,/);
  assert.match(raw, /const rawCommit = await commitEdgeSessionCoordinator/);
  assert.match(raw, /if \(!rawCommit\?\.ok\)/);
  assert.match(raw, /bindPreparedPlaybackReceipt\(\(\) => expirePlaybackSession\(session\.id, userId, db\)\)/);
  assert.match(raw, /return \{ session: publicPlaybackSession\(session\), playback:/);
  assert.match(raw, /transport: "native-raw-recovery"/);
});

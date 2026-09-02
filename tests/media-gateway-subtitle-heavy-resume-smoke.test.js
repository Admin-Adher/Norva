const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(
  path.join(root, 'ops/hetzner/media/private-subtitle-heavy-resume-smoke-client.mjs'),
  'utf8',
);
const runner = fs.readFileSync(
  path.join(root, 'ops/hetzner/media/run-private-subtitle-heavy-resume-smoke.sh'),
  'utf8',
);

test('subtitle-heavy resume smoke is fixed-input, private and cannot target production', () => {
  assert.match(runner, /CANARY_GATEWAY_CONTAINER is required/);
  assert.match(runner, /GATEWAY_CONTAINER.*!= 'norva-media-gateway'.*production-gateway-refused/);
  assert.match(runner, /norva-media-gateway-\[a-z0-9-\]\+-canary/);
  assert.match(client, /const PROVIDER_ROUTE = '\/fixture-subtitle-heavy\.mkv'/);
  assert.doesNotMatch(client, /process\.env\.(?:SOURCE|PROVIDER)_(?:URL|ROUTE)/);
  assert.match(runner, /--network none[\s\S]*fixture-subtitle-heavy\.mkv/);
  assert.match(client, /maximumConcurrent === 1/);
});

test('subtitle-heavy resume smoke exercises cold and measured-seek VAAPI below ten seconds', () => {
  assert.match(client, /const MAX_STARTUP_MS = 10_000/);
  assert.match(client, /videoMode === 'encode'/);
  assert.match(client, /videoEncoder === 'vaapi'/);
  assert.match(client, /ffmpegSpawnCount.*=== 1/);
  assert.match(client, /seekOffset: 0, ordinal: 'cold'/);
  assert.match(client, /seekOffset: 18,[\s\S]*requestedSubtitleStreamIndex/);
  assert.match(client, /actualStartOffset.*>= 17/);
  assert.match(runner, /There are 2 hardware devices/);
  assert.match(runner, /Impossible to convert between the formats/);
});

test('subtitle-heavy resume smoke preserves all exact rows while bounding startup and cleanup', () => {
  const languageList = /const SUBTITLE_LANGUAGES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(client)?.[1] || '';
  assert.equal((languageList.match(/'[a-z]{3}'/g) || []).length, 32);
  assert.match(client, /sourceTrackCount === 32/);
  assert.match(client, /preparedTrackCount === 8/);
  assert.match(client, /subtitleRenditions\?\.\[0\]\?\.streamIndex === requestedSubtitleStreamIndex/);
  assert.match(client, /activeSessions === 0/);
  assert.match(client, /videoEncoderCapacity\?\.active === 0/);
  assert.match(client, /vodInputPump\?\.active === 0/);
  assert.match(client, /rawPumpCount === 0/);
  assert.match(client, /activeStrictLidBrokers === 0/);
});

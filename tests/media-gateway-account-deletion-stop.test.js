const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'media-gateway', 'src', 'index.js'), 'utf8');

test('account deletion stop endpoint is authenticated and drains every provider lane', () => {
  const route = source.slice(source.indexOf("app.post('/sessions/stop-provider-affinities'"), source.indexOf("app.post('/xtream/epg'", source.indexOf("app.post('/sessions/stop-provider-affinities'")));
  const helper = source.slice(source.indexOf('async function stopProviderAffinities'), source.indexOf('async function stopConflictingOwnerSessions'));
  assert.match(route, /requireGatewayAuth/);
  assert.match(route, /affinityHashes/);
  assert.match(route, /providerDrained/);
  assert.doesNotMatch(route, /sourceUrl|ownerKey|session\.id|credentials/i);
  assert.match(helper, /stopSession\(session, \{ reason: 'account-deletion' \}\)/);
  assert.match(helper, /abortRawPumps/);
  assert.match(helper, /accountExtractions/);
  assert.match(helper, /stopChildProcess/);
  assert.match(helper, /strictLidBrokers/);
  assert.match(helper, /broker\.close\('viewer-preempted'\)/);
  assert.match(helper, /stoppedLanguageValidations/);
  assert.match(helper, /providerDrained: !remaining/);
});

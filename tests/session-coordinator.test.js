const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadMatcher() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'norva-relay', 'src', 'index.js'),
    'utf8'
  ).replace(/\r\n/g, '\n');
  const start = source.indexOf('function matchesSessionEndRequest(');
  const end = source.indexOf('\nfunction publicSession(', start);
  assert.ok(start >= 0 && end > start, 'session-end matcher not found');
  const stringHelperStart = source.indexOf('function stringOrNull(');
  const stringHelperEnd = source.indexOf('\nfunction boundedInt(', stringHelperStart);
  assert.ok(stringHelperStart >= 0 && stringHelperEnd > stringHelperStart, 'string helper not found');
  return new Function(
    source.slice(stringHelperStart, stringHelperEnd) +
    '\n' +
    source.slice(start, end) +
    '\nreturn matchesSessionEndRequest;'
  )();
}

const matches = loadMatcher();
const replacementGateway = {
  ownerKey: 'owner-a',
  sourceKey: 'source-a',
  playbackSessionId: 'new-playback',
  gatewaySessionId: 'new-gateway',
};

test('a delayed exact-session teardown cannot delete its replacement gateway', () => {
  assert.equal(matches(replacementGateway, {
    ownerKey: 'owner-a',
    sourceKey: 'source-a',
    playbackSessionId: 'old-playback',
  }), false);
});

test('exact playback or gateway ids still end their own session', () => {
  assert.equal(matches(replacementGateway, { playbackSessionId: 'new-playback' }), true);
  assert.equal(matches(replacementGateway, { gatewaySessionId: 'new-gateway' }), true);
});

test('owner/source cleanup remains available only when no exact id is supplied', () => {
  assert.equal(matches(replacementGateway, { ownerKey: 'owner-a', sourceKey: 'source-a' }), true);
  assert.equal(matches(replacementGateway, { ownerKey: 'owner-a', sourceKey: 'source-b' }), false);
});

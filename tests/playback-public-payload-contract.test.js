'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PLAYBACK_PATH = path.join(ROOT, 'supabase/functions/norva-playback/index.ts');
const PUBLIC_VIEW_PATH = path.join(ROOT, 'supabase/functions/_shared/cloud-public-view.mjs');
const PLAYBACK = fs.readFileSync(PLAYBACK_PATH, 'utf8').replace(/\r\n/g, '\n');

function section(start, end) {
  const from = PLAYBACK.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? PLAYBACK.indexOf(end, from + start.length) : PLAYBACK.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return PLAYBACK.slice(from, to);
}

test('playback success payloads use the shared private-by-default projections', async () => {
  const publicView = await import(pathToFileURL(PUBLIC_VIEW_PATH).href);
  const privateFields = {
    user_id: 'account-secret-id',
    provider_account_hash: 'provider-account-hash',
    target_url_hash: 'target-url-hash',
    external_session_id: 'gateway-private-id',
    error_message: 'raw-provider-error',
  };

  const session = publicView.sanitizePlaybackSession({
    ...privateFields,
    id: 'playback-id',
    source_id: 'source-id',
    playback_hint: { container: 'mkv', password: 'provider-password' },
  });
  const gateway = publicView.sanitizeGatewaySession({
    ...privateFields,
    id: 'gateway-id',
    status: 'ready',
    hls_url: 'https://gateway.norva.test/session.m3u8',
  });
  const event = publicView.sanitizePlaybackEvent({
    ...privateFields,
    id: 'event-id',
    event_type: 'first_frame',
  });

  const serialized = JSON.stringify({ session, gateway, event });
  for (const forbidden of [
    'account-secret-id',
    'provider-account-hash',
    'target-url-hash',
    'gateway-private-id',
    'raw-provider-error',
    'provider-password',
    '"user_id"',
    '"error_message"',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `playback payload leaked ${forbidden}`);
  }
  assert.equal(gateway.hls_url, 'https://gateway.norva.test/session.m3u8');
});

test('playback event and gateway responses cannot return raw database rows', () => {
  const event = section('async function recordPlaybackEvent(', 'async function recordPlaybackSessionFailure(');
  assert.match(event, /\.select\(PLAYBACK_EVENT_PUBLIC_SELECT\)/);
  assert.match(event, /return \{ event: sanitizePlaybackEvent\(data\) \}/);
  assert.doesNotMatch(event, /\.select\("\*"\)/);

  const creation = section('async function createPlaybackSessionCore(', 'async function createPlaybackSession(');
  assert.match(creation, /\.\.\.sanitizeGatewaySession\(gateway\.session\)/);
  const gatewayResponse = creation.slice(
    creation.indexOf('const gatewaySessionResponse ='),
    creation.indexOf('return {', creation.indexOf('const gatewaySessionResponse =')),
  );
  assert.doesNotMatch(gatewayResponse, /\.\.\.gateway\.session,/);

  const publicSession = section('function publicPlaybackSession(', 'function stripMkvH264FastStartProofDeep(');
  assert.match(publicSession, /sanitizePlaybackSession\(stripMkvH264FastStartProofDeep\(value\)\)/);
});

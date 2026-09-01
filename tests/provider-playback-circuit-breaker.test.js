const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('Edge and gateway derive the same provider identity for prefixed Xtream URLs', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const gatewayProxyPool = require('../services/media-gateway/src/providerProxyPool.js');
  const functionSource = section(
    edge,
    'function providerAccountKeyFromUrl(url: string): string {',
    '// POST /account-activity',
  ).replace(
    'function providerAccountKeyFromUrl(url: string): string {',
    'function providerAccountKeyFromUrl(url) {',
  );
  const edgeProviderAccountKey = Function(
    `"use strict"; ${functionSource}; return providerAccountKeyFromUrl;`,
  )();

  const prefixed = 'https://PANEL.EXAMPLE/prefix/movie/alice%2Btv/secret/42.mkv';
  const literalPercent = 'https://panel.example/prefix/series/plus%252Buser/secret/7.mp4';
  const metadata = 'https://panel.example/prefix/player_api.php?username=plus%252Buser';
  const spaced = 'https://panel.example:8443/prefix/movie/%20%20alice%20%20/secret/42.mkv';

  assert.equal(edgeProviderAccountKey(prefixed), 'panel.example/alice+tv');
  assert.equal(edgeProviderAccountKey(literalPercent), 'panel.example/plus%2Buser');
  assert.equal(edgeProviderAccountKey(metadata), 'panel.example/plus%2Buser');
  assert.equal(edgeProviderAccountKey(spaced), 'panel.example:8443/  alice  ');
  for (const url of [prefixed, literalPercent, metadata, spaced]) {
    assert.equal(
      gatewayProxyPool.providerAccountAffinityKey(url),
      edgeProviderAccountKey(url),
      `Edge and gateway must agree on the account key for ${url}`,
    );
  }
});

test('shouldOpenCircuitForProviderBusy is false within 8s of lastSelfReleaseAt', async () => {
  const policyPath = path.join(
    root,
    'supabase/functions/_shared/provider-playback-circuit-policy.mjs',
  );
  const policy = await import(`${pathToFileURL(policyPath).href}?handoff=${Date.now()}`);
  const nowMs = Date.parse('2026-08-13T10:00:00.000Z');

  assert.equal(policy.PROVIDER_HANDOFF_CIRCUIT_GRACE_MS, 8_000);
  assert.equal(
    policy.shouldOpenCircuitForProviderBusy({
      nowMs,
      lastSelfReleaseAt: new Date(nowMs - 1_000).toISOString(),
    }),
    false,
  );
  assert.equal(
    policy.shouldOpenCircuitForProviderBusy({
      nowMs,
      lastSelfReleaseAt: nowMs - 7_999,
    }),
    false,
  );
  assert.equal(
    policy.shouldOpenCircuitForProviderBusy({
      nowMs,
      lastSelfReleaseAt: new Date(nowMs - 8_000).toISOString(),
    }),
    true,
  );
  assert.equal(
    policy.shouldOpenCircuitForProviderBusy({ nowMs, lastSelfReleaseAt: null }),
    true,
  );
  assert.equal(
    policy.shouldOpenCircuitForProviderBusy({ nowMs, lastSelfReleaseAt: 'not-a-date' }),
    true,
  );
});

test('first HTTP 458 opens an account circuit immediately and repeated failures back off', async () => {
  const policyPath = path.join(
    root,
    'supabase/functions/_shared/provider-playback-circuit-policy.mjs',
  );
  const policy = await import(pathToFileURL(policyPath).href);
  const nowMs = Date.parse('2026-08-13T10:00:00.000Z');

  const first = policy.nextProviderCircuit({ nowMs, failureCount: 0 });
  assert.equal(first.failureCount, 1);
  assert.equal(first.blockedUntilMs, nowMs + 120_000);

  const open = policy.decideProviderCircuit({
    nowMs: nowMs + 1_000,
    blockedUntil: new Date(first.blockedUntilMs).toISOString(),
  });
  assert.equal(open.open, true);
  assert.equal(open.retryAfterSeconds, 119);

  const second = policy.nextProviderCircuit({ nowMs, failureCount: 1 });
  assert.equal(second.failureCount, 2);
  assert.equal(second.blockedUntilMs, nowMs + 240_000);
  assert.equal(policy.isProviderBusyFailure({ code: 'PROVIDER_BUSY' }), true);
  assert.equal(policy.isProviderBusyFailure({ upstreamStatus: 458 }), true);
  assert.equal(policy.isProviderBusyFailure({ upstreamStatus: 504 }), false);
});

test('background probes stop the same provider account after the first terminal 458 without treating proxy auth as provider busy', async () => {
  const policyPath = path.join(
    root,
    'supabase/functions/_shared/provider-playback-circuit-policy.mjs',
  );
  const policy = await import(`${pathToFileURL(policyPath).href}?terminal=${Date.now()}`);

  assert.equal(
    policy.providerProbeTerminalCode({ status: 458, code: 'PROVIDER_BUSY' }),
    'provider_busy',
  );
  assert.equal(
    policy.providerProbeTerminalCode({ status: 502, code: 'PROXY_AUTH_FAILED' }),
    'proxy_auth_failed',
  );
  assert.equal(
    policy.providerProbeTerminalCode({ status: 407, code: 'PROVIDER_BUSY' }),
    'proxy_auth_failed',
    'proxy authentication must win over ambiguous provider text and never open a 458 circuit',
  );
  assert.equal(policy.providerProbeTerminalCode({ status: 502, code: 'UPSTREAM_ERROR' }), null);

  const guard = policy.createProviderProbeTickGuard();
  let providerCalls = 0;
  for (const response of [
    { status: 458, code: 'PROVIDER_BUSY' },
    { status: 200, code: null },
  ]) {
    if (!guard.tryEnter('panel.example/account')) continue;
    providerCalls += 1;
    const terminal = policy.providerProbeTerminalCode(response);
    if (terminal) guard.stop('panel.example/account', terminal);
    guard.leave('panel.example/account');
  }
  assert.equal(providerCalls, 1, 'a second title from the same account must not be probed after 458');
  assert.equal(guard.terminalCode('panel.example/account'), 'provider_busy');
  assert.deepEqual(guard.terminalCodes(), ['provider_busy']);

  const proxyGuard = policy.createProviderProbeTickGuard();
  assert.equal(proxyGuard.tryEnter('panel.example/proxy-account'), true);
  proxyGuard.stop('panel.example/proxy-account', 'proxy_auth_failed');
  assert.equal(proxyGuard.tryEnter('panel.example/proxy-account'), false);
  assert.equal(proxyGuard.terminalCode('panel.example/proxy-account'), 'proxy_auth_failed');
});

test('repeated client reports cannot extend a live circuit or increase its backoff', async () => {
  const policyPath = path.join(
    root,
    'supabase/functions/_shared/provider-playback-circuit-policy.mjs',
  );
  const policy = await import(pathToFileURL(policyPath).href);
  const nowMs = Date.parse('2026-08-13T10:00:00.000Z');

  const first = policy.nextClientReportedProviderCircuit({ nowMs, failureCount: 0 });
  assert.deepEqual(first, {
    failureCount: 1,
    blockedUntilMs: nowMs + 120_000,
    changed: true,
  });

  const repeated = policy.nextClientReportedProviderCircuit({
    nowMs: nowMs + 1_000,
    failureCount: first.failureCount,
    blockedUntil: first.blockedUntilMs,
  });
  assert.deepEqual(repeated, {
    failureCount: 1,
    blockedUntilMs: first.blockedUntilMs,
    changed: false,
  });

  const afterExpiry = policy.nextClientReportedProviderCircuit({
    nowMs: nowMs + 121_000,
    failureCount: 8,
    blockedUntil: first.blockedUntilMs,
  });
  assert.equal(afterExpiry.failureCount, 8);
  assert.equal(afterExpiry.blockedUntilMs, nowMs + 241_000);
  assert.equal(afterExpiry.changed, true);
});

test('database owns circuit state without exposing cross-user account or session identifiers', () => {
  const migration = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((name) => /provider_playback_circuit_breaker\.sql$/.test(name))
    .map((name) => read(`supabase/migrations/${name}`))
    .join('\n');

  assert.match(migration, /create table if not exists public\.provider_playback_circuits/i);
  assert.match(migration, /provider_account_hash text/i);
  assert.match(migration, /superseded_at timestamptz/i);
  assert.doesNotMatch(migration, /add column if not exists superseded_by/i);
  assert.match(migration, /drop column if exists superseded_by/i);
  assert.match(migration, /create or replace function public\.claim_cloud_playback_session/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /unique index[\s\S]*\(provider_account_hash\)[\s\S]*status in \('pending', 'ready'\)/i);
  assert.doesNotMatch(migration, /unique index[\s\S]{0,220}\(user_id, provider_account_hash\)/i);
  assert.match(migration, /where provider_account_hash = p_provider_account_hash[\s\S]*status in \('pending', 'ready'\)/i);
  assert.match(migration, /status = 'expired'[\s\S]*superseded_at = v_now/i);
  assert.doesNotMatch(migration, /set[\s\S]{0,180}superseded_by\s*=/i);
  assert.match(migration, /create(?: or replace)? function public\.open_provider_playback_circuit/i);
  assert.match(migration, /on conflict \(provider_account_hash\)/i);
  assert.match(migration, /revoke all on table public\.provider_playback_circuits from public, anon, authenticated/i);
  assert.match(
    migration,
    /revoke select on table public\.cloud_playback_sessions from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /revoke select \(provider_account_hash\)[\s\S]{0,100}from public, anon, authenticated/i,
  );
  assert.match(migration, /revoke insert \(provider_account_hash, superseded_at\)[\s\S]{0,120}from public, anon, authenticated/i);
  assert.match(migration, /revoke update \(provider_account_hash, superseded_at\)[\s\S]{0,120}from public, anon, authenticated/i);
  const authenticatedProjection = migration.match(
    /grant select \(([\s\S]*?)\) on table public\.cloud_playback_sessions to authenticated/i,
  );
  assert.ok(authenticatedProjection, 'authenticated clients need an explicit safe session projection');
  assert.doesNotMatch(authenticatedProjection[1], /provider_account_hash|superseded_by/i);
  assert.match(migration, /grant execute on function public\.claim_cloud_playback_session[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /grant .*provider_playback_circuits.*authenticated/i);
  assert.match(migration, /p_source_id is null/);
});

test('client busy reports open a fixed circuit once while only a server-observed 458 escalates', () => {
  const migration = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((name) => /provider_playback_circuit_breaker\.sql$/.test(name))
    .map((name) => read(`supabase/migrations/${name}`))
    .join('\n');
  const edge = read('supabase/functions/norva-playback/index.ts');
  const report = section(edge, 'async function reportProviderPlaybackFailure(', 'async function createPlaybackSession(');
  const gateway = section(edge, 'async function createGatewaySession(', 'async function requestGatewaySession(');
  const record = section(edge, 'async function recordPlaybackSessionFailure(', 'async function getPlaybackTelemetrySummary(');

  assert.match(migration, /p_escalate boolean/i);
  assert.match(
    migration,
    /create function public\.open_provider_playback_circuit\(\s*p_provider_account_hash text,\s*p_reason_code text\s*\)[\s\S]*public\.open_provider_playback_circuit\(\s*p_provider_account_hash,\s*p_reason_code,\s*false\s*\)/i,
    'the old two-argument service-role Edge call must remain a non-escalating rolling-deploy shim',
  );
  assert.match(
    migration,
    /revoke all on function public\.open_provider_playback_circuit\(text, text\)[\s\S]*grant execute on function public\.open_provider_playback_circuit\(text, text\)[\s\S]*to service_role/i,
  );
  assert.match(migration, /if not p_escalate then[\s\S]*interval '120 seconds'[\s\S]*return query/i);
  assert.match(migration, /if found and v_previous\.blocked_until > v_now then[\s\S]*return query/i);
  assert.match(migration, /else[\s\S]*least\(16, v_previous\.failure_count \+ 1\)/i);
  assert.match(report, /shouldOpenCircuitForProviderBusy/);
  assert.match(report, /openProviderPlaybackCircuit\(providerAccountHash, db, false\)/);
  assert.match(report, /latestProviderSelfReleaseAt\(providerAccountHash, db, id\)/);
  assert.match(report, /circuitSkipped/);
  assert.match(gateway, /openProviderPlaybackCircuit\(providerAccountHash, db, true\)/);
  assert.match(gateway, /shouldOpenCircuitForProviderBusy/);
  assert.match(gateway, /PROVIDER_SLOT_RELEASE_DELAY_MS/);
  assert.ok(
    gateway.indexOf('openProviderPlaybackCircuit(providerAccountHash, db, true)')
      < gateway.indexOf('throw new HttpError'),
    'the server-observed 458 must open the circuit before it is propagated',
  );
  assert.doesNotMatch(record, /openProviderPlaybackCircuit/);
});

test('one playback intention permits only the 458 handoff or one proven container correction', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const gateway = section(edge, 'async function createGatewaySession(', 'async function requestGatewaySession(');
  const requests = [...gateway.matchAll(/requestGatewaySession\(/g)];

  assert.equal(
    requests.length,
    3,
    'one initial create plus mutually exclusive 458-handoff and container-correction retries',
  );
  const busyBranch = gateway.indexOf('isProviderBusyFailure');
  const mismatchBranch = gateway.indexOf('normalizeGatewaySourceContainerMismatch');
  assert.ok(busyBranch >= 0, 'handoff retry is gated on provider busy');
  assert.ok(mismatchBranch >= 0, 'container correction requires strict gateway evidence');
  assert.ok(
    requests[0].index < busyBranch,
    'the first requestGatewaySession call is the initial create',
  );
  assert.ok(
    requests[2].index > busyBranch,
    'the third requestGatewaySession call must be inside the 458-handoff retry',
  );
  assert.ok(
    requests[1].index > mismatchBranch && requests[1].index < busyBranch,
    'the only additional pre-busy request is the strict container-correction retry',
  );
  assert.match(gateway, /shouldOpenCircuitForProviderBusy/);
  assert.doesNotMatch(edge, /shouldRetryGatewayWithAudioTranscode|audioFallbackReason:\s*"copy_start_failed"/);
});

test('playback edge checks the circuit, claims one account session and reports supersession', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const create = section(edge, 'async function createPlaybackSession(', 'async function getPlaybackSession(');
  const heartbeat = section(edge, 'async function heartbeatPlaybackSession(', 'async function expirePlaybackSession(');

  assert.match(edge, /provider-playback-circuit-policy\.mjs/);
  assert.match(edge, /segments\[3\] === "provider-failure"/);
  assert.match(create, /providerAccountHashFromUrl\(targetUrl\)/);
  assert.match(create, /assertProviderCircuitClosed\(providerAccountHash, db\)/);
  assert.match(create, /db\.rpc\(\s*"claim_cloud_playback_session"/);
  assert.doesNotMatch(create, /\.from\("cloud_playback_sessions"\)\s*\.insert\(/);
  assert.match(create, /releaseSupersededPlaybackSessions/);
  assert.match(create, /PROVIDER_NATIVE_TAKEOVER_GRACE_MS/);
  assert.match(create, /mode !== "transcode"[\s\S]{0,160}releasedSuperseded > 0/);
  assert.match(heartbeat, /superseded_at/);
  assert.doesNotMatch(heartbeat, /superseded_by/);
  assert.match(heartbeat, /PLAYBACK_SUPERSEDED/);
  assert.match(edge, /open_provider_playback_circuit/);
  assert.match(edge, /PROVIDER_ACCOUNT_BUSY/);
  assert.match(edge, /version:\s*68/);
  assert.match(edge, /providerCircuitProtocol:\s*1/);
  assert.match(edge, /exactFileCodecProfileProtocol:\s*1/);
});

test('session creation derives the global account hash only from an owned server-resolved target', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const create = section(edge, 'async function createPlaybackSession(', 'async function getPlaybackSession(');
  const resolve = section(edge, 'async function resolvePlaybackTarget(', '// Series have no directly-playable stream id');

  assert.match(create, /if \(!sourceId \|\| !itemType \|\| !itemId\)/);
  assert.doesNotMatch(create, /body\.targetUrl|body\.target_url/);
  assert.match(resolve, /hint\.sourceType === "xtream"/);
  assert.match(resolve, /loadSourceConfig\(sourceId, userId, db\)/);
  assert.match(resolve, /providerAccountScope:\s*`user-source:\$\{userId\}:\$\{sourceId\}`/);
  assert.match(create, /"providerAccountScope" in resolved[\s\S]{0,200}sha256Hex\(providerAccountScope\)/);
  assert.ok(
    resolve.indexOf('if (hint.sourceType === "xtream")') < resolve.indexOf('if (typeof hint.targetUrl === "string")'),
    'Xtream targets must be rebuilt from the owned source before opaque M3U handling',
  );
  const ownership = create.indexOf('await assertOwnedSource(sourceId, userId, db)');
  const resolution = create.indexOf('await resolvePlaybackTarget(');
  const hashing = create.indexOf('providerAccountHashFromUrl(targetUrl)');
  assert.ok(ownership >= 0 && ownership < resolution, 'source ownership precedes resolution');
  assert.ok(resolution >= 0 && resolution < hashing, 'only the server-resolved target is hashed');
});

test('authenticated client playback events can never close the global provider circuit', () => {
  const edge = read('supabase/functions/norva-playback/index.ts');
  const events = section(edge, 'async function recordPlaybackEvent(', 'async function recordPlaybackSessionFailure(');

  assert.doesNotMatch(events, /provider_playback_circuits/);
  assert.doesNotMatch(events, /provider_account_hash/);
  assert.doesNotMatch(events, /first_frame[\s\S]{0,300}delete\(/i);
  assert.doesNotMatch(events, /play_started[\s\S]{0,300}delete\(/i);
});

test('legacy cloud creation is gone and browser creation never falls back during partial deployment', () => {
  const cloudEdge = read('supabase/functions/norva-cloud/index.ts');
  const route = section(cloudEdge, 'async function route(', 'async function requireUser(');
  const legacyCreate = section(cloudEdge, 'async function createPlaybackSession(', 'async function getPlaybackSession(');
  const cloudApi = read('public/js/cloudApi.js');
  const playbackRequest = section(cloudApi, 'async function playbackRequest(', 'async function playbackSessionRequest(');

  assert.equal(
    (route.match(/createPlaybackSession\(/g) || []).length,
    2,
    'both historical user and device routes remain explicit compatibility tombstones',
  );
  assert.match(legacyCreate, /throw new HttpError\(410/);
  assert.match(legacyCreate, /PLAYBACK_CREATION_MOVED/);
  assert.doesNotMatch(legacyCreate, /readJson\(|cloud_playback_sessions|targetUrl|createGatewaySession/);
  assert.doesNotMatch(playbackRequest, /request\('POST', '\/playback\/sessions'/);
  assert.doesNotMatch(playbackRequest, /error\?\.status === 404|error\?\.status === 405/);
});

test('mobile PWA creation also fails closed during a partial edge deployment', () => {
  const cloudApi = read('clients/mobile-pwa/cloudApi.js');
  const playbackRequest = section(cloudApi, 'async function playbackRequest(', 'async function playbackSessionRequest(');

  assert.match(playbackRequest, /requestToBase\(playbackBase\(\), 'POST', '\/playback\/session'/);
  assert.doesNotMatch(playbackRequest, /request\('POST', '\/playback\/sessions'/);
  assert.doesNotMatch(playbackRequest, /error\?\.status === 404|error\?\.status === 405|error\.status === 404|error\.status === 405/);
});

test('gateway keeps a precise safe network cause and never retries HTTP 458', () => {
  const gateway = read('services/media-gateway/src/index.js');
  const diagnostics = require('../services/media-gateway/src/providerFailure.js');

  assert.deepEqual(
    diagnostics.classifyProviderFetchFailure({
      name: 'TypeError',
      message: 'fetch failed',
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    }),
    { code: 'PROVIDER_CONNECT_TIMEOUT', category: 'timeout' },
  );
  assert.deepEqual(
    diagnostics.classifyProviderFetchFailure({
      message: 'fetch failed',
      cause: { code: 'ECONNRESET' },
    }),
    { code: 'PROVIDER_CONNECTION_RESET', category: 'connection_reset' },
  );
  assert.deepEqual(
    diagnostics.classifyProviderFetchFailure({
      message: 'fetch failed',
      cause: { code: 'ECONNREFUSED' },
    }),
    { code: 'PROVIDER_NETWORK_UNREACHABLE', category: 'network_unreachable' },
  );
  assert.equal(diagnostics.shouldRetryProviderStatus(458), false);
  assert.equal(diagnostics.shouldRetryProviderStatus(401), false);
  assert.deepEqual(
    diagnostics.classifyProviderResponseFailure(458, { error: 'max connections' }),
    {
      status: 458,
      code: 'PROVIDER_BUSY',
      publicMessage: 'This TV service is busy. Wait a few seconds, then try again.',
    },
  );
  assert.equal(
    diagnostics.classifyProviderResponseFailure(401, { error: 'user_multi_ip' }).code,
    'PROVIDER_MULTI_IP',
  );

  assert.match(gateway, /classifyProviderFetchFailure/);
  assert.match(gateway, /code:\s*networkFailure\.code/);
  assert.match(gateway, /return res\.status\(458\)\.json/);
  assert.match(gateway, /classifyProviderResponseFailure/);
  assert.match(gateway, /upstreamStatus:\s*458/);
  assert.doesNotMatch(gateway, /upstream\.status === 458[\s\S]{0,220}retrying/i);
  assert.doesNotMatch(gateway, /SLOT_BUSY_RETRY_DELAYS_MS/);
});

test('source connection test calls the real cloud endpoint for both user and paired device', () => {
  const api = read('public/js/api.js');
  const cloud = read('public/js/cloudApi.js');
  const edge = read('supabase/functions/norva-cloud/index.ts');
  const mapping = section(
    api,
    "if (method === 'POST' && /^\\/sources\\/[^/]+\\/toggle$/.test(path))",
    "if ((method === 'GET' && /^\\/sources\\/[^/]+\\/estimate$/.test(path))",
  );

  assert.match(mapping, /sourcesApi\.test\(id\)/);
  assert.doesNotMatch(mapping, /success:\s*true/);
  assert.match(cloud, /test:\s*\(id\) => request\('POST', `\/sources\/\$\{encodeURIComponent\(id\)\}\/test`\)/);
  assert.match(cloud, /test:\s*\(id\) => request\([\s\S]{0,100}`\/device\/sources\/\$\{encodeURIComponent\(id\)\}\/test`/);
  assert.match(edge, /id === "sources" && action && segments\[3\] === "test"/);
  assert.match(edge, /testSourceConnection\(action, device\.user_id, db\)/);
  assert.match(edge, /function classifyGatewayNetworkFailure\(/);
  assert.match(edge, /PROVIDER_DNS_FAILURE/);
  assert.match(edge, /PROVIDER_CONNECTION_RESET/);
  assert.match(edge, /PROVIDER_NETWORK_UNREACHABLE/);
  const gatewayRequest = section(edge, 'async function requestGatewayMetadata(', 'async function fetchText(');
  const metadataHelpers = section(edge, 'async function fetchJson(', 'async function requestGatewayMetadata(');
  assert.doesNotMatch(metadataHelpers, /fetchProviderMetadata|falling back to direct/i);
  assert.doesNotMatch(gatewayRequest, /error instanceof Error \? error\.message/);
  assert.match(gatewayRequest, /failure\.code/);
  assert.doesNotMatch(
    gatewayRequest,
    /throw new HttpError\([\s\S]{0,220},\s*payload\s*\)/,
    'the raw gateway payload must never become client-visible HttpError details',
  );
  assert.match(
    gatewayRequest,
    /code:\s*response\.status === 458\s*\?\s*"PROVIDER_BUSY"[\s\S]*networkCause:[\s\S]*upstreamStatus:\s*response\.status/,
  );
});

test('web player reports 458 once, shows the account conflict and does not auto retry', () => {
  const watch = read('public/js/pages/WatchPage.js');
  const engine = section(watch, 'async playWithEngine(', '// Local-hub fallback after the browser engine fails.');
  const errorUi = section(watch, 'showPlaybackError(message, options = {})', '\n    hidePlaybackError() {');

  assert.match(watch, /reportProviderPlaybackFailure/);
  assert.match(watch, /PROVIDER_BUSY/);
  assert.ok(watch.includes('Service déjà utilisé sur un autre appareil'));
  assert.doesNotMatch(engine, /SLOT_BUSY_RETRIES/);
  assert.doesNotMatch(errorUi, /providerBusy\s*\?\s*this\.schedulePlaybackErrorRefresh/);
  assert.match(errorUi, /playbackSuperseded \|\| providerBusy \|\| serverRecovery[\s\S]{0,40}\? false/);
});

test('web VOD creates one cloud session and never cascades gateway, relay, or direct modes', () => {
  const api = read('public/js/api.js');
  const flow = section(
    api,
    "const baseSession = {",
    "const url = payload.playback?.url || payload.url;",
  );

  assert.equal(
    (flow.match(/cloudPlaybackApi\(\)\.createSession\(/g) || []).length,
    2,
    'one engine request and one non-engine request are the only session creations in the VOD flow',
  );
  assert.doesNotMatch(flow, /PROVIDER_SLOT_RETRY_DELAYS_MS|attemptCreateGatewaySession|createGatewayTranscodeSession/);
  assert.doesNotMatch(flow, /mode:\s*['"]direct['"]/);
  assert.doesNotMatch(flow, /mode:\s*['"]relay['"][\s\S]{0,180}catch/);

  const watch = read('public/js/pages/WatchPage.js');
  const relayFallback = section(
    watch,
    'async retryWithCloudRelay(message)',
    'async retryWithCloudGatewayTranscode(message)',
  );
  const gatewayFallback = section(
    watch,
    'async retryWithCloudGatewayTranscode(message)',
    'async retryWithFullVideoTranscode(message)',
  );
  const terminalFailure = section(
    watch,
    'async handlePlaybackFailure(message)',
    '\n    isFormatPlaybackError(message)',
  );
  const engineFallback = section(
    watch,
    'async fallbackEngineToTranscode(playbackAttemptId, startOffsetOverride = null)',
    'async handleEngineRuntimeFailure(',
  );
  const explicitRetry = section(
    watch,
    'async retryPlaybackInPlace(positionOverride = null)',
    'clearPlaybackErrorRefreshTimer()',
  );
  assert.doesNotMatch(watch, /logRelayUpstreamDiagnostic|Relay upstream diagnostic/);
  assert.match(relayFallback, /currentPlaybackMode === 'gateway-session'[\s\S]{0,260}return false/);
  assert.doesNotMatch(gatewayFallback, /for \(let attempt|retrying after|waitForProviderSlotRelease\(retryDelay\)/);
  assert.match(
    watch,
    /hasOpenedCloudPlaybackLaneForAttempt\(playbackAttemptId\)/,
    'the player must remember that the current user intention already opened an upstream lane',
  );
  assert.match(
    engineFallback,
    /this\.isCloudPlaybackMode\(\)[\s\S]{0,180}hasOpenedCloudPlaybackLaneForAttempt\(playbackAttemptId\)[\s\S]{0,80}return false/,
    'an engine session already opened in the cloud must never resolve a second Gateway session automatically',
  );
  const cloudLaneGuard = terminalFailure.indexOf('const cloudLaneConsumed');
  const terminalRelease = terminalFailure.indexOf('await this.releasePlaybackPipelineForRetry()', cloudLaneGuard);
  const terminalSurface = terminalFailure.indexOf('this.showPlaybackError(message, { immediate: true })', terminalRelease);
  assert.ok(cloudLaneGuard >= 0 && terminalRelease > cloudLaneGuard && terminalSurface > terminalRelease,
    'a failed cloud lane must be released and surfaced as a terminal state before any fallback resolver runs');
  assert.match(explicitRetry, /const playbackAttemptId\s*=\s*this\.beginPlaybackAttempt\(\)/);
  assert.match(explicitRetry, /explicitServerConversion[\s\S]*_preferredExplicitCloudMode\s*===\s*['"]transcode['"]/);
  assert.match(explicitRetry, /explicitServerConversion[\s\S]{0,300}mode:\s*['"]transcode['"]/,
    'only a fresh explicit retry may request one server-transcode session');
});

test('desktop local VOD owns one cloud session and never cascades into the cloud gateway', () => {
  const api = read('public/js/api.js');
  const desktopFlow = section(
    api,
    'const localTranscoder = _localTranscoderBase();',
    '// Plain browser (no native player, no local transcoder):',
  );

  assert.equal(
    (desktopFlow.match(/cloudPlaybackApi\(\)\.createSession\(/g) || []).length,
    1,
    'the desktop-local path must create at most one cloud session per playback intention',
  );
  assert.match(desktopFlow, /cloudPlaybackApi\(\)\.expireSession\(/);
  assert.match(desktopFlow, /catch \(localErr\)[\s\S]*throw localErr/);
  assert.doesNotMatch(desktopFlow, /falling back to cloud gateway|fall through to the normal cloud path/i);
});

test('production rollout proves the provider circuit protocol on every runtime', () => {
  const gateway = read('services/media-gateway/src/index.js');
  const playback = read('supabase/functions/norva-playback/index.ts');
  const cloud = read('supabase/functions/norva-cloud/index.ts');
  const deploy = read('ops/hetzner/scripts/04-deploy-edge-functions.sh');

  assert.match(gateway, /const GATEWAY_VERSION = 143/);
  assert.match(gateway, /providerCircuitProtocol:\s*1/);
  assert.match(gateway, /providerProxyAffinityProtocol:\s*1/);
  assert.match(gateway, /exactFileCodecProfileProtocol:\s*1/);
  assert.match(playback, /version:\s*68/);
  assert.match(playback, /providerCircuitProtocol:\s*1/);
  assert.match(playback, /exactFileCodecProfileProtocol:\s*1/);
  assert.match(playback, /relayTakeoverProtocol:\s*1/);
  assert.match(playback, /relayCoordinatorLockTtlMs:\s*EDGE_SESSION_COORDINATOR_LOCK_TTL_MS/);
  assert.match(cloud, /version:\s*27/);
  assert.match(cloud, /playbackCreationProtocol:\s*1/);
  assert.match(cloud, /relayTakeoverProtocol:\s*1/);
  assert.match(cloud, /relayCoordinatorLockTtlMs:\s*EDGE_SESSION_COORDINATOR_LOCK_TTL_MS/);

  assert.match(deploy, /verify_function_protocol "\$service"/);
  assert.match(deploy, /EXPECTED_PLAYBACK_VERSION=68/);
  assert.match(deploy, /EXPECTED_RELAY_COORDINATOR_LOCK_TTL_MS=120000/);
  assert.match(deploy, /EXPECTED_ENGINE_TRACK_PROBE_BLOCKING=false/);
  assert.match(deploy, /EXPECTED_EXACT_FILE_CODEC_PROFILE_PROTOCOL=1/);
  assert.match(deploy, /sha256sum "\$path" \| awk/);
  assert.match(deploy, /http:\/\/\$\{container_ip\}:9000\/\$\{function_name\}\/health/);
  assert.match(deploy, /function_health_in_service "\$service" norva-playback/);
  assert.match(deploy, /providerCircuitProtocol/);
  assert.match(deploy, /function_health_in_service "\$service" norva-cloud/);
  assert.match(deploy, /playbackCreationProtocol/);
});

for (const client of ['android-phone', 'android-tv']) {
  test(`${client} treats HTTP 458 and session supersession as terminal without fallback`, () => {
    const javaRoot = `clients/${client}/app/src/main/java/tv/norva/${client === 'android-phone' ? 'phone' : 'tv'}`;
    const policy = read(`${javaRoot}/ProviderPlaybackPolicy.java`);
    const loadPolicy = read(`${javaRoot}/ProviderLoadErrorHandlingPolicy.java`);
    const player = read(`${javaRoot}/PlayerActivity.java`);
    const values = read(`clients/${client}/app/src/main/res/values/strings.xml`);
    const french = read(`clients/${client}/app/src/main/res/values-fr/strings.xml`);

    assert.match(policy, /HTTP_PROVIDER_BUSY\s*=\s*458/);
    assert.match(policy, /isProviderBusyHttpStatus/);
    assert.match(policy, /PLAYBACK_SUPERSEDED/);
    assert.match(loadPolicy, /getRetryDelayMsFor/);
    assert.match(loadPolicy, /C\.TIME_UNSET/);
    assert.match(loadPolicy, /ProviderPlaybackPolicy\.httpStatus\(loadErrorInfo\.exception\)/);
    assert.match(player, /ProviderPlaybackPolicy\.httpStatus\(error\)/);
    assert.match(player, /showProviderAccountConflict/);
    assert.match(player, /reportProviderBusy/);
    assert.match(values, /name="player_error_provider_in_use"/);
    assert.ok(french.includes('Service déjà utilisé sur un autre appareil'));
  });
}

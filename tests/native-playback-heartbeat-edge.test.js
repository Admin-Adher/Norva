const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const edgePath = path.join(root, 'supabase/functions/norva-playback/index.ts');
const policyPath = path.join(
  root,
  'supabase/functions/_shared/native-playback-heartbeat-policy.mjs',
);
const activityMigrationPath = path.join(
  root,
  'supabase/migrations/20260710170000_provider_account_activity.sql',
);
const heartbeatMigrationPath = path.join(
  root,
  'supabase/migrations/20260812150000_native_playback_heartbeat_liveness.sql',
);

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

async function loadPolicy() {
  return import(pathToFileURL(policyPath).href);
}

test('native heartbeat policy maintains a long-play chain while expiry stays immutable', async () => {
  const { decideNativePlaybackHeartbeat } = await loadPolicy();
  const origin = Date.parse('2026-08-12T10:00:00.000Z');
  const expiresAt = new Date(origin + 15 * 60 * 1000).toISOString();
  const state = {
    status: 'ready',
    createdAt: new Date(origin).toISOString(),
    nativeHeartbeatAt: null,
    expiresAt,
  };

  for (let minute = 1; minute <= 20; minute += 1) {
    const nowMs = origin + minute * 60 * 1000;
    const decision = decideNativePlaybackHeartbeat({ ...state, nowMs });
    assert.equal(decision.accepted, true, `minute ${minute} must remain active`);
    assert.equal(decision.shouldWrite, true, `minute ${minute} must refresh provider activity`);
    state.nativeHeartbeatAt = new Date(nowMs).toISOString();
    assert.equal(state.expiresAt, expiresAt, 'heartbeat must never mutate entitlement expiry');
    assert.equal('expiresAt' in decision, false, 'policy must not return a renewed expiry');
  }
});

test('native heartbeat policy is fail-closed and rate-limited at the temporal boundaries', async () => {
  const { decideNativePlaybackHeartbeat } = await loadPolicy();
  const origin = Date.parse('2026-08-12T10:00:00.000Z');
  const base = {
    status: 'ready',
    createdAt: new Date(origin).toISOString(),
    expiresAt: new Date(origin + 15 * 60 * 1000).toISOString(),
  };

  const firstPulse = decideNativePlaybackHeartbeat({
    ...base,
    nativeHeartbeatAt: null,
    nowMs: origin + 60 * 1000,
  });
  assert.deepEqual(
    { accepted: firstPulse.accepted, shouldWrite: firstPulse.shouldWrite },
    { accepted: true, shouldWrite: true },
    't+60 s establishes the native heartbeat chain before session expiry',
  );

  const pulseAtExpiry = new Date(origin + 15 * 60 * 1000).toISOString();
  const afterExpiryFresh = decideNativePlaybackHeartbeat({
    ...base,
    nativeHeartbeatAt: pulseAtExpiry,
    nowMs: origin + 16 * 60 * 1000,
  });
  assert.equal(afterExpiryFresh.accepted, true, 'a pulse less than two minutes old survives short expiry');
  assert.equal(afterExpiryFresh.shouldWrite, true);

  const duplicate = decideNativePlaybackHeartbeat({
    ...base,
    nativeHeartbeatAt: new Date(origin + 60 * 1000).toISOString(),
    nowMs: origin + 80 * 1000,
  });
  assert.deepEqual(
    { accepted: duplicate.accepted, shouldWrite: duplicate.shouldWrite },
    { accepted: true, shouldWrite: false },
    'a duplicate inside 30 seconds is acknowledged without a write',
  );

  const pausedTooLong = decideNativePlaybackHeartbeat({
    ...base,
    nativeHeartbeatAt: pulseAtExpiry,
    nowMs: origin + 17 * 60 * 1000 + 1,
  });
  assert.equal(pausedTooLong.accepted, false, 'a pause beyond the two-minute grace is rejected');

  const tooOld = decideNativePlaybackHeartbeat({
    status: 'ready',
    createdAt: new Date(origin).toISOString(),
    nativeHeartbeatAt: new Date(origin + 12 * 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(origin + 13 * 60 * 60 * 1000).toISOString(),
    nowMs: origin + 12 * 60 * 60 * 1000 + 1,
  });
  assert.equal(tooOld.accepted, false, 'a session older than twelve hours is rejected');

  const explicitlyExpired = decideNativePlaybackHeartbeat({
    ...base,
    status: 'expired',
    nativeHeartbeatAt: new Date(origin + 60 * 1000).toISOString(),
    nowMs: origin + 80 * 1000,
  });
  assert.equal(explicitlyExpired.accepted, false, 'an expired status is rejected even with a fresh pulse');

  const missedFirstPulse = decideNativePlaybackHeartbeat({
    ...base,
    nativeHeartbeatAt: null,
    nowMs: origin + 15 * 60 * 1000 + 1,
  });
  assert.equal(missedFirstPulse.accepted, false, 'a chain cannot start after the short session expiry');

  const genericRowUpdateAfterExpiry = decideNativePlaybackHeartbeat({
    ...base,
    nativeHeartbeatAt: null,
    updatedAt: new Date(origin + 16 * 60 * 1000).toISOString(),
    nowMs: origin + 16 * 60 * 1000 + 1,
  });
  assert.equal(
    genericRowUpdateAfterExpiry.accepted,
    false,
    'a generic row update must never impersonate a native heartbeat chain',
  );
});

test('native heartbeat is a versioned authenticated REST route with a bounded response', () => {
  const edge = read(edgePath);
  const router = section(edge, 'Deno.serve(async (req) => {', 'async function requireIdentity');

  assert.match(router, /version:\s*80/);
  assert.match(router, /nativeHeartbeatProtocol:\s*1/);
  assert.match(router, /providerCircuitProtocol:\s*1/);
  assert.match(
    router,
    /req\.method === "POST"[\s\S]*?segments\[0\] === "playback"[\s\S]*?segments\[1\] === "sessions"[\s\S]*?segments\[2\][\s\S]*?segments\[3\] === "heartbeat"[\s\S]*?requireIdentity\(req, supabase\)[\s\S]*?heartbeatPlaybackSession\(segments\[2\], identity\.userId, supabase\)/,
  );
});

test('native heartbeat derives the source from an owned active session and never records an event', () => {
  const edge = read(edgePath);
  const heartbeat = section(
    edge,
    'async function heartbeatPlaybackSession(',
    'async function expirePlaybackSession(',
  );

  assert.match(heartbeat, /\.from\("cloud_playback_sessions"\)/);
  assert.match(
    heartbeat,
    /\.select\("id,source_id,status,created_at,native_heartbeat_at,expires_at,superseded_at"\)/,
  );
  assert.doesNotMatch(heartbeat, /superseded_by/);
  assert.match(heartbeat, /PLAYBACK_SUPERSEDED/);
  assert.match(heartbeat, /\.eq\("id", id\)/);
  assert.match(heartbeat, /\.eq\("user_id", userId\)/);
  assert.match(heartbeat, /\.eq\("source_id", sourceId\)/);
  assert.match(heartbeat, /decideNativePlaybackHeartbeat\(\{/);
  assert.match(heartbeat, /if \(!sourceId \|\| !policy\.accepted\)/);
  assert.match(heartbeat, /sourceId\s*=\s*stringOrNull\(session\.source_id\)/);
  assert.match(heartbeat, /\.eq\("source_id", sourceId\)/);
  assert.match(heartbeat, /\.in\("status", NATIVE_HEARTBEAT_ACTIVE_STATUSES\)/);
  assert.match(heartbeat, /\.gte\("created_at"/);
  assert.match(heartbeat, /\.lte\("created_at", nowIso\)/);
  assert.match(heartbeat, /renewalQuery\.is\("native_heartbeat_at", null\)/);
  assert.match(heartbeat, /stringOrNull\(current\?\.source_id\) !== sourceId/);
  assert.match(
    heartbeat,
    /db\.rpc\("provider_account_touch_by_source",\s*\{\s*p_source_id:\s*sourceId,\s*p_kind:\s*"native-heartbeat",?\s*\}\)/,
  );
  assert.match(heartbeat, /return \{ ok: true \};/);

  assert.doesNotMatch(heartbeat, /cloud_playback_events/);
  assert.doesNotMatch(heartbeat, /updated_at/);
  assert.doesNotMatch(heartbeat, /target_url|playback_hint|config_hint|credential|password/i);
  assert.doesNotMatch(heartbeat, /console\.(?:log|warn|error)/);
});

test('native exact close only treats a globally absent session as idempotent 404', () => {
  const edge = read(edgePath);
  const expiry = section(
    edge,
    'async function expirePlaybackSession(',
    'async function recordPlaybackEvent(',
  );

  const globalLookup = section(
    expiry,
    '.from("cloud_playback_sessions")',
    'const gatewaySessions',
  );
  assert.match(globalLookup, /\.eq\("id", id\)/);
  assert.doesNotMatch(globalLookup, /\.eq\("user_id", userId\)/);
  assert.match(globalLookup, /if \(!session\) throw new HttpError\(404/);
  assert.match(
    globalLookup,
    /stringOr\(session\.user_id, ""\) !== userId[\s\S]*?HttpError\(403/,
    'an account switch must not turn a still-existing foreign session into an ACK-able 404',
  );
  assert.match(
    expiry,
    /\.update\(\{ status: "expired", expires_at:[\s\S]*?\.eq\("id", id\)[\s\S]*?\.eq\("user_id", userId\)/,
    'the final write must remain ownership scoped even after the service-role lookup',
  );
  assert.equal(
    [...expiry.matchAll(/signal:\s*AbortSignal\.timeout\(8_000\)/g)].length,
    2,
    'raw-pump and gateway-session cleanup must release the WebView close budget',
  );
  const coordinator = section(
    edge,
    'async function requestEdgeCoordinator(',
    '// Phase 2 dedup read flag:',
  );
  assert.match(coordinator, /signal:\s*AbortSignal\.timeout\(8_000\)/);
});

test('native heartbeat keeps a bounded liveness chain past five minutes without extending entitlement expiry', () => {
  const edge = read(edgePath);
  const heartbeat = section(
    edge,
    'async function heartbeatPlaybackSession(',
    'async function expirePlaybackSession(',
  );
  const activityMigration = read(activityMigrationPath);
  const heartbeatMigration = read(heartbeatMigrationPath);
  const policySource = read(policyPath);

  assert.match(policySource, /NATIVE_HEARTBEAT_GRACE_SECONDS = 2 \* 60;/);
  assert.match(policySource, /NATIVE_HEARTBEAT_MAX_SESSION_AGE_SECONDS = 12 \* 60 \* 60;/);
  assert.match(policySource, /NATIVE_HEARTBEAT_MIN_WRITE_INTERVAL_SECONDS = 30;/);
  assert.match(activityMigration, /last_seen_at > now\(\) - interval '5 minutes'/);
  assert.match(
    heartbeatMigration,
    /add column if not exists native_heartbeat_at timestamptz/,
  );
  assert.match(
    heartbeatMigration,
    /revoke update on table public\.cloud_playback_sessions from public, anon, authenticated/,
    'authenticated clients must not be able to forge any heartbeat policy input',
  );
  assert.match(
    heartbeatMigration,
    /drop policy if exists "cloud_playback_sessions_update_own"/,
  );
  assert.doesNotMatch(
    heartbeatMigration,
    /grant\s+update(?:\s*\([^)]*native_heartbeat_at[^)]*\))?\s+on\s+(?:table\s+)?public\.cloud_playback_sessions\s+to\s+(?:public|anon|authenticated)/i,
  );
  assert.match(
    heartbeatMigration,
    /grant update on table public\.cloud_playback_sessions to service_role/,
  );

  assert.match(
    edge,
    /from "\.\.\/_shared\/native-playback-heartbeat-policy\.mjs"/,
  );
  assert.match(
    policySource,
    /expires > now \|\| \(hasHeartbeatChain && nativeHeartbeat > graceCutoffMs\)/,
  );
  assert.match(
    heartbeat,
    /\.or\(`expires_at\.gt\.\$\{nowIso\},native_heartbeat_at\.gt\.\$\{graceCutoffIso\}`\)/,
  );
  assert.match(heartbeat, /renewalQuery\.lte\("native_heartbeat_at", writeCutoffIso\)/);
  assert.match(heartbeat, /renewalQuery\.is\("native_heartbeat_at", null\)/);
  assert.doesNotMatch(
    heartbeat,
    /\.update\(\{[\s\S]*?expires_at:/,
    'provider liveness must not lengthen the short entitlement/concurrency session lease',
  );
  assert.deepEqual(
    [...heartbeat.matchAll(/\.update\(\{([\s\S]*?)\}\)/g)].map((match) => match[1].trim()),
    ['native_heartbeat_at: nowIso'],
    'heartbeat may update only its liveness timestamp',
  );
  assert.match(
    heartbeat,
    /if \(!policy\.shouldWrite\) return \{ ok: true \};/,
    'duplicate or over-eager clients must be acknowledged without extra DB/event writes',
  );
});

test('fresh provider activity preempts episode probes before and after their lease claim', () => {
  const edge = read(edgePath);
  const guard = section(
    edge,
    'async function episodeBackgroundBlockReason(',
    'function episodeAudioTracks(',
  );
  const episodeFlow = section(
    edge,
    'async function runEpisodeAudioBackfill(',
    'async function runOneDimension(',
  );

  assert.match(guard, /db\.rpc\("provider_account_busy", \{\s*p_key: accountKey/);
  assert.match(guard, /if \(busy === true\) return "provider-account-busy";/);

  const beforeClaim = episodeFlow.indexOf('episodeBackgroundBlockReason(db, userId, targetUrl)');
  const claim = episodeFlow.indexOf('claimProviderFileProbeStrict(');
  const raceRecheck = episodeFlow.indexOf(
    'episodeBackgroundBlockReason(db, userId, targetUrl)',
    beforeClaim + 1,
  );
  const providerFetch = episodeFlow.indexOf('/probe-audio');
  assert.ok(beforeClaim >= 0 && beforeClaim < claim, 'viewer activity must block before lease claim');
  assert.ok(claim < raceRecheck, 'provider activity must be rechecked after the lease race');
  assert.ok(raceRecheck < providerFetch, 'no provider probe may start before the race recheck');
});

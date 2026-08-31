const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const ROUTING_PATH = path.join(
  ROOT,
  'supabase',
  'functions',
  '_shared',
  'media-gateway-canary-routing.mjs',
);
const EDGE_PATH = path.join(ROOT, 'supabase', 'functions', 'norva-playback', 'index.ts');
const MIGRATION_PATH = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260817213000_media_gateway_canary_route.sql',
);
const STAGE_SCRIPT_PATH = path.join(
  ROOT,
  'ops',
  'hetzner',
  'media',
  'stage-edge-vaapi-canary.sh',
);
const UNSTAGE_SCRIPT_PATH = path.join(
  ROOT,
  'ops',
  'hetzner',
  'media',
  'unstage-edge-vaapi-canary.sh',
);
const DEPLOY_SCRIPT_PATH = path.join(
  ROOT,
  'ops',
  'hetzner',
  'media',
  'deploy-edge-vaapi-v53.sh',
);
const DEPLOY_V54_SCRIPT_PATH = path.join(
  ROOT,
  'ops',
  'hetzner',
  'media',
  'deploy-edge-vaapi-v54.sh',
);
const EDGE_RELOAD_SCRIPT_PATH = path.join(
  ROOT,
  'ops',
  'hetzner',
  'scripts',
  '04-deploy-edge-functions.sh',
);
const ACTIVATE_SCRIPT_PATH = path.join(
  ROOT,
  'ops',
  'hetzner',
  'media',
  'activate-edge-vaapi-canary-user.sh',
);
const DEACTIVATE_SCRIPT_PATH = path.join(
  ROOT,
  'ops',
  'hetzner',
  'media',
  'deactivate-edge-vaapi-canary-user.sh',
);
const GLOBAL_ACTIVATION_SCRIPT_PATH = path.join(
  ROOT,
  'ops',
  'hetzner',
  'media',
  'activate-private-media-gateway-global.sh',
);

const USER_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const GATEWAY_ID = 'a7250ec1-171b-4bcf-ad7d-41bac56130ec';
const DEFAULT_TOKEN = 'default-gateway-token-0123456789abcdef';
const CANARY_TOKEN = 'canary-gateway-token-0123456789abcdef';

async function routingModule() {
  return import(`${pathToFileURL(ROUTING_PATH).href}?t=${Date.now()}-${Math.random()}`);
}

function edgeStartupPolicyNormalizer() {
  const edge = fs.readFileSync(EDGE_PATH, 'utf8');
  const start = edge.indexOf('function normalizeGatewayStartupPolicy(');
  const end = edge.indexOf('\nfunction normalizeCodecProfile(', start);
  assert.ok(start >= 0 && end > start, 'startup policy normalizer must remain extractable');
  const source = `${edge.slice(start, end)}\nglobalThis.__normalizeGatewayStartupPolicy = normalizeGatewayStartupPolicy;`;
  const transformed = esbuild.transformSync(source, {
    loader: 'ts',
    format: 'iife',
    target: 'es2022',
  }).code;
  const context = {
    boundedNullableNumber(value, min, max) {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number.parseFloat(String(value));
      if (!Number.isFinite(parsed)) return null;
      return Math.max(min, Math.min(max, parsed));
    },
    recordOrEmpty(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    },
    stringOr(value, fallback) {
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'boolean') return String(value);
      return fallback;
    },
  };
  vm.runInNewContext(transformed, context);
  return context.__normalizeGatewayStartupPolicy;
}

test('canary routing is off by default and leaves ordinary accounts on the default Gateway', async () => {
  const { buildMediaGatewayRoutingConfig, selectMediaGatewayRouteForUserHash } = await routingModule();
  const config = buildMediaGatewayRoutingConfig({
    defaultRoute: { url: 'https://railway-gateway.example', token: DEFAULT_TOKEN },
  });
  assert.equal(config.canaryState, 'off');
  assert.equal(config.canaryUserHashes.length, 0);
  assert.equal(selectMediaGatewayRouteForUserHash(config, OTHER_HASH)?.kind, 'default');
});

test('one exact user hash selects the private route while every other user stays on default', async () => {
  const {
    buildMediaGatewayRoutingConfig,
    selectMediaGatewayRouteForGatewayId,
    selectMediaGatewayRouteForUserHash,
  } = await routingModule();
  const config = buildMediaGatewayRoutingConfig({
    defaultRoute: { url: 'https://railway-gateway.example/', token: DEFAULT_TOKEN },
    canaryRoute: {
      url: 'http://norva-media-gateway:8080/',
      token: CANARY_TOKEN,
      gatewayId: GATEWAY_ID,
    },
    canaryUserHashes: USER_HASH,
  });
  assert.equal(config.canaryState, 'ready');
  assert.deepEqual(config.canaryUserHashes, [USER_HASH]);
  assert.equal(selectMediaGatewayRouteForUserHash(config, USER_HASH)?.kind, 'canary');
  assert.equal(selectMediaGatewayRouteForUserHash(config, OTHER_HASH)?.kind, 'default');
  assert.equal(selectMediaGatewayRouteForGatewayId(config, GATEWAY_ID)?.kind, 'canary');
  assert.equal(selectMediaGatewayRouteForGatewayId(config, null)?.kind, 'default');
  assert.equal(selectMediaGatewayRouteForGatewayId(config, 'f5b4af2e-d6f7-4f2d-b45d-33b033332c81'), null);
});

test('a complete private route with no selected account stays safely staged', async () => {
  const { buildMediaGatewayRoutingConfig, selectMediaGatewayRouteForUserHash } = await routingModule();
  const config = buildMediaGatewayRoutingConfig({
    defaultRoute: { url: 'https://railway-gateway.example', token: DEFAULT_TOKEN },
    canaryRoute: {
      url: 'http://norva-media-gateway:8080',
      token: CANARY_TOKEN,
      gatewayId: GATEWAY_ID,
    },
    canaryUserHashes: '',
  });
  assert.equal(config.canaryState, 'standby');
  assert.equal(config.canaryUserHashes.length, 0);
  assert.equal(selectMediaGatewayRouteForUserHash(config, USER_HASH)?.kind, 'default');
});

test('a selected canary account fails closed when any route binding is invalid', async () => {
  const { buildMediaGatewayRoutingConfig, selectMediaGatewayRouteForUserHash } = await routingModule();
  const config = buildMediaGatewayRoutingConfig({
    defaultRoute: { url: 'https://railway-gateway.example', token: DEFAULT_TOKEN },
    canaryRoute: {
      url: 'http://norva-media-gateway:8080',
      token: 'short',
      gatewayId: GATEWAY_ID,
    },
    canaryUserHashes: USER_HASH,
  });
  assert.equal(config.canaryState, 'invalid');
  assert.equal(selectMediaGatewayRouteForUserHash(config, USER_HASH), null);
  assert.equal(selectMediaGatewayRouteForUserHash(config, OTHER_HASH)?.kind, 'default');
});

test('malformed allowlists never select a canary or expose a partial route', async () => {
  const { buildMediaGatewayRoutingConfig, selectMediaGatewayRouteForUserHash } = await routingModule();
  const config = buildMediaGatewayRoutingConfig({
    defaultRoute: { url: 'https://railway-gateway.example', token: DEFAULT_TOKEN },
    canaryRoute: {
      url: 'http://norva-media-gateway:8080',
      token: CANARY_TOKEN,
      gatewayId: GATEWAY_ID,
    },
    canaryUserHashes: `${USER_HASH},not-a-hash`,
  });
  assert.equal(config.canaryState, 'invalid');
  assert.equal(config.canaryUserHashes.length, 0);
  assert.equal(selectMediaGatewayRouteForUserHash(config, USER_HASH)?.kind, 'default');
});

test('norva-playback persists the chosen gateway identity and routes cleanup by stored identity', () => {
  const edge = fs.readFileSync(EDGE_PATH, 'utf8');
  assert.match(edge, /gateway_id:\s*gatewayRoute\.gatewayId/);
  assert.match(edge, /select\("id, playback_session_id, gateway_id, external_session_id, status"\)/);
  assert.match(edge, /mediaGatewayRouteForStoredSession\(runtimeConfig, gateway\)/);
  assert.match(edge, /MEDIA_GATEWAY_STORED_ROUTE_UNAVAILABLE/);
  assert.match(edge, /MEDIA_GATEWAY_CANARY_ROUTE_UNAVAILABLE/);
  assert.match(edge, /createBytePipeAccess\([\s\S]*?rawTokenExpiresAt,[\s\S]*?true,[\s\S]*?\);/);
  assert.match(edge, /version: 63[\s\S]*mediaGatewayCanaryRouting:/);
});

test('Edge v61 forwards only admitted copy, complete-cache, or measured VAAPI startup policies', () => {
  const normalize = edgeStartupPolicyNormalizer();
  const base = {
    protocol: 2,
    eligible: true,
    pipeline: 'copy',
    targetBufferSeconds: 6,
    minimumEncodeRateX: 1.15,
    observedEncodeRateX: 4,
    reason: 'mkv-h264-copy-ready',
  };
  for (const value of [
    base,
    { ...base, reason: 'complete-hls-cache-hit', observedEncodeRateX: 20 },
    {
      ...base,
      pipeline: 'video-transcode',
      reason: 'vaapi-transcode-ready',
      minimumEncodeRateX: 2,
      observedEncodeRateX: 12,
    },
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(normalize(value))), value);
  }
  for (const value of [
    { ...base, pipeline: 'video-transcode' },
    { ...base, pipeline: 'video-transcode', reason: 'vaapi-transcode-ready', minimumEncodeRateX: 1.99 },
    { ...base, pipeline: 'video-transcode', reason: 'complete-hls-cache-hit', minimumEncodeRateX: 2 },
    { ...base, pipeline: 'audio-transcode', reason: 'complete-hls-cache-hit' },
    { ...base, observedEncodeRateX: 1 },
  ]) {
    assert.equal(normalize(value), null);
  }
});

test('the route registry is service-only and stores no Gateway bearer token', () => {
  const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(migration, new RegExp(GATEWAY_ID));
  assert.match(migration, /http:\/\/norva-media-gateway:8080/);
  assert.match(migration, /revoke all on table public\.media_gateways from anon, authenticated/);
  assert.doesNotMatch(migration, /NORVA_MEDIA_GATEWAY_CANARY_TOKEN|gateway-token-[a-z0-9]/i);
});

test('standby staging is integrity-pinned, selects no account, and rolls partial state back', () => {
  const stage = fs.readFileSync(STAGE_SCRIPT_PATH, 'utf8');
  const unstage = fs.readFileSync(UNSTAGE_SCRIPT_PATH, 'utf8');

  assert.match(stage, /readonly MIGRATION="\$\{MEDIA_DIR\}\/20260817213000_media_gateway_canary_route\.sql"/);
  assert.match(stage, /readonly MIGRATION_SHA256='[a-f0-9]{64}'/);
  assert.match(stage, /trap rollback_partial_stage EXIT/);
  assert.match(stage, /EDGE_VAAPI_CANARY_PARTIAL_STAGE_ROLLED_BACK/);
  assert.match(stage, /\('NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES', '', true,/);
  assert.match(stage, /routing=standby selected_users=0 gateway=internal callback=private/);
  assert.doesNotMatch(stage, /echo\s+"?\$\{?gateway_token/i);

  assert.match(unstage, /selected-account-still-active/);
  assert.match(unstage, /delete from public\.cloud_runtime_config/);
  assert.match(unstage, /set status = 'maintenance'/);
});

test('Edge v53 deploy is revisioned, route-off, and rolls both replicas back on failure', () => {
  const deploy = fs.readFileSync(DEPLOY_SCRIPT_PATH, 'utf8');
  assert.match(deploy, /readonly SOURCE_ROOT='\/home\/adrien\/norva-deployments\/mkv-44d0f79'/);
  assert.match(deploy, /readonly TARGET_ROOT='\/home\/adrien\/norva-deployments\/mkv-vaapi-v53-11a301100cd0'/);
  assert.match(deploy, /readonly ARCHIVE_SHA256='11a301100cd02597d5c4f995184b875b1127baebba55e8422ae938cb56810e25'/);
  assert.match(deploy, /active_routed_sessions=/);
  assert.match(deploy, /SOURCE_ENV_REAL="\$\(readlink -f -- "\$\{SOURCE_OPS\}\/\.env"\)"/);
  assert.match(deploy, /stat -c '%a' "\$\{SOURCE_ENV_REAL\}"\)" == '600'/);
  assert.match(deploy, /stat -c '%U:%G' "\$\{SOURCE_ENV_REAL\}"\)" == 'adrien:adrien'/);
  assert.match(deploy, /install -m 0600 "\$\{SOURCE_ENV_REAL\}" "\$\{TARGET_OPS\}\/\.env"/);
  assert.match(deploy, /\[\[ ! -L "\$\{TARGET_OPS\}\/\.env" \]\]/);
  assert.match(deploy, /existing_canary_config=/);
  assert.match(deploy, /canary-config-already-present/);
  assert.match(deploy, /compose_from "\$\{SOURCE_OPS\}" up -d --no-deps --force-recreate functions/);
  assert.match(deploy, /compose_from "\$\{SOURCE_OPS\}" up -d --no-deps --force-recreate functions2/);
  assert.match(deploy, /route-mutated-during-code-deploy/);
  assert.match(deploy, /EDGE_V53_DEPLOYED_ROUTE_OFF_OK/);
  assert.match(deploy, /canary_state=off selected_users=0 gateway_callback=private/);
});

test('Edge v55 deploy drains one-user routing, upgrades both replicas, and restores it only after verification', () => {
  const deploy = fs.readFileSync(DEPLOY_V54_SCRIPT_PATH, 'utf8');
  const reload = fs.readFileSync(EDGE_RELOAD_SCRIPT_PATH, 'utf8');
  assert.match(deploy, /readonly SOURCE_ROOT='\/home\/adrien\/norva-deployments\/mkv-vaapi-v53-11a301100cd0'/);
  assert.match(deploy, /readonly TARGET_ROOT='\/home\/adrien\/norva-deployments\/mkv-vaapi-v54-9bbcddbecb3b'/);
  assert.match(deploy, /readonly ARCHIVE_SHA256='9bbcddbecb3b2804398bbe07f57b0658f7766befa245acacbaa10d49a1480dde'/);
  assert.match(deploy, /readonly GATEWAY_IMAGE='norva-media-gateway:vaapi-3d9cbd892800'/);
  assert.match(deploy, /h\.version === 105/);
  assert.match(deploy, /h\.vaapiVodFastStart\?\.targetBufferSeconds === 6/);
  assert.match(deploy, /h\.vaapiVodFastStart\?\.minimumEncodeRateX === 2/);
  assert.match(deploy, /a7a31dca6004980ca7088eba65f64ba1b691c416faee978d1e560427b7c12546  supabase\/functions\/norva-playback\/index\.ts/);
  assert.match(deploy, /767d3315c950070c93c827adc9c2bc583b17b3adba2a425fa0ca7dbbb1039dda  ops\/hetzner\/scripts\/04-deploy-edge-functions\.sh/);
  assert.match(reload, /^EXPECTED_PLAYBACK_VERSION=63$/m);

  const drain = deploy.indexOf("set_canary_selection ''");
  const standby = deploy.indexOf('wait_edge_state 53 standby 0', drain);
  const sessionDrain = deploy.indexOf('wait_no_canary_sessions', standby);
  const deployStart = deploy.indexOf('bash "${TARGET_OPS}/scripts/04-deploy-edge-functions.sh"', sessionDrain);
  const v54Standby = deploy.indexOf('wait_edge_state 54 standby 0', deployStart);
  const restore = deploy.indexOf('set_canary_selection "${SELECTED_USER_HASH}"', v54Standby);
  const ready = deploy.indexOf('wait_edge_state 54 ready 1', restore);
  assert.ok(
    drain >= 0 && standby > drain && sessionDrain > standby && deployStart > sessionDrain
      && v54Standby > deployStart && restore > v54Standby && ready > restore,
  );

  assert.match(deploy, /compose_from "\$\{SOURCE_OPS\}" up -d --no-deps --force-recreate functions/);
  assert.match(deploy, /compose_from "\$\{SOURCE_OPS\}" up -d --no-deps --force-recreate functions2/);
  assert.match(deploy, /EDGE_V54_ROLLBACK_INCOMPLETE_INSPECT_REQUIRED/);
  assert.match(deploy, /EDGE_V54_DEPLOYED_ONE_USER_OK/);
  assert.doesNotMatch(deploy, /echo[^\n]*(SELECTED_USER_HASH|gateway_token|db_canary_token)/i);
});

test('one-user activation proves the callback before selection and rolls selection back first', () => {
  const activate = fs.readFileSync(ACTIVATE_SCRIPT_PATH, 'utf8');
  const callbackWrite = activate.indexOf('NORVA_EDGE_CALLBACK_BASE=${ACTIVE_CALLBACK}');
  const callbackProbe = activate.indexOf('callback-auth-probe');
  const selectionWrite = activate.indexOf("set value='${USER_HASH}'");
  assert.ok(callbackWrite >= 0 && callbackProbe > callbackWrite && selectionWrite > callbackProbe);
  const rollbackSelection = activate.indexOf("set value='' where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES'");
  const rollbackStandby = activate.indexOf('wait_edge_state standby 0', rollbackSelection);
  const rollbackCallback = activate.indexOf(
    'install -m 0600 "${CALLBACK_BACKUP}" "${ENV_PATH}"',
    rollbackStandby,
  );
  assert.ok(
    rollbackSelection >= 0
      && rollbackStandby > rollbackSelection
      && rollbackCallback > rollbackStandby,
  );
  assert.match(activate, /probe_callback_from_gateway\(\)[\s\S]*docker exec -i "\$\{GATEWAY_CONTAINER\}" node --input-type=module/);
  assert.match(activate, /process\.env\.NORVA_EDGE_CALLBACK_BASE/);
  assert.match(activate, /process\.env\.GATEWAY_TOKEN/);
  assert.match(activate, /ROLLBACK_INCOMPLETE_INSPECT_REQUIRED/);
  assert.match(activate, /wait_edge_state standby 0/);
  assert.match(activate, /wait_edge_state ready 1/);
  assert.match(activate, /UUID exact du compte canary/);
  assert.match(activate, /select count\(\*\) from auth\.users where id='\$\{USER_ID\}'::uuid/);
  assert.match(activate, /EDGE_VAAPI_CANARY_ONE_USER_READY_OK/);
  assert.doesNotMatch(activate, /echo[^\n]*(gateway_token|db_canary_token|USER_HASH)/i);
});

test('one-user deactivation stops routing before waiting for active session drain', () => {
  const deactivate = fs.readFileSync(DEACTIVATE_SCRIPT_PATH, 'utf8');
  const clearSelection = deactivate.indexOf("set value='' where key='NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES'");
  const standbyWait = deactivate.indexOf('wait_standby');
  const activeSessionGate = deactivate.indexOf('canary-session-still-active');
  const callbackRestore = deactivate.indexOf('install -m 0600 "${CALLBACK_BACKUP}" "${ENV_PATH}"');
  assert.ok(clearSelection >= 0 && standbyWait >= 0 && activeSessionGate > clearSelection && callbackRestore > activeSessionGate);
  assert.match(deactivate, /gateway_id='\$\{GATEWAY_ID\}'::uuid/);
  assert.match(deactivate, /EDGE_VAAPI_CANARY_ONE_USER_DEACTIVATED_OK/);
});

test('global activation is drained, atomic, cache-settled, and rollback-armed', () => {
  const activate = fs.readFileSync(GLOBAL_ACTIVATION_SCRIPT_PATH, 'utf8');
  assert.match(activate, /readonly GATEWAY_IMAGE='norva-media-gateway:vaapi-b180cdcbf0be'/);
  assert.match(activate, /h\.version === 109/);
  assert.match(activate, /readonly FUNCTION_VERSION='56'/);
  assert.match(activate, /readonly EDGE_RUNTIME_CONFIG_CACHE_SETTLE_SECONDS=35/);
  assert.match(activate, /active_state=[\s\S]*cloud_playback_sessions[\s\S]*cloud_gateway_sessions/);
  assert.match(activate, /\[\[ "\$\{active_state\}" == '0\|0' \]\]/);
  assert.match(activate, /chmod 0600 "\$\{ROLLBACK_SQL\}"/);
  assert.match(activate, /sha256sum "\$\{ROLLBACK_SQL\}" > "\$\{ROLLBACK_SQL\}\.sha256"/);
  assert.match(activate, /trap 'restore_previous_config \$\?' ERR INT TERM/);
  assert.match(activate, /set value = v_canary_url[\s\S]*key = 'NORVA_MEDIA_GATEWAY_URL'/);
  assert.match(activate, /set value = v_canary_token[\s\S]*key = 'NORVA_MEDIA_GATEWAY_TOKEN'/);
  assert.match(activate, /set value = ''[\s\S]*key = 'NORVA_MEDIA_GATEWAY_CANARY_USER_HASHES'/);

  const mutation = activate.indexOf("do $global_route$");
  const settle = activate.indexOf('sleep "${EDGE_RUNTIME_CONFIG_CACHE_SETTLE_SECONDS}"', mutation);
  const standby = activate.indexOf('wait_edge_state standby 0', settle);
  const verification = activate.indexOf('global-binding-verification', standby);
  assert.ok(mutation >= 0 && settle > mutation && standby > settle && verification > standby);

  assert.match(activate, /audience=all-current-and-future-users route=default-private selected_users=0/);
  assert.doesNotMatch(activate, /echo[^\n]*(gateway_token|db_canary_token)/i);
});

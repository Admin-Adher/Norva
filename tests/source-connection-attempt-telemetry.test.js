const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function loadTelemetry() {
  return import('../supabase/functions/_shared/source-connection-attempt.mjs');
}

test('source attempt summary keeps only root domain, exact-host hash and bounded shape', async () => {
  const { summarizeSourceConnectionAttempt } = await loadTelemetry();
  const raw = 'https://alice:secret@panel.customer.example.co.in/get.php?username=alice&password=secret&type=m3u_plus';
  const summary = await summarizeSourceConnectionAttempt({ sourceType: 'Xtream', url: raw });

  assert.deepEqual(summary, {
    sourceType: 'xtream',
    domainNormalized: 'example.co.in',
    hostHash: crypto.createHash('sha256').update('panel.customer.example.co.in').digest('hex'),
    pathShape: 'get.php',
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /alice|secret|customer|https|username|password/);
});

test('source attempt path classifier distinguishes safe shapes without returning paths', async () => {
  const { classifySourceAttemptPath, summarizeSourceConnectionAttempt } = await loadTelemetry();
  assert.equal(classifySourceAttemptPath('provider.test'), 'root');
  assert.equal(classifySourceAttemptPath('provider.test/player_api.php?action=user'), 'player_api.php');
  assert.equal(classifySourceAttemptPath('https://provider.test/live/list.m3u8?token=nope'), '.m3u8');
  assert.equal(classifySourceAttemptPath('https://provider.test/download/list.m3u'), '.m3u');
  assert.equal(classifySourceAttemptPath('https://jiotv.com/login.html'), 'web_page');
  assert.equal(classifySourceAttemptPath('not a url'), 'invalid');

  const preserved = await summarizeSourceConnectionAttempt({
    sourceType: 'xtream',
    url: 'https://provider.test',
    inputPathShape: 'get.php',
  });
  assert.equal(preserved.pathShape, 'get.php');
  const serverWins = await summarizeSourceConnectionAttempt({
    sourceType: 'm3u',
    url: 'https://provider.test/list.m3u8?token=private',
    inputPathShape: 'root',
  });
  assert.equal(serverWins.pathShape, '.m3u8');
});

test('source attempt domain normalizer hides subdomains and labels network addresses', async () => {
  const { normalizedSourceAttemptDomain } = await loadTelemetry();
  assert.equal(normalizedSourceAttemptDomain('stream.customer.jiotv.com'), 'jiotv.com');
  assert.equal(normalizedSourceAttemptDomain('edge.provider.com.bd'), 'provider.com.bd');
  assert.equal(normalizedSourceAttemptDomain('192.0.2.8'), 'ip-address');
  assert.equal(normalizedSourceAttemptDomain('box.local'), 'local-address');
});

test('source attempt client context uses bounded Norva app versions', async () => {
  const { sourceAttemptClientContext } = await loadTelemetry();
  assert.deepEqual(sourceAttemptClientContext('Mozilla/5.0 NorvaTV-AndroidPhone/1.3.12'), {
    platform: 'mobile_android', appVersion: '1.3.12',
  });
  assert.deepEqual(sourceAttemptClientContext('Mozilla/5.0 NorvaTV-AndroidTV/3.4.1'), {
    platform: 'android_tv', appVersion: '3.4.1',
  });
  assert.deepEqual(sourceAttemptClientContext('Mozilla/5.0 Chrome/140.0'), {
    platform: 'web', appVersion: null,
  });
});

test('source attempt failures collapse into bounded operational families', async () => {
  const { classifySourceAttemptFailure } = await loadTelemetry();
  assert.equal(classifySourceAttemptFailure({ status: 422, code: 'MISSING_CREDENTIALS' }), 'missing_credentials');
  assert.equal(classifySourceAttemptFailure({ status: 401 }), 'credentials');
  assert.equal(classifySourceAttemptFailure({ status: 404 }), 'endpoint_not_found');
  assert.equal(classifySourceAttemptFailure({ status: 413 }), 'payload_too_large');
  assert.equal(classifySourceAttemptFailure({ status: 504 }), 'timeout');
  assert.equal(classifySourceAttemptFailure({ status: 458 }), 'provider_busy');
  assert.equal(classifySourceAttemptFailure({ status: 400, message: 'This URL does not look like a valid M3U playlist' }), 'playlist_format');
  assert.equal(classifySourceAttemptFailure({ status: 502, code: 'PROVIDER_DNS_FAILURE' }), 'provider_unreachable');
  assert.equal(classifySourceAttemptFailure({ status: 500 }), 'infrastructure');
});

test('database and client contracts never persist or forward a raw URL field', () => {
  const root = path.resolve(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260902090000_source_connection_attempt_telemetry_v1.sql'), 'utf8');
  const payloadFamilyMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20260902170000_source_connection_attempt_payload_family.sql'), 'utf8');
  const tableContract = migration.slice(
    migration.indexOf('create table analytics_private.source_connection_attempts'),
    migration.indexOf('comment on table analytics_private.source_connection_attempts'),
  );
  assert.doesNotMatch(tableContract, /\buser_id\b|\burl\b|\bpath\b|\bquery\b|\busername\b|\bpassword\b|\bip_address\b/i);
  assert.match(migration, /expires_at timestamptz not null default \(now\(\) \+ interval '90 days'\)/);
  assert.match(migration, /admin_internal_accounts/);
  assert.match(payloadFamilyMigration, /'payload_too_large'/);
  assert.doesNotMatch(payloadFamilyMigration, /\buser_id\b|\burl\b|\bquery\b|\busername\b|\bpassword\b|\bip_address\b/i);

  const sourceManager = fs.readFileSync(path.join(root, 'public/js/components/SourceManager.js'), 'utf8');
  const homePage = fs.readFileSync(path.join(root, 'public/js/pages/HomePage.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
  const cloudApi = fs.readFileSync(path.join(root, 'public/js/cloudApi.js'), 'utf8');
  const edge = fs.readFileSync(path.join(root, 'supabase/functions/norva-cloud/index.ts'), 'utf8');
  assert.match(sourceManager, /inputPathShape/);
  assert.match(homePage, /inputPathShape: urlInput\?\.dataset\?\.sourceInputPathShape/);
  assert.match(api, /payload\.inputPathShape = pathShape/);
  assert.match(api, /recordAttempt: \(data\) => API\.request\('POST', '\/sources\/attempt', data\)/);
  assert.match(cloudApi, /recordAttempt: \(attempt\) => request\('POST', '\/sources\/attempt', attempt\)/);
  assert.match(edge, /const allowedKeys = new Set\(\[\s*"sourceType", "domainNormalized", "hostHash", "pathShape", "failureFamily"/);
  assert.doesNotMatch(api, /payload\.inputPath(?!Shape)|payload\.rawUrl/);
});

test('browser-side classifier emits only a root domain, host hash and bounded shape', async () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../public/js/components/SourceManager.js'),
    'utf8',
  );
  const sandbox = { window: {}, console, URL, TextEncoder, crypto: globalThis.crypto, setTimeout, clearTimeout };
  vm.runInNewContext(source, sandbox, { filename: 'SourceManager.js' });
  const classify = sandbox.window.SourceManager.prototype.sourceInputPathShape;
  const context = sandbox.window.SourceManager.prototype;
  assert.equal(classify.call(context, 'https://panel.test/get.php?username=private&password=private'), 'get.php');
  assert.equal(classify.call(context, 'https://panel.test/player_api.php'), 'player_api.php');
  assert.equal(classify.call(context, 'https://panel.test/list.m3u8?token=private'), '.m3u8');
  assert.equal(classify.call(context, 'https://jiotv.com/login.html'), 'web_page');
  assert.equal(classify.call(context, 'ftp://provider.test/list.m3u'), 'invalid');

  const feedback = context.sourceInputFeedback;
  assert.equal(feedback.call(context, 'nooor', 'm3u').state, 'invalid');
  assert.equal(feedback.call(context, 'restream.re', 'm3u').state, 'neutral');
  assert.equal(feedback.call(context, 'https://panel.test/get.php?token=private', 'm3u').state, 'ready');
  assert.equal(feedback.call(context, 'https://jiotv.com/login.html', 'm3u').state, 'invalid');
  assert.equal(feedback.call(context, 'nooor', 'xtream').state, 'invalid');
  assert.equal(feedback.call(context, 'https://nooor', 'xtream').state, 'invalid');
  assert.equal(feedback.call(context, 'https://panel.test', 'xtream').state, 'ready');

  const parseXtream = context.parseXtreamLink;
  assert.equal(parseXtream.call(context, 'nooor'), null);
  assert.equal(parseXtream.call(context, 'https://nooor'), null);
  // A port does not turn a bare application/provider name into a real hostname.
  assert.equal(parseXtream.call(context, 'http://provider:8080'), null);
  assert.equal(parseXtream.call(context, 'http://provider.test:8080').serverUrl, 'http://provider.test:8080');
  assert.equal(parseXtream.call(context, 'https://panel.test').serverUrl, 'https://panel.test');

  const diagnostic = await context.sourceAttemptDiagnostic.call(context, {
    type: 'xtream',
    url: 'https://alice:secret@panel.customer.example.co.in/get.php?username=alice&password=secret',
  });
  assert.equal(diagnostic.domainNormalized, 'example.co.in');
  assert.equal(diagnostic.pathShape, 'get.php');
  assert.equal(diagnostic.hostHash, crypto.createHash('sha256').update('panel.customer.example.co.in').digest('hex'));
  assert.doesNotMatch(JSON.stringify(diagnostic), /alice|secret|customer|https|username|password/);

  let transmitted = null;
  sandbox.window.API = {
    isCloudMode: () => true,
    sources: { recordAttempt: async (payload) => { transmitted = payload; } },
  };
  assert.equal(await context.reportSourceConnectionValidationAttempt.call(context, {
    type: 'xtream',
    url: 'https://alice:secret@panel.customer.example.co.in/get.php?username=alice&password=secret',
    failureFamily: 'missing_credentials',
  }), true);
  assert.equal(transmitted.failureFamily, 'missing_credentials');
  assert.equal(transmitted.domainNormalized, 'example.co.in');
  assert.doesNotMatch(JSON.stringify(transmitted), /alice|secret|customer|https|username|password|\burl\b/i);
});

'use strict';

// Guards the two halves of one contract: what the sync path PERSISTS into
// cloud_sources.sync_error, and what norva-admin's ops alert CONCLUDES from it.
// Before 2026-08-21 the persist step kept only error.message, so every provider
// failure reached the classifier as the bare sentence "Media gateway refused the
// metadata request" -> `infra`, the one class the alert does not suppress. An
// expired subscription alerted 4x/day forever, and a genuine outage of our own
// gateway was indistinguishable from it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const load = () => import(pathToFileURL(
  path.join(root, 'supabase/functions/_shared/source-sync-error.mjs'),
).href);

const GATEWAY = 'Media gateway refused the metadata request';
const fail = (status, details) => Object.assign(new Error(GATEWAY), { status, details });

test('an expired provider subscription is suppressed instead of alerting', async () => {
  const m = await load();
  const text = m.formatSourceSyncError(fail(403, { error: 'subscription expired' }), 'Source sync failed');
  assert.equal(text, '[403] ' + GATEWAY + ' (subscription expired)');
  assert.equal(m.classifyOpsSourceError(text), 'expired');
  assert.ok(m.SILENT_OPS_SOURCE_ERROR_KINDS.has(m.classifyOpsSourceError(text)));
});

test('an outage of our own media gateway still alerts', async () => {
  const m = await load();
  const text = m.formatSourceSyncError(fail(502, { error: 'upstream unavailable' }), 'Source sync failed');
  assert.equal(m.classifyOpsSourceError(text), 'infra');
  assert.equal(m.SILENT_OPS_SOURCE_ERROR_KINDS.has('infra'), false);
});

test('discarding the status is what made every provider problem look like infra', async () => {
  const m = await load();
  // Exactly what was persisted before the fix: message only.
  assert.equal(m.classifyOpsSourceError(GATEWAY), 'infra');
  // The same failure, carrying its status, is correctly read as user-side.
  assert.equal(m.classifyOpsSourceError(m.formatSourceSyncError(fail(403, null))), 'auth');
});

test('a busy slot outranks an expiry mentioned in the same payload', async () => {
  const m = await load();
  const text = m.formatSourceSyncError(fail(403, { error: 'account busy, subscription expired' }));
  assert.equal(m.classifyOpsSourceError(text), 'busy');
  assert.ok(m.SILENT_OPS_SOURCE_ERROR_KINDS.has('busy'));
});

test('provider credentials never reach the persisted error', async () => {
  const m = await load();
  const leaky = [
    'http://panel.example:8080/player_api.php?username=adrien&password=s3cr3t',
    '{"username":"adrien","password":"s3cr3t"}',
    'http://adrien:s3cr3t@panel.example:8080/live',
  ];
  for (const raw of leaky) {
    const text = m.formatSourceSyncError(fail(403, { error: raw }));
    assert.ok(!text.includes('s3cr3t'), 'password leaked: ' + text);
    assert.ok(!text.includes('adrien'), 'username leaked: ' + text);
  }
});

test('the persisted error stays bounded for a column the dashboard renders', async () => {
  const m = await load();
  const text = m.formatSourceSyncError(fail(500, { error: 'x'.repeat(5000) }));
  assert.ok(text.length <= m.MAX_SYNC_ERROR_CHARS, 'length was ' + text.length);
});

test('a non-HttpError failure still yields its fallback', async () => {
  const m = await load();
  assert.equal(m.formatSourceSyncError(null, 'Source sync failed'), 'Source sync failed');
  assert.equal(m.formatSourceSyncError(new Error(''), 'Source sync failed'), 'Source sync failed');
});

test('terminal discovery statuses stop the watchdog while transient statuses remain resumable', async () => {
  const m = await load();
  for (const status of [400, 401, 403, 404, 409, 422, 458, 499]) {
    assert.equal(m.isTerminalSourceSyncStatus(status), true, String(status));
  }
  for (const status of [null, 399, 408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(m.isTerminalSourceSyncStatus(status), false, String(status));
  }

  const xtream = read('supabase/functions/_shared/xtream-sync.ts');
  assert.match(xtream, /isTerminalSourceSyncStatus\([\s\S]*err instanceof HttpError \? err\.status : null/);
  assert.match(xtream, /syncCursor: terminal \? compactRecord\(\{[\s\S]*active: false,[\s\S]*terminalAt: failedAt,[\s\S]*terminalStatus:/);
});

test('Xtream discovery yields to playback without recording a source failure', () => {
  const source = read('supabase/functions/_shared/xtream-sync.ts');
  const xtream = source.slice(
    source.indexOf('export async function driveXtreamSyncToReady('),
    source.indexOf('\n// Plain-language', source.indexOf('export async function driveXtreamSyncToReady(')),
  );
  const preflightAt = xtream.indexOf('db.rpc("provider_account_busy_for_catalog_refresh"');
  const rollingFallbackAt = xtream.indexOf('db.rpc("provider_account_busy"', preflightAt);
  const providerFetchAt = xtream.indexOf('const fetchCatalog = async');
  const contentionCatchAt = xtream.indexOf('isProviderViewerPriority(err)');
  const failureAt = xtream.indexOf('sync driver failed');

  assert.ok(preflightAt > 0, 'missing foreground-presence preflight');
  assert.ok(rollingFallbackAt > preflightAt, 'missing conservative rolling-deploy fallback');
  assert.ok(providerFetchAt > preflightAt, 'busy preflight must run before provider fetches');
  assert.ok(contentionCatchAt > providerFetchAt, 'missing gateway race fence');
  assert.ok(failureAt > contentionCatchAt, 'viewer contention must be handled before failure persistence');
  assert.match(xtream, /if \(accountBusy\) \{[\s\S]*stage: "waiting_for_provider"[\s\S]*return;/);
  assert.match(xtream, /isProviderViewerPriority\(err\)[\s\S]*cursor\.attempts = Math\.max\(0,[\s\S]*cursor\.fetchErrors = Math\.max\(0,[\s\S]*stage: "waiting_for_provider"[\s\S]*return;/);
  assert.match(source, /function isProviderViewerPriority[\s\S]*error\.status !== 409[\s\S]*account_busy[\s\S]*provider_account_busy[\s\S]*viewer_preempted[\s\S]*active playback/);
});

test('catalog refresh ignores passive presence and its own released pages but keeps every real holder fenced', () => {
  const migration = read('supabase/migrations/20260826141838_provider_catalog_refresh_busy_scope_v1.sql');
  const activityKindMigration = read('supabase/migrations/20260826145555_provider_catalog_refresh_activity_kind_v1.sql');
  assert.match(migration, /create or replace function public\.provider_account_busy_for_catalog_refresh\(p_key text\)/i);
  assert.match(migration, /last_seen_at > statement_timestamp\(\) - interval '5 minutes'[\s\S]*kind is distinct from 'presence'/i);
  assert.doesNotMatch(migration, /kind is distinct from 'language-validation'/i);
  assert.match(migration, /revoke all on function public\.provider_account_busy_for_catalog_refresh\(text\)[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.provider_account_busy_for_catalog_refresh\(text\)[\s\S]*to service_role/i);
  assert.match(activityKindMigration, /kind is distinct from 'presence'[\s\S]*kind is distinct from 'catalog-refresh'/i);
  assert.doesNotMatch(activityKindMigration, /kind is distinct from 'language-validation'/i);
  assert.match(activityKindMigration, /create or replace function public\.provider_account_touch_many/i);
  assert.match(activityKindMigration, /excluded\.kind not in \('presence', 'catalog-refresh', 'language-validation'\)/i);
  assert.match(activityKindMigration, /activity\.kind in \('presence', 'catalog-refresh'\)/i);
  assert.match(activityKindMigration, /revoke all on function public\.provider_account_busy_for_catalog_refresh\(text\)[\s\S]*from public, anon, authenticated/i);
  assert.match(activityKindMigration, /grant execute on function public\.provider_account_busy_for_catalog_refresh\(text\)[\s\S]*to service_role/i);
});

// Discovered, not enumerated. A hand-written file list missed
// _shared/xtream-sync.ts — the site the recurring cron sync actually reaches,
// because the driver catches its own gateway HttpError and never lets it
// bubble to the callers' catch blocks. Any new write site now fails here.
test('every cloud_sources error path persists through the shared formatter', () => {
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|mjs)$/.test(entry.name) && !/\.test\.[tm]?[js]s?$/.test(entry.name)) sources.push(full);
    }
  };
  walk(path.join(root, 'supabase', 'functions'));

  const countWrites = (src) => src.split(/\r?\n/).filter((line) => {
    const hit = line.match(/sync_error:\s*(\S+)/);
    return Boolean(hit) && !hit[1].startsWith('null');
  }).length;

  const writers = sources
    .filter((file) => countWrites(fs.readFileSync(file, 'utf8')) > 0)
    .map((file) => path.relative(root, file).split(path.sep).join('/'));

  assert.ok(writers.length >= 3, 'expected to discover the sync_error write sites, found ' + writers.length);
  for (const file of writers) {
    const src = read(file);
    assert.ok(
      src.includes('source-sync-error.mjs'),
      file + ' writes sync_error but does not import the shared formatter',
    );
    assert.ok(
      src.includes('formatSourceSyncError('),
      file + ' writes sync_error without formatting it',
    );
    // Counting ties writes to formatter calls without tripping on the HTTP
    // response paths, which legitimately surface error.message as-is.
    const formatted = (src.match(/formatSourceSyncError\(/g) || []).length;
    assert.ok(
      formatted >= countWrites(src),
      file + ' has ' + countWrites(src) + ' sync_error write(s) but only '
        + formatted + ' formatted value(s)',
    );
  }
});

test('the status leads, so it survives truncation by any consumer', async () => {
  const m = await load();
  // The admin dashboard used to cut this string at 80 chars while the status sat
  // at the END, two characters from being lost. Leading it makes every consumer
  // safe, including ones written later.
  const text = m.formatSourceSyncError(fail(401, { error: 'x'.repeat(400) }));
  assert.ok(text.startsWith('[401] '), 'status must lead: ' + text.slice(0, 40));
  for (const cut of [12, 40, 80, 160]) {
    assert.equal(m.classifyOpsSourceError(text.slice(0, cut)), 'auth', 'lost the verdict at ' + cut + ' chars');
  }
});

test('the admin dashboard badges the kind and no longer truncates the reason', () => {
  const admin = read('public/js/pages/AdminPage.js');
  assert.ok(
    admin.includes('static errKindBadge(syncError)'),
    'AdminPage must expose the badge helper',
  );
  assert.equal(
    (admin.match(/AdminPage\.errKindBadge\(s\.sync_error\)/g) || []).length,
    2,
    'both the alert list and the source row must badge the kind',
  );
  assert.ok(
    !admin.includes('String(s.sync_error).slice(0, 80)'),
    'the 80-char truncation must be gone (overflow is CSS-handled now)',
  );
  assert.ok(
    admin.includes('.al-err{color:#ff9b9b;font-size:11px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'),
    '.al-err must ellipsise instead of the JS cutting the string',
  );
});

test('the ops classifier and its suppression policy have a single definition', () => {
  const admin = read('supabase/functions/norva-admin/index.ts');
  assert.ok(
    !admin.includes('function classifyOpsSourceError'),
    'norva-admin must import the classifier, not redeclare it',
  );
  assert.ok(
    admin.includes('SILENT_OPS_SOURCE_ERROR_KINDS.has(kind)'),
    'the suppression policy must come from the shared set',
  );
});

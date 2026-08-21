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
  assert.equal(text, GATEWAY + ' (403: subscription expired)');
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

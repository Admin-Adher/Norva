'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('provider activity writer hashes real caller keys and preserves strict holder priority', () => {
  const migration = read(
    'supabase',
    'migrations',
    '20260828193000_provider_activity_opaque_touch_and_catalog_drain_v1.sql',
  );

  assert.match(
    migration,
    /when key ~ '\^\[0-9A-Fa-f\]\{64\}\$' then pg_catalog\.lower\(key\)[\s\S]*encode\(extensions\.digest\(key, 'sha256'\), 'hex'\)/,
  );
  assert.match(
    migration,
    /case excluded\.kind[\s\S]*when 'presence' then 0[\s\S]*when 'catalog-refresh' then 1[\s\S]*when 'language-validation' then 2[\s\S]*else 3[\s\S]*>=/,
  );
  assert.match(
    migration,
    /revoke all on function public\.provider_account_touch_many\(text\[\], text\)[\s\S]*grant execute[\s\S]*to service_role/,
  );
  assert.match(migration, /notify pgrst, 'reload schema'/);
});

test('playback reserves the opaque holder before a bounded catalogue drain and never retries 458', () => {
  const edge = read('supabase', 'functions', 'norva-playback', 'index.ts');
  const create = section(
    edge,
    'async function createPlaybackSession(',
    '\nasync function getPlaybackSession(',
  );

  const readDrain = create.indexOf('await providerCatalogRefreshDrainRemainingMs(');
  const reserveSession = create.indexOf('await touchProviderAccountByUrl(db, targetUrl, "session")');
  const waitDrain = create.indexOf('if (catalogRefreshDrainMs > 0) await sleep(catalogRefreshDrainMs)');
  const prepareCoordinator = create.indexOf('const edgeCoordination = mode === "transcode"');
  const directReturn = create.indexOf('if (mode === "direct")');
  assert.ok(readDrain >= 0 && readDrain < reserveSession, 'read the weaker holder before upgrade');
  assert.ok(reserveSession < waitDrain, 'session reservation prevents a later catalogue downgrade');
  assert.ok(waitDrain < prepareCoordinator, 'known provider drain does not consume the coordinator lock TTL');
  assert.ok(prepareCoordinator < directReturn, 'coordination remains before any provider transport opens');
  assert.ok(waitDrain < directReturn, 'all transport modes drain before opening provider I/O');
  assert.match(
    edge,
    /const PROVIDER_CATALOG_REFRESH_DRAIN_MS = boundedInt\([\s\S]*60_000[\s\S]*120_000/,
  );
  assert.match(
    edge,
    /providerCatalogRefreshDrainRemainingMs[\s\S]*\.eq\("account_key", providerAccountHash\)[\s\S]*"catalog-refresh"/,
  );

  const gatewayCreate = section(
    edge,
    'async function createGatewaySession(',
    '\nasync function requestGatewaySession(',
  );
  assert.equal(
    (gatewayCreate.match(/requestGatewaySession\(/g) || []).length,
    3,
    'the drain does not add another provider retry path',
  );
});

test('a fresh shared catalog-refresh observation actually blocks viewer provider I/O', async () => {
  const edge = read('supabase', 'functions', 'norva-playback', 'index.ts');
  const source = section(
    edge,
    'async function providerCatalogRefreshDrainRemainingMs(',
    '\nasync function touchProviderAccountBySource(',
  )
    .replace('db: SupabaseClient', 'db')
    .replace('providerAccountHash: string', 'providerAccountHash');
  const now = Date.parse('2026-09-01T12:00:00.000Z');
  const FakeDate = class extends Date {
    static now() { return now; }
  };
  const remaining = vm.runInNewContext(
    `(() => { ${source}; return providerCatalogRefreshDrainRemainingMs; })()`,
    {
      Date: FakeDate,
      Number,
      Math,
      PROVIDER_CATALOG_REFRESH_DRAIN_MS: 45_000,
      stringOr: (value, fallback) => value == null ? fallback : String(value),
    },
  );
  const dbFor = (kind, lastSeenAt) => ({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return { data: { kind, last_seen_at: lastSeenAt }, error: null };
        },
      };
    },
  });

  const waitMs = await remaining(
    dbFor('catalog-refresh', new Date(now - 5_000).toISOString()),
    'opaque-account-hash',
  );
  assert.equal(waitMs, 40_000);
  assert.equal(await remaining(
    dbFor('gateway', new Date(now - 5_000).toISOString()),
    'opaque-account-hash',
  ), 0);

  let releaseWait;
  let providerOpened = false;
  const sleep = () => new Promise((resolve) => { releaseWait = resolve; });
  const viewer = (async () => {
    if (waitMs > 0) await sleep(waitMs);
    providerOpened = true;
  })();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(providerOpened, false, 'viewer provider I/O stays closed during shared drain');
  releaseWait();
  await viewer;
  assert.equal(providerOpened, true);
});

test('Gateway reports short catalogue holders immediately and drains an active handoff', () => {
  const gateway = read('services', 'media-gateway', 'src', 'index.js');
  const registration = section(
    gateway,
    'function registerAccountExtraction(',
    '\nfunction preemptAccountExtractions(',
  );
  const activityGroups = section(
    gateway,
    'function activeProviderAccountActivityGroups(',
    '\nlet _accountActivityLastErrorAt',
  );
  const sessionRoute = section(
    gateway,
    "app.post('/sessions'",
    "\napp.delete('/sessions/:id'",
  );

  assert.match(
    registration,
    /Promise\.resolve\(\)\.then\(\(\) => reportAccountActivity\(\)\)/,
  );
  assert.match(activityGroups, /if \(entry\.preempted \|\| entry\.reportActivity === false\) continue/);
  assert.match(
    gateway,
    /const PROVIDER_CATALOG_REFRESH_SLOT_RELEASE_DELAY_MS = clampInt\([\s\S]*45_000[\s\S]*120_000/,
  );
  const countBeforePreempt = sessionRoute.indexOf(
    'const catalogRefreshExtractions = activeCatalogRefreshExtractionCount(playbackProxyKey)',
  );
  const preempt = sessionRoute.indexOf(
    "preemptAccountExtractions(playbackProxyKey, 'transcode session start')",
  );
  const delay = sessionRoute.indexOf(
    'PROVIDER_CATALOG_REFRESH_SLOT_RELEASE_DELAY_MS',
  );
  assert.ok(countBeforePreempt >= 0 && countBeforePreempt < preempt);
  assert.ok(preempt < delay, 'the active catalogue class selects the longer release drain');
  assert.match(gateway, /const GATEWAY_VERSION = 143/);
  assert.match(edgeVersion(gateway), /providerCatalogRefreshSlotReleaseDelayMs/);
});

function edgeVersion(gateway) {
  return section(gateway, "app.get('/health'", "\napp.get('/debug/failures'");
}

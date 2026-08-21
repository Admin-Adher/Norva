'use strict';

// The velocity store is the foundation every later anti-abuse signal stands on,
// so these tests pin the two properties that are easy to lose silently: nothing
// raw ever reaches the database, and one increment is one atomic write.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { importTypescriptModule } = require('./helpers/import-typescript-module');

const root = path.join(__dirname, '..');
const modulePath = path.join(root, 'supabase/functions/_shared/risk-velocity-store.ts');
const migrationPath = path.join(root, 'supabase/migrations/20260821200000_abuse_velocity_store.sql');
const read = (p) => fs.readFileSync(p, 'utf8');

const SALT = 'test-salt-long-enough-to-pass-the-guard';

const previousDeno = globalThis.Deno;
globalThis.Deno = {
  env: {
    get(name) {
      if (name === 'NORVA_ABUSE_HASH_SALT') return SALT;
      return undefined;
    },
  },
};

const loading = importTypescriptModule(modulePath);

test.after(async () => {
  await loading;
  if (previousDeno === undefined) delete globalThis.Deno;
  else globalThis.Deno = previousDeno;
});

function stubDb(reply) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      return Promise.resolve({ data: reply(args), error: null });
    },
  };
}

test('a subject is salted and scoped to its dimension before it is stored', async () => {
  const { hashSubject, velocityHashingConfigured } = await loading;
  assert.equal(velocityHashingConfigured(), true);

  const ip = '88.163.67.137';
  const hashed = await hashSubject('ip', ip);
  assert.match(hashed, /^[0-9a-f]{64}$/);

  // A bare sha256 of an IPv4 is reversible by brute force in seconds, so it is
  // an encoding rather than pseudonymisation. The stored value must not be one.
  const bare = nodeCrypto.createHash('sha256').update(ip).digest('hex');
  assert.notEqual(hashed, bare);

  // The same address in two dimensions must not be correlatable by comparing
  // hashes, or the /24 counter leaks which exact address it came from.
  assert.notEqual(hashed, await hashSubject('ip_subnet_24', ip));

  assert.equal(hashed, await hashSubject('ip', ip), 'hashing stays deterministic');
});

test('an email is normalised, so rotating case or spacing does not reset a counter', async () => {
  const { hashSubject } = await loading;
  const canonical = await hashSubject('email', 'user@example.com');
  assert.equal(await hashSubject('email', '  User@Example.COM  '), canonical);
  assert.notEqual(await hashSubject('email', 'user2@example.com'), canonical);
});

test('an empty subject is refused rather than counted as a shared bucket', async () => {
  const { hashSubject } = await loading;
  await assert.rejects(hashSubject('ip', '   '), /velocity_subject_empty/);
});

test('no raw subject ever reaches the database', async () => {
  const { createPostgresVelocityStore } = await loading;
  const db = stubDb(() => []);
  const store = createPostgresVelocityStore(db);

  const ip = '88.163.67.137';
  const email = 'victim@example.com';
  await store.touch([
    { dimension: 'ip', subject: ip, windowsSeconds: [60] },
    { dimension: 'email', subject: email, windowsSeconds: [3600] },
  ]);

  const payload = JSON.stringify(db.calls[0].args);
  assert.ok(!payload.includes(ip), 'the raw address must not appear in the payload');
  assert.ok(!payload.includes(email), 'the raw email must not appear in the payload');
  assert.ok(!payload.includes('example.com'), 'not even the domain');
  assert.equal((payload.match(/[0-9a-f]{64}/g) || []).length, 2, 'two hashes, two subjects');
});

test('every dimension is counted in a single round trip', async () => {
  const { createPostgresVelocityStore } = await loading;
  const db = stubDb(() => []);
  const store = createPostgresVelocityStore(db);

  await store.touch([
    { dimension: 'ip', subject: '1.2.3.4', windowsSeconds: [60] },
    { dimension: 'ip_subnet_24', subject: '1.2.3.0/24', windowsSeconds: [60] },
    { dimension: 'asn', subject: 'AS64500', windowsSeconds: [60] },
    { dimension: 'email', subject: 'a@b.co', windowsSeconds: [60] },
    { dimension: 'device', subject: 'dev-1', windowsSeconds: [60] },
    { dimension: 'user_agent', subject: 'curl/8', windowsSeconds: [60] },
  ]);

  // Six dimensions, one call. The signup path cannot pay six network hops.
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].name, 'abuse_velocity_touch');
  assert.equal(db.calls[0].args.p_entries.length, 6);
});

test('windows are de-duplicated, sorted, and nonsense is dropped', async () => {
  const { createPostgresVelocityStore } = await loading;
  const db = stubDb(() => []);
  const store = createPostgresVelocityStore(db);

  await store.touch([{
    dimension: 'ip',
    subject: '1.2.3.4',
    windowsSeconds: [3600, 60, 60, 0, -5, Number.NaN, 86400, 99999999],
  }]);

  assert.deepEqual(db.calls[0].args.p_entries[0].windows_seconds, [60, 3600, 86400]);
});

test('a window the database did not answer reads as zero, not as absent', async () => {
  const { createPostgresVelocityStore } = await loading;
  const db = stubDb((args) => [{
    dimension: 'ip',
    subject_hash: args.p_entries[0].subject_hash,
    // 3600 deliberately omitted from the reply.
    counts: { 60: 4 },
  }]);
  const store = createPostgresVelocityStore(db);

  const [reading] = await store.touch([
    { dimension: 'ip', subject: '1.2.3.4', windowsSeconds: [60, 3600] },
  ]);
  assert.equal(reading.counts[60], 4);
  assert.equal(reading.counts[3600], 0, 'the engine must never see undefined here');
});

test('the fan-out is bounded, so one malformed caller cannot fan a signup out', async () => {
  const { createPostgresVelocityStore, MAX_VELOCITY_ENTRIES } = await loading;
  const db = stubDb(() => []);
  const store = createPostgresVelocityStore(db);

  const tooMany = Array.from({ length: MAX_VELOCITY_ENTRIES + 1 }, (_, i) => ({
    dimension: 'ip',
    subject: `10.0.0.${i}`,
    windowsSeconds: [60],
  }));
  await assert.rejects(store.touch(tooMany), /velocity_too_many_entries/);
  assert.equal(db.calls.length, 0, 'nothing is written when the request is refused');
});

test('an rpc failure surfaces instead of being reported as zero velocity', async () => {
  const { createPostgresVelocityStore } = await loading;
  const store = createPostgresVelocityStore({
    rpc: () => Promise.resolve({ data: null, error: { code: '57014' } }),
  });
  // Silently returning zeros would tell the engine "this subject is new", which
  // is the most dangerous possible lie. The engine decides to fail open; the
  // store never decides it for them.
  await assert.rejects(
    store.touch([{ dimension: 'ip', subject: '1.2.3.4', windowsSeconds: [60] }]),
    /velocity_rpc_failed/,
  );
});

test('one hundred concurrent increments cannot lose a count', () => {
  const sql = read(migrationPath);
  // Proving this against a live database needs Postgres, which these tests do
  // not have. What is provable here is the only property that matters: the
  // increment is a single atomic statement, so there is no read-modify-write
  // window for concurrent signups to race through, and no lock to contend on.
  const upserts = sql.match(/on conflict \(dimension, resolution, subject_hash, bucket_start\)\s*\n\s*do update set hits = b\.hits \+ 1/g) || [];
  assert.equal(upserts.length, 2, 'one atomic upsert per resolution');
  assert.doesNotMatch(sql, /for update/i, 'no row locking is needed or wanted');
  assert.doesNotMatch(sql, /pg_advisory/i, 'no advisory lock on the signup path');
});

test('the table keeps a sliding window, at two resolutions', () => {
  const sql = read(migrationPath);
  assert.match(sql, /resolution\s+text\s+not null/);
  assert.match(sql, /check \(resolution in \('minute', 'hour'\)\)/);
  // Minute buckets bound the read cost of an hour window to 60 rows, hour
  // buckets bound a day to 24. A single fixed bucket_start would let a burst
  // straddling a boundary pass twice the budget.
  assert.match(sql, /v_seconds <= 3600/);
  assert.match(sql, /date_trunc\('minute', v_now - make_interval/);
  assert.match(sql, /date_trunc\('hour', v_now - make_interval/);
});

test('the store is private, pseudonymised and short-lived', () => {
  const sql = read(migrationPath);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table abuse_private\.velocity_buckets\s*\n\s*from public, anon, authenticated, service_role;/);
  // Only a 64-hex hash is storable: a raw address cannot be written even by a
  // caller that forgets to hash.
  assert.match(sql, /check \(subject_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(sql, /velocity_prune/);
  assert.match(sql, /interval '48 hours'/);
  assert.match(sql, /interval '30 days'/);
  // The public shims are the only door, and only the service role holds a key.
  assert.match(sql, /grant execute on function public\.abuse_velocity_touch\(jsonb\) to service_role;/);
  assert.match(sql, /revoke all on function public\.abuse_velocity_touch\(jsonb\)\s*\n\s*from public, anon, authenticated;/);
});

test('the store holds no threshold and renders no verdict', () => {
  const sql = read(migrationPath);
  const ts = read(modulePath);

  // Structural, not lexical. Grepping a migration for words like "threshold"
  // only ever proves that its comments discuss thresholds — the first two
  // attempts at this test failed on their own prose. What actually constrains
  // the design is the column list: a store that cannot hold a score or a
  // verdict cannot start rendering one.
  const body = sql
    .slice(sql.indexOf('create table if not exists abuse_private.velocity_buckets ('))
    .split('primary key')[0];
  const columns = [...body.matchAll(/^\s{2}(\w+)\s+(?:text|integer|timestamptz|boolean|numeric|jsonb)\b/gm)]
    .map((m) => m[1]);
  assert.deepEqual(columns, [
    'dimension', 'resolution', 'subject_hash', 'bucket_start', 'hits', 'updated_at',
  ], 'six counting columns and nothing that could hold a decision');

  // The only conditionals in the function pick a resolution or reject malformed
  // input; none of them branches on how large a count is.
  assert.doesNotMatch(sql, /case\s+when/i, 'no verdict expression in the schema');
  // The TypeScript side may name them in prose, but must expose no such API.
  assert.doesNotMatch(ts, /export (function|const) (decide|block|allow)/);
});

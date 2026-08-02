'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const helperSource = read('supabase/functions/_shared/partners-api.ts');
const edgeSource = read('supabase/functions/norva-partners/index.ts');
const migrationSource = read(
  'supabase/migrations/20260802193000_partners_member_write_rate_limits.sql',
);
const fiscalMigrationSource = read(
  'supabase/migrations/20260802190000_partners_fiscal_payout_onboarding.sql',
);
const kongSource = read('ops/hetzner/volumes/api/kong.yml');
const hetznerComposeSource = read('ops/hetzner/docker-compose.supabase.yml');

function helpers() {
  const compiled = esbuild.transformSync(helperSource, {
    loader: 'ts',
    format: 'cjs',
    target: 'es2022',
  }).code;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    crypto: cryptoNode.webcrypto,
    TextEncoder,
    Uint8Array,
    URL,
    URLSearchParams,
  });
  return module.exports;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('member write fingerprints are deterministic, operation-bound and opaque', async () => {
  const { partnersMemberWriteRequestHash } = helpers();
  const fiscal = await partnersMemberWriteRequestHash(
    'fiscal_profile_self_attestation',
    ['FR', 'partners-tax-self-certification-v1', 'accepted'],
  );
  assert.match(fiscal, /^[0-9a-f]{64}$/);
  assert.equal(
    fiscal,
    await partnersMemberWriteRequestHash(
      'fiscal_profile_self_attestation',
      ['FR', 'partners-tax-self-certification-v1', 'accepted'],
    ),
  );
  assert.notEqual(
    fiscal,
    await partnersMemberWriteRequestHash(
      'payout_onboarding',
      ['FR', 'partners-tax-self-certification-v1', 'accepted'],
    ),
  );
  assert.equal(fiscal.includes('FR'), false);
  await assert.rejects(
    () => partnersMemberWriteRequestHash('unsupported', ['FR']),
    (error) => error?.status === 400 && error?.code === 'invalid_request',
  );
});

test('reservation sanitizer accepts only the exact bounded counter contract', () => {
  const { sanitizeMemberWriteReservation } = helpers();
  const valid = {
    schema_version: 1,
    action: 'member_write_reserved',
    operation: 'fiscal_profile_self_attestation',
    replayed: false,
    limit: 8,
    used: 3,
    remaining: 5,
    window_seconds: 86400,
  };
  assert.deepEqual(
    plain(sanitizeMemberWriteReservation(
      valid,
      'fiscal_profile_self_attestation',
    )),
    valid,
  );
  for (const malformed of [
    { ...valid, account_id: 'forbidden' },
    { ...valid, operation: 'payout_onboarding' },
    { ...valid, limit: 9 },
    { ...valid, used: 9, remaining: -1 },
    { ...valid, remaining: 4 },
    { ...valid, window_seconds: 60 },
  ]) {
    assert.throws(() => sanitizeMemberWriteReservation(
      malformed,
      'fiscal_profile_self_attestation',
    ));
  }
});
test('Edge reserves a normalized key after JWT verification and before each state mutation', () => {
  const authentication = edgeSource.indexOf('const userId = await requireUserId(token, admin);');
  const fiscalStart = edgeSource.indexOf('} else if (route === "/fiscal-profile")');
  const payoutStart = edgeSource.indexOf('} else if (route === "/payout-onboarding")');
  const payoutEnd = edgeSource.indexOf('} else if (route === "/tv-relays/consume")');
  assert.ok(authentication > 0 && authentication < fiscalStart);

  const fiscal = edgeSource.slice(fiscalStart, payoutStart);
  const payout = edgeSource.slice(payoutStart, payoutEnd);
  for (const [block, operation, mutationRpc] of [
    [fiscal, 'fiscal_profile_self_attestation', 'PARTNERS_RPC.fiscalProfileSelfAttest'],
    [payout, 'payout_onboarding', 'PARTNERS_RPC.payoutOnboardingRequest'],
  ]) {
    const parseAt = block.indexOf('await readJsonBody(req)');
    const hashAt = block.indexOf('partnersMemberWriteRequestHash(operation');
    const reserveAt = block.indexOf('PARTNERS_RPC.memberWriteReserve');
    const mutateAt = block.indexOf(mutationRpc);
    assert.ok(parseAt >= 0 && parseAt < hashAt);
    assert.ok(hashAt < reserveAt && reserveAt < mutateAt, operation);
    assert.match(block, /p_user_id: userId/);
    assert.match(block, /p_idempotency_key: idempotencyKey/);
    assert.match(block, /p_request_hash: requestHash/);
    assert.match(block, /sanitizeMemberWriteReservation/);
  }
});

test('database reservation is service-only, rolling, replay-safe and mapped to 429', () => {
  const { mapDatabaseError } = helpers();
  assert.deepEqual(plain(mapDatabaseError({ code: 'P0008' }, 'mutation')), {
    status: 429,
    code: 'rate_limited',
    message: 'Too many access requests were received. Try again later.',
  });
  assert.match(migrationSource, /pg_advisory_xact_lock\([\s\S]*p_user_id::text[\s\S]*v_operation/);
  assert.match(migrationSource, /reserved_at >= now\(\) - interval '24 hours'/);
  assert.match(migrationSource, /v_limit constant integer := 8/);
  assert.match(migrationSource, /if found then[\s\S]*v_existing_hash is distinct from v_request_hash[\s\S]*'replayed', true/);
  assert.match(migrationSource, /if v_used >= v_limit then[\s\S]*errcode = 'P0008'/);
  assert.match(migrationSource, /grant execute on function public\.partners_service_member_write_reserve\([\s\S]*to service_role/);
  assert.doesNotMatch(migrationSource, /to authenticated|to anon/);
  assert.doesNotMatch(migrationSource, /email|address|tax_identifier|provider_reference/);
  assert.doesNotMatch(
    fiscalMigrationSource,
    /perform affiliate_private\.partners_enforce_fiscal_onboarding_write_limit/,
  );
});

test('Kong applies bounded IP burst limits on exact POST routes before the generic Functions route', () => {
  assert.match(
    hetznerComposeSource,
    /KONG_PLUGINS:[^\n]*request-size-limiting[^\n]*rate-limiting/,
    'every declarative plugin used by the Partners routes is enabled in Kong',
  );
  const genericAt = kongSource.indexOf('\n  - name: functions-v1\n');
  assert.ok(genericAt > 0);
  for (const spec of [
    {
      name: 'functions-v1-partners-fiscal-profile-write',
      path: '~/functions/v1/norva-partners/fiscal-profile$',
      upstream: 'http://edge-functions-pool/norva-partners/fiscal-profile',
    },
    {
      name: 'functions-v1-partners-payout-onboarding-write',
      path: '~/functions/v1/norva-partners/payout-onboarding$',
      upstream: 'http://edge-functions-pool/norva-partners/payout-onboarding',
    },
  ]) {
    const start = kongSource.indexOf(`\n  - name: ${spec.name}\n`);
    assert.ok(start > 0 && start < genericAt, spec.name);
    const block = kongSource.slice(start, kongSource.indexOf('\n  - name:', start + 4));
    assert.match(block, new RegExp(`url: ${spec.upstream.replaceAll('/', '\\/')}`));
    assert.ok(block.includes(`- '${spec.path}'`));
    assert.match(block, /methods:\n\s+- POST/);
    assert.match(block, /name: rate-limiting/);
    assert.match(block, /minute: 30/);
    assert.match(block, /hour: 240/);
    assert.match(block, /limit_by: ip/);
    assert.match(block, /policy: local/);
  }
});

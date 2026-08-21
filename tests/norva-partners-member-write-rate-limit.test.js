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
const frictionlessMigrationSource = read(
  'supabase/migrations/20260804173000_partners_frictionless_membership_credits.sql',
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
  for (const [operation, fields] of [
    ['membership_join', ['terms-accepted', 'disclosure-accepted']],
    ['link_rotation', ['rotate']],
    ['payout_country_bind', ['FR']],
    ['access_credit_quote', ['3']],
    ['access_credit_redeem', ['crq_0123456789abcdef01234567']],
  ]) {
    assert.match(
      await partnersMemberWriteRequestHash(operation, fields),
      /^[0-9a-f]{64}$/,
      operation,
    );
  }
  await assert.rejects(
    () => partnersMemberWriteRequestHash('unsupported', ['FR']),
    (error) => error?.status === 400 && error?.code === 'invalid_request',
  );
});

test('reservation sanitizer accepts only the exact bounded counter contract', () => {
  const { sanitizeMemberWriteReservation } = helpers();
  const contracts = [
    ['membership_join', 4],
    ['link_rotation', 4],
    ['payout_country_bind', 8],
    ['access_credit_quote', 24],
    ['access_credit_redeem', 12],
    ['fiscal_profile_self_attestation', 8],
    ['payout_onboarding', 8],
  ];
  for (const [operation, limit] of contracts) {
    const valid = {
      schema_version: 1,
      action: 'member_write_reserved',
      operation,
      replayed: false,
      limit,
      used: Math.min(3, limit),
      remaining: limit - Math.min(3, limit),
      window_seconds: 86400,
    };
    assert.deepEqual(
      plain(sanitizeMemberWriteReservation(valid, operation)),
      valid,
      operation,
    );
  }
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
  const reserveHelperStart = edgeSource.indexOf('async function reserveMemberWrite(');
  const reserveHelperEnd = edgeSource.indexOf('async function callVersionedRpc(', reserveHelperStart);
  const reserveHelper = edgeSource.slice(reserveHelperStart, reserveHelperEnd);
  assert.ok(reserveHelperStart > authentication);
  assert.match(reserveHelper, /partnersMemberWriteRequestHash\(/);
  assert.match(reserveHelper, /PARTNERS_RPC\.memberWriteReserve/);
  assert.match(reserveHelper, /p_user_id: userId/);
  assert.match(reserveHelper, /p_idempotency_key: idempotencyKey/);
  assert.match(reserveHelper, /p_request_hash: requestHash/);
  assert.match(reserveHelper, /sanitizeMemberWriteReservation/);

  const routeCases = [
    ['/join', '/credit/quotes', 'membership_join', 'PARTNERS_RPC.join'],
    ['/credit/quotes', '/credit/redemptions', 'access_credit_quote', 'PARTNERS_RPC.accessCreditQuote'],
    ['/credit/redemptions', '/credit/status', 'access_credit_redeem', 'PARTNERS_RPC.accessCreditRedeem'],
    ['/payout-country', '/access-request', 'payout_country_bind', 'PARTNERS_RPC.payoutCountryBind'],
    ['/links', '/kyc/rights', 'link_rotation', 'PARTNERS_RPC.rotateLink'],
  ];
  for (const [route, nextRoute, operation, mutationRpc] of routeCases) {
    const start = edgeSource.indexOf(`} else if (route === "${route}")`);
    const end = edgeSource.indexOf(`} else if (route === "${nextRoute}"`, start);
    const block = edgeSource.slice(start, end);
    const parseAt = block.indexOf('await readJsonBody(req)');
    const reserveAt = block.indexOf('await reserveMemberWrite(');
    const operationAt = block.indexOf(`"${operation}"`, reserveAt);
    const mutateAt = block.indexOf(mutationRpc);
    assert.ok(parseAt >= 0 && parseAt < reserveAt, operation);
    assert.ok(reserveAt < operationAt && operationAt < mutateAt, operation);
  }

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
  for (const operation of [
    'membership_join',
    'link_rotation',
    'payout_country_bind',
    'access_credit_quote',
    'access_credit_redeem',
  ]) {
    assert.match(frictionlessMigrationSource, new RegExp(`'${operation}'`));
  }
  assert.match(frictionlessMigrationSource, /when 'membership_join' then 4/);
  assert.match(frictionlessMigrationSource, /when 'link_rotation' then 4/);
  assert.match(frictionlessMigrationSource, /when 'payout_country_bind' then 8/);
  assert.match(frictionlessMigrationSource, /when 'access_credit_quote' then 24/);
  assert.match(frictionlessMigrationSource, /when 'access_credit_redeem' then 12/);
  assert.match(frictionlessMigrationSource, /reserved_at < now\(\) - interval '30 days'/);
  assert.match(frictionlessMigrationSource, /if found then[\s\S]*'replayed', true[\s\S]*if v_used >= v_operation_limit then/);
});

test('Kong applies bounded IP burst limits on exact POST routes before the generic Functions route', () => {
  assert.match(
    kongSource,
    /^_format_version: '3\.0'/,
    'Kong 3 declarative format is required for expression-based routes',
  );
  assert.match(
    hetznerComposeSource,
    /KONG_PLUGINS:[^\n]*request-size-limiting[^\n]*rate-limiting/,
    'every declarative plugin used by the Partners routes is enabled in Kong',
  );
  // Position in this file no longer decides precedence. Under
  // KONG_ROUTER_FLAVOR: expressions regex_priority is ignored, the generic
  // /functions/v1/ route was winning, and these seven ceilings never ran: 34
  // consecutive POSTs to the credit-quote route drew no 429 and no RateLimit
  // header at all. An explicit priority is what makes them apply, and a real
  // 429 is what proves it — each of the seven was verified against the live
  // gateway, so this test guards a contract that has actually been observed
  // rather than one that merely reads correctly.
  assert.match(kongSource, /^  - name: functions-v1$/m, 'the generic route still exists');
  for (const spec of [
    {
      name: 'functions-v1-partners-membership-join-write',
      path: '/functions/v1/norva-partners/join',
      upstream: 'http://edge-functions-pool/norva-partners/join',
    },
    {
      name: 'functions-v1-partners-link-rotation-write',
      path: '/functions/v1/norva-partners/links',
      upstream: 'http://edge-functions-pool/norva-partners/links',
    },
    {
      name: 'functions-v1-partners-payout-country-write',
      path: '/functions/v1/norva-partners/payout-country',
      upstream: 'http://edge-functions-pool/norva-partners/payout-country',
    },
    {
      name: 'functions-v1-partners-access-credit-quote-write',
      path: '/functions/v1/norva-partners/credit/quotes',
      upstream: 'http://edge-functions-pool/norva-partners/credit/quotes',
    },
    {
      name: 'functions-v1-partners-access-credit-redeem-write',
      path: '/functions/v1/norva-partners/credit/redemptions',
      upstream: 'http://edge-functions-pool/norva-partners/credit/redemptions',
    },
    {
      name: 'functions-v1-partners-fiscal-profile-write',
      path: '/functions/v1/norva-partners/fiscal-profile',
      upstream: 'http://edge-functions-pool/norva-partners/fiscal-profile',
    },
    {
      name: 'functions-v1-partners-payout-onboarding-write',
      path: '/functions/v1/norva-partners/payout-onboarding',
      upstream: 'http://edge-functions-pool/norva-partners/payout-onboarding',
    },
  ]) {
    const start = kongSource.indexOf(`\n  - name: ${spec.name}\n`);
    assert.ok(start > 0, spec.name);
    const block = kongSource.slice(start, kongSource.indexOf('\n  - name:', start + 4));
    // Comments are stripped before looking for what must be absent: the block
    // explains in prose why regex_priority is inert, and matching that prose
    // would only ever prove the prose exists.
    const code = block.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    assert.match(block, new RegExp(`url: ${spec.upstream.replaceAll('/', '\\/')}`));
    assert.ok(
      code.includes(`expression: 'http.path == "${spec.path}" && http.method == "POST"'`),
      `${spec.name} matches by expression, and http.path excludes the query string`,
    );
    assert.match(code, /priority: 1000/);
    assert.doesNotMatch(code, /regex_priority/, 'inert under the expressions router');
    assert.doesNotMatch(code, /methods:/, 'the method lives in the expression now');
    assert.match(block, /name: rate-limiting/);
    assert.match(block, /minute: 30/);
    assert.match(block, /hour: 240/);
    assert.match(block, /limit_by: ip/);
    assert.match(block, /policy: local/);
    // A ceiling that publishes its budget and its remaining count tells an
    // attacker exactly what rate to pace against.
    assert.match(block, /hide_client_headers: true/);
  }
});

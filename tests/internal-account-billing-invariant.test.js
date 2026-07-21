const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');

const migration = read('supabase/migrations/20260721120000_internal_account_billing_invariant.sql');
const revolut = read('supabase/functions/norva-revolut/index.ts');
const billing = read('supabase/functions/norva-revolut-billing/index.ts');
const lifecycle = read('supabase/functions/norva-lifecycle/index.ts');

function routeSlice(source, route, nextRoute) {
  const start = source.indexOf(`path === "/${route}"`);
  const end = nextRoute ? source.indexOf(`path === "/${nextRoute}"`, start + 1) : source.length;
  assert.ok(start >= 0 && end > start, `route /${route} must be extractable`);
  return source.slice(start, end);
}

test('only the five explicitly named current pilot identities are backfilled', () => {
  const emails = [
    'adrien.hernandez@outlook.com',
    'hernandez.jeremy@outlook.fr',
    'projethorizon2030@gmail.com',
    'adrienhernandez20@gmail.com',
    'cventis.support@gmail.com',
  ];
  for (const email of emails) assert.match(migration, new RegExp(email.replace('.', '\\.')));
  assert.match(migration, /where lower\(u\.email\) in \(/i);
  assert.doesNotMatch(migration, /trigger[\s\S]{0,120}(?:on|after insert on) auth\.users/i);
});

test('internal projections are canonical, perpetual system grants with no billing state', () => {
  assert.match(migration, /create trigger aaa_norva_internal_entitlement_invariant/i);
  assert.match(migration, /before insert or update on public\.cloud_entitlement_projection/i);
  for (const assignment of [
    /new\.provider := 'system'/,
    /new\.provider_customer_id := null/,
    /new\.plan_code := 'family'/,
    /new\.status := coalesce\(v_hard_status, 'active'\)/,
    /new\.current_period_end := null/,
    /new\.trial_ends_at := null/,
    /new\.fail_open_until := null/,
    /new\.dunning_last_at := null/,
    /new\.dunning_stage := 0/,
    /new\.billing_retry_count := 0/,
    /new\.mrr_cents := null/,
    /new\.bill_period := null/,
  ]) assert.match(migration, assignment);
  assert.match(migration, /after insert on public\.admin_internal_accounts/i);
});

test('explicit internal hard-blocks remain blocked but cannot retain a billable rail', () => {
  const trigger = migration.slice(
    migration.indexOf('create or replace function public.norva_enforce_internal_entitlement()'),
    migration.indexOf('drop trigger if exists aaa_norva_internal_entitlement_invariant'),
  );
  assert.match(trigger, /new\.status in \('revoked', 'refunded', 'fraud'\)/);
  assert.match(trigger, /old\.status in \('revoked', 'refunded', 'fraud'\)/);
  assert.match(trigger, /new\.provider := 'system'/);
  assert.match(trigger, /new\.provider_customer_id := null/);
  assert.match(trigger, /new\.status := coalesce\(v_hard_status, 'active'\)/);
  assert.match(trigger, /new\.current_period_end := null/);
  assert.doesNotMatch(migration, /where p\.status not in \('revoked', 'refunded', 'fraud'\)/i);
});

test('the invariant preserves provider history tables instead of rewriting billing evidence', () => {
  assert.doesNotMatch(migration, /(?:update|delete from)\s+public\.cloud_revolut_customers/i);
  assert.doesNotMatch(migration, /(?:update|delete from)\s+public\.cloud_revolut_ledger/i);
  assert.doesNotMatch(migration, /(?:update|delete from)\s+public\.cloud_revolut_orders/i);
  assert.doesNotMatch(migration, /update\s+public\.cloud_revolut_billing_attempts[\s\S]{0,300}set\s+status/i);
  assert.match(migration, /raise exception 'internal_account_billing_inflight'/i);
});

test('database billing claim and both apply paths fail closed for internal accounts', () => {
  const claim = migration.slice(
    migration.indexOf('create or replace function public.claim_revolut_billing_cycle('),
    migration.indexOf('do $rename_apply_success$'),
  );
  assert.ok(claim.indexOf('norva_is_internal_account(p_user_id)') <
    claim.indexOf('claim_revolut_billing_cycle_noninternal('));
  assert.match(claim, /'internal'::text/);
  assert.match(migration, /before insert on public\.cloud_revolut_billing_attempts/i);
  assert.match(migration, /raise exception 'internal_account_not_billable'/i);

  for (const fn of ['apply_revolut_billing_success', 'apply_revolut_billing_failure']) {
    const start = migration.lastIndexOf(`create or replace function public.${fn}(`);
    assert.ok(start >= 0);
    const block = migration.slice(start, migration.indexOf('$function$;', start) + 11);
    const lock = block.indexOf('pg_advisory_xact_lock');
    const membership = block.indexOf('norva_is_internal_account(v_user_id)');
    assert.ok(lock >= 0 && lock < membership);
    assert.match(block, /raise exception 'internal_account_billing_reconciliation_required'/);
    assert.doesNotMatch(block, /update public\.cloud_revolut_billing_attempts/);
  }
});

test('internal tagging and renewal claims share a per-user transaction lock', () => {
  assert.match(migration, /function public\.norva_is_internal_account[\s\S]{0,160}volatile/i);
  assert.match(migration, /create trigger aaa_norva_lock_internal_billing_transition/i);
  assert.match(
    migration,
    /before insert or update or delete on public\.admin_internal_accounts/i,
  );
  const claim = migration.slice(
    migration.indexOf('create or replace function public.claim_revolut_billing_cycle('),
    migration.indexOf('do $rename_apply_success$'),
  );
  const lock = claim.indexOf('pg_advisory_xact_lock');
  const membership = claim.indexOf('norva_is_internal_account(p_user_id)');
  const baseClaim = claim.indexOf('claim_revolut_billing_cycle_noninternal(');
  assert.ok(lock >= 0 && lock < membership && membership < baseClaim);

  const attemptGuard = migration.slice(
    migration.indexOf('create or replace function public.norva_block_internal_billing_attempt()'),
    migration.indexOf('drop trigger if exists aaa_norva_block_internal_billing_attempt'),
  );
  assert.ok(attemptGuard.indexOf('pg_advisory_xact_lock') <
    attemptGuard.indexOf('norva_is_internal_account(new.user_id)'));
});

test('every Revolut customer mapping write is linearized with internal and projection state', () => {
  const guard = migration.slice(
    migration.indexOf('create or replace function public.norva_guard_revolut_customer_mapping()'),
    migration.indexOf('drop trigger if exists aaa_norva_guard_revolut_customer_mapping'),
  );
  assert.ok(guard.length > 0);
  const lock = guard.indexOf('pg_advisory_xact_lock');
  const internal = guard.indexOf('norva_is_internal_account(new.user_id)');
  const projectionLock = guard.indexOf('for update;');
  assert.ok(lock >= 0 && lock < internal && internal < projectionLock);
  assert.match(guard, /v_status in \('revoked', 'refunded', 'fraud'\)/);
  assert.match(guard, /v_provider <> 'revolut' and v_status <> 'expired'/);
  assert.match(guard, /raise exception 'internal_account_not_billable'/);
  assert.match(guard, /raise exception 'revolut_customer_account_blocked'/);
  assert.match(guard, /raise exception 'revolut_customer_rail_mismatch'/);
  assert.match(migration, /before insert or update on public\.cloud_revolut_customers/i);
});

test('removing an internal tag restores a snapshot or expires legacy included access', () => {
  assert.match(migration, /create table if not exists public\.admin_internal_entitlement_snapshots/i);
  assert.match(migration, /to_jsonb\(p\)/i);
  assert.match(migration, /create trigger aaz_norva_internal_account_restore/i);
  const restore = migration.slice(
    migration.indexOf('create or replace function public.norva_restore_external_entitlement()'),
    migration.indexOf('drop trigger if exists aaz_norva_internal_account_restore'),
  );
  assert.match(restore, /jsonb_populate_record/i);
  assert.match(restore, /require an explicit resubscribe/i);
  assert.match(restore, /p\.provider not in \('system', 'manual'\)/i);
  assert.match(restore, /greatest\(/i);
  assert.match(restore, /v_current_status in \('revoked', 'refunded', 'fraud'\)/i);
  assert.match(restore, /plan_code = 'none'/i);
  assert.match(restore, /status = 'expired'/i);
});

test('mutating Revolut routes reject internal billing and profile returns neutral included access', () => {
  assert.match(revolut, /internal account check failed/);
  assert.match(revolut, /billing_eligibility_unavailable/);
  assert.match(revolut, /internal_account_not_billable/);
  assert.equal((revolut.match(/await guardInternalBilling\(db, user\.id\)/g) || []).length, 4);
  assert.equal((revolut.match(/await guardInternalBilling\(db, user\.id, true\)/g) || []).length, 1);

  const checkout = routeSlice(revolut, 'checkout', 'confirm');
  assert.ok(checkout.indexOf('guardInternalBilling') < checkout.indexOf('let payload:'));
  assert.ok(checkout.indexOf('guardInternalBilling') < checkout.indexOf('await revolut('));
  assert.ok(checkout.indexOf('account_billing_blocked') < checkout.indexOf('await revolut('));

  const confirm = routeSlice(revolut, 'confirm', 'profile');
  assert.ok(confirm.indexOf('guardInternalBilling') < confirm.indexOf('let payload:'));
  assert.ok(confirm.indexOf('guardInternalBilling') < confirm.indexOf('await revolut('));
  assert.match(confirm, /curHardBlocked/);
  assert.match(confirm, /rejected_account_blocked/);
  assert.match(confirm, /revolutMappingRejection\(customerCommitError\.message\)/);
  assert.match(confirm, /stampFinalized\(rejection\.finalization/);

  const profile = routeSlice(revolut, 'profile', 'cancel');
  assert.ok(profile.indexOf('guardInternalBilling') < profile.indexOf('cloud_revolut_customers'));
  assert.match(profile, /guardInternalBilling\(db, user\.id, true\)/);
  assert.match(revolut, /json\(\{ ok: true, profile: null, included_access: true \}\)/);
  for (const [route, next] of [['cancel', 'resume'], ['resume', null]]) {
    const block = routeSlice(revolut, route, next);
    assert.ok(block.indexOf('guardInternalBilling') < block.indexOf('norva_apply_revolut_account_action'));
    assert.doesNotMatch(block, /from\("cloud_entitlement_projection"\).*update/s);
  }
});

test('recurring worker checks internal status before claim and again before remote charge', () => {
  const charge = billing.slice(billing.indexOf('async function chargeUser'), billing.indexOf('function addHours'));
  const guards = [...charge.matchAll(/await isInternal\(db, row\.user_id\)/g)].map((m) => m.index);
  assert.ok(guards.length >= 2);
  assert.ok(guards[0] < charge.indexOf('claimBillingCycle('));
  assert.ok(guards[1] > charge.indexOf('claimBillingCycle('));
  assert.ok(guards[1] < charge.indexOf('chargeSavedCard('));
  assert.match(billing, /action: "internal" \|/);
  assert.match(billing, /if \(claim\.action === "internal"\) return "skipped"/);
  assert.match(billing, /internal_account_check_failed/);
});

test('dunning and past-due expiry lifecycle paths exclude internal accounts; Edge trial is retired', () => {
  assert.match(lifecycle, /async function internalAccountOrUnknown/);
  assert.match(lifecycle, /internal account check failed[\s\S]*return true/);
  for (const [start, end] of [
    ['async function runDunning', 'async function runWinback'],
    ['async function runExpirePastDue', 'async function authenticatedUserId'],
  ]) {
    const block = lifecycle.slice(lifecycle.indexOf(start), lifecycle.indexOf(end));
    assert.match(block, /internalAccountOrUnknown/);
  }
  assert.doesNotMatch(lifecycle, /runTrialReminder|LC_TRIAL/);
  assert.match(lifecycle, /trial_reminder: "db_cron_canonical"/);
  const welcome = lifecycle.slice(
    lifecycle.indexOf('async function runWelcome'),
    lifecycle.indexOf('async function runDunning'),
  );
  assert.match(welcome, /internalError/);
  assert.match(welcome, /throw new Error\(`internal_account_check_failed:/);
});

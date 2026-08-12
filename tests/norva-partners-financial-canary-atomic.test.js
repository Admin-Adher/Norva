'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260812122425_partners_financial_canary_atomic_cycle.sql',
  ),
  'utf8',
).replace(/\r\n?/g, '\n');
const aal2Migration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '20260802135202_partners_sensitive_mutations_aal2.sql',
  ),
  'utf8',
).replace(/\r\n?/g, '\n');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const createRpc = section(
  migration,
  'affiliate_private.admin_partners_financial_canary_cycle_create(',
  'affiliate_private.admin_partners_financial_canary_cycle_approve(',
);
const lineage = section(
  migration,
  'affiliate_private.partners_financial_canary_lineage_current(',
  'affiliate_private.guard_financial_canary_cycle_exclusivity()',
);
const cycleExclusivityGuard = section(
  migration,
  'affiliate_private.guard_financial_canary_cycle_exclusivity()',
  'affiliate_private.guard_financial_canary_cycle_approval()',
);
const cycleGuard = section(
  migration,
  'affiliate_private.guard_financial_canary_cycle_approval()',
  'affiliate_private.admin_partners_financial_canary_cycle_create(',
);
const approveRpc = section(
  migration,
  'affiliate_private.admin_partners_financial_canary_cycle_approve(',
  'affiliate_private.admin_partners_financial_canary_cycle_abort(',
);
const abortRpc = section(
  migration,
  'affiliate_private.admin_partners_financial_canary_cycle_abort(',
  'affiliate_private.guard_financial_canary_manual_batch()',
);
const manualBatchGuard = section(
  migration,
  'affiliate_private.guard_financial_canary_manual_batch()',
  'public.admin_partners_financial_canary_cycle_create(',
);

test('financial canary hard-caps the one-shot payment at 1000 minor units', () => {
  assert.match(createRpc, /p_amount_minor not between 1 and 1000/);
  assert.match(
    migration,
    /authorization_sha256\s+text not null unique[\s\S]*transaction_hash\s+text not null unique/,
  );
  assert.match(
    createRpc,
    /run\.authorization_sha256 = v_authorization[\s\S]*run\.transaction_hash = v_transaction/,
  );
});

test('financial canary excludes deleted, banned and unconfirmed auth users', () => {
  assert.match(createRpc, /user_row\.deleted_at is null/);
  assert.match(createRpc, /user_row\.banned_until is null/);
  assert.match(createRpc, /user_row\.banned_until < clock_timestamp\(\)/);
  assert.match(createRpc, /user_row\.email_confirmed_at is not null/);
});

test('financial canary requires the exact current live Didit proof', () => {
  for (const contract of [
    /kyc_session\.provider_session_hash\s*=\s*account\.verification_reference/,
    /kyc_session\.provider_environment = 'live'/,
    /kyc_session\.provider_status = 'approved'/,
    /kyc_session\.status = 'verified'/,
    /kyc_session\.provider_purge_status = 'purged'/,
    /newer_kyc_session\.provider_environment = 'live'/,
    /newer_kyc_session\.status <> 'superseded'/,
    /newer_kyc_session\.created_at > kyc_session\.created_at/,
    /webhook_event\.processing_outcome = 'verified'/,
    /webhook_event\.provider_event_at = kyc_session\.verified_at/,
  ]) {
    assert.match(createRpc, contract);
  }
});

test('checker and batch time revalidate the live subject and payout destination', () => {
  for (const contract of [
    /user_row\.deleted_at is null/,
    /user_row\.banned_until is null/,
    /user_row\.banned_until < clock_timestamp\(\)/,
    /user_row\.email_confirmed_at is not null/,
    /allowlist_row\.status = 'active'/,
    /account\.verification_status = 'verified'/,
    /fiscal\.declaration_version =\s*'partners-tax-self-certification-v1'/,
    /request\.execution_adapter = 'revolut_manual'/,
    /profile\.status = 'active'/,
    /binding\.status = 'active'/,
    /route\.execution_adapter = 'revolut_manual'/,
    /affiliate_revolut_beneficiary_revocations/,
    /child_fact\.event_type in \('refund', 'chargeback'\)/,
  ]) {
    assert.match(lineage, contract);
  }
  assert.doesNotMatch(lineage, /kyc_session\.expires_at/);
  assert.equal(
    (migration.match(/partners_financial_canary_lineage_current\(/g) || [])
      .length >= 4,
    true,
  );
});

test('financial canary delegates only to the owner-only historical payout bodies', () => {
  assert.match(
    createRpc,
    /admin_partners_payout_cycle_create_pre_aal2_20260802\(/,
  );
  assert.match(
    migration,
    /admin_partners_payout_cycle_approve_pre_aal2_20260802\(/,
  );
  assert.match(
    aal2Migration,
    /admin_partners_payout_cycle_create_pre_aal2_20260802\([\s\S]*admin_partners_payout_cycle_approve_pre_aal2_20260802\([\s\S]*from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function\s+affiliate_private\.admin_partners_payout_cycle_(?:create|approve)_pre_aal2_20260802/i,
  );
});

test('financial canary checker cannot be bypassed with a caller-set custom GUC', () => {
  assert.doesNotMatch(
    cycleGuard,
    /current_setting\(\s*'norva\.partners_financial_canary_control'/,
  );
  assert.match(cycleGuard, /run\.state = 'approved'/);
  assert.match(cycleGuard, /run\.approved_at = transaction_timestamp\(\)/);
  assert.match(
    cycleGuard,
    /run\.approved_by_pseudonym =\s*affiliate_private\.partners_admin_actor_pseudonym\(\)/,
  );

  const authorizeIndex = approveRpc.indexOf(
    'update affiliate_private.affiliate_financial_canary_runs',
  );
  const delegateIndex = approveRpc.indexOf(
    'admin_partners_payout_cycle_approve_pre_aal2_20260802(',
  );
  assert.ok(authorizeIndex >= 0, 'checker must consume its private authorization');
  assert.ok(delegateIndex > authorizeIndex, 'authorization must precede delegated approval');
  assert.match(
    approveRpc,
    /partners_financial_canary_lineage_current\(\s*v_run\.id,\s*false\s*\)/,
  );
  assert.match(approveRpc, /v_cycle\.approved_by_pseudonym <> v_actor/);
  assert.match(approveRpc, /v_cycle\.approved_at <> transaction_timestamp\(\)/);
});

test('approval atomically prepares the exact one-item manual batch', () => {
  const approveIndex = approveRpc.indexOf(
    'admin_partners_payout_cycle_approve_pre_aal2_20260802(',
  );
  const prepareIndex = approveRpc.indexOf(
    'admin_partners_revolut_manual_batch_prepare(',
  );
  assert.ok(approveIndex >= 0, 'historical approval must be delegated');
  assert.ok(
    prepareIndex > approveIndex,
    'manual batch preparation must follow approval in the same function',
  );
  assert.match(approveRpc, /v_batch\.status <> 'prepared'/);
  assert.match(approveRpc, /v_batch\.prepared_by_pseudonym is distinct from v_actor/);
  assert.match(approveRpc, /v_batch\.item_count <> 1/);
  assert.match(approveRpc, /v_batch_result ->> 'replayed'\)::boolean is distinct from false/);
  assert.match(approveRpc, /execution\.state = 'prepared'/);
  assert.match(approveRpc, /execution\.prepared_by_pseudonym = v_actor/);
  assert.match(approveRpc, /'batch', v_batch_result -> 'batch'/);
});

test('draft abort is Finance+AAL2, audited and cannot release an allocation', () => {
  assert.match(abortRpc, /partners_require_capability\('finance'\)/);
  assert.match(abortRpc, /partners_require_aal2\(\s*'Partners financial canary abort'/);
  assert.match(abortRpc, /'ABORT_FINANCIAL_CANARY:' \|\| v_cycle_key/);
  const releaseLock = abortRpc.indexOf(
    "hashtextextended('norva:partners:release-control', 0)",
  );
  const runLock = abortRpc.indexOf('select run.*');
  assert.ok(releaseLock >= 0 && runLock > releaseLock);
  assert.match(abortRpc, /v_run\.state = 'draft'/);
  assert.match(abortRpc, /v_cycle\.status = 'draft'/);
  assert.match(abortRpc, /v_item\.allocation_entry_id is null/);
  assert.match(
    abortRpc,
    /update affiliate_private\.affiliate_payout_cycles cycle\s+set status = 'cancelled'/,
  );
  assert.doesNotMatch(abortRpc, /update affiliate_private\.affiliate_payout_items/);
  assert.doesNotMatch(abortRpc, /insert into affiliate_private\.affiliate_commission_(?:entries|postings)/);
  assert.doesNotMatch(abortRpc, /payout_release/);
  assert.match(abortRpc, /'financial_canary_cycle_aborted'/);
  assert.match(abortRpc, /'item_status', 'pending'/);
  assert.match(
    abortRpc,
    /approved financial canary requires normal batch cancellation workflow/,
  );
});

test('draft abort has a strict public wrapper and no implicit service-role grant', () => {
  assert.match(
    migration,
    /public\.admin_partners_financial_canary_cycle_abort\([\s\S]*?security invoker/,
  );
  assert.match(
    migration,
    /revoke all on function\s+affiliate_private\.admin_partners_financial_canary_cycle_abort\(\s*text, text, text\s*\)\s+from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /revoke all on function\s+public\.admin_partners_financial_canary_cycle_abort\(text, text, text\)\s+from public, anon, service_role/,
  );
  assert.match(
    migration,
    /grant execute on function\s+public\.admin_partners_financial_canary_cycle_abort\(text, text, text\)\s+to authenticated/,
  );
});

test('release-control lock serializes every payout cycle and manual batch mutation', () => {
  assert.match(
    migration,
    /create trigger affiliate_payout_cycles_00_financial_canary_exclusivity_guard\s+before insert or update on affiliate_private\.affiliate_payout_cycles/,
  );
  assert.match(
    cycleExclusivityGuard,
    /pg_advisory_xact_lock\(\s*hashtextextended\('norva:partners:release-control', 0\)/,
  );
  assert.match(
    cycleExclusivityGuard,
    /active_run\.state in \('draft', 'approved'\)[\s\S]*linked_run\.cycle_id = new\.id[\s\S]*linked_run\.state in \('draft', 'approved'\)/,
  );
  assert.match(
    migration,
    /revoke all on function\s+affiliate_private\.guard_financial_canary_cycle_exclusivity\(\)\s+from public, anon, authenticated, service_role/,
  );

  const lockIndex = manualBatchGuard.indexOf(
    "hashtextextended('norva:partners:release-control', 0)",
  );
  const lookupIndex = manualBatchGuard.indexOf('select run.*');
  assert.ok(lockIndex >= 0, 'manual batch guard must take release-control');
  assert.ok(
    lookupIndex > lockIndex,
    'manual batch guard must take release-control before reading canary state',
  );
  assert.match(
    manualBatchGuard,
    /active_run\.state in \('draft', 'approved'\)[\s\S]*linked_run\.cycle_id = new\.cycle_id[\s\S]*linked_run\.state in \('draft', 'approved'\)/,
  );
});

test('terminal canary cycles release exclusivity while every nonterminal cycle blocks', () => {
  for (const guard of [cycleExclusivityGuard, manualBatchGuard]) {
    assert.match(
      guard,
      /active_cycle\.status not in \('settled', 'failed', 'cancelled'\)/,
    );
    assert.match(
      guard,
      /linked_cycle\.status not in \('settled', 'failed', 'cancelled'\)/,
    );
    assert.doesNotMatch(
      guard,
      /(?:active_cycle|linked_cycle)\.status not in \([^)]*(?:draft|approved|prepared)/,
    );
    assert.match(guard, /financial canary release control is active/);
  }
});

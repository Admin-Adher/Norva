'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs
  .readFileSync(path.join(root, file), 'utf8')
  .replace(/\r\n/g, '\n');

const migrationPath =
  'supabase/migrations/20260730100300_partners_airwallex_settlement_reconciliation.sql';

test('Airwallex reconciliation stores only append-only minimized evidence, reviews and decisions', () => {
  const sql = read(migrationPath);

  assert.match(
    sql,
    /create table\s+affiliate_private\.affiliate_airwallex_settlement_observations/i,
  );
  assert.match(
    sql,
    /create table affiliate_private\.affiliate_airwallex_settlement_reviews/i,
  );
  assert.match(
    sql,
    /create table affiliate_private\.affiliate_airwallex_settlement_decisions/i,
  );
  assert.match(sql, /provider_reference_hash\s+text not null/i);
  assert.match(sql, /proof_hash\s+text not null unique/i);
  assert.match(
    sql,
    /evidence_source[\s\S]*transaction_reconciliation_report/i,
  );
  assert.match(sql, /amount_minor\s+bigint not null/i);
  assert.match(sql, /currency\s+text not null/i);
  assert.match(sql, /value_date\s+date not null/i);
  assert.doesNotMatch(
    sql,
    /affiliate_airwallex_settlement_(?:observations|reviews|decisions)\s*\([^;]*(?:payload|document|iban|account_number|provider_transfer_id)/i,
  );
  assert.match(
    sql,
    /affiliate_airwallex_settlement_observations_append_only[\s\S]*reject_partners_finance_mutation/i,
  );
  assert.match(
    sql,
    /affiliate_airwallex_settlement_reviews_append_only[\s\S]*reject_partners_finance_mutation/i,
  );
  assert.match(
    sql,
    /affiliate_airwallex_settlement_decisions_append_only[\s\S]*reject_partners_finance_mutation/i,
  );
  assert.match(
    sql,
    /enable row level security[\s\S]*revoke all on table[\s\S]*from public, anon, authenticated, service_role/i,
  );
});

test('service evidence and two distinct human Finance approvals are least-privilege RPCs', () => {
  const sql = read(migrationPath);

  assert.match(
    sql,
    /partners_service_airwallex_settlement_observe\([\s\S]*?security definer/i,
  );
  assert.match(
    sql,
    /admin_partners_airwallex_settlement_review\([\s\S]*?partners_require_capability\('finance'\)/i,
  );
  assert.match(
    sql,
    /admin_partners_airwallex_settlement_decide\([\s\S]*?partners_require_capability\('finance'\)/i,
  );
  assert.equal(
    (
      sql.match(
        /v_actor := affiliate_private\.partners_admin_actor_pseudonym\(\);/g,
      ) || []
    ).length >= 3,
    true,
  );
  assert.match(
    sql,
    /settlement review and decision require distinct Finance actors/i,
  );
  assert.equal(
    (
      sql.match(
        /coalesce\(auth\.jwt\(\) ->> 'aal', ''\) <> 'aal2'/g,
      ) || []
    ).length,
    2,
  );
  assert.match(
    sql,
    /Airwallex settlement mutation requires AAL2/,
  );
  assert.match(
    sql,
    /v_confirmation <> 'REVIEW:' \|\| v_key/i,
  );
  assert.match(
    sql,
    /when v_decision = 'confirmed' then 'CONFIRM:' \|\| v_key[\s\S]*'QUARANTINE:' \|\| v_key/i,
  );
  assert.match(
    sql,
    /v_confirmation <> \(\s*case[\s\S]*?'CONFIRM:' \|\| v_key[\s\S]*?'QUARANTINE:' \|\| v_key[\s\S]*?end\s*\)\s*or length/i,
    'nested CASE remains parenthesized so PL/pgSQL does not consume its THEN as the IF terminator',
  );
  assert.match(
    sql,
    /grant execute on function\s+public\.partners_service_airwallex_settlement_observe\([\s\S]*?\)\s*to service_role;/i,
  );
  assert.match(
    sql,
    /grant execute on function\s+public\.admin_partners_airwallex_settlement_review\([\s\S]*?\)\s*to authenticated;/i,
  );
  assert.match(
    sql,
    /grant execute on function\s+public\.admin_partners_airwallex_settlement_decide\([\s\S]*?\)\s*to authenticated;/i,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function[\s\S]*?\bto\s+(?:anon|public)\s*;/i,
  );
});

test('confirmation is exact-money, idempotent and posts one balanced settlement', () => {
  const sql = read(migrationPath);

  assert.match(
    sql,
    /affiliate_payout_settlement_allocation_once_idx[\s\S]*where entry_kind = 'payout_settlement'/i,
  );
  assert.match(
    sql,
    /v_item\.amount_minor is distinct from v_observation\.amount_minor[\s\S]*v_item\.currency is distinct from v_observation\.currency/i,
  );
  assert.match(
    sql,
    /'partner_payout_clearing',\s*'debit'[\s\S]*'partner_cash_settled',\s*'credit'/i,
  );
  assert.match(
    sql,
    /update affiliate_private\.affiliate_payout_items[\s\S]*status = 'settled'/i,
  );
  assert.match(
    sql,
    /reconciliation_status = 'confirmed',[\s\S]*job_status = 'settled'/i,
  );
  assert.match(
    sql,
    /select count\(\*\)::integer[\s\S]*item\.status <> 'settled'[\s\S]*status = 'settled'/i,
  );
  assert.match(sql, /get diagnostics v_remaining = row_count/i);
  assert.match(sql, /replayed', true/i);
});

test('late provider failure quarantines the projection without rewriting settled money', () => {
  const sql = read(migrationPath);

  assert.match(
    sql,
    /guard_airwallex_post_settlement_dispatch\(\)[\s\S]*post_settlement_exception/i,
  );
  assert.match(
    sql,
    /new\.reconciliation_status := 'exception'[\s\S]*new\.job_status := 'exception'/i,
  );
  assert.match(
    sql,
    /guard_airwallex_settled_payout_item\(\)[\s\S]*settled payout financial fields are immutable/i,
  );
  assert.match(
    sql,
    /guard_airwallex_settled_payout_cycle\(\)[\s\S]*settled payout cycle is immutable/i,
  );
  assert.match(
    sql,
    /new\.status := 'settled'[\s\S]*new\.provider_transfer_hash := old\.provider_transfer_hash/i,
  );
  assert.doesNotMatch(
    sql,
    /post_settlement_exception[\s\S]{0,1000}entry_kind[\s\S]{0,100}payout_settlement/i,
  );
});

test('terminal exceptions stay monotone under every later provider observation', () => {
  const sql = read(migrationPath);

  assert.match(
    sql,
    /if old\.reconciliation_status = 'exception' then[\s\S]*exception payout dispatch identity is immutable/i,
  );
  assert.match(
    sql,
    /if old\.reconciliation_status = 'exception' then[\s\S]*new\.reconciliation_status := 'exception'[\s\S]*new\.job_status := 'exception'/i,
  );
  assert.match(
    sql,
    /new\.last_error_code := coalesce\(\s*old\.last_error_code,\s*'settlement_exception'\s*\)/i,
  );
  assert.match(
    sql,
    /new\.next_attempt_at := greatest\([\s\S]*interval '100 years'/i,
  );
  assert.match(
    sql,
    /decision_evidence\.observation_kind = 'settlement_evidence'[\s\S]*Airwallex settlement decision guards are incomplete/i,
  );
});

test('restore verification covers the full Airwallex reconciliation surface and never prints credentials', () => {
  const verifier = read('ops/hetzner/backup/verify-partners-restore.sql');
  const restore = read('ops/hetzner/scripts/02-restore-hetzner.sh');

  for (const table of [
    'affiliate_airwallex_beneficiary_reservations',
    'affiliate_payout_dispatches',
    'affiliate_payout_provider_events',
    'affiliate_airwallex_settlement_observations',
    'affiliate_airwallex_settlement_reviews',
    'affiliate_airwallex_settlement_decisions',
  ]) {
    assert.match(verifier, new RegExp(`'${table}'`));
  }
  for (const trigger of [
    'affiliate_airwallex_settlement_observations_append_only',
    'affiliate_airwallex_settlement_reviews_append_only',
    'affiliate_airwallex_settlement_decisions_append_only',
    'affiliate_airwallex_settlement_decision_guard',
    'affiliate_payout_settlement_semantics',
    'affiliate_airwallex_post_settlement_dispatch_guard',
    'affiliate_airwallex_settled_payout_item_guard',
    'affiliate_airwallex_settled_payout_cycle_guard',
  ]) {
    assert.match(verifier, new RegExp(`'${trigger}'`));
  }
  assert.match(
    verifier,
    /restored Airwallex reconciliation contains % invalid decisions/,
  );
  assert.match(
    verifier,
    /restored Airwallex reconciliation contains % invalid projections/,
  );
  assert.match(
    verifier,
    /restored Airwallex reconciliation contains % invalid settled cycles/,
  );
  assert.match(
    verifier,
    /restored Airwallex Finance mutations lost the AAL2 step-up/,
  );
  assert.match(
    verifier,
    /quarantined\.decision = 'quarantined'[\s\S]*settlement_quarantined/,
  );
  assert.match(
    verifier,
    /conflicting_evidence\.observation_kind =\s*'settlement_evidence'[\s\S]*settlement_evidence_conflict/,
  );
  assert.match(
    verifier,
    /dispatch\.reconciliation_status = 'exception'[\s\S]*dispatch\.job_status is distinct from 'exception'/,
  );
  assert.match(
    verifier,
    /index_metadata\.indisunique[\s\S]*pg_get_expr\(/,
  );
  assert.match(
    verifier,
    /relation\.relname = v_expected\.table_name[\s\S]*routine\.proname = v_expected\.function_name/,
  );
  assert.doesNotMatch(restore, /echo\s+"[^"]*\$TARGET/);
  assert.doesNotMatch(
    restore,
    /NEXT:[^\n]*postgresql:\/\/postgres:\$\{POSTGRES_PASSWORD\}/,
  );
});

test('pgTAP executes confirmation, competing-writer and late-failure behavior', () => {
  const sql = read('supabase/tests/affiliate_p0.sql');

  assert.match(
    sql,
    /the second distinct AAL2 Finance actor confirms the settlement/,
  );
  assert.match(
    sql,
    /an AAL1 Finance reviewer cannot mutate settlement evidence/,
  );
  assert.match(
    sql,
    /the first AAL2 Finance actor records the explicit evidence review/,
  );
  assert.match(
    sql,
    /an AAL1 Finance decision cannot settle money/,
  );
  assert.match(
    sql,
    /a competing Finance writer serializes behind and cannot double-decide/,
  );
  assert.match(
    sql,
    /a late provider failure becomes an exception instead of reversing settlement/,
  );
  assert.match(
    sql,
    /settled:settled:exception:exception/,
  );
  assert.match(
    sql,
    /a settled payout item rejects a NULL transfer-hash rewrite/,
  );
  assert.match(
    sql,
    /a fresh PAID webhook cannot reopen a quarantined dispatch/,
  );
  assert.match(
    sql,
    /the quarantine projection stays terminal after the later PAID event/,
  );
  assert.match(
    sql,
    /new conflicting report evidence cannot append after quarantine/,
  );
  assert.match(
    sql,
    /a fresh PAID webhook cannot reopen conflicting settlement evidence/,
  );
  assert.match(
    sql,
    /the conflict reason and both immutable facts survive PAID replay/,
  );
  assert.match(
    sql,
    /conflicting evidence remains visible but offers no impossible Finance action/,
  );
  assert.match(
    sql,
    /a stale Finance review cannot overwrite terminal conflict with quarantine/,
  );
});

test('only the automated cron report boundary can ingest provider settlements', () => {
  const edge = read('supabase/functions/norva-partners-payout/index.ts');

  assert.doesNotMatch(edge, /route === "\/settlements\/observe"/);
  assert.doesNotMatch(edge, /handleSettlementObservation/);
  assert.match(edge, /route === "\/cron\/reports"/);
  assert.match(
    edge,
    /handleReportsCron[\s\S]*await requireCron\(req\)[\s\S]*downloadFinancialReportContent[\s\S]*partners_worker_airwallex_report_apply/,
  );
  assert.doesNotMatch(edge, /downloadUrl|client[_-]?url/i);
  assert.doesNotMatch(
    edge,
    /console\.(?:log|error)\([^)]*(?:settlementReference|proofHash|providerTransferId)/,
  );
});

test('Admin settlement queue exposes redacted two-person actions with exact confirmations', () => {
  const admin = read('public/js/pages/AdminPage.js');

  assert.match(admin, /admin_partners_airwallex_settlements/);
  assert.match(admin, /admin_partners_airwallex_settlement_review/);
  assert.match(admin, /admin_partners_airwallex_settlement_decide/);
  assert.match(
    admin,
    /settlement-review[\s\S]*settlement-confirm[\s\S]*settlement-quarantine/,
  );
  assert.match(
    admin,
    /`\$\{operation\}:\$\{observation\}`/,
  );
  assert.match(
    admin,
    /Un second opérateur Finance distinct doit maintenant décider/,
  );
  assert.doesNotMatch(
    admin,
    /partners-admin-settlements[\s\S]{0,3000}(?:providerTransferId|proofHash|settlementReference)/,
  );
});

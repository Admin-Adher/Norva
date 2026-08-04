const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const migration = read('supabase/migrations/20260804160000_partners_privacy_rights_human_review.sql');
const reverificationMigration = read(
  'supabase/migrations/20260804165000_partners_kyc_reverification_override.sql',
);
const api = read('supabase/functions/_shared/partners-api.ts');
const edge = read('supabase/functions/norva-partners/index.ts');
const cloud = read('public/js/cloudApi.js');
const page = read('public/js/pages/PartnersPage.js');
const admin = read('public/js/pages/AdminPage.js');
const privacy = read('public/privacy.html');

test('biometric withdrawal is append-only and guards the canonical v2 prepare RPC', () => {
  assert.match(migration, /create table affiliate_private\.affiliate_biometric_consent_withdrawals/);
  assert.match(migration, /affiliate_biometric_withdrawal_append_only/);
  assert.match(migration, /rename to partners_service_kyc_prepare_v2_pre_withdrawal_20260804/);
  assert.match(migration, /create function affiliate_private\.partners_service_kyc_prepare_v2\([\s\S]*affiliate_biometric_consent_withdrawals/);
  assert.match(migration, /raise exception 'biometric consent was withdrawn'/);
  assert.match(
    migration,
    /partners_service_kyc_session_record_v3_pre_withdrawal_20260804/,
  );
  assert.match(
    migration,
    /norva:partners:biometric-withdraw:[\s\S]*session_disposition'[\s\S]*'withdrawn'/,
  );
  assert.match(
    migration,
    /jsonb_set\([\s\S]*\{kyc,status\}[\s\S]*superseded/,
  );
  assert.match(
    migration,
    /partners_didit_purge_activate_staged\([\s\S]*biometric_consent_withdrawn/,
  );
  assert.match(
    migration,
    /provider_session_hash = v_provider_session_hash[\s\S]{0,180}session_purpose = 'member_kyc'[\s\S]{0,120}source_record_id = v_session_id[\s\S]{0,120}provider_environment = v_provider_environment/,
  );
  assert.match(
    migration,
    /kyc_didit_purge_orphan_dead_lettered[\s\S]*purge_dead_letter[\s\S]*release_blocked/,
  );
});

test('human review grants one private atomic re-verification without widening ordinary limits', () => {
  assert.match(
    reverificationMigration,
    /create table[\s\S]*affiliate_private\.affiliate_kyc_reverification_grants/,
  );
  assert.match(
    reverificationMigration,
    /create unique index affiliate_kyc_reverification_one_available_idx[\s\S]*where consumed_at is null/,
  );
  assert.match(
    reverificationMigration,
    /if tg_op = 'INSERT'[\s\S]*review\.account_id = new\.account_id[\s\S]*review\.reviewed_by_pseudonym = new\.issued_by_pseudonym[\s\S]*before insert or update or delete/,
  );
  assert.match(
    reverificationMigration,
    /partners_require_capability\('risk'\)[\s\S]*partners_require_aal2/,
  );
  assert.match(
    reverificationMigration,
    /resolution = 'reverification_available'[\s\S]*affiliate_kyc_reverification_grants/,
  );
  assert.match(
    reverificationMigration,
    /for update of grant_row[\s\S]*set_config\([\s\S]*reverification_grant_control[\s\S]*update affiliate_private\.affiliate_kyc_reverification_grants/,
  );
  assert.match(
    reverificationMigration,
    /current_setting\([\s\S]{0,120}reverification_grant_control[\s\S]{0,120}is distinct from 'consume'/,
  );
  assert.match(
    reverificationMigration,
    /v_attempt_count >= v_attempt_policy\.max_attempts/,
  );
  assert.match(
    reverificationMigration,
    /v_last_terminal_at[\s\S]*v_attempt_policy\.cooldown_seconds/,
  );
  assert.doesNotMatch(
    reverificationMigration,
    /raise exception 'KYC attempt policy denied this request'/,
  );
  assert.doesNotMatch(
    reverificationMigration,
    /raise exception 'KYC attempt cooldown is active'/,
  );
  assert.match(
    reverificationMigration,
    /partners_service_kyc_prepare_v2_pre_withdrawal_20260804/,
  );
  assert.doesNotMatch(
    reverificationMigration,
    /grant execute on function[\s\S]{0,180}partners_service_kyc_prepare_reverification_once_v2[\s\S]{0,80}service_role/,
  );
});

test('member rights and human-review routes use exact Edge contracts', () => {
  for (const route of ['/kyc/rights', '/kyc/consent/withdraw', '/kyc/reviews']) {
    assert.match(api, new RegExp(route.replaceAll('/', '\\/')));
    assert.match(edge, new RegExp(route.replaceAll('/', '\\/')));
  }
  assert.match(api, /sanitizeKycRightsData/);
  assert.match(api, /sanitizeKycRightsMutationData/);
  assert.match(api, /KYC_HUMAN_REVIEW_REASONS/);
  assert.match(edge, /parseKycHumanReviewInput/);
});

test('the browser validates rights and offers withdrawal plus human review', () => {
  assert.match(cloud, /validatePartnersKycRights/);
  assert.match(cloud, /withdrawConsent: partnersWithdrawBiometricConsent/);
  assert.match(cloud, /requestHumanReview: partnersRequestKycHumanReview/);
  assert.match(page, /Withdraw consent for any new biometric check/);
  assert.match(page, /Request human review/);
  assert.match(page, /NorvaModal\.confirm/);
  assert.doesNotMatch(page, /provider_session_id|provider_payload|identity_document/);
});

test('Admin Risk exposes only the sanitized AAL2 human-review workflow', () => {
  assert.match(migration, /partners_require_capability\('risk'\)/);
  assert.match(migration, /partners_require_aal2\([\s\S]*KYC human-review/);
  assert.match(admin, /id="partners-admin-kyc-human-reviews"/);
  assert.match(admin, /admin_partners_kyc_human_review_queue/);
  assert.match(admin, /admin_partners_kyc_human_review_locator/);
  assert.match(admin, /admin_partners_kyc_human_review_decide/);
  assert.match(admin, /RESOLVE-REVERIFY:/);
  assert.match(admin, /_partnersPickEvidenceHash/);
});

test('Privacy explains mixed Didit roles, transfers, automation and recourse', () => {
  assert.match(privacy, /independent controller for limited security/);
  assert.match(privacy, /standard contractual clauses/);
  assert.match(privacy, /Didit uses automated systems/);
  assert.match(privacy, /request a human review/);
  assert.match(privacy, /does not[\s\S]*predetermine whether any particular data-protection-law provision/);
});

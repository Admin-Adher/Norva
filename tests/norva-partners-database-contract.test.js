const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migrationDir = path.join(root, 'supabase', 'migrations');
const matches = fs.readdirSync(migrationDir)
  .filter((name) => /^\d+_norva_partners_foundation\.sql$/.test(name));

assert.equal(matches.length, 1);

const migration = fs.readFileSync(
  path.join(migrationDir, matches[0]),
  'utf8',
).replace(/\r\n/g, '\n');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing section: ${start}`);
  const to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

const privateTables = [
  'affiliate_program_versions',
  'affiliate_country_policies',
  'affiliate_accounts',
  'affiliate_links',
  'affiliate_pilot_allowlist',
  'affiliate_release_gates',
  'affiliate_events',
];

test('canonical Partners data stays in a locked private schema', () => {
  assert.match(migration, /create schema if not exists affiliate_private/);
  assert.match(
    migration,
    /revoke all on schema affiliate_private from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /revoke all on all tables in schema affiliate_private\s+from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /grant usage on schema affiliate_private to service_role/,
  );

  for (const table of privateTables) {
    assert.match(
      migration,
      new RegExp(`create table affiliate_private\\.${table} \\(`),
    );
    assert.match(
      migration,
      new RegExp(
        `alter table affiliate_private\\.${table}\\s+enable row level security`,
      ),
    );
  }
  assert.doesNotMatch(migration, /create policy/i);
  assert.doesNotMatch(migration, /grant\s+(?:select|insert|update|delete|all)[\s\S]*affiliate_private/i);
});

test('program and account model can represent only individual accounts', () => {
  const program = section(
    migration,
    'create table affiliate_private.affiliate_program_versions (',
    'create unique index affiliate_program_versions_one_active_idx',
  );
  const account = section(
    migration,
    'create table affiliate_private.affiliate_accounts (',
    'create unique index affiliate_accounts_one_open_per_user_idx',
  );

  assert.match(program, /account_type\s+text not null default 'individual'/);
  assert.match(program, /check \(account_type = 'individual'\)/);
  assert.match(account, /account_type\s+text not null default 'individual'/);
  assert.match(account, /check \(account_type = 'individual'\)/);
  assert.match(
    account,
    /user_id\s+uuid references auth\.users\(id\) on delete restrict/,
  );
  assert.match(
    account,
    /status <> 'active'[\s\S]*user_id is not null[\s\S]*verification_status = 'verified'[\s\S]*nullif\(btrim\(verification_provider\), ''\) is not null[\s\S]*nullif\(btrim\(verification_reference\), ''\) is not null[\s\S]*age_verified[\s\S]*contract_status = 'accepted'/,
  );
  assert.match(
    account,
    /terms_version_accepted\s+text,[\s\S]*contract_accepted_at\s+timestamptz,[\s\S]*disclosure_version_accepted\s+text,[\s\S]*disclosure_accepted_at\s+timestamptz/,
  );
  assert.match(
    account,
    /contract_status <> 'accepted'[\s\S]*nullif\(btrim\(terms_version_accepted\), ''\) is not null[\s\S]*contract_accepted_at is not null[\s\S]*nullif\(btrim\(disclosure_version_accepted\), ''\) is not null[\s\S]*disclosure_accepted_at is not null/,
  );
  assert.match(
    account,
    /user_id is not null[\s\S]*status = 'closed'[\s\S]*verification_provider is null[\s\S]*verification_reference is null[\s\S]*not age_verified[\s\S]*not capacity_verified[\s\S]*contract_status <> 'accepted'/,
  );
  assert.match(
    migration,
    /create unique index affiliate_accounts_verification_identity_idx[\s\S]*verification_provider,[\s\S]*verification_reference[\s\S]*where verification_provider is not null[\s\S]*and verification_reference is not null/,
  );
  assert.match(
    account,
    /verification_reference !~ '\[\[:space:\]\[:cntrl:\]\]'/,
  );
  assert.doesNotMatch(migration, /\b(?:kyb|company|corporate|ubo)\b/i);
  assert.doesNotMatch(account, /document|selfie|bank|iban|beneficiary/i);
});

test('version and verification-provider formats match the Edge contract', () => {
  const program = section(
    migration,
    'create table affiliate_private.affiliate_program_versions (',
    'create unique index affiliate_program_versions_one_active_idx',
  );
  const policy = section(
    migration,
    'create table affiliate_private.affiliate_country_policies (',
    'create unique index affiliate_country_policies_scope_idx',
  );
  const account = section(
    migration,
    'create table affiliate_private.affiliate_accounts (',
    'create unique index affiliate_accounts_one_open_per_user_idx',
  );
  const versionPattern = /\^\[a-z0-9\]\[a-z0-9\._-\]\{2,63\}\$/g;

  assert.ok((program.match(versionPattern) || []).length >= 3);
  assert.ok((policy.match(versionPattern) || []).length >= 2);
  assert.ok((account.match(versionPattern) || []).length >= 2);
  assert.match(
    policy,
    /length\(verification_provider\) between 2 and 64[\s\S]*verification_provider ~ '\^\[a-z0-9\]\[a-z0-9\._-\]\+\$'/,
  );
  assert.match(
    policy,
    /not individual_available[\s\S]*verification_provider is not null/,
  );
  assert.match(
    policy,
    /verification_level\s+text not null[\s\S]*default 'identity_age_country_capacity'/,
  );
  assert.match(
    policy,
    /not capacity_required[\s\S]*verification_level = 'identity_age_country_capacity'/,
  );
});

test('program thresholds and jurisdiction codes are structurally validated', () => {
  const thresholdValidator = section(
    migration,
    'create or replace function affiliate_private.valid_payout_thresholds(',
    'create table affiliate_private.affiliate_program_versions (',
  );
  assert.match(thresholdValidator, /\^\[A-Z\]\{3\}\$/);
  assert.match(thresholdValidator, /jsonb_typeof\(v_value\) <> 'number'/);
  assert.match(
    thresholdValidator,
    /select count\(\*\)[\s\S]*from jsonb_each\(p_thresholds\)[\s\S]*> 32/,
  );
  assert.match(thresholdValidator, /\^\[1-9\]\[0-9\]\{0,15\}\$/);
  assert.match(
    thresholdValidator,
    /v_value::text::numeric > 9007199254740991/,
  );

  const currencyValidator = section(
    migration,
    'create or replace function affiliate_private.valid_currency_codes(',
    'create table affiliate_private.affiliate_program_versions (',
  );
  assert.match(currencyValidator, /cardinality\(p_codes\) <= 10/);
  assert.match(currencyValidator, /\^\[A-Z\]\{3\}\$/);
  assert.match(currencyValidator, /count\(distinct c\.code\)/);
  assert.match(
    migration,
    /affiliate_private\.valid_currency_codes\(payout_currencies\)/,
  );
  const coverageValidator = section(
    migration,
    'create or replace function affiliate_private.payout_currencies_covered(',
    'create table affiliate_private.affiliate_program_versions (',
  );
  assert.match(
    coverageValidator,
    /affiliate_private\.valid_payout_thresholds\(p_thresholds\)/,
  );
  assert.match(
    coverageValidator,
    /affiliate_private\.valid_currency_codes\(p_currencies\)/,
  );
  assert.match(coverageValidator, /cardinality\(p_currencies\) > 0/);
  assert.match(
    coverageValidator,
    /not \(p_thresholds \? c\.code\)[\s\S]*\(p_thresholds ->> c\.code\)::numeric <= 0/,
  );
  assert.doesNotMatch(
    migration,
    /insert into affiliate_private\.affiliate_program_versions/,
  );
  assert.doesNotMatch(migration, /norva-partners-p0-draft-1|\{"EUR":1000\}/);

  const subdivisions = migration.match(
    /\^\[A-Z0-9\]\+\(\?:-\[A-Z0-9\]\+\)\*\$/g,
  ) || [];
  assert.ok(subdivisions.length >= 5);
  assert.match(migration, /length\(subdivision_code\) <= 12/);
  assert.match(
    migration,
    /split_part\(subdivision_code, '-', 1\) = country_code/,
  );
  assert.match(
    migration,
    /split_part\(v_subdivision, '-', 1\) <> v_country/,
  );
});

test('account, policy and program transitions are atomic and mutually guarded', () => {
  const accountGuard = section(
    migration,
    'create or replace function affiliate_private.validate_affiliate_account_transition()',
    'create or replace function affiliate_private.validate_affiliate_policy_transition()',
  );
  assert.ok(
    (accountGuard.match(/for share/g) || []).length >= 2,
    'account validation must lock both referenced rows',
  );
  assert.match(
    accountGuard,
    /v_policy\.program_version_id <> new\.program_version_id/,
  );
  assert.match(
    accountGuard,
    /v_policy\.country_code <> new\.country_code/,
  );
  assert.match(
    accountGuard,
    /v_policy\.subdivision_code is not null[\s\S]*v_policy\.subdivision_code is distinct from new\.subdivision_code/,
  );
  assert.match(
    accountGuard,
    /new\.status = 'active'[\s\S]*v_program\.status <> 'active'[\s\S]*v_program\.effective_from > now\(\)[\s\S]*v_policy\.individual_available[\s\S]*affiliate_private\.payout_currencies_covered/,
  );
  assert.match(
    accountGuard,
    /new\.terms_version_accepted is distinct from v_policy\.terms_version[\s\S]*new\.disclosure_version_accepted[\s\S]*is distinct from v_policy\.disclosure_version/,
  );
  assert.match(
    accountGuard,
    /new\.verification_provider[\s\S]*is distinct from v_policy\.verification_provider/,
  );
  assert.match(
    accountGuard,
    /v_policy\.capacity_required[\s\S]*not new\.capacity_verified/,
  );
  assert.match(
    accountGuard,
    /invalid Partners account status transition[\s\S]*closed Partners accounts are terminal/,
  );
  assert.match(
    accountGuard,
    /old\.status = 'closed'[\s\S]*new\.closed_at is distinct from old\.closed_at[\s\S]*Partners account closure timestamp is immutable/,
  );
  assert.match(
    accountGuard,
    /new\.user_pseudonym is distinct from old\.user_pseudonym[\s\S]*Partners account identity is immutable/,
  );
  assert.match(
    accountGuard,
    /new\.user_id is distinct from old\.user_id[\s\S]*closed minimized account/,
  );
  assert.match(
    accountGuard,
    /from auth\.users u[\s\S]*u\.email_confirmed_at is not null[\s\S]*for share[\s\S]*active Partners account requires a confirmed email/,
  );

  const policyGuard = section(
    migration,
    'create or replace function affiliate_private.validate_affiliate_policy_transition()',
    'create or replace function affiliate_private.validate_affiliate_program_transition()',
  );
  assert.match(policyGuard, /from affiliate_private\.affiliate_program_versions[\s\S]*for share/);
  assert.match(
    policyGuard,
    /new\.individual_available[\s\S]*not affiliate_private\.payout_currencies_covered/,
  );
  assert.match(
    policyGuard,
    /cannot change the scope of an assigned Partners policy/,
  );
  assert.match(
    policyGuard,
    /a\.status = 'active'[\s\S]*a\.terms_version_accepted is distinct from new\.terms_version[\s\S]*a\.disclosure_version_accepted[\s\S]*is distinct from new\.disclosure_version/,
  );
  assert.match(
    policyGuard,
    /a\.verification_provider[\s\S]*is distinct from new\.verification_provider/,
  );
  assert.match(
    policyGuard,
    /new\.minimum_age is distinct from old\.minimum_age[\s\S]*new\.capacity_required is distinct from old\.capacity_required[\s\S]*new\.verification_level is distinct from old\.verification_level[\s\S]*new\.verification_provider is distinct from old\.verification_provider[\s\S]*new\.payout_currencies is distinct from old\.payout_currencies[\s\S]*a\.status <> 'closed'[\s\S]*versioned Partners policy requirements require a new policy for assigned accounts/,
  );

  const programGuard = section(
    migration,
    'create or replace function affiliate_private.validate_affiliate_program_transition()',
    'create or replace function affiliate_private.guard_partners_release_contract()',
  );
  assert.match(
    programGuard,
    /cp\.individual_available[\s\S]*not affiliate_private\.payout_currencies_covered/,
  );
  assert.match(
    programGuard,
    /a\.status = 'active'[\s\S]*new\.status <> 'active'[\s\S]*new\.effective_from > now\(\)/,
  );
  assert.match(
    programGuard,
    /invalid Partners program status transition/,
  );
  assert.match(
    programGuard,
    /new\.version_key is distinct from old\.version_key[\s\S]*new\.payout_thresholds is distinct from old\.payout_thresholds[\s\S]*new\.terms_version is distinct from old\.terms_version[\s\S]*new\.disclosure_version is distinct from old\.disclosure_version[\s\S]*new\.effective_from is distinct from old\.effective_from[\s\S]*old\.status <> 'draft'[\s\S]*a\.status <> 'closed'[\s\S]*published or assigned Partners program terms require a new version/,
  );

  const releaseGuard = section(
    migration,
    'create or replace function affiliate_private.guard_partners_release_contract()',
    'create trigger affiliate_accounts_validate_transition',
  );
  assert.match(
    releaseGuard,
    /pg_advisory_xact_lock\([\s\S]*hashtextextended\('norva:partners:release-control', 0\)/,
  );
  assert.match(
    releaseGuard,
    /where f\.key = 'partners_enabled'[\s\S]*if v_partners_enabled then/,
  );
  assert.match(
    releaseGuard,
    /v_count <> 1[\s\S]*disable Partners before invalidating its active program/,
  );
  assert.match(
    releaseGuard,
    /cp\.individual_available[\s\S]*affiliate_private\.payout_currencies_covered[\s\S]*v_count < 1[\s\S]*disable Partners before invalidating its last available policy/,
  );

  for (const trigger of [
    'affiliate_accounts_validate_transition',
    'affiliate_country_policies_validate_transition',
    'affiliate_program_versions_validate_transition',
    'affiliate_country_policies_release_contract',
    'affiliate_program_versions_release_contract',
  ]) {
    assert.match(migration, new RegExp(`create trigger ${trigger}`));
  }
  assert.match(
    migration,
    /create trigger affiliate_country_policies_release_contract[\s\S]*after insert or update or delete[\s\S]*execute function affiliate_private\.guard_partners_release_contract\(\)/,
  );
  assert.match(
    migration,
    /create trigger affiliate_program_versions_release_contract[\s\S]*after insert or update or delete[\s\S]*execute function affiliate_private\.guard_partners_release_contract\(\)/,
  );
});

test('shareable links use high-entropy public codes and deterministic hashes', () => {
  const links = section(
    migration,
    'create table affiliate_private.affiliate_links (',
    'create unique index affiliate_links_one_active_per_account_idx',
  );
  assert.match(links, /extensions\.gen_random_bytes\(24\)/);
  assert.match(links, /translate\([\s\S]*'\+\/'[\s\S]*'-_'/);
  assert.match(links, /public_code\s+text not null unique/);
  assert.match(links, /\^\[A-Za-z0-9_-\]\{32\}\$/);
  assert.match(links, /code_hash\s+text generated always as/);
  assert.match(links, /extensions\.digest\(public_code, 'sha256'\)/);
  assert.doesNotMatch(
    links,
    /public_code\s+[^,\n]*default gen_random_uuid\(\)/,
  );
  assert.match(links, /rotated_from_id[\s\S]*on delete restrict/);
  assert.match(
    links,
    /check \(rotated_from_id is null or rotated_from_id <> id\)/,
  );
  assert.match(
    migration,
    /create unique index affiliate_links_one_successor_per_predecessor_idx[\s\S]*where rotated_from_id is not null/,
  );
});

test('active links require current account evidence and rotations are terminal', () => {
  const linkGuard = section(
    migration,
    'create or replace function affiliate_private.validate_affiliate_link_transition()',
    'create or replace function affiliate_private.guard_affiliate_account_active_links()',
  );
  assert.match(linkGuard, /new Partners links must start active/);
  assert.match(
    linkGuard,
    /Partners links are retained; revoke instead of deleting/,
  );
  assert.match(
    linkGuard,
    /new\.public_code is distinct from old\.public_code[\s\S]*new\.campaign_key is distinct from old\.campaign_key[\s\S]*new\.rotated_from_id is distinct from old\.rotated_from_id[\s\S]*Partners link identity and rotation are immutable/,
  );
  assert.match(
    linkGuard,
    /old\.status = 'revoked'[\s\S]*revoked Partners links are terminal/,
  );
  assert.match(
    linkGuard,
    /from affiliate_private\.affiliate_accounts a[\s\S]*for share/,
  );
  assert.match(
    linkGuard,
    /v_account\.status <> 'active'[\s\S]*v_account\.verification_status <> 'verified'[\s\S]*v_account\.contract_status <> 'accepted'/,
  );
  assert.match(
    linkGuard,
    /from auth\.users u[\s\S]*email_confirmed_at is not null[\s\S]*for share/,
  );
  assert.match(
    linkGuard,
    /active Partners link requires the current P0 program[\s\S]*active Partners link requires current policy evidence/,
  );
  assert.match(
    linkGuard,
    /v_policy\.capacity_required[\s\S]*not v_account\.capacity_verified/,
  );
  assert.match(
    linkGuard,
    /successor\.rotated_from_id = new\.id[\s\S]*rotated Partners link cannot be reactivated/,
  );
  assert.match(
    linkGuard,
    /v_predecessor\.account_id <> new\.account_id[\s\S]*v_predecessor\.status <> 'revoked'[\s\S]*v_predecessor\.created_at >= new\.created_at/,
  );

  const accountLinkGuard = section(
    migration,
    'create or replace function affiliate_private.guard_affiliate_account_active_links()',
    'create or replace function affiliate_private.guard_affiliate_auth_user_transition()',
  );
  assert.match(
    accountLinkGuard,
    /new\.status <> 'active'[\s\S]*l\.status = 'active'[\s\S]*revoke the active Partners link before account downgrade/,
  );

  const authGuard = section(
    migration,
    'create or replace function affiliate_private.guard_affiliate_auth_user_transition()',
    'create trigger affiliate_links_validate_transition',
  );
  assert.match(authGuard, /security definer[\s\S]*set search_path = ''/i);
  assert.match(
    authGuard,
    /tg_op = 'DELETE'[\s\S]*unlink and minimize Partners accounts before deleting the user/,
  );
  assert.match(
    authGuard,
    /new\.email_confirmed_at is null[\s\S]*a\.status = 'active'[\s\S]*active Partners accounts require a confirmed email/,
  );

  for (const trigger of [
    'affiliate_links_validate_transition',
    'affiliate_accounts_active_link_guard',
    'affiliate_auth_users_partners_guard',
  ]) {
    assert.match(migration, new RegExp(`create trigger ${trigger}`));
  }
  assert.match(
    migration,
    /create trigger affiliate_links_validate_transition[\s\S]*before insert or update or delete on affiliate_private\.affiliate_links/,
  );
});

test('affiliate audit is append-only even for privileged callers', () => {
  const events = section(
    migration,
    'create table affiliate_private.affiliate_events (',
    'create index affiliate_events_aggregate_idx',
  );
  assert.match(events, /before_state\s+jsonb not null/);
  assert.match(events, /after_state\s+jsonb not null/);
  assert.match(events, /justification[\s\S]*between 12 and 1000/);

  assert.match(
    migration,
    /create trigger affiliate_events_append_only[\s\S]*before update or delete on affiliate_private\.affiliate_events/,
  );
  assert.match(
    migration,
    /raise exception 'affiliate_events is append-only'/,
  );
});

test('service bootstrap is the sole sanitized read boundary', () => {
  const bootstrap = section(
    migration,
    'create or replace function public.partners_service_bootstrap(',
    'revoke all on function public.partners_service_bootstrap',
  );

  assert.match(
    bootstrap,
    /p_user_id uuid,[\s\S]*p_country_code text default null,[\s\S]*p_subdivision_code text default null/,
  );
  assert.match(bootstrap, /stable[\s\S]*security definer[\s\S]*set search_path = ''/i);
  assert.match(bootstrap, /raise exception 'user not found' using errcode = 'P0002'/);
  assert.match(bootstrap, /'schema_version', 1/);

  for (const key of [
    'flags',
    'visibility',
    'eligibility',
    'program',
    'policy',
    'allowlist',
    'account',
    'version_key',
    'commission_rate_bps',
    'attribution_window_days',
    'maturation_days',
    'payout_thresholds',
    'individual_available',
    'minimum_age',
    'capacity_required',
    'kyc_level',
    'payout_currencies',
    'terms_version',
    'disclosure_version',
    'verification_status',
    'contract_status',
    'link_status',
  ]) {
    assert.match(bootstrap, new RegExp(`'${key}'`), key);
  }

  for (const reason of [
    'disabled',
    'country_required',
    'country_not_supported',
    'subdivision_not_supported',
    'not_allowlisted',
    'account_blocked',
    'account_attention_required',
    'eligible',
    'invite_only',
    'available',
    'existing_account',
  ]) {
    assert.match(bootstrap, new RegExp(`'${reason}'`), reason);
  }

  const bootstrapResponse = section(
    bootstrap,
    'return jsonb_build_object(',
    'end;\n$$;',
  );
  assert.doesNotMatch(
    bootstrapResponse,
    /verification_reference|verification_provider|user_pseudonym|public_code|code_hash|email|phone|document|selfie|iban/i,
  );
  assert.match(
    bootstrap,
    /v_program\.commission_rate_bps <> 2000[\s\S]*v_program\.attribution_window_days <> 30[\s\S]*v_program\.maturation_days <> 45/,
  );
  assert.match(
    bootstrap,
    /v_program_valid := v_program_exists[\s\S]*v_program\.status = 'active'[\s\S]*v_program\.effective_from <= now\(\)[\s\S]*v_program\.effective_until > now\(\)/,
  );
  assert.match(
    bootstrap,
    /v_policy_valid := v_policy_exists[\s\S]*v_program_valid[\s\S]*v_policy\.individual_available[\s\S]*v_policy\.effective_from <= now\(\)[\s\S]*v_policy\.effective_until > now\(\)/,
  );
  assert.match(
    bootstrap,
    /v_policy_valid := v_policy_exists[\s\S]*affiliate_private\.payout_currencies_covered/,
  );
  const policyLookup = section(
    bootstrap,
    'elsif v_program_exists and v_country is not null then',
    'v_policy_exists := found;',
  );
  assert.doesNotMatch(
    policyLookup,
    /effective_from|effective_until/,
    'scope precedence must be resolved before policy effectiveness',
  );
  assert.match(
    policyLookup,
    /cp\.subdivision_code is null[\s\S]*cp\.subdivision_code = v_subdivision[\s\S]*order by[\s\S]*cp\.subdivision_code = v_subdivision[\s\S]*then 0/,
  );
  assert.match(
    bootstrap,
    /v_policy_valid := v_policy_exists[\s\S]*v_policy\.effective_from <= now\(\)[\s\S]*v_policy\.effective_until > now\(\)/,
  );
  assert.match(
    bootstrap,
    /elsif not v_program_valid then[\s\S]*v_eligibility_reason := 'disabled'/,
  );
  assert.match(
    bootstrap,
    /Natural time expiry is an attention state[\s\S]*v_account_evidence_valid :=[\s\S]*v_account\.verification_provider[\s\S]*v_account_attention_required :=[\s\S]*not v_program_valid[\s\S]*not v_policy_valid[\s\S]*not v_account_evidence_valid[\s\S]*elsif v_account_attention_required then[\s\S]*v_eligibility_reason := 'account_attention_required'/,
  );
  assert.match(
    bootstrap,
    /v_account\.age_verified[\s\S]*not v_policy\.capacity_required[\s\S]*v_account\.capacity_verified/,
  );
  assert.doesNotMatch(
    bootstrap,
    /active Partners account contract is inconsistent/,
  );
  assert.match(
    bootstrap,
    /elsif not v_policy_valid then[\s\S]*v_eligibility_reason := 'subdivision_not_supported'[\s\S]*v_eligibility_reason := 'country_not_supported'/,
  );
  assert.match(
    bootstrap,
    /v_policy\.country_code <> v_account\.country_code[\s\S]*v_policy\.subdivision_code <> v_account\.subdivision_code/,
  );
  assert.match(bootstrap, /v_allowlisted_any boolean := false/);
  assert.match(
    bootstrap,
    /v_allowlisted_for_jurisdiction boolean := false/,
  );
  assert.match(
    bootstrap,
    /into v_allowlisted_any[\s\S]*into v_allowlisted_for_jurisdiction/,
  );
  assert.match(
    bootstrap,
    /elsif v_invite_only and not v_allowlisted_any then[\s\S]*v_visibility_reason := 'invite_only'/,
  );
  assert.match(
    bootstrap,
    /elsif v_invite_only and not v_allowlisted_for_jurisdiction then[\s\S]*v_eligibility_reason := 'not_allowlisted'/,
  );
  assert.match(
    bootstrap,
    /'allowlist', jsonb_build_object\([\s\S]*'required', v_invite_only,[\s\S]*'included', v_allowlisted_any/,
  );
  const allowlistResponse = section(
    bootstrapResponse,
    "'allowlist', jsonb_build_object(",
    "'account', jsonb_build_object(",
  );
  assert.doesNotMatch(
    allowlistResponse,
    /country|subdivision|scope/i,
    'allowlist jurisdiction scope must remain private',
  );
  assert.match(
    migration,
    /revoke all on function public\.partners_service_bootstrap\(uuid, text, text\)\s+from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.partners_service_bootstrap\(uuid, text, text\)\s+to service_role/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.partners_service_bootstrap\([^;]+to (?:anon|authenticated)/i,
  );
});

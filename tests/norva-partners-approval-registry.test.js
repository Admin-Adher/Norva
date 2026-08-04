'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs
  .readFileSync(path.join(root, file), 'utf8')
  .replace(/\r\n/g, '\n');

const migration = read(
  'supabase/migrations/20260804083541_partners_approval_registry.sql',
);
const preactivation = read(
  'ops/hetzner/scripts/check-norva-partners-pilot-preactivation.sql',
);
const runbook = read('docs/NORVA-PARTNERS-APPROVAL-REGISTRY.md');

test('approval evidence is private, RLS protected and append-only', () => {
  assert.match(
    migration,
    /create table affiliate_private\.affiliate_approval_packages/i,
  );
  assert.match(
    migration,
    /create table affiliate_private\.affiliate_release_gate_approval_bindings/i,
  );
  assert.match(
    migration,
    /create table affiliate_private\.affiliate_deployment_manifests/i,
  );
  assert.match(
    migration,
    /affiliate_approval_packages\s+enable row level security/i,
  );
  assert.match(
    migration,
    /affiliate_release_gate_approval_bindings\s+enable row level security/i,
  );
  assert.match(
    migration,
    /revoke all on table affiliate_private\.affiliate_approval_packages[\s\S]*from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /raise exception 'Partners approval packages are append-only'/i,
  );
  assert.match(
    migration,
    /raise exception 'Partners deployment manifests are append-only'/i,
  );
  assert.match(
    migration,
    /create trigger affiliate_approval_packages_append_only[\s\S]*before update or delete/i,
  );
});

test('deployment authority is versioned, current and callable only by AAL2 release managers', () => {
  assert.match(
    migration,
    /partners_require_aal2\(\s*'Partners deployment manifest registration'/i,
  );
  assert.match(migration, /partners_is_release_manager\(\)/i);
  assert.match(
    migration,
    /affiliate_deployment_manifest_bindings[\s\S]*deployment_environment[\s\S]*primary key/i,
  );
  assert.match(
    migration,
    /partners_approval_package_is_current\([\s\S]*affiliate_deployment_manifest_bindings[\s\S]*manifest_binding\.deployment_manifest_id = manifest\.id/i,
  );
  assert.match(
    migration,
    /grant execute on function\s+affiliate_private\.admin_partners_deployment_manifest_register\([\s\S]*to authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.admin_partners_deployment_manifest_register\([\s\S]*to authenticated/i,
  );
  assert.match(migration, /deployment_manifest_unchanged/i);
  assert.match(
    migration,
    /document\.value #>> '\{\}' = repeat\('0', 64\)/i,
  );
  assert.match(
    migration,
    /count\(distinct document\.value #>> '\{\}'\)/i,
  );
  assert.match(
    migration,
    /p_document_hashes ->> 'deployment_proof' <> v_deployment_hash/i,
  );
});

test('approval activation reuses capability ownership and live AAL2', () => {
  assert.match(
    migration,
    /partners_require_control_access\(\s*'set_gate',[\s\S]*v_gate,[\s\S]*true/i,
  );
  assert.match(
    migration,
    /partners_require_aal2\(\s*'Partners approval package registration'/i,
  );
  assert.match(
    migration,
    /pg_advisory_xact_lock\([\s\S]*norva:partners:release-control/i,
  );
  assert.match(
    migration,
    /insert into affiliate_private\.affiliate_approval_packages[\s\S]*insert into[\s\S]*affiliate_private\.affiliate_release_gate_approval_bindings[\s\S]*update affiliate_private\.affiliate_release_gates/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.admin_partners_release_gate_approve[\s\S]*to authenticated/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.admin_partners_release_gate_approve[\s\S]*to (?:anon|public|service_role)/i,
  );
});

test('packages seal program, jurisdiction, documents, commit and deployment', () => {
  for (const field of [
    'program_snapshot_sha256',
    'jurisdiction_scope',
    'document_hashes',
    'source_commit_sha',
    'deployment_environment',
    'deployment_key',
    'deployment_evidence_sha256',
    'deployment_manifest_sha256',
    'package_sha256',
    'expires_at',
  ]) {
    assert.match(migration, new RegExp(`\\b${field}\\b`, 'i'));
  }
  assert.match(
    migration,
    /source_commit_sha ~ '\^\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)\$'/i,
  );
  assert.match(
    migration,
    /deployment_environment in \('preproduction', 'production'\)/i,
  );
  assert.match(
    migration,
    /package_version[\s\S]*unique \(gate_key, package_version\)/i,
  );
  assert.match(
    migration,
    /partners_approval_package_sha256\([\s\S]*'approved_by_pseudonym'[\s\S]*'justification'/i,
  );
  assert.match(
    migration,
    /guard_partners_approval_package_insert\(\)[\s\S]*Partners approval package integrity mismatch/i,
  );
  assert.match(
    migration,
    /guard_partners_approval_binding_mutation\(\)[\s\S]*package\.gate_key = new\.gate_key[\s\S]*package\.approved_at = new\.bound_at/i,
  );
  assert.match(
    migration,
    /when 'privacy_approved'[\s\S]*'dpia'[\s\S]*'gdpr_self_assessment'[\s\S]*'biometric_consent'[\s\S]*'records_of_processing'/i,
  );
});

test('gate truth is dynamically bound to current exact evidence', () => {
  assert.match(
    migration,
    /partners_release_gate_approval_is_current\([\s\S]*p_deployment_environment text[\s\S]*package\.deployment_environment = lower/i,
  );
  assert.match(
    migration,
    /partners_release_gate_approval_is_current\(p_gate_key text\)[\s\S]*p_gate_key,[\s\S]*'production'/i,
  );
  assert.match(
    migration,
    /create or replace function affiliate_private\.release_gates_satisfied/i,
  );
  assert.match(
    migration,
    /partners_approval_package_is_current\([\s\S]*requested\.package_id,[\s\S]*requested\.gate_key/i,
  );
  assert.match(
    migration,
    /count\(distinct requested\.program_version_id\)/i,
  );
  assert.match(
    migration,
    /Partners release gate requires a current immutable approval package/i,
  );
  assert.match(
    migration,
    /program activation requires matching approval packages/i,
  );
  assert.match(
    migration,
    /country policy availability requires matching approval packages/i,
  );
  assert.match(
    migration,
    /revoke scoped Partners release gates before changing the (?:program contract|country policy)/i,
  );
  assert.match(
    migration,
    /package\.package_sha256\s*=\s*affiliate_private\.partners_approval_package_sha256\(/i,
  );
  assert.match(
    migration,
    /manifest\.manifest_sha256\s*=\s*affiliate_private\.partners_deployment_manifest_sha256\(/i,
  );
  assert.match(
    migration,
    /package\.document_hashes\s*\?&\s*affiliate_private\.partners_approval_required_document_keys\(/i,
  );
  const countryGuard = migration.match(
    /create or replace function\s+affiliate_private\.guard_partners_country_policy_approved_scope\(\)[\s\S]*?end;\n\$\$;/i,
  )?.[0] || '';
  assert.ok(countryGuard);
  assert.doesNotMatch(countryGuard, /auth\.uid\(\) is not null/i);
  assert.match(
    migration,
    /create or replace function\s+affiliate_private\.partners_assert_didit_certification_pre_gate\(\)[\s\S]*partners_release_gate_approval_is_current\([\s\S]*'privacy_approved',[\s\S]*'preproduction'/i,
  );
  assert.match(
    migration,
    /create or replace function\s+public\.admin_partners_revolut_payout_status\(\)[\s\S]*admin_partners_revolut_payout_status_approval_registry/i,
  );
  assert.match(
    migration,
    /admin_partners_revolut_payout_status_approval_registry\(\)[\s\S]*partners_release_gate_approval_is_current\([\s\S]*'revolut_api_adapter_verified'/i,
  );
});

test('the fifty-member privacy boundary is transactionally enforced', () => {
  assert.match(
    migration,
    /guard_partners_pilot_allowlist_limit\(\)[\s\S]*pg_advisory_xact_lock\([\s\S]*pilot-allowlist-limit/i,
  );
  assert.match(migration, /if v_active_count >= 50/i);
  assert.match(
    migration,
    /create trigger affiliate_pilot_allowlist_limit[\s\S]*before insert or update of user_id, status, expires_at/i,
  );
});

test('Admin provenance is useful but excludes actor and justification', () => {
  assert.match(migration, /'recorded_satisfied', gate\.satisfied/i);
  assert.match(migration, /'approval_status', case/i);
  assert.match(migration, /'approval_provenance', case/i);
  assert.match(migration, /'package_sha256', package\.package_sha256/i);
  assert.match(migration, /'document_keys'/i);
  assert.match(
    migration,
    /create or replace function public\.admin_partners_configuration\(\)[\s\S]*select affiliate_private\.admin_partners_configuration\(\)/i,
  );
  assert.match(
    migration,
    /revoke all on function\s+affiliate_private\.admin_partners_revolut_payout_status\(\)[\s\S]*from public, anon, authenticated, service_role/i,
  );

  const configurationBlock = migration.match(
    /create or replace function affiliate_private\.admin_partners_configuration\(\)[\s\S]*?end;\n\$\$;/i,
  )?.[0] || '';
  assert.ok(configurationBlock);
  assert.doesNotMatch(configurationBlock, /approved_by_pseudonym/i);
  assert.doesNotMatch(configurationBlock, /'justification'/i);
  assert.doesNotMatch(configurationBlock, /policy_snapshot_sha256/i);
});

test('preactivation checks effective packages, not raw gate booleans', () => {
  assert.match(
    preactivation,
    /partners_release_gate_approval_is_current\(\s*expected\.gate_key,[\s\S]*:'deployment_environment'/i,
  );
  assert.match(
    preactivation,
    /gate\.approval_registry_exact_pilot_scope/i,
  );
  assert.match(
    preactivation,
    /partners_approval_package_is_current\(\s*package\.id,[\s\S]*gate\.gate_key,[\s\S]*:'deployment_environment'/i,
  );
  assert.match(preactivation, /package\.source_commit_sha/i);
  assert.match(
    preactivation,
    /package\.source_commit_sha = lower\(:'candidate_commit_sha'\)/i,
  );
  assert.match(preactivation, /package\.deployment_evidence_sha256/i);
  assert.match(preactivation, /package\.jurisdiction_scope/i);
  assert.match(
    preactivation,
    /package\.deployment_environment = :'deployment_environment'/i,
  );
  assert.match(
    preactivation,
    /jsonb_array_length\(package\.jurisdiction_scope\) = 1/i,
  );
});

test('operator documentation forbids treating a template as approval', () => {
  assert.match(runbook, /Le booléen d’une release gate n’est plus une preuve/);
  assert.match(runbook, /ne vaut jamais approbation/);
  assert.match(runbook, /AAL2/);
  assert.match(runbook, /Une expiration[\s\S]*rend immédiatement la gate ineffective/);
  assert.match(runbook, /pseudonymes, justifications[\s\S]*restent privés/);
});

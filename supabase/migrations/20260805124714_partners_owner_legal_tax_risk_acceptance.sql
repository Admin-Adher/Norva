-- A professional opinion remains the preferred evidence. For the explicitly
-- owner-accepted global individual membership with a France-only cash pilot,
-- make the absence of that opinion
-- impossible to hide: the immutable package must also seal the owner's risk
-- acceptance, the deployed disclosure and the conservative tax policy.
create or replace function
affiliate_private.partners_approval_required_document_keys(p_gate_key text)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select array['approval_record', 'deployment_proof']::text[] || case p_gate_key
    when 'membership_privacy_approved' then
      array[
        'membership_privacy_notice',
        'membership_records_of_processing',
        'membership_minimization_review'
      ]
    when 'privacy_approved' then
      array[
        'dpia',
        'gdpr_self_assessment',
        'biometric_consent',
        'privacy_notice',
        'records_of_processing'
      ]
    when 'legal_and_tax_approved' then
      array[
        'legal_tax_review',
        'owner_risk_acceptance',
        'partners_terms',
        'partners_disclosure',
        'tax_operating_policy'
      ]
    when 'individual_verification_coverage_confirmed' then
      array['kyc_certification']
    when 'individual_payout_coverage_confirmed' then
      array['payout_coverage_review']
    when 'country_policy_approved' then
      array['country_policy_review', 'payout_corridor_review']
    when 'financial_data_contract_approved' then
      array['financial_contract_test']
    when 'shadow_reconciliation_clean' then
      array['shadow_reconciliation_report']
    when 'backup_restore_verified' then
      array['restore_rehearsal_proof']
    when 'payout_execution_adapter_verified' then
      array['payout_execution_test']
    when 'manual_payout_workflow_verified' then
      array['manual_payout_runbook_test']
    when 'revolut_api_adapter_verified' then
      array['revolut_api_certification']
    when 'tv_relay_security_verified' then
      array['tv_relay_security_review']
    when 'general_release_approved' then
      array['release_readiness_report']
    else '{}'::text[]
  end;
$$;

revoke all on function
  affiliate_private.partners_approval_required_document_keys(text)
from public, anon, authenticated, service_role;

comment on function
  affiliate_private.partners_approval_required_document_keys(text)
is
  'Fail-closed immutable evidence contract. The France P0 legal gate discloses owner risk acceptance and never impersonates professional advice.';

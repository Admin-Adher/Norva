begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(129);

-- One immutable catalogue keeps existence, ownership, security, volatility
-- and ACL assertions for the current Partners baseline, bounded signed Didit
-- terminal-review recovery and bounded orphan-purge recovery without creating
-- any object in the restored database.
set local norva.partners_restore_expected_routines = '[
  {"signature":"affiliate_private.partners_actor_is_live_admin(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_has_capability(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_can_manage_capabilities()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_is_release_manager()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_require_aal2(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_release_gate_activation_aal2()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_admin_operator_key(uuid)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_capability_operators()","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_capability_set_by_operator_key(text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_capability_set(uuid,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_capability_operators()","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.partners_access_decision_email_enqueue()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.register_member_didit_session()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_didit_certification_session_transition()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_certification_key_hash(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_certification_key(text,uuid)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_certification_public_reason(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_certification_operator_hash()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_require_didit_certification_observer(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_assert_didit_certification_pre_gate()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_require_didit_certification_operator(text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_kyc_certification_preflight()","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_certification_resume()","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_certification_status()","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.partners_service_kyc_certification_create_claim(text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_certification_binding_match(text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"public.admin_partners_kyc_certification_preflight()","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_certification_prepare(text,text,boolean,text,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_certification_resume()","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_certification_status()","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.partners_service_kyc_certification_create_claim(text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_binding_match(text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_session_record(text,text,text,integer,text,text,text,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_webhook_apply(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text)","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.valid_partners_approval_document_hashes(jsonb)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.valid_partners_approval_jurisdiction_scope(jsonb)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_required_document_keys(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_package_sha256(text,integer,text,text,jsonb,jsonb,text,text,text,text,text,text,timestamptz,timestamptz,text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_deployment_manifest_sha256(text,integer,text,text,text,jsonb,text,timestamptz,text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_deployment_manifest_insert()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.reject_partners_deployment_manifest_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_deployment_manifest_binding()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_approval_package_insert()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.reject_partners_approval_package_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_approval_binding_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_program_approval_snapshot_sha256(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_country_policy_approval_snapshot_sha256(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_package_is_current(uuid,text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_package_is_current(uuid,text,text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_release_gate_approval_is_current(text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.release_gates_satisfied(text[])","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_approval_gate_covers_policy(text,uuid,text,text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_deployment_manifest_register(text,text,text,text,jsonb,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamptz,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_release_gate_approve(text,text,jsonb,jsonb,text,text,text,text,timestamptz,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.guard_partners_release_gate_approval()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.clear_partners_release_gate_approval()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_program_approved_scope()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_country_policy_approved_scope()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_pilot_allowlist_limit()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_configuration_pre_approval_registry_20260804()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_configuration()","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_configuration()","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_revolut_payout_status()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_revolut_payout_status_approval_registry()","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_revolut_payout_status()","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"public.partners_service_kyc_session_record_v2(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_didit_purge_managed_mutation()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.mark_member_didit_purge_pending()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.mark_certification_didit_purge_pending()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_account_activation_until_didit_purged()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_didit_purge_activation_audit()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_purge_public_status(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_purge_sync_source(text,text,timestamptz)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_purge_stage_member(text,text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_didit_purge_activate_staged(text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_session_record_v3(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_didit_purge_enqueue(text,text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_certification_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_webhook_apply_and_enqueue_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_certification_webhook_apply_purge(text,text,text,integer,text,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_didit_cert_review_apply_purge(text,text,text,integer,text,timestamptz,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_cert_review_apply_purge(text,text,text,integer,text,timestamptz,timestamptz,integer,text,boolean,boolean,boolean,text,text,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_claim(integer,integer)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_complete(bigint,uuid,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_fail(bigint,uuid,text,integer,boolean,integer)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_heartbeat(text,integer,integer,integer,integer)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_status()","security_definer":true,"volatility":"s","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_orphans(text,integer)","security_definer":true,"volatility":"s","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_didit_purge_recover(text,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_claim(integer,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_complete(bigint,uuid,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_fail(bigint,uuid,text,integer,boolean,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_heartbeat(text,integer,integer,integer,integer)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_status()","security_definer":false,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_orphans(text,integer)","security_definer":false,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_didit_purge_recover(text,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_didit_purge_coverage_ready()","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(uuid,text,text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_session_record_v3_pre_withdrawal_20260804(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_partners_kyc_human_review_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_kyc_rights_snapshot(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_rights_get(uuid)","security_definer":true,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_rights_get(uuid)","security_definer":false,"volatility":"s","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_biometric_consent_withdraw(uuid,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_biometric_consent_withdraw(uuid,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_kyc_human_review_request(uuid,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_kyc_human_review_request(uuid,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)","security_definer":true,"volatility":"s","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_human_review_queue(integer,integer,text)","security_definer":false,"volatility":"s","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_human_review_locator(text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_human_review_locator(text,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.guard_kyc_reverification_grant_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_kyc_prepare_reverification_once_v2(uuid,text,text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_kyc_human_review_decide_pre_reverification_grant_20260804(text,text,text,timestamptz,text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.validate_affiliate_member_transition()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_affiliate_member_active_links()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_affiliate_auth_user_transition()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.validate_affiliate_link_transition()","security_definer":false,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_member_write_reserve(uuid,text,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_account_deletion_ready(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_access_credit_balances(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_fx_source_amount_ceil(bigint,bigint,bigint)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_access_credit_offer(uuid,integer)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_account_balances(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_cash_readiness(uuid)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_access_grants_reconcile(uuid)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.reconcile_access_grants_after_projection()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_access_credit_status(uuid)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_access_credit_quote(uuid,integer,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_access_credit_redeem(uuid,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_bootstrap_v2(uuid)","security_definer":true,"volatility":"s","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_referral_visibility(uuid,integer,text)","security_definer":true,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_referral_visibility(uuid,integer,text)","security_definer":false,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_bootstrap_v2(uuid)","security_definer":false,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_dashboard_v2(uuid,integer,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_join_v2(uuid,boolean,boolean,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_access_credit_quote(uuid,integer,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_access_credit_redeem(uuid,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_access_grants_reconcile(uuid)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_access_credit_status(uuid)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_assert_kyc_cash_eligibility(uuid)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_service_payout_country_bind(uuid,text,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_payout_country_bind(uuid,text,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_rotate_link(uuid,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"public.partners_service_rotate_link(uuid,text)","security_definer":false,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_payout_profile_get(uuid)","security_definer":true,"volatility":"s","access_role":"service_role"},
  {"signature":"public.partners_service_payout_profile_get(uuid)","security_definer":false,"volatility":"s","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.guard_financial_canary_run_mutation()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.partners_financial_canary_authorization_current(text,uuid,text,text)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.partners_financial_canary_lineage_current(uuid,boolean)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"affiliate_private.guard_financial_canary_cycle_exclusivity()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_financial_canary_cycle_approval()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.guard_financial_canary_manual_batch()","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_financial_canary_cycle_create(date,date,text,integer,bigint,text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_financial_canary_cycle_approve(text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_financial_canary_cycle_abort(text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_financial_canary_cycle_create(date,date,text,integer,bigint,text,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_financial_canary_cycle_approve(text,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"public.admin_partners_financial_canary_cycle_abort(text,text,text)","security_definer":false,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)","security_definer":true,"volatility":"v","access_role":"service_role"},
  {"signature":"affiliate_private.is_managed_partners_flag(text)","security_definer":false,"volatility":"i","access_role":"owner"},
  {"signature":"affiliate_private.partners_require_control_access(text,text,boolean)","security_definer":true,"volatility":"s","access_role":"owner"},
  {"signature":"public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)","security_definer":true,"volatility":"v","access_role":"authenticated"},
  {"signature":"affiliate_private.admin_partners_program_activate_pre_aal2_20260802(text,text,text)","security_definer":true,"volatility":"v","access_role":"owner"},
  {"signature":"affiliate_private.admin_partners_program_activate(text,text,text)","security_definer":true,"volatility":"v","access_role":"authenticated"}
]';

select extensions.is(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*)
    from expected
    where to_regprocedure(expected.signature) is not null
  ),
  184::bigint,
  'the restored candidate exposes every baseline and frictionless routine'
);

select extensions.is(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*)
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
    where pg_catalog.pg_get_userbyid(routine.proowner) = current_user
  ),
  184::bigint,
  'every migrated routine retains the controlled migration executor owner'
);

select extensions.ok(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*) = 184
      and count(*) filter (
        where expected.access_role = 'owner'
      ) = 86
      and count(*) filter (
        where expected.access_role = 'authenticated'
      ) = 36
      and bool_and(routine.prosecdef = expected.security_definer)
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
  ),
  'privileged implementations and public invoker shims preserve their security modes'
);

select extensions.ok(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*) = 184
      and bool_and(
        'search_path=""' = any(coalesce(routine.proconfig, '{}'::text[]))
      )
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
  ),
  'every migrated routine pins an empty search_path'
);

select extensions.ok(
  (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select count(*) = 184
      and bool_and(routine.provolatile = expected.volatility::"char")
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
  ),
  'restored authorization reads and mutations retain their reviewed volatility'
);

select extensions.ok(
  regexp_count(
    lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    ))),
    'and attribution\.referred_user_id is not null'
  ) = 3
  and position(
    'where numbered.referred_user_id is not null'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
    )))
  ) = 0,
  'restored referral labels are contiguous across visible accounts only'
);

select extensions.ok(
  not exists (
    with expected as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
    )
    select 1
    from expected
    join pg_catalog.pg_proc routine
      on routine.oid = to_regprocedure(expected.signature)
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) acl
    where acl.grantee = 0
      and acl.privilege_type = 'EXECUTE'
  ),
  'none of the migrated routines inherits PUBLIC execution'
);

with allowed as (
  select *
  from pg_catalog.jsonb_to_recordset(
    current_setting('norva.partners_restore_expected_routines')::jsonb
  ) as routine(
    signature text,
    security_definer boolean,
    volatility text,
    access_role text
  )
  where access_role <> 'owner'
)
select extensions.ok(
  pg_catalog.has_function_privilege(
    allowed.access_role,
    to_regprocedure(allowed.signature),
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    to_regprocedure(allowed.signature),
    'EXECUTE'
  )
  and (
    pg_catalog.has_function_privilege(
      'authenticated',
      to_regprocedure(allowed.signature),
      'EXECUTE'
    ) = (allowed.access_role = 'authenticated')
  )
  and (
    pg_catalog.has_function_privilege(
      'service_role',
      to_regprocedure(allowed.signature),
      'EXECUTE'
    ) = (allowed.access_role = 'service_role')
  ),
  'exact Partners API execution role: ' || allowed.signature
)
from allowed
order by allowed.signature;

select extensions.ok(
  (
    with owner_only as (
      select *
      from pg_catalog.jsonb_to_recordset(
        current_setting('norva.partners_restore_expected_routines')::jsonb
      ) as routine(
        signature text,
        security_definer boolean,
        volatility text,
        access_role text
      )
      where access_role = 'owner'
    )
    select count(*) = 86
      and bool_and(
        not pg_catalog.has_function_privilege(
          'anon',
          to_regprocedure(owner_only.signature),
          'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'authenticated',
          to_regprocedure(owner_only.signature),
          'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'service_role',
          to_regprocedure(owner_only.signature),
          'EXECUTE'
        )
      )
    from owner_only
  ),
  'private predicates, helpers and trigger functions remain owner-only'
);

select extensions.ok(
  position(
    'select affiliate_private.admin_partners_capability_operators()'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'public.admin_partners_capability_operators()'
    )))
  ) > 0
  and position(
    'select affiliate_private.admin_partners_capability_set_by_operator_key('
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'public.admin_partners_capability_set_by_operator_key(text,text,boolean,text)'
    )))
  ) > 0,
  'public capability RPCs remain thin invoker shims over guarded implementations'
);

select extensions.ok(
  position(
    'norva-partners-capability-operator:v1:'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_admin_operator_key(uuid)'
    ))
  ) > 0
  and position(
    '''sha256'''
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_admin_operator_key(uuid)'
    )))
  ) > 0,
  'operator identifiers remain domain-separated opaque SHA-256 keys'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_access_requests'::regclass
      and trigger_row.tgname = 'partners_access_decision_email_enqueue'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.partners_access_decision_email_enqueue()'
      )
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgtype = 17
      and trigger_row.tgattr::text = (
        select attribute_row.attnum::text
        from pg_catalog.pg_attribute attribute_row
        where attribute_row.attrelid = trigger_row.tgrelid
          and attribute_row.attname = 'status'
          and not attribute_row.attisdropped
      )
      and not trigger_row.tgisinternal
  ),
  'the access-decision email trigger is enabled on the restored request table'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_release_gates'::regclass
      and trigger_row.tgname = 'affiliate_release_gates_activation_aal2'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.guard_partners_release_gate_activation_aal2()'
      )
      and trigger_row.tgenabled = 'O'
      and trigger_row.tgtype = 19
      and trigger_row.tgattr::text = (
        select attribute_row.attnum::text
        from pg_catalog.pg_attribute attribute_row
        where attribute_row.attrelid = trigger_row.tgrelid
          and attribute_row.attname = 'satisfied'
          and not attribute_row.attisdropped
      )
      and not trigger_row.tgisinternal
  ),
  'release-gate activation is guarded by the restored before-update AAL2 trigger'
);

select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_access_requests'::regclass
      and trigger_row.tgname = 'partners_access_decision_email_enqueue'
      and position(
        'after update of status'
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
      and position(
        'old.status = ''requested'''
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
      and position(
        'new.status'
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
      and position(
        'approved'
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
      and position(
        'declined'
        in lower(pg_catalog.pg_get_triggerdef(trigger_row.oid))
      ) > 0
  ),
  'only requested-to-final access transitions enqueue a decision email'
);

select extensions.ok(
  position(
    'partners_access_decision:'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0
  and position(
    'norva_enqueue_branded_email'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0
  and position(
    'cloud_branded_email_outbox'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0
  and position(
    'delivery_key = ''norva-branded-'''
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0
  and position(
    'Partners access decision email mismatch'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_decision_email_enqueue()'
    ))
  ) > 0,
  'decision emails retain their transactional dedupe and frozen-envelope checks'
);

select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions session
    where session.status = 'pending'
      and session.provider_environment = 'legacy_unbound'
  ),
  'restored KYC data contains no unprovable pending legacy session'
);

select extensions.ok(
  not exists (
    select entry.id
    from affiliate_private.affiliate_commission_entries entry
    left join affiliate_private.affiliate_commission_postings posting
      on posting.entry_id = entry.id
      and posting.currency = entry.currency
    group by entry.id, entry.amount_minor
    having count(posting.id) < 2
      or coalesce(sum(posting.amount_minor) filter (
        where posting.direction = 'debit'
      ), 0) <> coalesce(sum(posting.amount_minor) filter (
        where posting.direction = 'credit'
      ), 0)
      or coalesce(sum(posting.amount_minor) filter (
        where posting.direction = 'debit'
      ), 0) <> entry.amount_minor
  ),
  'restored commission entries remain fully balanced regardless of row count'
);

select extensions.ok(
  (
    with target as (
      select to_regclass(
        'affiliate_private.affiliate_financial_canary_runs'
      ) as oid
    )
    select target.oid is not null
      and coalesce((
        select relation.relrowsecurity
          and pg_catalog.pg_get_userbyid(relation.relowner) = current_user
        from pg_catalog.pg_class relation
        where relation.oid = target.oid
      ), false)
      and coalesce(not pg_catalog.has_table_privilege(
        'anon', target.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ), false)
      and coalesce(not pg_catalog.has_table_privilege(
        'authenticated', target.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ), false)
      and coalesce(not pg_catalog.has_table_privilege(
        'service_role', target.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ), false)
      and (
        select count(*) = 5
          and bool_and(constraint_row.contype = 'c')
          and bool_and(constraint_row.convalidated)
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid = target.oid
          and constraint_row.conname = any(array[
            'affiliate_financial_canary_runs_key',
            'affiliate_financial_canary_runs_hashes',
            'affiliate_financial_canary_runs_scope',
            'affiliate_financial_canary_runs_actors',
            'affiliate_financial_canary_runs_state'
          ]::text[])
      )
      and (
        select count(*) = 7
          and bool_and(constraint_row.convalidated)
        from pg_catalog.pg_constraint constraint_row
        where constraint_row.conrelid = target.oid
          and constraint_row.contype = 'u'
      )
    from target
  )
  and (
    with expected(
      trigger_name,
      relation_name,
      routine_name,
      trigger_type
    ) as (
      values
        (
          'affiliate_financial_canary_runs_guard',
          'affiliate_financial_canary_runs',
          'guard_financial_canary_run_mutation',
          31::smallint
        ),
        (
          'affiliate_payout_cycles_00_financial_canary_exclusivity_guard',
          'affiliate_payout_cycles',
          'guard_financial_canary_cycle_exclusivity',
          23::smallint
        ),
        (
          'affiliate_payout_cycles_financial_canary_approval_guard',
          'affiliate_payout_cycles',
          'guard_financial_canary_cycle_approval',
          19::smallint
        ),
        (
          'affiliate_revolut_manual_batches_financial_canary_guard',
          'affiliate_revolut_manual_batches',
          'guard_financial_canary_manual_batch',
          7::smallint
        )
    )
    select count(*) = 4
      and bool_and(trigger_row.tgenabled = 'O')
      and bool_and(not trigger_row.tgisinternal)
      and bool_and(trigger_row.tgtype = expected.trigger_type)
      and bool_and(routine_namespace.nspname = 'affiliate_private')
      and bool_and(routine.proname = expected.routine_name)
    from expected
    join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.nspname = 'affiliate_private'
    join pg_catalog.pg_class relation
      on relation.relnamespace = relation_namespace.oid
      and relation.relname = expected.relation_name
    join pg_catalog.pg_trigger trigger_row
      on trigger_row.tgrelid = relation.oid
      and trigger_row.tgname = expected.trigger_name
    join pg_catalog.pg_proc routine
      on routine.oid = trigger_row.tgfoid
    join pg_catalog.pg_namespace routine_namespace
      on routine_namespace.oid = routine.pronamespace
  ),
  'financial canary authorization remains private, one-shot and guarded across payout mutations'
);

select extensions.ok(
  to_regclass('affiliate_private.affiliate_approval_packages') is not null
  and to_regclass(
    'affiliate_private.affiliate_release_gate_approval_bindings'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_deployment_manifests'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_deployment_manifest_bindings'
  ) is not null
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_approval_packages'::regclass
  )
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_release_gate_approval_bindings'::regclass
  )
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_deployment_manifests'::regclass
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_approval_packages',
    'SELECT'
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
        'affiliate_private.affiliate_approval_packages'::regclass
      and constraint_row.conname =
        'affiliate_approval_packages_owner_review_validity'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_approval_packages'::regclass
      and trigger_row.tgname = 'affiliate_approval_packages_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_deployment_manifests'::regclass
      and trigger_row.tgname =
        'affiliate_deployment_manifests_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_pilot_allowlist'::regclass
      and trigger_row.tgname = 'affiliate_pilot_allowlist_limit'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and (
    select count(*)
    from affiliate_private.affiliate_pilot_allowlist allowlist_row
    where allowlist_row.status = 'active'
      and (
        allowlist_row.expires_at is null
        or allowlist_row.expires_at > statement_timestamp()
      )
  ) <= 50,
  'restored manifests, 90-day owner approvals and the transactional pilot cap remain guarded'
);

select extensions.ok(
  regexp_replace(
    lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    )),
    '[[:space:]]+',
    ' ',
    'g'
  ) like
    '%''ready'', coalesce( v_account.member_status = ''active'' and v_credits_enabled, false )%',
  'restored bootstrap emits explicit boolean false for non-member credit readiness'
);

select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_biometric_consent_attestations'
  ) is not null
  and (
    select relation.relrowsecurity
    from pg_catalog.pg_class relation
    where relation.oid =
      'affiliate_private.affiliate_biometric_consent_attestations'::regclass
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_biometric_consent_attestations',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_biometric_consent_attestations',
    'SELECT'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_biometric_consent_attestations'::regclass
      and trigger_row.tgname = 'affiliate_biometric_consent_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and position(
    'partners-biometric-consent-v1'
    in pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(uuid,text,text,text,boolean,text)'
    ))
  ) > 0
  and position(
    'affiliate_biometric_consent_attestations'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2_pre_withdrawal_20260804(uuid,text,text,text,boolean,text)'
    )))
  ) > 0
  and not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_prepare(uuid,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_prepare(uuid,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_session_record(uuid,text,text,text,integer,text,timestamptz,text,text,text,integer)',
    'EXECUTE'
  )
  and (
    select count(*) = 3
      and bool_and(relation.relrowsecurity)
    from unnest(array[
      'affiliate_private.affiliate_biometric_consent_withdrawals',
      'affiliate_private.affiliate_kyc_human_review_requests',
      'affiliate_private.affiliate_kyc_reverification_grants'
    ]) relation_name
    join pg_catalog.pg_class relation
      on relation.oid = to_regclass(relation_name)
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_biometric_consent_withdrawals',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_kyc_human_review_requests',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_kyc_reverification_grants',
    'SELECT'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_biometric_consent_withdrawals'::regclass
      and trigger_row.tgname = 'affiliate_biometric_withdrawal_append_only'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.reject_partners_append_only_mutation()'
      )
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_kyc_reverification_grants'::regclass
      and trigger_row.tgname = 'affiliate_kyc_reverification_grant_guard'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.guard_kyc_reverification_grant_mutation()'
      )
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_kyc_human_review_requests'::regclass
      and trigger_row.tgname = 'affiliate_kyc_human_review_guard'
      and trigger_row.tgfoid = to_regprocedure(
        'affiliate_private.guard_partners_kyc_human_review_mutation()'
      )
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and position(
    'affiliate_biometric_consent_withdrawals'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'
    )))
  ) > 0
  and position(
    'partners_service_kyc_prepare_v2_pre_withdrawal_20260804'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'
    )))
  ) > 0
  and position(
    'partners_require_capability(''risk'')'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.admin_partners_kyc_human_review_queue(integer,integer,text)'
    )))
  ) > 0
  and position(
    'partners_require_aal2'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.admin_partners_kyc_human_review_decide(text,text,text,timestamptz,text,text)'
    )))
  ) > 0
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_prepare_reverification_once_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and position(
    'affiliate_kyc_reverification_grants'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'
    )))
  ) > 0,
  'biometric consent, withdrawal and one-shot human review remain private, guarded and bound to KYC'
);

select extensions.ok(
  (
    select count(*) = 3
      and bool_and(relation.relrowsecurity)
    from unnest(array[
      'affiliate_private.affiliate_didit_purge_outbox',
      'affiliate_private.affiliate_didit_purge_events',
      'affiliate_private.affiliate_didit_purge_worker_state'
    ]) relation_name
    join pg_catalog.pg_class relation
      on relation.oid = to_regclass(relation_name)
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_didit_purge_outbox',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_didit_purge_outbox',
    'SELECT'
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_didit_purge_outbox'::regclass
      and trigger_row.tgname = 'affiliate_didit_purge_outbox_managed'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid =
        'affiliate_private.affiliate_didit_purge_events'::regclass
      and trigger_row.tgname = 'affiliate_didit_purge_events_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_kyc_sessions session
    where session.provider_session_hash is not null
      and session.status <> 'pending'
      and session.provider_purge_status = 'not_required'
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_didit_certification_sessions session
    where session.provider_session_hash is not null
      and session.status in ('approved', 'declined', 'expired', 'quarantined')
      and session.provider_purge_status = 'not_required'
  ),
  'durable provider deletion state remains private, guarded and terminal-session complete'
);

select extensions.ok(
  exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'affiliate_private'
      and column_row.table_name = 'affiliate_didit_certification_events'
      and column_row.column_name = 'provider_delivered_at'
      and column_row.data_type = 'timestamp with time zone'
      and column_row.is_nullable = 'YES'
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_didit_certification_events'::regclass
      and constraint_row.conname =
        'affiliate_didit_certification_events_delivery'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
      and position(
        'provider_delivered_at'
        in pg_catalog.pg_get_constraintdef(constraint_row.oid)
      ) > 0
      and position(
        'provider_event_created_at'
        in pg_catalog.pg_get_constraintdef(constraint_row.oid)
      ) > 0
      and position(
        '00:05:00'
        in pg_catalog.pg_get_constraintdef(constraint_row.oid)
      ) > 0
  ),
  'signed Didit terminal-review delivery time is nullable, bounded and constrained'
);

select extensions.ok(
  position(
    'partners_release_gate_approval_is_current'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_assert_didit_certification_pre_gate()'
    )))
  ) > 0
  and position(
    'and gate.satisfied'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_assert_didit_certification_pre_gate()'
    )))
  ) = 0
  and position(
    'admin_partners_revolut_payout_status_approval_registry'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'public.admin_partners_revolut_payout_status()'
    )))
  ) > 0
  and position(
    'partners_didit_purge_coverage_ready'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_approval_package_is_current(uuid,text,text)'
    )))
  ) > 0,
  'restored Didit, purge and Revolut consumers use effective approval evidence'
);

select extensions.ok(
  (
    with expected(schema_name, relation_name, service_select) as (
      values
        ('affiliate_private', 'affiliate_access_credit_catalog', false),
        ('affiliate_private', 'affiliate_access_credit_quotes', false),
        ('affiliate_private', 'affiliate_access_credit_redemptions', false),
        ('affiliate_private', 'affiliate_web_tax_policies', false),
        ('public', 'cloud_access_grants', true)
    ), inspected as (
      select
        expected.*,
        relation.oid,
        relation.relrowsecurity,
        pg_catalog.pg_get_userbyid(relation.relowner) = current_user
          as owner_matches
      from expected
      left join pg_catalog.pg_namespace namespace
        on namespace.nspname = expected.schema_name
      left join pg_catalog.pg_class relation
        on relation.relnamespace = namespace.oid
        and relation.relname = expected.relation_name
        and relation.relkind in ('r', 'p')
    )
    select count(*) = 5
      and bool_and(oid is not null)
      and bool_and(relrowsecurity)
      and bool_and(owner_matches)
      and bool_and(not pg_catalog.has_table_privilege(
        'anon', oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ))
      and bool_and(not pg_catalog.has_table_privilege(
        'authenticated', oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ))
      and bool_and(
        pg_catalog.has_table_privilege('service_role', oid, 'SELECT')
          = service_select
      )
      and bool_and(not pg_catalog.has_table_privilege(
        'service_role', oid,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      ))
    from inspected
  ),
  'frictionless and tax-policy relations retain owner, RLS and exact API ACLs'
);

select extensions.ok(
  (
    with expected(
      trigger_name,
      relation_schema,
      relation_name,
      routine_name,
      trigger_type
    ) as (
      values
        (
          'affiliate_accounts_member_validate_transition',
          'affiliate_private',
          'affiliate_accounts',
          'validate_affiliate_member_transition',
          23::smallint
        ),
        (
          'affiliate_accounts_member_active_link_guard',
          'affiliate_private',
          'affiliate_accounts',
          'guard_affiliate_member_active_links',
          19::smallint
        ),
        (
          'cloud_entitlement_projection_access_grants_insert',
          'public',
          'cloud_entitlement_projection',
          'reconcile_access_grants_after_projection',
          5::smallint
        ),
        (
          'cloud_entitlement_projection_access_grants_update',
          'public',
          'cloud_entitlement_projection',
          'reconcile_access_grants_after_projection',
          17::smallint
        )
    )
    select count(*) = 4
      and bool_and(trigger_row.oid is not null)
      and bool_and(trigger_row.tgenabled = 'O')
      and bool_and(not trigger_row.tgisinternal)
      and bool_and(trigger_row.tgtype = expected.trigger_type)
      and bool_and(routine_namespace.nspname = 'affiliate_private')
      and bool_and(routine.proname = expected.routine_name)
    from expected
    left join pg_catalog.pg_namespace relation_namespace
      on relation_namespace.nspname = expected.relation_schema
    left join pg_catalog.pg_class relation
      on relation.relnamespace = relation_namespace.oid
      and relation.relname = expected.relation_name
    left join pg_catalog.pg_trigger trigger_row
      on trigger_row.tgrelid = relation.oid
      and trigger_row.tgname = expected.trigger_name
    left join pg_catalog.pg_proc routine
      on routine.oid = trigger_row.tgfoid
    left join pg_catalog.pg_namespace routine_namespace
      on routine_namespace.oid = routine.pronamespace
  ),
  'membership and entitlement projection triggers are restored exactly'
);

select extensions.ok(
  (
    select count(*) = 9
      and bool_and(
        affiliate_private.is_managed_partners_flag(flag.key)
      )
    from public.admin_feature_flags flag
    where flag.key = any(array[
      'partners_enabled',
      'partners_invite_only',
      'partners_cash_pilot_allowlist_only',
      'partners_earnings_enabled',
      'partners_credit_redemptions_enabled',
      'partners_shadow_mode',
      'partners_payouts_live',
      'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    ]::text[])
  )
  and not affiliate_private.is_managed_partners_flag(
    'partners_unreviewed_sentinel'
  )
  and exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key = 'membership_privacy_approved'
  )
  and affiliate_private.partners_approval_required_document_keys(
    'membership_privacy_approved'
  ) = array[
    'approval_record',
    'deployment_proof',
    'membership_privacy_notice',
    'membership_records_of_processing',
    'membership_minimization_review'
  ]::text[]
  and affiliate_private.partners_approval_required_document_keys(
    'legal_and_tax_approved'
  ) = array[
    'approval_record',
    'deployment_proof',
    'legal_tax_review',
    'owner_risk_acceptance',
    'partners_terms',
    'partners_disclosure',
    'tax_operating_policy'
  ]::text[]
  and position(
    'membership_privacy_approved'
    in pg_catalog.pg_get_constraintdef((
      select constraint_row.oid
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conrelid =
        'affiliate_private.affiliate_release_gates'::regclass
        and constraint_row.conname = 'affiliate_release_gates_key'
    ))
  ) > 0,
  'managed flags and both membership and owner-risk approval contracts survive restoration'
);

select extensions.ok(
  position(
    'partners_invite_only'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'
    )))
  ) = 0
  and position(
    'member_status'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'
    )))
  ) > 0
  and position(
    'partners_assert_kyc_cash_eligibility'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'
    )))
  ) > 0
  and position(
    'partners_assert_kyc_cash_eligibility'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'
    )))
  ) > 0
  and position(
    'partners_assert_kyc_cash_eligibility'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'
    )))
  ) > 0
  and position(
    'partners_cash_pilot_allowlist_only'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'
    )))
  ) > 0
  and position(
    'membership_privacy_approved'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.guard_partners_program_approved_scope()'
    )))
  ) > 0
  and position(
    'membership_privacy_approved'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.admin_partners_program_activate_pre_aal2_20260802(text,text,text)'
    )))
  ) > 0
  and position(
    'partners_require_aal2'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.admin_partners_program_activate(text,text,text)'
    )))
  ) > 0
  and position(
    'admin_partners_program_activate_pre_aal2_20260802'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.admin_partners_program_activate(text,text,text)'
    )))
  ) > 0
  and position(
    'cash partners prerequisites are incomplete'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)'
    )))
  ) > 0,
  'membership stays frictionless while every cash entry point remains guarded'
);

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_access_credit_catalog catalog
    where catalog.catalog_key = 'acc_p0_usd_plus_month_v1'
      and catalog.status = 'active'
      and catalog.plan_code = 'plus'
      and catalog.currency = 'USD'
      and catalog.currency_exponent = 2
      and catalog.unit_amount_minor = 499
      and catalog.unit_duration_days = 30
      and catalog.minimum_months = 1
      and catalog.maximum_months = 12
  )
  and exists (
    select 1
    from pg_catalog.pg_index index_row
    where index_row.indexrelid = to_regclass(
      'affiliate_private.affiliate_access_credit_catalog_one_active_idx'
    )
      and index_row.indisunique
      and index_row.indisvalid
      and index_row.indisready
      and pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid
      ) like '%status = ''active''%'
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_commission_entries'::regclass
      and constraint_row.conname = 'affiliate_commission_entries_kind'
      and constraint_row.convalidated
      and pg_catalog.pg_get_constraintdef(constraint_row.oid)
        like '%access_credit_redemption%'
  )
  and exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_commission_postings'::regclass
      and constraint_row.conname = 'affiliate_commission_postings_account'
      and constraint_row.convalidated
      and pg_catalog.pg_get_constraintdef(constraint_row.oid)
        like '%partner_access_credit_clearing%'
  ),
  'the exact P0 USD Plus reference catalogue and multi-currency access-credit ledger contract remain'
);

select extensions.ok(
  exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'affiliate_private'
      and column_row.table_name = 'affiliate_access_credit_quotes'
      and column_row.column_name = 'reference_total_amount_minor'
      and column_row.is_nullable = 'NO'
  )
  and exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'affiliate_private'
      and column_row.table_name = 'affiliate_access_credit_redemptions'
      and column_row.column_name = 'reference_amount_minor'
      and column_row.is_nullable = 'NO'
  )
  and position(
    'ceil('
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_fx_source_amount_ceil(bigint,bigint,bigint)'
    )))
  ) > 0
  and position(
    'affiliate_fx_rate_snapshots'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_access_credit_offer(uuid,integer)'
    )))
  ) > 0
  and position(
    'partners_cash_readiness'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'
    )))
  ) = 0,
  'access credits debit any supported balance through immutable exact FX without a KYC dependency'
);

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_web_tax_policies policy
    where policy.policy_key = 'wtp_fr_usd_owner_v1'
      and policy.status = 'active'
      and policy.country_code = 'FR'
      and policy.currency = 'USD'
      and policy.currency_exponent = 2
      and policy.calculation_mode = 'gross_is_net'
      and policy.tax_rate_bps = 0
      and policy.approved_by_role = 'accountable_owner'
      and not policy.external_review
      and policy.effective_until <= policy.effective_from + interval '90 days'
  )
  and not pg_catalog.has_function_privilege(
    'anon',
    'public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)',
    'EXECUTE'
  )
  and not pg_catalog.has_function_privilege(
    'authenticated',
    'public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)',
    'EXECUTE'
  )
  and pg_catalog.has_function_privilege(
    'service_role',
    'public.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)',
    'EXECUTE'
  )
  and position(
    'financial_fact_unavailable'
    in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
      'affiliate_private.partners_worker_web_tax_resolve(uuid,text,text,text,integer,bigint,text,timestamptz)'
    )))
  ) > 0,
  'Web commissions use a time-bounded owner policy and fail closed without authoritative country or lineage'
);

select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_accounts account
    left join auth.users cloud_user on cloud_user.id = account.user_id
    left join affiliate_private.affiliate_program_versions program
      on program.id = account.member_program_version_id
    where account.member_status = 'active'
      and (
        cloud_user.id is null
        or cloud_user.email_confirmed_at is null
        or program.id is null
        or program.status <> 'active'
        or program.account_type <> 'individual'
        or program.commission_rate_bps <> 2000
        or program.attribution_window_days <> 30
        or program.maturation_days <> 45
        or account.member_terms_version_accepted
          is distinct from program.terms_version
        or account.member_disclosure_version_accepted
          is distinct from program.disclosure_version
      )
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_links link
    join affiliate_private.affiliate_accounts account
      on account.id = link.account_id
    where link.status = 'active'
      and account.member_status <> 'active'
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_access_credit_redemptions redemption
    join affiliate_private.affiliate_access_credit_quotes quote
      on quote.id = redemption.quote_id
    join affiliate_private.affiliate_accounts account
      on account.id = redemption.account_id
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = redemption.ledger_entry_id
    join public.cloud_access_grants grant_row
      on grant_row.redemption_id = redemption.id
    where quote.account_id <> redemption.account_id
      or quote.status <> 'redeemed'
      or quote.currency <> redemption.currency
      or quote.currency_exponent <> redemption.currency_exponent
      or quote.months <> redemption.months
      or quote.total_amount_minor <> redemption.amount_minor
      or quote.reference_currency <> redemption.reference_currency
      or quote.reference_currency_exponent <>
        redemption.reference_currency_exponent
      or quote.reference_total_amount_minor <>
        redemption.reference_amount_minor
      or quote.fx_rate_snapshot_id is distinct from redemption.fx_rate_snapshot_id
      or quote.duration_days <> redemption.duration_days
      or entry.account_id <> redemption.account_id
      or entry.entry_kind <> 'access_credit_redemption'
      or entry.currency <> redemption.currency
      or entry.currency_exponent <> redemption.currency_exponent
      or entry.amount_minor <> redemption.amount_minor
      or grant_row.plan_code <> redemption.plan_code
      or grant_row.duration_seconds <> redemption.duration_days::bigint * 86400
      or grant_row.user_pseudonym <> account.user_pseudonym
      or (
        grant_row.user_id is not null
        and grant_row.user_id is distinct from account.user_id
      )
  ),
  'restored membership, active links and access-credit mappings are coherent at any cardinality'
);

select * from extensions.finish();

rollback;

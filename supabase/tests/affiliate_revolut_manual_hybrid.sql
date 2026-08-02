begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

-- Release posture -----------------------------------------------------------

select extensions.is(
  (
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_revolut_api_enabled'
  ),
  false,
  'Revolut API starts fail-closed'
);
select extensions.is(
  (
    select count(*)::integer
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key in (
      'manual_payout_workflow_verified',
      'revolut_api_adapter_verified'
    )
  ),
  2,
  'manual and API release gates exist'
);
select extensions.is(
  (
    select count(*)::integer
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key in (
      'manual_payout_workflow_verified',
      'revolut_api_adapter_verified'
    )
      and gate.satisfied
  ),
  0,
  'Revolut release gates start unsatisfied'
);
select extensions.ok(
  affiliate_private.is_managed_partners_flag(
    'partners_revolut_api_enabled'
  ),
  'the API kill switch is managed'
);

-- Private evidence surface --------------------------------------------------

select extensions.is(
  (
    select count(*)::integer
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'affiliate_private'
      and relation.relname = any (
        array[
          'affiliate_revolut_reference_allocations',
          'affiliate_revolut_beneficiary_bindings',
          'affiliate_revolut_beneficiary_binding_tickets',
          'affiliate_revolut_beneficiary_revocations',
          'affiliate_revolut_manual_batches',
          'affiliate_revolut_payout_executions',
          'affiliate_revolut_api_worker_lease',
          'affiliate_revolut_payout_events',
          'affiliate_revolut_statement_tickets',
          'affiliate_revolut_statement_imports',
          'affiliate_revolut_statement_rows',
          'affiliate_revolut_manual_reviews',
          'affiliate_revolut_manual_decisions',
          'affiliate_revolut_return_observations',
          'affiliate_revolut_return_reviews',
          'affiliate_revolut_return_decisions',
          'affiliate_revolut_late_completion_observations',
          'affiliate_revolut_late_completion_reviews',
          'affiliate_revolut_late_completion_decisions',
          'affiliate_revolut_manual_cancellations',
          'affiliate_revolut_manual_unmapped_requests',
          'affiliate_revolut_manual_unmapped_releases',
          'affiliate_revolut_reconciliation_incidents',
          'affiliate_revolut_reconciliation_incident_reviews',
          'affiliate_revolut_transaction_aliases',
          'affiliate_revolut_reconciliation_incident_decisions'
        ]::text[]
      )
      and relation.relrowsecurity
  ),
  26,
  'RLS covers every Revolut evidence/control table'
);
select extensions.ok(
  not has_table_privilege(
    'anon',
    'affiliate_private.affiliate_revolut_manual_batches',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'affiliate_private.affiliate_revolut_payout_executions',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'affiliate_private.affiliate_revolut_api_worker_lease',
    'SELECT'
  ),
  'API roles cannot read private payout evidence directly'
);
select extensions.ok(
  not exists (
    select 1
    from pg_catalog.pg_default_acl defaults
    join pg_catalog.pg_namespace namespace
      on namespace.oid = defaults.defaclnamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        defaults.defaclacl,
        pg_catalog.acldefault('f', defaults.defaclrole)
      )
    ) privilege
    where namespace.nspname = 'affiliate_private'
      and defaults.defaclobjtype = 'f'
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'future affiliate_private routines do not inherit PUBLIC execution'
);

-- Exact RPC boundary --------------------------------------------------------

select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_manual_batch_export(text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_partners_revolut_manual_batch_export(text,text,text)',
    'EXECUTE'
  ),
  'only authenticated Finance can enter atomic export'
);
select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_manual_batch_payload(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_manual_batch_mark_exported(text,text,text,text,text)',
    'EXECUTE'
  ),
  'legacy pre-confirm payload and split export confirmation are disabled'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_manual_batch_cancel(text,text,text,timestamp with time zone,text,text)',
    'EXECUTE'
  ),
  'cancellation accepts a timestamped Revolut search proof'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_manual_batch_release_unmapped(text,jsonb,text,timestamp with time zone,text,text)',
    'EXECUTE'
  ),
  'unmapped release accepts a timestamped Revolut search proof'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_manual_controls_queue(integer,integer,text)',
    'EXECUTE'
  ),
  'Finance can read the sanitized maker-checker queue'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_manual_control_reject(text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_partners_revolut_manual_control_reject(text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.admin_partners_revolut_manual_control_reject(text,text,text)',
    'EXECUTE'
  ),
  'only authenticated Finance can reject a pending manual control'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_reconciliation_incident_review(text,text,text,text,timestamp with time zone,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_reconciliation_incidents(integer,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)',
    'EXECUTE'
  ),
  'Finance owns the AAL2 reconciliation incident review boundary'
);
select extensions.ok(
  has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_late_completion_review(text,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_late_completion_decide(text,text,text,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_partners_revolut_late_completion_queue(integer,integer,text)',
    'EXECUTE'
  ),
  'late settlement has review, decision and queue RPCs'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_profile_status(uuid)'::regprocedure
  )) like '%auth.jwt()%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_profile_status(uuid)'::regprocedure
  )) like '%''aal2''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_profile_status(uuid)'::regprocedure
  )) like '%payout profile status requires aal2%',
  'the beneficiary and payout profile read model requires explicit Finance AAL2'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_return_queue(integer,integer,text)'::regprocedure
  )) like '%auth.jwt()%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_return_queue(integer,integer,text)'::regprocedure
  )) like '%''aal2''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_return_queue(integer,integer,text)'::regprocedure
  )) like '%revolut return queue requires aal2%',
  'the returned-payment evidence queue requires explicit Finance AAL2'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_revolut_beneficiary_binding_propose(text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_service_revolut_beneficiary_binding_propose(text,text,text)',
    'EXECUTE'
  )
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_revolut_beneficiary_binding_propose(text,text,text)'::regprocedure
  )) like '%ticket_token_hash%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_revolut_beneficiary_binding_propose(text,text,text)'::regprocedure
  )) like '%mapping_attestation_hmac%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_revolut_beneficiary_binding_propose(text,text,text)'::regprocedure
  )) like '%authorization_ticket_id%',
  'the service proposal consumes the AAL2-minted one-use ticket without exposing it to clients'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'affiliate_private.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)',
    'EXECUTE'
  )
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_statement_ingest(text,date,date,text,jsonb)'::regprocedure
  )) like '%direct statement ingestion is disabled%',
  'the retired direct statement parser stays unreachable'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'affiliate_private.capture_revolut_reconciliation_incident()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.capture_revolut_reconciliation_incident()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'affiliate_private.guard_commission_entry_open_account()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.guard_commission_entry_open_account()',
    'EXECUTE'
  ),
  'private trigger routines have no client execution path'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_revolut_statement_ingest(text,date,date,text,jsonb,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_revolut_statement_ingest(text,date,date,text,jsonb,text,text)',
    'EXECUTE'
  ),
  'statement ingestion uses the signed seven-argument service contract'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'public.partners_service_payout_profile_set(uuid,text,text,text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_payout_profile_set(uuid,text,text,text,text,text)',
    'EXECUTE'
  ),
  'legacy generic payout setup is unreachable; Finance maker-checker owns setup'
);
select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_prepare_account_deletion(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_prepare_account_deletion(uuid)',
    'EXECUTE'
  ),
  'account deletion can only cross its financial-closure boundary'
);
select extensions.ok(
  not has_function_privilege(
    'service_role',
    'affiliate_private.revolut_manual_batch_manifest_hash(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.record_revolut_late_completion_observation(uuid,text,uuid,text,timestamp with time zone)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.refresh_revolut_payout_aggregate(uuid)',
    'EXECUTE'
  ),
  'internal manifest, late-evidence and aggregate helpers are not callable'
);

-- Immutable snapshots and maker-checker evidence ----------------------------

select extensions.ok(
  (
    select count(*) = 4
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'affiliate_private.affiliate_revolut_manual_batches'::regclass
      and attribute.attname in (
        'canonical_manifest_hash',
        'export_file_hash',
        'exported_by_pseudonym',
        'exported_at'
      )
      and not attribute.attisdropped
  ),
  'manual batches retain separate manifest and exact file evidence'
);
select extensions.ok(
  (
    select count(*) = 8
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'affiliate_private.affiliate_revolut_payout_executions'::regclass
      and attribute.attname in (
        'payout_reference',
        'beneficiary_binding_id',
        'beneficiary_binding_version',
        'beneficiary_fingerprint_hmac',
        'beneficiary_fingerprint_key_version',
        'currency_exponent',
        'amount_minor',
        'adapter'
      )
      and not attribute.attisdropped
  ),
  'executions snapshot reference, binding, money and adapter identity'
);
select extensions.ok(
  (
    select count(*) = 4
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'affiliate_private.affiliate_revolut_manual_cancellations'::regclass
      and attribute.attname in (
        'request_search_evidence_hash',
        'request_search_observed_at',
        'approval_search_evidence_hash',
        'approval_search_observed_at'
      )
      and not attribute.attisdropped
  ),
  'cancellations store two independent timestamped searches'
);
select extensions.ok(
  (
    select count(*) = 5
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'affiliate_private.affiliate_revolut_manual_unmapped_requests'::regclass
      and attribute.attname in (
        'references_snapshot',
        'request_search_evidence_hash',
        'request_search_observed_at',
        'approval_search_evidence_hash',
        'approval_search_observed_at'
      )
      and not attribute.attisdropped
  ),
  'unmapped controls retain a sanitized reference snapshot and two searches'
);
select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_revolut_return_observation_incident_idx'
  ) is not null
  and to_regclass(
    'affiliate_private.affiliate_revolut_late_completion_incident_idx'
  ) is not null,
  'return and late completion coalesce cross-channel evidence by incident'
);

-- Function contracts and invariants ----------------------------------------

select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)'::regprocedure
  )) like '%access-export:%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)'::regprocedure
  )) like '%convert_to(v_tsv, ''utf8'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)'::regprocedure
  )) like '%progress_file_hash%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)'::regprocedure
  )) like '%execution set changed during export%',
  'atomic export hashes exact UTF-8 bytes and audits immutable/progress files'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_cancel(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%interval ''7 days''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_cancel(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%distinct, newer exact revolut search%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_cancel(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%approval_search_evidence_hash%',
  'batch cancellation enforces cooldown and independent checker search'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(text,jsonb,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%interval ''7 days''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(text,jsonb,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%distinct, newer exact revolut search%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(text,jsonb,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%references_snapshot%',
  'unmapped release freezes an exact subset through maker-checker approval'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batches(integer,integer,text)'::regprocedure
  )) like '%manual payout batch list requires aal2%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batches(integer,integer,text)'::regprocedure
  )) like '%unmapped_references%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batches(integer,integer,text)'::regprocedure
  )) not like '%beneficiary_token_ref%',
  'batch preview exposes initiation references without beneficiary tokens'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_controls_queue(integer,integer,text)'::regprocedure
  )) like '%maker_search_observed_at%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_controls_queue(integer,integer,text)'::regprocedure
  )) like '%''rejected''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_controls_queue(integer,integer,text)'::regprocedure
  )) not like '%beneficiary_token_ref%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_controls_queue(integer,integer,text)'::regprocedure
  )) not like '%provider_transaction_id%',
  'control queue is token-free and provider-id-free'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_control_reject(text,text,text)'::regprocedure
  )) like '%reject-control:%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_control_reject(text,text,text)'::regprocedure
  )) like '%maker and rejection checker require distinct finance actors%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_control_reject(text,text,text)'::regprocedure
  )) like '%payout-approval-configuration%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_control_reject(text,text,text)'::regprocedure
  )) like '%replayed%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.guard_revolut_manual_cancellation_transition()'::regprocedure
  )) like '%new.status not in (''confirmed'', ''rejected'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.guard_revolut_unmapped_request_transition()'::regprocedure
  )) like '%new.status not in (''confirmed'', ''rejected'')%',
  'pending cancellation and unmapped controls have an audited terminal rejection path'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.guard_payout_profile_binding_and_hold()'::regprocedure
  )) like '%exactly match its verified binding%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.guard_payout_profile_binding_and_hold()'::regprocedure
  )) like '%decision.decision = ''quarantined''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.guard_payout_profile_binding_and_hold()'::regprocedure
  )) like '%new.revolut_binding_id := null%',
  'profile guard blocks token swaps and auto-clears inactive bindings'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_payout_profile_set(uuid,text,text,text,text,text)'::regprocedure
  )) like '%revolut payout profiles require verified beneficiary binding%',
  'generic payout profile setup explicitly rejects Revolut'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.record_revolut_late_completion_observation(uuid,text,uuid,text,timestamp with time zone)'::regprocedure
  )) like '%payout-approval-configuration%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.record_revolut_late_completion_observation(uuid,text,uuid,text,timestamp with time zone)'::regprocedure
  )) like '%where profile.account_id = v_item.account_id%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.record_revolut_late_completion_observation(uuid,text,uuid,text,timestamp with time zone)'::regprocedure
  )) not like '%profile.currency = v_execution.currency%',
  'late completion serializes and freezes every payout profile for the account'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_worker_revolut_payout_observe(text,text,text,text,timestamp with time zone,text,text,bigint)'::regprocedure
  )) like '%revolut_api_late_completion_recorded%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_worker_revolut_payout_observe(text,text,text,text,timestamp with time zone,text,text,bigint)'::regprocedure
  )) like '%record_revolut_late_completion_observation%',
  'API COMPLETED evidence reaches the same late-settlement incident path'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_late_completion_decide(text,text,text,text)'::regprocedure
  )) like '%payout_late_settlement%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_late_completion_decide(text,text,text,text)'::regprocedure
  )) like '%partner_recovery_due%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_late_completion_decide(text,text,text,text)'::regprocedure
  )) like '%partner_cash_settled%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_late_completion_decide(text,text,text,text)'::regprocedure
  )) like '%release checker and late decision require distinct actors%',
  'late confirmation posts one recovery split with independent actors'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_statement_context()'::regprocedure
  )) like '%conflicting currency exponent snapshots%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_statement_context()'::regprocedure
  )) not like '%execution.reconciliation_status in%',
  'statement context includes terminal and released historical executions'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_currency_set(text,integer,text,text)'::regprocedure
  )) like '%currency exponent is immutable after financial history exists%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_currency_set(text,integer,text,text)'::regprocedure
  )) like '%affiliate_revolut_payout_executions%',
  'currency exponents freeze after any financial or execution history'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_prepare_account_deletion(uuid)'::regprocedure
  )) like '%pending_financial_closure%'
  and lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_prepare_account_deletion(uuid)'::regprocedure
  )) like '%execution.payout_item_id = item.id%'
  and lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_prepare_account_deletion(uuid)'::regprocedure
  )) like '%open_execution_count%',
  'account deletion fails closed on that account financial work only'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_commission_reverse(text,text,text)'::regprocedure
  )) like '%manual commission reversal requires aal2%'
  and strpos(
    lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_commission_reverse(text,text,text)'::regprocedure
    )),
    'payout-approval-configuration'
  ) < strpos(
    lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_commission_reverse(text,text,text)'::regprocedure
    )),
    'for update'
  )
  and strpos(
    lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_commission_reverse(text,text,text)'::regprocedure
    )),
    'partners_balance_lock'
  ) < strpos(
    lower(pg_catalog.pg_get_functiondef(
      'affiliate_private.admin_partners_commission_reverse(text,text,text)'::regprocedure
    )),
    'insert into affiliate_private.affiliate_commission_entries'
  )
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_commission_reverse(text,text,text)'::regprocedure
  )) like '%v_account.status = ''closed''%',
  'manual reversals fence account deletion before creating financial entries'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.record_revolut_return_observation(uuid,text,uuid,text,text,timestamp with time zone)'::regprocedure
  )) like '%on conflict do nothing%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.record_revolut_late_completion_observation(uuid,text,uuid,text,timestamp with time zone)'::regprocedure
  )) like '%on conflict do nothing%',
  'cross-channel evidence coalesces instead of violating incident uniqueness'
);

select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)'::regprocedure
  )) like '%manual transfer record must contain only reference%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)'::regprocedure
  )) not like '%v_transfer ? ''provider_transaction_id''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)'::regprocedure
  )) like '%v_resolved_count%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)'::regprocedure
  )) like '%revolut_manual_batch_entry_progressed%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)'::regprocedure
  )) like '%release.entry_kind = ''payout_release''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)'::regprocedure
  )) like '%then ''released''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)'::regprocedure
  )) like '%v_account.status <> ''active''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(text,jsonb,text,text)'::regprocedure
  )) like '%partners_balance_lock%',
  'manual Basic entry is statement-first, overlap-safe and fully audited'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)'::regprocedure
  )) like '%entered_in_revolut%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)'::regprocedure
  )) like '%statement_matched%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_manual_batch_export(text,text,text)'::regprocedure
  )) not like '%provider_transaction_id%',
  'manual export and progress evidence never expose or accept a copied provider id'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_review(text,text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%left(v_incident.source_provider_transaction_hash, 12)%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_review(text,text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%release_after_return requires exact terminal return evidence and cooldown%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_review(text,text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%affiliate_revolut_return_observations%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_review(text,text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%v_search_at < now() - interval ''2 minutes''%',
  'incident maker review uses a UI-safe fingerprint and independent return proof'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%v_checker_decision not in (''approved'', ''quarantined'')%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%when ''approved'' then ''approve''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%v_effective_action = ''quarantine''%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%left(v_incident.source_provider_transaction_hash, 12)%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%checker requires a distinct, newer fresh revolut search%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incident_decide(text,text,text,timestamp with time zone,text,text)'::regprocedure
  )) like '%release_after_return requires exact terminal return evidence and cooldown%',
  'incident checker can approve or quarantine with fresh independent evidence'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)'::regprocedure
  )) not like '%paged.source_state%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)'::regprocedure
  )) like '%paged.source_provider_state%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)'::regprocedure
  )) like '%source_currency_exponent%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)'::regprocedure
  )) like '%expected_currency_exponent%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)'::regprocedure
  )) like '%remap_exact_and_settle%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)'::regprocedure
  )) like '%has_terminal_return_evidence%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_reconciliation_incidents(integer,integer,text)'::regprocedure
  )) like '%authoritative_transaction_fingerprint%',
  'incident queue is actionable, exponent-aware and alias-aware without raw ids'
);
select extensions.is(
  (
    select count(*)::integer
    from pg_catalog.pg_class index_relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = index_relation.relnamespace
    where namespace.nspname = 'affiliate_private'
      and index_relation.relname = any (array[
        'affiliate_revolut_reconciliation_incident_execution_idx',
        'affiliate_revolut_reconciliation_review_target_idx',
        'affiliate_revolut_transaction_alias_incident_idx',
        'affiliate_revolut_reconciliation_decision_history_idx'
      ]::text[])
      and index_relation.relkind = 'i'
  ),
  4,
  'incident foreign-key and history paths remain indexed'
);
select extensions.ok(
  (
    select pg_catalog.pg_get_constraintdef(constraint_info.oid)
      like '%payout_duplicate_settlement%'
    from pg_catalog.pg_constraint constraint_info
    where constraint_info.conrelid =
      'affiliate_private.affiliate_commission_entries'::regclass
      and constraint_info.conname = 'affiliate_commission_entries_kind'
  )
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.record_revolut_late_completion_observation(uuid,text,uuid,text,timestamp with time zone)'::regprocedure
  )) like '%payout_release'', ''payout_settlement%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.record_revolut_late_completion_observation(uuid,text,uuid,text,timestamp with time zone)'::regprocedure
  )) like '%duplicate_completed_after_settlement%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_late_completion_decide(text,text,text,text)'::regprocedure
  )) like '%payout_duplicate_settlement%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.assert_revolut_payout_resolution_semantics()'::regprocedure
  )) like '%payout_duplicate_settlement%',
  'a second exact COMPLETED posts an explicit duplicate-settlement recovery'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_prepare_account_deletion(uuid)'::regprocedure
  )) like '%partner_commission_pending%'
  and lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_prepare_account_deletion(uuid)'::regprocedure
  )) like '%open_commission_job_count%'
  and lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_prepare_account_deletion(uuid)'::regprocedure
  )) like '%open_maturation_job_count%'
  and lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_prepare_account_deletion(uuid)'::regprocedure
  )) like '%open_dispute_won_job_count%'
  and lower(pg_catalog.pg_get_functiondef(
    'public.partners_service_prepare_account_deletion(uuid)'::regprocedure
  )) like '%unresolved_reconciliation_incident_count%',
  'account deletion waits for pending balances, workers and incidents'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_worker_commission_job_complete(text,text,text,text,text)'::regprocedure
  )) like '%payout-approval-configuration%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_worker_commission_job_complete(text,text,text,text,text)'::regprocedure
  )) like '%closed partner account cannot receive ledger writes%'
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_worker_commission_job_complete_pre_financial_fence(text,text,text,text,text)',
    'EXECUTE'
  ),
  'commission worker completion shares the account-close financial fence'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_ops_alert_snapshot()'::regprocedure
  )) like '%revolut_manual_action_required%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_ops_alert_snapshot()'::regprocedure
  )) like '%worker_item ->> ''worker'' <> ''payout''%',
  'manual mode filters inactive payout worker heartbeats'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_payout_status()'::regprocedure
  )) like '%api_adapter_verified%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_payout_status()'::regprocedure
  )) like '%manual_statement_pending%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_payout_status()'::regprocedure
  )) like '%statement_matched_review_pending%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_payout_status()'::regprocedure
  )) like '%review.target_execution_id = execution.id%'
  and lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.admin_partners_revolut_payout_status()'::regprocedure
  )) like '%decision.action <> ''quarantine''%',
  'payout status separates the API gate and manual pending stages without incident double counting'
);
select extensions.ok(
  lower(pg_catalog.pg_get_functiondef(
    'affiliate_private.partners_service_revolut_beneficiary_binding_propose(text,text,text)'::regprocedure
  )) not like '%v_cycle.id%',
  'beneficiary proposal has no undeclared payout-cycle dependency'
);

select * from extensions.finish();
rollback;

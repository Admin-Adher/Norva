begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(79);

select extensions.has_column(
  'affiliate_private',
  'affiliate_accounts',
  'member_status',
  'membership has a lifecycle independent from legacy KYC/cash status'
);

select extensions.ok(
  (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_accounts'::regclass
      and constraint_row.conname = 'affiliate_accounts_member_status'
  ) like '%not_joined%active%held%suspended%closed%',
  'membership status has the exact fail-closed lifecycle'
);

select extensions.ok(
  (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_accounts'::regclass
      and constraint_row.conname =
        'affiliate_accounts_member_active_consistency'
  ) like '%member_program_version_id IS NOT NULL%'
  and (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_accounts'::regclass
      and constraint_row.conname =
        'affiliate_accounts_member_active_consistency'
  ) like '%member_terms_accepted_at IS NOT NULL%'
  and (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_accounts'::regclass
      and constraint_row.conname =
        'affiliate_accounts_member_active_consistency'
  ) like '%member_disclosure_accepted_at IS NOT NULL%',
  'active membership requires complete server-versioned consent evidence'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_join_v2(uuid,boolean,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_join_v2(uuid,boolean,boolean,text)',
    'EXECUTE'
  )
  and not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'public.partners_service_join_v2(uuid,boolean,boolean,text)'::regprocedure
  ),
  'join is confined to the service-role Edge boundary and public shim is invoker'
);

select extensions.ok(
  position(
    'email_confirmed_at is not null'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'::regprocedure
    ))
  ) > 0
  and position(
    'program.terms_version'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'::regprocedure
    ))
  ) > 0
  and position(
    'program.disclosure_version'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'::regprocedure
    ))
  ) > 0
  and position(
    'country_code'
    in lower(pg_get_function_arguments(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'::regprocedure
    ))
  ) = 0,
  'join requires a confirmed user, derives document versions and requests no country'
);

select extensions.ok(
  position(
    'v_account.member_status <> ''active'''
    in lower(pg_get_functiondef(
      'affiliate_private.validate_affiliate_link_transition()'::regprocedure
    ))
  ) > 0
  and position(
    'verification_status'
    in lower(pg_get_functiondef(
      'affiliate_private.validate_affiliate_link_transition()'::regprocedure
    ))
  ) = 0
  and not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_accounts'::regclass
      and trigger_row.tgname = 'affiliate_accounts_active_link_guard'
      and not trigger_row.tgisinternal
  )
  and exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_accounts'::regclass
      and trigger_row.tgname = 'affiliate_accounts_member_active_link_guard'
      and not trigger_row.tgisinternal
  ),
  'an active sharing link depends on membership and never on KYC'
);

select extensions.ok(
  position(
    'a.member_status = ''active'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_referral_resolve(text,text,timestamptz,text,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    'v_account.member_program_version_id'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_referral_resolve(text,text,timestamptz,text,text,text)'::regprocedure
    ))
  ) > 0,
  'referral resolution uses frictionless membership and its program snapshot'
);

select extensions.ok(
  position(
    'v_referrer.member_status <> ''active'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_referral_claim(uuid,text,text)'::regprocedure
    ))
  ) > 0,
  'referral attribution remains available before KYC'
);

select extensions.ok(
  position(
    'v_account.member_status = ''active'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_financial_fact_ingest(text,text,text,text,uuid,text,text,text,text,integer,bigint,bigint,bigint,bigint,timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    'partners_earnings_enabled'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_financial_fact_ingest(text,text,text,text,uuid,text,text,text,text,integer,bigint,bigint,bigint,bigint,timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    'partners_shadow_mode'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_financial_fact_ingest(text,text,text,text,uuid,text,text,text,text,integer,bigint,bigint,bigint,bigint,timestamptz)'::regprocedure
    ))
  ) = 0
  and position(
    'partners_payouts_live'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_financial_fact_ingest(text,text,text,text,uuid,text,text,text,text,integer,bigint,bigint,bigint,bigint,timestamptz)'::regprocedure
    ))
  ) = 0
  and position(
    'partner_commission_pending'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_commission_job_complete_pre_financial_fence(text,text,text,text,text)'::regprocedure
    ))
  ) > 0,
  'new production facts create immediate pending earnings behind their own flag'
);

select extensions.ok(
  position(
    'v_program.maturation_days <> 45'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_commission_job_complete_pre_financial_fence(text,text,text,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    'make_interval(days => v_program.maturation_days)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_commission_job_complete_pre_financial_fence(text,text,text,text,text)'::regprocedure
    ))
  ) > 0,
  'commission accruals mature at the immutable P0 J+45 delay'
);

select extensions.ok(
  position(
    'v_account.member_status <> ''active'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_maturation_complete(text,text,text,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    'partner_commission_available'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_worker_maturation_complete(text,text,text,text,text)'::regprocedure
    ))
  ) > 0,
  'J+45 release checks membership rather than KYC and credits available balance'
);

select extensions.ok(
  position(
    'p_account.verification_status = ''verified'''
    in lower(pg_get_functiondef(
      (
        select routine.oid
        from pg_proc routine
        join pg_namespace namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = 'affiliate_private'
          and routine.proname = 'partners_payout_account_evidence_is_current'
      )
    ))
  ) > 0
  and position(
    'p_account.status = ''active'''
    in lower(pg_get_functiondef(
      (
        select routine.oid
        from pg_proc routine
        join pg_namespace namespace on namespace.oid = routine.pronamespace
        where namespace.nspname = 'affiliate_private'
          and routine.proname = 'partners_payout_account_evidence_is_current'
      )
    ))
  ) > 0,
  'cash readiness preserves legacy active status and verified KYC evidence'
);

select extensions.is(
  (
    select count(*)
    from public.admin_feature_flags flag
    where flag.key in (
      'partners_earnings_enabled',
      'partners_credit_redemptions_enabled'
    )
      and not flag.enabled
  ),
  2::bigint,
  'earnings and access conversion have independent default-off kill switches'
);

select extensions.has_table(
  'affiliate_private',
  'affiliate_access_credit_catalog',
  'the authoritative access-credit catalog exists'
);

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_access_credit_catalog catalog
    where catalog.status = 'active'
      and catalog.catalog_key = 'acc_p0_usd_plus_month_v1'
      and catalog.plan_code = 'plus'
      and catalog.currency = 'USD'
      and catalog.currency_exponent = 2
      and catalog.unit_amount_minor = 499
      and catalog.unit_duration_days = 30
      and catalog.minimum_months = 1
      and catalog.maximum_months = 12
  ),
  'P0 maps the canonical USD 4.99 price to Plus, never to Family'
);

select extensions.ok(
  to_regclass(
    'affiliate_private.affiliate_access_credit_quotes'
  ) is not null
  and (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_access_credit_quotes'::regclass
      and constraint_row.conname = 'affiliate_access_credit_quotes_amounts'
  ) like '%reference_total_amount_minor = (reference_unit_amount_minor * months)%'
  and (
    select position(
      '00:20:00'
      in pg_get_constraintdef(constraint_row.oid)
    ) > 0
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_access_credit_quotes'::regclass
      and constraint_row.conname = 'affiliate_access_credit_quotes_expiry'
  ),
  'quotes bind server price, duration and a short maximum expiry'
);

select extensions.has_table(
  'affiliate_private',
  'affiliate_access_credit_redemptions',
  'exactly-once access-credit redemptions are retained privately'
);

select extensions.ok(
  to_regclass('public.cloud_access_grants') is not null
  and (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid = 'public.cloud_access_grants'::regclass
  )
  and not has_table_privilege(
    'authenticated', 'public.cloud_access_grants', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.cloud_access_grants', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'public.cloud_access_grants', 'INSERT'
  ),
  'the additive grant overlay is RLS-protected behind narrow mutations'
);

select extensions.ok(
  exists (
    select 1
    from pg_index index_row
    where index_row.indexrelid = to_regclass(
      'public.cloud_access_grants_one_active_per_user_idx'
    )
      and index_row.indisunique
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        like '%status = ''active''%'
  ),
  'at most one access-credit grant can run per user'
);

select extensions.ok(
  position(
    'cloud_entitlement_projection'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'update public.cloud_entitlement_projection'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) = 0
  and position(
    '''revoked'', ''refunded'', ''fraud'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''paused_provider'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'projection.fail_open_until'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'projection.last_verified_at'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''grace'', ''past_due'', ''unknown'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0,
  'grant reconciliation mirrors provider grace evidence without overwriting it'
);

select extensions.ok(
  (
    select count(*) = 2
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'public.cloud_entitlement_projection'::regclass
      and not trigger_row.tgisinternal
      and trigger_row.tgname in (
        'cloud_entitlement_projection_access_grants_insert',
        'cloud_entitlement_projection_access_grants_update'
      )
      and trigger_row.tgenabled <> 'D'
  )
  and position(
    'partners_service_access_grants_reconcile'
    in lower(pg_get_functiondef(
      'affiliate_private.reconcile_access_grants_after_projection()'::regprocedure
    ))
  ) > 0
  and position(
    'if exists ('
    in lower(pg_get_functiondef(
      'affiliate_private.reconcile_access_grants_after_projection()'::regprocedure
    ))
  ) = 0
  and position(
    '''norva:access-grants:user:'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) < position(
    'from public.cloud_entitlement_projection projection'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  )
  and position(
    'for share'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) = 0
  and position(
    'update public.cloud_entitlement_projection'
    in lower(pg_get_functiondef(
      'affiliate_private.reconcile_access_grants_after_projection()'::regprocedure
    ))
  ) = 0,
  'provider projection changes always serialize without a reverse projection row lock'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_access_credit_quote(uuid,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_access_credit_quote(uuid,integer,text)',
    'EXECUTE'
  ),
  'quote creation is confined to the service-role Edge boundary'
);

select extensions.ok(
  position(
    'catalog.unit_amount_minor * p_months'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'::regprocedure
    ))
  ) > 0
  and pg_get_function_arguments(
    'affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'::regprocedure
  ) not like '%amount%'
  and pg_get_function_arguments(
    'affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'::regprocedure
  ) not like '%currency%',
  'clients choose only months; price and USD currency are server-authoritative'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_access_credit_redeem(uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_access_credit_redeem(uuid,text,text)',
    'EXECUTE'
  ),
  'redemption is confined to the service-role Edge boundary'
);

select extensions.ok(
  position(
    'partners_balance_lock(v_account.id, v_quote.currency)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''norva:partners:user:'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) < position(
    'partners_balance_lock(v_account.id, v_quote.currency)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  )
  and position(
    'partners_balance_lock(v_account.id, v_quote.currency)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) < position(
    'partners_service_access_grants_reconcile('
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  )
  and lower(pg_get_functiondef(
    'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
  )) ~ '''partner_commission_available''[[:space:]]*,[[:space:]]*''debit'''
  and lower(pg_get_functiondef(
    'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
  )) ~ '''partner_access_credit_clearing''[[:space:]]*,[[:space:]]*''credit''',
  'redemption atomically spends the quoted source-currency balance under the canonical balance lock'
);

select extensions.ok(
  position(
    'partners_balance_lock'
    in lower(pg_get_functiondef(
      'affiliate_private.guard_commission_entry_open_account()'::regprocedure
    ))
  ) > 0
  and exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'affiliate_private.affiliate_commission_entries'::regclass
      and trigger_row.tgname =
        'affiliate_commission_entries_open_account_guard'
      and not trigger_row.tgisinternal
  ),
  'conversion and payout ledger writes serialize through the same balance lock'
);

select extensions.ok(
  (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_commission_entries'::regclass
      and constraint_row.conname = 'affiliate_commission_entries_kind'
  ) like '%access_credit_redemption%'
  and (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_commission_postings'::regclass
      and constraint_row.conname = 'affiliate_commission_postings_account'
  ) like '%partner_access_credit_clearing%',
  'access conversion is represented by balanced immutable ledger vocabulary'
);

select extensions.ok(
  not exists (
    select 1
    from unnest(array[
      'application',
      'terms_acceptance',
      'link_rotation',
      'kyc_prepare',
      'kyc_session_record',
      'referral_claim',
      'payout_profile',
      'tv_relay_consume',
      'access_request',
      'fiscal_profile_self_attestation',
      'payout_onboarding',
      'membership_join',
      'access_credit_quote',
      'access_credit_redeem'
    ]::text[]) expected(operation)
    where (
      select pg_get_constraintdef(constraint_row.oid)
      from pg_constraint constraint_row
      where constraint_row.conrelid =
        'affiliate_private.affiliate_service_idempotency'::regclass
        and constraint_row.conname =
          'affiliate_service_idempotency_operation'
    ) not like '%' || expected.operation || '%'
  )
  and exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_access_credit_redemptions'::regclass
      and constraint_row.contype = 'u'
      and pg_get_constraintdef(constraint_row.oid) like '%quote_id%'
  ),
  'legacy and frictionless mutations remain idempotent and each quote spends once'
);

select extensions.ok(
  position(
    '''partner_commission_pending'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_route_commission_recovery(uuid,uuid,text,bigint,boolean)'::regprocedure
    ))
  ) > 0
  and position(
    '''partner_commission_available'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_route_commission_recovery(uuid,uuid,text,bigint,boolean)'::regprocedure
    ))
  ) > 0
  and position(
    '''partner_recovery_due'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_route_commission_recovery(uuid,uuid,text,bigint,boolean)'::regprocedure
    ))
  ) > 0
  and position(
    'cloud_access_grants'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_route_commission_recovery(uuid,uuid,text,bigint,boolean)'::regprocedure
    ))
  ) = 0,
  'refunds and chargebacks reverse pending/available or create recovery debt without corrupting grants'
);

select extensions.ok(
  position(
    '''action'', ''membership_joined'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''action'', ''access_credit_quoted'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''action'', ''access_credit_redeemed'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) > 0,
  'RPC responses expose stable versioned action contracts'
);

select extensions.ok(
  position(
    'verification_status'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) = 0
  and position(
    'affiliate_fiscal_profiles'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) = 0
  and position(
    'affiliate_payout_provider_configs'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) = 0,
  'non-cash conversion has no KYC, fiscal or corridor dependency'
);

select extensions.ok(
  position(
    '''provider'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''overlay'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''queued_grants'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_grants_reconcile(uuid)'::regprocedure
    ))
  ) > 0,
  'overlay reconciliation exposes the exact provider and queue state contract'
);

select extensions.ok(
  position(
    '''balance'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_status(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''catalog'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_status(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''cash_readiness'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_status(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'partners_cash_readiness'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'::regprocedure
    ))
  ) > 0
  and position(
    'partners_cash_readiness'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_status(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'partners_cash_readiness'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) > 0
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_cash_readiness(uuid)',
    'EXECUTE'
  ),
  'join, bootstrap and status share one private cash-readiness reason matrix'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_bootstrap_v2(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.partners_service_dashboard_v2(uuid,integer,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_bootstrap_v2(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_dashboard_v2(uuid,integer,text,text)',
    'EXECUTE'
  )
  and not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'public.partners_service_bootstrap_v2(uuid)'::regprocedure
  )
  and not (
    select routine.prosecdef
    from pg_proc routine
    where routine.oid =
      'public.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
  ),
  'bootstrap and dashboard v2 remain service-role-only invoker shims'
);

select extensions.ok(
  position(
    '''schema_version'', 2'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''partners_enabled'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''partners_earnings_enabled'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''partners_credit_redemptions_enabled'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''partners_payouts_live'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'country'
    in lower(pg_get_function_arguments(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) = 0,
  'bootstrap v2 exposes exact release controls without requesting country'
);

select extensions.ok(
  position(
    '''schema_version'', 2'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''balances'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''next_maturation_at'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''credit_readiness'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''cash_readiness'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''occurred_at'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''matures_at'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''pending'', ''available'', ''redeemed'', ''paid'', ''reversed'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    'partners_account_balances(v_account.id)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    'order by balance.currency'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_account_balances(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''fx_rate_unavailable'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_status(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''balances'', ''[]''::jsonb'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_dashboard_v2(uuid,integer,text,text)'::regprocedure
    ))
  ) > 0,
  'dashboard v2 publishes sorted real-currency balances, readiness and history'
);

select extensions.ok(
  position(
    'errcode = ''p1001'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'::regprocedure
    ))
  ) > 0
  and position(
    'errcode = ''p1002'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'::regprocedure
    ))
  ) > 0
  and position(
    'errcode = ''p1005'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'::regprocedure
    ))
  ) > 0
  and position(
    'errcode = ''p1008'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_quote(uuid,integer,text)'::regprocedure
    ))
  ) > 0
  and position(
    'errcode = ''p1003'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    'errcode = ''p1004'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    'errcode = ''p1006'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_access_credit_redeem(uuid,text,text)'::regprocedure
    ))
  ) > 0,
  'credit RPCs expose the complete message-independent SQLSTATE matrix'
);

select extensions.ok(
  position(
    'affiliate_pilot_allowlist'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_join_v2(uuid,boolean,boolean,text)'::regprocedure
    ))
  ) = 0
  and position(
    '''partners_invite_only'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''pilot_not_allowed'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) = 0
  and position(
    '''partners_cash_pilot_allowlist_only'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_bootstrap_v2(uuid)'::regprocedure
    ))
  ) > 0,
  'membership is public while invite-only is informative and the cash allowlist is explicit'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.partners_service_payout_country_bind(uuid,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.partners_service_payout_country_bind(uuid,text,text)',
    'EXECUTE'
  )
  and (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'affiliate_private.affiliate_service_idempotency'::regclass
      and constraint_row.conname = 'affiliate_service_idempotency_operation'
  ) like '%payout_country_bind%',
  'payout-country binding is service-only and idempotent'
);

select extensions.ok(
  position(
    'member_program_version_id'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_cash_readiness(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'policy.verification_provider = ''didit'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_cash_readiness(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'affiliate_kyc_attempt_policies'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_cash_readiness(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'route.execution_adapter = ''revolut_manual'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_cash_readiness(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'affiliate_currency_metadata'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_cash_readiness(uuid)'::regprocedure
    ))
  ) > 0,
  'cash readiness requires current P0, Didit, fiscal and a live manual corridor'
);

select extensions.ok(
  position(
    'partners_assert_kyc_cash_eligibility(p_user_id)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'::regprocedure
    ))
  ) > 0
  and position(
    'v_account.member_status <> ''active'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_assert_kyc_cash_eligibility(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'route.execution_adapter = ''revolut_manual'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_assert_kyc_cash_eligibility(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'pg_advisory_xact_lock'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_assert_kyc_cash_eligibility(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'for update'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_assert_kyc_cash_eligibility(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'partners_assert_kyc_cash_eligibility(p_user_id)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'::regprocedure
    ))
  ) < position(
    'select account.id'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'::regprocedure
    ))
  )
  and position(
    'invalid versioned biometric consent'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'::regprocedure
    ))
  ) < position(
    'partners_assert_kyc_cash_eligibility(p_user_id)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'::regprocedure
    ))
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.partners_assert_kyc_cash_eligibility(uuid)',
    'EXECUTE'
  )
  and position(
    'partners_assert_kyc_cash_eligibility(p_user_id)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure
    ))
  ) > 0
  and position(
    'partners_assert_kyc_cash_eligibility(p_user_id)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''partners_cash_pilot_allowlist_only'''
    in lower(pg_get_functiondef(
      'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''norva:partners:release-control'''
    in lower(pg_get_functiondef(
      'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    '''norva:partners:release-control'''
    in lower(pg_get_functiondef(
      'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'::regprocedure
    ))
  ) < position(
    '''norva:partners:payout-approval-configuration'''
    in lower(pg_get_functiondef(
      'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'::regprocedure
    ))
  )
  and (
    select count(*) = 4
      and bool_and(pg_get_userbyid(routine.proowner) = current_user)
    from pg_proc routine
    where routine.oid in (
      'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)'::regprocedure,
      'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)'::regprocedure,
      'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)'::regprocedure,
      'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)'::regprocedure
    )
  )
  and has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_service_kyc_prepare_v2(uuid,text,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_service_fiscal_profile_self_attest(uuid,text,text,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'affiliate_private.partners_service_payout_onboarding_request(uuid,text,boolean,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'affiliate_private.admin_partners_revolut_manual_batch_prepare(text,text,text)',
    'EXECUTE'
  ),
  'cash guard rewrites preserve validation, lock order, owners and exact ACLs'
);

select extensions.ok(
  position(
    'partners_cash_readiness(v_account.id)'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_payout_profile_get(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    '''account_not_active'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_payout_profile_get(uuid)'::regprocedure
    ))
  ) > 0,
  'payout profile reuses the member-aware authoritative cash matrix'
);

select extensions.ok(
  (
    select bool_and(
      affiliate_private.is_managed_partners_flag(flag_key)
    )
    from unnest(array[
      'partners_enabled',
      'partners_invite_only',
      'partners_cash_pilot_allowlist_only',
      'partners_earnings_enabled',
      'partners_credit_redemptions_enabled',
      'partners_shadow_mode',
      'partners_payouts_live',
      'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    ]::text[]) flag_key
  )
  and not affiliate_private.is_managed_partners_flag(
    'partners_unmanaged_test'
  ),
  'the release registry manages exactly the nine Partners flags'
);

select extensions.ok(
  position(
    'catalog.catalog_key = ''acc_p0_usd_plus_month_v1'''
    in lower(pg_get_functiondef(
      'public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    'catalog.unit_amount_minor = 499'
    in lower(pg_get_functiondef(
      'public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    '''partners_shadow_mode'''
    in lower(pg_get_functiondef(
      'public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    '''partners_revolut_api_enabled'''
    in lower(pg_get_functiondef(
      'public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)'::regprocedure
    ))
  ) > 0
  and exists (
    select 1
    from affiliate_private.affiliate_release_gates gate
    where gate.gate_key = 'membership_privacy_approved'
      and not gate.satisfied
  )
  and affiliate_private.partners_approval_required_document_keys(
    'membership_privacy_approved'
  ) @> array[
    'approval_record',
    'deployment_proof',
    'membership_privacy_notice',
    'membership_records_of_processing',
    'membership_minimization_review'
  ]::text[]
  and position(
    '''membership_privacy_approved'''
    in lower(pg_get_functiondef(
      'public.admin_partners_control(text,text,boolean,text,uuid,text,text,timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    '''risk partners approval'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_require_control_access(text,text,boolean)'::regprocedure
    ))
  ) > 0,
  'release control pins Plus 499 and separates AAL2 membership privacy from cash/API gates'
);

select extensions.ok(
  exists (
    select 1
    from pg_attribute attribute
    where attribute.attrelid = 'public.cloud_access_grants'::regclass
      and attribute.attname = 'user_id'
      and not attribute.attnotnull
      and not attribute.attisdropped
  )
  and exists (
    select 1
    from pg_attribute attribute
    where attribute.attrelid = 'public.cloud_access_grants'::regclass
      and attribute.attname = 'user_pseudonym'
      and attribute.attnotnull
      and not attribute.attisdropped
  )
  and (
    select pg_get_constraintdef(constraint_row.oid)
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.cloud_access_grants'::regclass
      and constraint_row.conname = 'cloud_access_grants_user_retention'
  ) like '%consumed%revoked%',
  'access grants detach only after entering a retained terminal state'
);

select extensions.ok(
  position(
    'update public.cloud_access_grants'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_prepare_account_deletion(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'member_status = ''closed'''
    in lower(pg_get_functiondef(
      'affiliate_private.partners_service_prepare_account_deletion(uuid)'::regprocedure
    ))
  ) > 0
  and position(
    'public.cloud_access_grants'
    in lower(pg_get_functiondef(
      'affiliate_private.partners_account_deletion_ready(uuid)'::regprocedure
    ))
  ) > 0,
  'account deletion revokes and pseudonymizes grants before auth deletion'
);

select extensions.ok(
  position(
    'v_target_member_status'
    in lower(pg_get_functiondef(
      'affiliate_private.admin_partners_account_action(text,text,text,text)'::regprocedure
    ))
  ) > 0
  and position(
    'member_status = v_target_member_status'
    in lower(pg_get_functiondef(
      'affiliate_private.admin_partners_account_action(text,text,text,text)'::regprocedure
    ))
  ) > 0,
  'explicit Risk actions atomically stop both cash and member earnings states'
);

create temporary table frictionless_test_state (
  state_key text primary key,
  text_value text,
  json_value jsonb
) on commit drop;

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    'f4000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'frictionless-partner@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    'f4000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'frictionless-referred-pending@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now() + interval '1 second',
    now() + interval '1 second'
  ),
  (
    'f4000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'frictionless-referred-mature@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now() + interval '1 second',
    now() + interval '1 second'
  ),
  (
    'f4000000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'frictionless-no-membership@example.invalid',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into affiliate_private.affiliate_program_versions (
  version_key,
  account_type,
  status,
  commission_rate_bps,
  attribution_window_days,
  maturation_days,
  payout_thresholds,
  terms_version,
  disclosure_version,
  effective_from
)
values (
  'frictionless-p0-test-v1',
  'individual',
  'active',
  2000,
  30,
  45,
  '{"USD":1000}'::jsonb,
  'partners-terms-frictionless-v1',
  'partners-disclosure-frictionless-v1',
  now() - interval '1 minute'
);

insert into affiliate_private.affiliate_currency_metadata (
  currency_code,
  exponent,
  status,
  configured_by_pseudonym,
  justification
)
values (
  'USD',
  2,
  'active',
  repeat('a', 64),
  'Frictionless Partners runtime test currency metadata.'
)
on conflict (currency_code) do nothing;

select set_config(
  'norva.partners_control',
  'admin_partners_control',
  true
);
update public.admin_feature_flags flag
set enabled = case
  when flag.key = 'partners_invite_only' then false
  else true
end,
updated_at = now()
where flag.key in (
  'partners_enabled',
  'partners_invite_only',
  'partners_cash_pilot_allowlist_only',
  'partners_earnings_enabled',
  'partners_credit_redemptions_enabled'
);

insert into frictionless_test_state (state_key, json_value)
values (
  'public_membership_cash_pilot_bootstrap',
  public.partners_service_bootstrap_v2(
    'f4000000-0000-4000-8000-000000000004'
  )
);

select extensions.ok(
  (
    select state.json_value #>> '{flags,partners_invite_only}' = 'false'
      and state.json_value #>> '{flags,partners_cash_pilot_allowlist_only}' = 'true'
      and state.json_value #>> '{eligibility,eligible}' = 'true'
      and state.json_value #>> '{eligibility,reason}' = 'available'
      and state.json_value #>> '{cash_readiness,reason}' =
        'membership_required'
      and state.json_value #>> '{membership,exists}' = 'false'
    from frictionless_test_state state
    where state.state_key = 'public_membership_cash_pilot_bootstrap'
  ),
  'bootstrap keeps membership public while the cash pilot remains allowlisted'
);

select extensions.ok(
  (
    select jsonb_typeof(
      state.json_value #> '{credit_readiness,ready}'
    ) = 'boolean'
      and state.json_value #>> '{credit_readiness,ready}' = 'false'
    from frictionless_test_state state
    where state.state_key = 'public_membership_cash_pilot_bootstrap'
  ),
  'bootstrap serializes non-member credit readiness as boolean false'
);

select extensions.is(
  public.partners_service_join_v2(
    'f4000000-0000-4000-8000-000000000004',
    true,
    true,
    'frictionless.join.public.0001'
  ) #>> '{membership,status}',
  'active',
  'a confirmed non-allowlisted user can join and share without entering cash KYC'
);

insert into affiliate_private.affiliate_pilot_allowlist (
  user_id,
  status,
  added_by_pseudonym
)
values (
  'f4000000-0000-4000-8000-000000000001',
  'active',
  repeat('f', 64)
);

insert into frictionless_test_state (state_key, json_value)
values (
  'join_first',
  public.partners_service_join_v2(
    'f4000000-0000-4000-8000-000000000001',
    true,
    true,
    'frictionless.join.0001'
  )
), (
  'join_replay',
  public.partners_service_join_v2(
    'f4000000-0000-4000-8000-000000000001',
    true,
    true,
    'frictionless.join.0001'
  )
), (
  'join_existing_new_key',
  public.partners_service_join_v2(
    'f4000000-0000-4000-8000-000000000001',
    true,
    true,
    'frictionless.join.0002'
  )
);

select extensions.ok(
  (
    select state.json_value #>> '{membership,status}' = 'active'
      and state.json_value #>> '{membership,verification_status}' =
        'not_started'
      and state.json_value #>> '{link,status}' = 'active'
      and state.json_value #>> '{cash_readiness,reason}' =
        'payout_country_required'
      and state.json_value ->> 'next_action' = 'share_link'
    from frictionless_test_state state
    where state.state_key = 'join_first'
  )
  and exists (
    select 1
    from affiliate_private.affiliate_accounts account
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
      and account.member_status = 'active'
      and account.status = 'pending_verification'
      and account.verification_status = 'not_started'
      and account.country_code is null
  ),
  'a confirmed Cloud user joins, receives a link and remains KYC-free for earnings'
);

select extensions.ok(
  (
    select replay.json_value ->> 'replayed' = 'true'
      and (first_response.json_value - 'replayed') =
        (replay.json_value - 'replayed')
    from frictionless_test_state first_response
    join frictionless_test_state replay on true
    where first_response.state_key = 'join_first'
      and replay.state_key = 'join_replay'
  )
  and (
    select count(*)
    from affiliate_private.affiliate_accounts account
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
  ) = 1
  and (
    select count(*)
    from affiliate_private.affiliate_links link
    join affiliate_private.affiliate_accounts account
      on account.id = link.account_id
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
      and link.status = 'active'
  ) = 1,
  'membership replay preserves the exact contract and creates no duplicate account or link'
);

select extensions.ok(
  (
    select state.json_value ->> 'changed' = 'false'
      and state.json_value ->> 'replayed' = 'false'
      and state.json_value #>> '{membership,status}' = 'active'
    from frictionless_test_state state
    where state.state_key = 'join_existing_new_key'
  )
  and (
    select count(*)
    from affiliate_private.affiliate_events event
    join affiliate_private.affiliate_accounts account
      on event.aggregate_type = 'account'
      and event.aggregate_key = account.id::text
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
      and event.action = 'membership_joined'
  ) = 1,
  'a second join key returns the active snapshot without duplicating the membership transition audit'
);

insert into frictionless_test_state (state_key, text_value)
select 'referral_code_hash', link.code_hash
from affiliate_private.affiliate_links link
join affiliate_private.affiliate_accounts account
  on account.id = link.account_id
where account.user_id = 'f4000000-0000-4000-8000-000000000001'
  and link.status = 'active';

insert into frictionless_test_state (state_key, json_value)
select
  'referral_resolve_pending',
  public.partners_service_referral_resolve(
    state.text_value,
    repeat('1', 64),
    now() + interval '1 day',
    repeat('2', 64),
    repeat('3', 64),
    repeat('4', 64)
  )
from frictionless_test_state state
where state.state_key = 'referral_code_hash';

insert into frictionless_test_state (state_key, json_value)
values (
  'referral_claim_pending',
  public.partners_service_referral_claim(
    'f4000000-0000-4000-8000-000000000002',
    repeat('1', 64),
    'frictionless.claim.0001'
  )
);

insert into frictionless_test_state (state_key, json_value)
select
  'referral_resolve_mature',
  public.partners_service_referral_resolve(
    state.text_value,
    repeat('5', 64),
    now() + interval '1 day',
    repeat('6', 64),
    repeat('7', 64),
    repeat('8', 64)
  )
from frictionless_test_state state
where state.state_key = 'referral_code_hash';

insert into frictionless_test_state (state_key, json_value)
values (
  'referral_claim_mature',
  public.partners_service_referral_claim(
    'f4000000-0000-4000-8000-000000000003',
    repeat('5', 64),
    'frictionless.claim.0002'
  )
);

select extensions.ok(
  (
    select state.json_value ->> 'accepted' = 'true'
    from frictionless_test_state state
    where state.state_key = 'referral_resolve_pending'
  )
  and (
    select bool_and(state.json_value ->> 'outcome' = 'attributed')
    from frictionless_test_state state
    where state.state_key in (
      'referral_claim_pending', 'referral_claim_mature'
    )
  )
  and (
    select count(*)
    from affiliate_private.affiliate_attributions attribution
    where attribution.referred_user_id in (
      'f4000000-0000-4000-8000-000000000002',
      'f4000000-0000-4000-8000-000000000003'
    )
  ) = 2,
  'a KYC-free membership link attributes distinct confirmed Cloud users immediately'
);

select extensions.throws_ok(
  $$
    select public.partners_service_access_credit_status(
      'f4000000-0000-4000-8000-000000000002'
    )
  $$,
  'P1001',
  'Partners membership is unavailable',
  'P1001 maps missing membership without relying on a generic credit error'
);

update public.admin_feature_flags flag
set enabled = false, updated_at = now()
where flag.key = 'partners_credit_redemptions_enabled';
select extensions.throws_ok(
  $$
    select public.partners_service_access_credit_quote(
      'f4000000-0000-4000-8000-000000000001',
      1,
      'frictionless.disabled.0001'
    )
  $$,
  'P1002',
  'access credit redemptions are disabled',
  'P1002 maps the access-credit kill switch'
);
update public.admin_feature_flags flag
set enabled = true, updated_at = now()
where flag.key = 'partners_credit_redemptions_enabled';

update affiliate_private.affiliate_access_credit_catalog catalog
set status = 'retired'
where catalog.catalog_key = 'acc_p0_usd_plus_month_v1';
select extensions.throws_ok(
  $$
    select public.partners_service_access_credit_quote(
      'f4000000-0000-4000-8000-000000000001',
      1,
      'frictionless.catalog.0001'
    )
  $$,
  'P1005',
  'access credit catalog is unavailable',
  'P1005 maps an unavailable authoritative catalog'
);
update affiliate_private.affiliate_access_credit_catalog catalog
set status = 'active'
where catalog.catalog_key = 'acc_p0_usd_plus_month_v1';

select extensions.throws_ok(
  $$
    select public.partners_service_access_credit_quote(
      'f4000000-0000-4000-8000-000000000001',
      1,
      'frictionless.balance.0001'
    )
  $$,
  'P1004',
  'insufficient available Partner balance',
  'P1004 maps an insufficient available source-currency balance at quote time'
);

create or replace function pg_temp.stage_frictionless_financial_fact(
  p_transaction_hash text,
  p_parent_transaction_hash text,
  p_referred_user_id uuid,
  p_event_type text,
  p_occurred_at timestamptz
)
returns text
language plpgsql
as $test$
declare
  v_attribution_id uuid;
  v_fact_id uuid;
  v_job_key text;
begin
  select attribution.id
  into strict v_attribution_id
  from affiliate_private.affiliate_attributions attribution
  where attribution.referred_user_id = p_referred_user_id;

  insert into affiliate_private.affiliate_financial_facts (
    transaction_hash,
    parent_transaction_hash,
    referred_user_id,
    attribution_id,
    rail,
    event_type,
    environment,
    facts_status,
    currency,
    currency_exponent,
    gross_minor,
    discount_minor,
    tax_minor,
    eligible_minor,
    occurred_at
  ) values (
    p_transaction_hash,
    p_parent_transaction_hash,
    p_referred_user_id,
    v_attribution_id,
    'web',
    p_event_type,
    'production',
    'complete',
    'USD',
    2,
    2495,
    null,
    0,
    2495,
    p_occurred_at
  ) returning id into v_fact_id;

  insert into affiliate_private.affiliate_commission_jobs (
    fact_id,
    job_kind
  ) values (
    v_fact_id,
    case
      when p_event_type in ('capture', 'renewal') then 'accrual'
      else 'reversal'
    end
  ) returning job_key into v_job_key;
  return v_job_key;
end;
$test$;

create or replace function pg_temp.complete_frictionless_commission_job(
  p_transaction_hash text,
  p_worker_id text,
  p_lease_token_hash text
)
returns jsonb
language plpgsql
as $test$
declare
  v_job_key text;
begin
  select job.job_key
  into strict v_job_key
  from affiliate_private.affiliate_commission_jobs job
  join affiliate_private.affiliate_financial_facts fact
    on fact.id = job.fact_id
  where fact.transaction_hash = p_transaction_hash;
  perform public.partners_worker_commission_jobs_lease(
    p_worker_id,
    p_lease_token_hash,
    1,
    60
  );
  return public.partners_worker_commission_job_complete(
    v_job_key,
    p_worker_id,
    p_lease_token_hash,
    'succeeded',
    null
  );
end;
$test$;

create or replace function pg_temp.complete_frictionless_maturation_job(
  p_transaction_hash text,
  p_worker_id text,
  p_lease_token_hash text
)
returns jsonb
language plpgsql
as $test$
declare
  v_job_key text;
begin
  select maturation.job_key
  into strict v_job_key
  from affiliate_private.affiliate_maturation_jobs maturation
  join affiliate_private.affiliate_commission_entries accrual
    on accrual.id = maturation.accrual_entry_id
  join affiliate_private.affiliate_financial_facts fact
    on fact.id = accrual.fact_id
  where fact.transaction_hash = p_transaction_hash;
  perform public.partners_worker_maturation_lease(
    p_worker_id,
    p_lease_token_hash,
    1,
    60
  );
  return public.partners_worker_maturation_complete(
    v_job_key,
    p_worker_id,
    p_lease_token_hash,
    'succeeded',
    null
  );
end;
$test$;

insert into frictionless_test_state (state_key, text_value)
values (
  'pending_capture_staged',
  pg_temp.stage_frictionless_financial_fact(
    repeat('3', 64),
    null,
    'f4000000-0000-4000-8000-000000000002',
    'capture',
    now()
  )
);
insert into frictionless_test_state (state_key, json_value)
values (
  'pending_capture_complete',
  pg_temp.complete_frictionless_commission_job(
    repeat('3', 64),
    'frictionless-pending-worker',
    repeat('a', 64)
  )
);

select extensions.ok(
  exists (
    select 1
    from affiliate_private.affiliate_commission_entries entry
    join affiliate_private.affiliate_financial_facts fact
      on fact.id = entry.fact_id
    where fact.transaction_hash = repeat('3', 64)
      and entry.entry_kind = 'accrual'
      and entry.amount_minor = 499
      and entry.matures_at = fact.occurred_at + interval '45 days'
  )
  and (
    affiliate_private.partners_access_credit_balances((
      select account.id
      from affiliate_private.affiliate_accounts account
      where account.user_id =
        'f4000000-0000-4000-8000-000000000001'
    )) #>> '{pending_minor}'
  )::bigint = 499,
  'a referred payment posts 20 percent pending immediately with exact J+45 maturity'
);

insert into frictionless_test_state (state_key, text_value)
values (
  'pending_refund_staged',
  pg_temp.stage_frictionless_financial_fact(
    repeat('6', 64),
    repeat('3', 64),
    'f4000000-0000-4000-8000-000000000002',
    'refund',
    now() + interval '1 second'
  )
);
insert into frictionless_test_state (state_key, json_value)
values (
  'pending_refund_complete',
  pg_temp.complete_frictionless_commission_job(
    repeat('6', 64),
    'frictionless-refund-worker',
    repeat('b', 64)
  )
);

select extensions.ok(
  (
    select balances #>> '{pending_minor}' = '0'
      and balances #>> '{available_minor}' = '0'
      and balances #>> '{recovery_due_minor}' = '0'
    from (
      select affiliate_private.partners_access_credit_balances(account.id)
        as balances
      from affiliate_private.affiliate_accounts account
      where account.user_id =
        'f4000000-0000-4000-8000-000000000001'
    ) state
  )
  and exists (
    select 1
    from affiliate_private.affiliate_commission_entries reversal
    join affiliate_private.affiliate_financial_facts fact
      on fact.id = reversal.fact_id
    where fact.transaction_hash = repeat('6', 64)
      and reversal.entry_kind = 'reversal'
      and reversal.amount_minor = 499
  )
  and not exists (
    select 1
    from public.cloud_access_grants grant_row
    where grant_row.user_id =
      'f4000000-0000-4000-8000-000000000001'
  ),
  'a refund before maturation removes pending commission without debt or access mutation'
);

insert into frictionless_test_state (state_key, text_value)
values (
  'mature_capture_staged',
  pg_temp.stage_frictionless_financial_fact(
    repeat('9', 64),
    null,
    'f4000000-0000-4000-8000-000000000003',
    'renewal',
    now() - interval '46 days'
  )
);
insert into frictionless_test_state (state_key, json_value)
values (
  'mature_capture_complete',
  pg_temp.complete_frictionless_commission_job(
    repeat('9', 64),
    'frictionless-mature-worker',
    repeat('c', 64)
  )
);
insert into frictionless_test_state (state_key, json_value)
values (
  'mature_release_complete',
  pg_temp.complete_frictionless_maturation_job(
    repeat('9', 64),
    'frictionless-release-worker',
    repeat('d', 64)
  )
);

insert into frictionless_test_state (state_key, json_value)
values (
  'race_quote',
  public.partners_service_access_credit_quote(
    'f4000000-0000-4000-8000-000000000001',
    1,
    'frictionless.race.quote.0001'
  )
);

select extensions.throws_ok(
  $$
    select public.partners_service_access_credit_quote(
      'f4000000-0000-4000-8000-000000000001',
      2,
      'frictionless.race.quote.0001'
    )
  $$,
  'P0003',
  'idempotency key was reused with another request',
  'an idempotency key cannot be replayed with a different quote payload'
);

with partner as (
  select account.id as account_id
  from affiliate_private.affiliate_accounts account
  where account.user_id = 'f4000000-0000-4000-8000-000000000001'
), allocation as (
  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    entry_kind,
    currency,
    currency_exponent,
    amount_minor
  )
  select partner.account_id, 'payout_allocation', 'USD', 2, 1
  from partner
  returning id
), postings as (
  insert into affiliate_private.affiliate_commission_postings (
    entry_id,
    ledger_account,
    direction,
    amount_minor,
    currency
  )
  select allocation.id, 'partner_commission_available', 'debit', 1, 'USD'
  from allocation
  union all
  select allocation.id, 'partner_payout_clearing', 'credit', 1, 'USD'
  from allocation
)
insert into frictionless_test_state (state_key, text_value)
select 'race_payout_allocation', allocation.id::text
from allocation;

select extensions.throws_ok(
  $$
    select public.partners_service_access_credit_redeem(
      'f4000000-0000-4000-8000-000000000001',
      (
        select state.json_value #>> '{quote,key}'
        from frictionless_test_state state
        where state.state_key = 'race_quote'
      ),
      'frictionless.race.redeem.0001'
    )
  $$,
  'P1004',
  'insufficient available Partner balance',
  'redemption rechecks the shared balance lock after an intervening payout allocation'
);

with allocation as (
  select entry.*
  from affiliate_private.affiliate_commission_entries entry
  join frictionless_test_state state
    on state.text_value = entry.id::text
  where state.state_key = 'race_payout_allocation'
), release as (
  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    entry_kind,
    related_entry_id,
    currency,
    currency_exponent,
    amount_minor
  )
  select
    allocation.account_id,
    'payout_release',
    allocation.id,
    allocation.currency,
    allocation.currency_exponent,
    allocation.amount_minor
  from allocation
  returning id
)
insert into affiliate_private.affiliate_commission_postings (
  entry_id,
  ledger_account,
  direction,
  amount_minor,
  currency
)
select release.id, 'partner_payout_clearing', 'debit', 1, 'USD'
from release
union all
select release.id, 'partner_commission_available', 'credit', 1, 'USD'
from release;

update affiliate_private.affiliate_access_credit_quotes quote
set
  created_at = now() - interval '20 minutes',
  expires_at = now() - interval '5 minutes'
where quote.quote_key = (
  select state.json_value #>> '{quote,key}'
  from frictionless_test_state state
  where state.state_key = 'race_quote'
);

select extensions.throws_ok(
  $$
    select public.partners_service_access_credit_redeem(
      'f4000000-0000-4000-8000-000000000001',
      (
        select state.json_value #>> '{quote,key}'
        from frictionless_test_state state
        where state.state_key = 'race_quote'
      ),
      'frictionless.expired.0001'
    )
  $$,
  'P1003',
  'access credit quote expired',
  'P1003 maps a server-observed expired quote'
);

select extensions.throws_ok(
  $$
    select public.partners_service_access_credit_redeem(
      'f4000000-0000-4000-8000-000000000001',
      'crq_ffffffffffffffffffffffff',
      'frictionless.conflict.0001'
    )
  $$,
  'P1006',
  'access credit quote is unavailable',
  'P1006 maps a missing or non-owned quote without disclosing its existence'
);

insert into affiliate_private.affiliate_access_credit_quotes (
  quote_key,
  account_id,
  catalog_id,
  status,
  plan_code,
  currency,
  currency_exponent,
  months,
  unit_amount_minor,
  total_amount_minor,
  reference_currency,
  reference_currency_exponent,
  reference_unit_amount_minor,
  reference_total_amount_minor,
  duration_days,
  expires_at,
  redeemed_at,
  created_at
)
select
  fixture.quote_key,
  account.id,
  catalog.id,
  fixture.status,
  'plus',
  'USD',
  2,
  1,
  499,
  499,
  'USD',
  2,
  499,
  499,
  30,
  now() - interval '31 days' + interval '10 minutes',
  case when fixture.status = 'redeemed'
    then now() - interval '31 days' + interval '5 minutes'
    else null
  end,
  now() - interval '31 days'
from affiliate_private.affiliate_accounts account
cross join affiliate_private.affiliate_access_credit_catalog catalog
cross join (values
  ('crq_aaaaaaaaaaaaaaaaaaaaaaaa'::text, 'expired'::text),
  ('crq_bbbbbbbbbbbbbbbbbbbbbbbb'::text, 'cancelled'::text),
  ('crq_cccccccccccccccccccccccc'::text, 'redeemed'::text)
) fixture(quote_key, status)
where account.user_id = 'f4000000-0000-4000-8000-000000000001'
  and catalog.catalog_key = 'acc_p0_usd_plus_month_v1';

insert into frictionless_test_state (state_key, json_value)
values (
  'success_quote',
  public.partners_service_access_credit_quote(
    'f4000000-0000-4000-8000-000000000001',
    1,
    'frictionless.success.quote.0001'
  )
);

insert into frictionless_test_state (state_key, json_value)
select
  'success_redeem',
  public.partners_service_access_credit_redeem(
    'f4000000-0000-4000-8000-000000000001',
    quote.json_value #>> '{quote,key}',
    'frictionless.success.redeem.0001'
  )
from frictionless_test_state quote
where quote.state_key = 'success_quote';

select extensions.ok(
  not exists (
    select 1
    from affiliate_private.affiliate_access_credit_quotes quote
    where quote.quote_key in (
      'crq_aaaaaaaaaaaaaaaaaaaaaaaa',
      'crq_bbbbbbbbbbbbbbbbbbbbbbbb'
    )
  )
  and exists (
    select 1
    from affiliate_private.affiliate_access_credit_quotes quote
    where quote.quote_key = 'crq_cccccccccccccccccccccccc'
      and quote.status = 'redeemed'
  ),
  'quote maintenance prunes only old expired or cancelled rows and always retains redeemed evidence'
);

select extensions.ok(
  (
    select redemption.json_value #>> '{redemption,status}' = 'granted'
      and redemption.json_value #>> '{redemption,currency}' = 'USD'
      and (redemption.json_value #>> '{redemption,amount_minor}')::bigint = 499
      and redemption.json_value #>> '{grant,status}' = 'active'
      and redemption.json_value #>> '{balance,available_minor}' = '0'
    from frictionless_test_state redemption
    where redemption.state_key = 'success_redeem'
  )
  and exists (
    select 1
    from affiliate_private.affiliate_accounts account
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
      and account.member_status = 'active'
      and account.status = 'pending_verification'
      and account.verification_status = 'not_started'
  )
  and (
    select
      (affiliate_private.partners_access_credit_balances(account.id)
        #>> '{available_minor}')::bigint =
      affiliate_private.partners_account_payable_balance(account.id, 'USD')
    from affiliate_private.affiliate_accounts account
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
  ),
  'available commission converts to USD Norva access without KYC or cash eligibility'
);

insert into frictionless_test_state (state_key, json_value)
select
  'success_redeem_replay',
  public.partners_service_access_credit_redeem(
    'f4000000-0000-4000-8000-000000000001',
    quote.json_value #>> '{quote,key}',
    'frictionless.success.redeem.0001'
  )
from frictionless_test_state quote
where quote.state_key = 'success_quote';

select extensions.ok(
  (
    select replay.json_value ->> 'replayed' = 'true'
      and first_response.json_value #>> '{redemption,key}' =
        replay.json_value #>> '{redemption,key}'
      and first_response.json_value #>> '{grant,key}' =
        replay.json_value #>> '{grant,key}'
      and (first_response.json_value - 'replayed') =
        (replay.json_value - 'replayed')
    from frictionless_test_state first_response
    join frictionless_test_state replay on true
    where first_response.state_key = 'success_redeem'
      and replay.state_key = 'success_redeem_replay'
  )
  and (
    select count(*)
    from affiliate_private.affiliate_access_credit_redemptions redemption
    join affiliate_private.affiliate_accounts account
      on account.id = redemption.account_id
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
  ) = 1
  and (
    select count(*)
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
  ) = 1,
  'redemption replay preserves exact identifiers and cannot duplicate ledger redemption or grant'
);

insert into public.cloud_entitlement_projection (
  user_id,
  provider,
  provider_customer_id,
  plan_code,
  status,
  current_period_end,
  last_verified_at,
  last_event_at
)
values (
  'f4000000-0000-4000-8000-000000000001',
  'revenuecat',
  'frictionless-provider-customer',
  'family',
  'active',
  now() + interval '7 days',
  now(),
  now()
);

select extensions.ok(
  exists (
    select 1
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
      and grant_row.status = 'paused_provider'
      and grant_row.remaining_seconds > 0
      and grant_row.active_from is null
      and grant_row.active_until is null
  ),
  'provider purchase pauses an active credit in the projection write transaction'
);

insert into frictionless_test_state (state_key, json_value)
values (
  'provider_pause',
  public.partners_service_access_grants_reconcile(
    'f4000000-0000-4000-8000-000000000001'
  )
);

select extensions.ok(
  (
    select state.json_value #>> '{provider,status}' = 'active'
      and state.json_value #>> '{provider,active}' = 'true'
      and state.json_value #>> '{overlay,status}' = 'paused_provider'
    from frictionless_test_state state
    where state.state_key = 'provider_pause'
  )
  and exists (
    select 1
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
      and grant_row.status = 'paused_provider'
      and grant_row.remaining_seconds > 0
      and grant_row.active_from is null
      and grant_row.active_until is null
  )
  and exists (
    select 1
    from public.cloud_entitlement_projection projection
    where projection.user_id = 'f4000000-0000-4000-8000-000000000001'
      and projection.provider = 'revenuecat'
      and projection.status = 'active'
  ),
  'an active provider entitlement pauses the additive grant without overwriting provider state'
);

update public.cloud_entitlement_projection projection
set
  status = 'past_due',
  current_period_end = now() - interval '1 day',
  fail_open_until = now() + interval '2 hours',
  last_verified_at = now() - interval '10 days',
  updated_at = now()
where projection.user_id = 'f4000000-0000-4000-8000-000000000001';

insert into frictionless_test_state (state_key, json_value)
values (
  'provider_past_due_fail_open',
  public.partners_service_access_grants_reconcile(
    'f4000000-0000-4000-8000-000000000001'
  )
);

select extensions.ok(
  (
    select state.json_value #>> '{provider,provider}' = 'revenuecat'
      and state.json_value #>> '{provider,status}' = 'past_due'
      and state.json_value #>> '{provider,active}' = 'true'
      and state.json_value #>> '{provider,fail_open}' = 'true'
      and state.json_value #>> '{provider,reason}' = 'billing_grace'
      and state.json_value #>> '{provider,fail_open_until}' is not null
      and state.json_value #>> '{provider,last_verified_at}' is not null
      and state.json_value #>> '{overlay,status}' = 'paused_provider'
    from frictionless_test_state state
    where state.state_key = 'provider_past_due_fail_open'
  )
  and exists (
    select 1
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
      and grant_row.status = 'paused_provider'
  ),
  'past_due remains provider-authorized during fail-open and cannot consume credit time'
);

update public.cloud_entitlement_projection projection
set
  status = 'unknown',
  current_period_end = now() - interval '1 day',
  fail_open_until = now() - interval '1 second',
  last_verified_at = now() - interval '1 hour',
  updated_at = now()
where projection.user_id = 'f4000000-0000-4000-8000-000000000001';

insert into frictionless_test_state (state_key, json_value)
values (
  'provider_unknown_recently_verified',
  public.partners_service_access_grants_reconcile(
    'f4000000-0000-4000-8000-000000000001'
  )
);

select extensions.ok(
  (
    select state.json_value #>> '{provider,status}' = 'unknown'
      and state.json_value #>> '{provider,active}' = 'true'
      and state.json_value #>> '{provider,fail_open}' = 'true'
      and state.json_value #>> '{provider,reason}' =
        'billing_recently_verified'
      and state.json_value #>> '{overlay,status}' = 'paused_provider'
    from frictionless_test_state state
    where state.state_key = 'provider_unknown_recently_verified'
  )
  and exists (
    select 1
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
      and grant_row.status = 'paused_provider'
  ),
  'unknown remains provider-authorized while recently verified and keeps credit paused'
);

update public.cloud_entitlement_projection projection
set
  status = 'revoked',
  current_period_end = now() + interval '7 days',
  fail_open_until = now() + interval '7 days',
  last_verified_at = now(),
  updated_at = now()
where projection.user_id = 'f4000000-0000-4000-8000-000000000001';

insert into frictionless_test_state (state_key, json_value)
values (
  'provider_hard_block',
  public.partners_service_access_grants_reconcile(
    'f4000000-0000-4000-8000-000000000001'
  )
);

select extensions.ok(
  (
    select state.json_value #>> '{provider,status}' = 'revoked'
      and state.json_value #>> '{provider,active}' = 'false'
      and state.json_value #>> '{provider,hard_block}' = 'true'
      and state.json_value #>> '{provider,reason}' = 'revoked'
      and state.json_value #>> '{overlay,status}' = 'blocked_provider'
    from frictionless_test_state state
    where state.state_key = 'provider_hard_block'
  )
  and exists (
    select 1
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
      and grant_row.status = 'paused_provider'
  ),
  'hard provider blocks override period and grace evidence without spending credit'
);

update public.cloud_entitlement_projection projection
set
  status = 'expired',
  current_period_end = now() - interval '1 second',
  fail_open_until = null,
  last_verified_at = now() - interval '10 days',
  updated_at = now()
where projection.user_id = 'f4000000-0000-4000-8000-000000000001';

insert into frictionless_test_state (state_key, json_value)
values (
  'provider_resume',
  public.partners_service_access_grants_reconcile(
    'f4000000-0000-4000-8000-000000000001'
  )
);

select extensions.ok(
  (
    select state.json_value #>> '{provider,status}' = 'expired'
      and state.json_value #>> '{provider,active}' = 'false'
      and state.json_value #>> '{overlay,status}' = 'active'
      and state.json_value #>> '{overlay,active_grant,status}' = 'active'
    from frictionless_test_state state
    where state.state_key = 'provider_resume'
  )
  and exists (
    select 1
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
      and grant_row.status = 'active'
      and abs(
        extract(epoch from grant_row.active_until - now())
        - grant_row.remaining_seconds
      ) < 5
  )
  and exists (
    select 1
    from public.cloud_entitlement_projection projection
    where projection.user_id = 'f4000000-0000-4000-8000-000000000001'
      and projection.provider = 'revenuecat'
      and projection.status = 'expired'
  ),
  'provider expiry resumes the exact remaining grant duration and leaves projection authoritative'
);

update public.cloud_access_grants grant_row
set
  status = 'consumed',
  remaining_seconds = 0,
  active_from = null,
  active_until = null,
  consumed_at = now(),
  updated_at = now()
where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
  and grant_row.status = 'active';

insert into frictionless_test_state (state_key, text_value)
values (
  'mature_refund_staged',
  pg_temp.stage_frictionless_financial_fact(
    repeat('c', 64),
    repeat('9', 64),
    'f4000000-0000-4000-8000-000000000003',
    'chargeback',
    now()
  )
);
insert into frictionless_test_state (state_key, json_value)
values (
  'mature_refund_complete',
  pg_temp.complete_frictionless_commission_job(
    repeat('c', 64),
    'frictionless-recovery-worker',
    repeat('e', 64)
  )
);

select extensions.ok(
  (
    select balances #>> '{available_minor}' = '0'
      and balances #>> '{recovery_due_minor}' = '499'
      and balances #>> '{redeemed_minor}' = '499'
    from (
      select affiliate_private.partners_access_credit_balances(account.id)
        as balances
      from affiliate_private.affiliate_accounts account
      where account.user_id =
        'f4000000-0000-4000-8000-000000000001'
    ) state
  )
  and (
    select count(*)
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
      and grant_row.status = 'consumed'
      and grant_row.remaining_seconds = 0
  ) = 1
  and (
    select
      (affiliate_private.partners_access_credit_balances(account.id)
        #>> '{available_minor}')::bigint =
      affiliate_private.partners_account_payable_balance(account.id, 'USD')
    from affiliate_private.affiliate_accounts account
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
  ),
  'a post-consumption chargeback records recovery debt without revoking or recreating access'
);

select extensions.throws_ok(
  $$
    select public.partners_service_payout_onboarding_request(
      'f4000000-0000-4000-8000-000000000001',
      'USD',
      true,
      'frictionless.payout.0001'
    )
  $$,
  'P1007',
  'payout country is unavailable',
  'cash payout remains unavailable until an explicit supported payout country is bound'
);

insert into frictionless_test_state (state_key, json_value)
values (
  'dashboard_runtime',
  public.partners_service_dashboard_v2(
    'f4000000-0000-4000-8000-000000000001',
    25,
    null,
    'all'
  )
);

select extensions.ok(
  (
    select array_agg(key_name order by key_name) = array[
      'balances',
      'cash_readiness',
      'credit_readiness',
      'flags',
      'history',
      'link',
      'membership',
      'next_maturation_at',
      'overlay',
      'program',
      'provider',
      'schema_version'
    ]::text[]
    from frictionless_test_state state
    cross join lateral jsonb_object_keys(state.json_value) key_name
    where state.state_key = 'dashboard_runtime'
  )
  and (
    select state.json_value ->> 'schema_version' = '2'
      and state.json_value #>> '{membership,status}' = 'active'
      and state.json_value #>> '{cash_readiness,reason}' =
        'payout_country_required'
      and state.json_value #>> '{balances,0,currency}' = 'USD'
      and state.json_value #>> '{balances,0,recovery_due_minor}' = '499'
      and state.json_value #> '{credit_readiness,catalog}' is not null
      and jsonb_array_length(state.json_value #> '{history,items}') > 0
      and not exists (
        select 1
        from jsonb_array_elements(
          state.json_value #> '{history,items}'
        ) history(item)
        where history.item ->> 'type' = 'release'
      )
      and exists (
        select 1
        from jsonb_array_elements(
          state.json_value #> '{history,items}'
        ) history(item)
        where history.item ->> 'type' = 'accrual'
          and history.item ->> 'status' = 'available'
      )
      and not (state.json_value ? 'eligibility')
    from frictionless_test_state state
    where state.state_key = 'dashboard_runtime'
  ),
  'dashboard v2 returns one exact, actionable contract after runtime mutations'
);

insert into frictionless_test_state (state_key, json_value)
values (
  'deletion_financially_blocked',
  public.partners_service_prepare_account_deletion(
    'f4000000-0000-4000-8000-000000000001'
  )
);

select extensions.ok(
  (
    select state.json_value ->> 'ready' = 'false'
      and state.json_value ->> 'state' = 'pending_financial_closure'
      and state.json_value #>> '{balances,0,currency}' = 'USD'
      and state.json_value #>> '{balances,0,recovery_due_minor}' = '499'
    from frictionless_test_state state
    where state.state_key = 'deletion_financially_blocked'
  )
  and exists (
    select 1
    from affiliate_private.affiliate_accounts account
    where account.user_id = 'f4000000-0000-4000-8000-000000000001'
      and account.status <> 'closed'
      and account.member_status = 'active'
  )
  and exists (
    select 1
    from public.cloud_access_grants grant_row
    where grant_row.user_id = 'f4000000-0000-4000-8000-000000000001'
      and grant_row.user_pseudonym = encode(
        extensions.digest(
          'norva-partners-subject:v1:' ||
            'f4000000-0000-4000-8000-000000000001',
          'sha256'
        ),
        'hex'
      )
      and grant_row.status in ('consumed', 'revoked')
  )
  and not affiliate_private.partners_account_deletion_ready(
    'f4000000-0000-4000-8000-000000000001'
  ),
  'unresolved recovery debt keeps account deletion fail-closed without detaching retained state'
);

insert into frictionless_test_state (state_key, json_value)
values (
  'deletion_prepared',
  public.partners_service_prepare_account_deletion(
    'f4000000-0000-4000-8000-000000000004'
  )
);

select extensions.ok(
  (
    select state.json_value ->> 'ready' = 'true'
      and state.json_value ->> 'changed' = 'true'
    from frictionless_test_state state
    where state.state_key = 'deletion_prepared'
  )
  and exists (
    select 1
    from affiliate_private.affiliate_accounts account
    where account.user_pseudonym = encode(
      extensions.digest(
        'norva-partners-subject:v1:' ||
          'f4000000-0000-4000-8000-000000000004',
        'sha256'
      ),
      'hex'
    )
      and account.user_id is null
      and account.status = 'closed'
      and account.member_status = 'closed'
  )
  and not exists (
    select 1
    from affiliate_private.affiliate_links link
    join affiliate_private.affiliate_accounts account
      on account.id = link.account_id
    where account.user_pseudonym = encode(
      extensions.digest(
        'norva-partners-subject:v1:' ||
          'f4000000-0000-4000-8000-000000000004',
        'sha256'
      ),
      'hex'
    )
      and link.status = 'active'
  )
  and affiliate_private.partners_account_deletion_ready(
    'f4000000-0000-4000-8000-000000000004'
  ),
  'financially clear account deletion revokes sharing and closes membership'
);

insert into affiliate_private.affiliate_currency_metadata (
  currency_code, exponent, status, configured_by_pseudonym, justification
) values (
  'EUR', 2, 'active', repeat('e', 64),
  'Exact EUR access-credit integration test metadata.'
) on conflict (currency_code) do nothing;

create or replace function pg_temp.stage_frictionless_eur_fact()
returns text
language plpgsql
as $test$
declare
  v_attribution_id uuid;
  v_fact_id uuid;
  v_job_key text;
begin
  select attribution.id into strict v_attribution_id
  from affiliate_private.affiliate_attributions attribution
  where attribution.referred_user_id =
    'f4000000-0000-4000-8000-000000000003';
  insert into affiliate_private.affiliate_financial_facts (
    transaction_hash, parent_transaction_hash, referred_user_id,
    attribution_id, rail, event_type, environment, facts_status,
    currency, currency_exponent, gross_minor, discount_minor,
    tax_minor, eligible_minor, occurred_at
  ) values (
    repeat('e', 64), null,
    'f4000000-0000-4000-8000-000000000003', v_attribution_id,
    'web', 'renewal', 'production', 'complete', 'EUR', 2,
    2495, 0, 0, 2495, now() - interval '46 days'
  ) returning id into v_fact_id;
  insert into affiliate_private.affiliate_commission_jobs (fact_id, job_kind)
  values (v_fact_id, 'accrual') returning job_key into v_job_key;
  return v_job_key;
end;
$test$;

select pg_temp.stage_frictionless_eur_fact();
select pg_temp.complete_frictionless_commission_job(
  repeat('e', 64), 'frictionless-eur-worker', repeat('1', 64)
);
select pg_temp.complete_frictionless_maturation_job(
  repeat('e', 64), 'frictionless-eur-release', repeat('2', 64)
);

insert into affiliate_private.affiliate_fx_rate_snapshots (
  snapshot_key, source_currency, source_exponent, source_units_minor,
  target_currency, target_exponent, target_units_minor, rate_source,
  observed_at, valid_until, evidence_sha256, idempotency_key,
  payload_sha256, recorded_by_pseudonym, justification
) values (
  'fxr_eeeeeeeeeeeeeeeeeeeeeeee', 'EUR', 2, 100,
  'USD', 2, 110, 'finance_manual', now() - interval '1 minute',
  now() + interval '1 day', repeat('3', 64),
  'frictionless.fx.eur.0001', repeat('4', 64), repeat('5', 64),
  'Exact EUR to USD snapshot for access-credit integration test.'
);

insert into frictionless_test_state (state_key, json_value)
values (
  'eur_quote',
  public.partners_service_access_credit_quote(
    'f4000000-0000-4000-8000-000000000001',
    1,
    'frictionless.eur.quote.0001'
  )
);
insert into frictionless_test_state (state_key, json_value)
select
  'eur_redeem',
  public.partners_service_access_credit_redeem(
    'f4000000-0000-4000-8000-000000000001',
    quote.json_value #>> '{quote,key}',
    'frictionless.eur.redeem.0001'
  )
from frictionless_test_state quote
where quote.state_key = 'eur_quote';

select extensions.ok(
  (
    select quote.json_value #>> '{quote,currency}' = 'EUR'
      and (quote.json_value #>> '{quote,total_amount_minor}')::bigint = 454
      and quote.json_value #>> '{quote,reference_currency}' = 'USD'
      and (quote.json_value #>> '{quote,reference_total_amount_minor}')::bigint = 499
      and quote.json_value #>> '{quote,fx_rate_snapshot_key}' =
        'fxr_eeeeeeeeeeeeeeeeeeeeeeee'
    from frictionless_test_state quote
    where quote.state_key = 'eur_quote'
  )
  and (
    select redemption.json_value #>> '{redemption,currency}' = 'EUR'
      and (redemption.json_value #>> '{redemption,amount_minor}')::bigint = 454
      and (redemption.json_value #>> '{redemption,reference_amount_minor}')::bigint = 499
      and (redemption.json_value #>> '{balance,available_minor}')::bigint = 45
    from frictionless_test_state redemption
    where redemption.state_key = 'eur_redeem'
  )
  and exists (
    select 1
    from affiliate_private.affiliate_access_credit_redemptions redemption
    join affiliate_private.affiliate_fx_rate_snapshots rate
      on rate.id = redemption.fx_rate_snapshot_id
    where redemption.currency = 'EUR'
      and redemption.amount_minor = 454
      and redemption.reference_currency = 'USD'
      and redemption.reference_amount_minor = 499
      and rate.snapshot_key = 'fxr_eeeeeeeeeeeeeeeeeeeeeeee'
  ),
  'a non-USD balance converts without KYC through one immutable exact FX quote'
);

select * from extensions.finish();
rollback;

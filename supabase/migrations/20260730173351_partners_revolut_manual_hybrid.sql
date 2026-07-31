-- Norva Partners - Revolut Business Basic manual payout rail and dormant API.
--
-- Production default:
--   * real ledger allocation and J+45 maturation remain authoritative;
--   * Norva prepares immutable, exact-money batches;
--   * a Finance operator validates and enters every transfer in Revolut;
--   * a second Finance control reconciles normalized statement evidence;
--   * no raw statement, IBAN, beneficiary name or bank account is persisted.
--
-- Future upgrade:
--   * the Revolut Business API worker is implemented against the same execution
--     records, but cannot lease a job unless BOTH the managed database flag and
--     the Edge environment kill-switch are explicitly enabled;
--   * switching a route never changes the adapter snapshotted on an existing
--     payout item or execution.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Release controls and corridor adapter snapshot
-- ---------------------------------------------------------------------------

alter table affiliate_private.affiliate_release_gates
  drop constraint affiliate_release_gates_key;
alter table affiliate_private.affiliate_release_gates
  add constraint affiliate_release_gates_key
  check (
    gate_key in (
      'legal_and_tax_approved',
      'privacy_approved',
      'individual_verification_coverage_confirmed',
      'individual_payout_coverage_confirmed',
      'country_policy_approved',
      'financial_data_contract_approved',
      'shadow_reconciliation_clean',
      'backup_restore_verified',
      'payout_execution_adapter_verified',
      'tv_relay_security_verified',
      'general_release_approved',
      'manual_payout_workflow_verified',
      'revolut_api_adapter_verified'
    )
  );

insert into affiliate_private.affiliate_release_gates (gate_key)
values
  ('manual_payout_workflow_verified'),
  ('revolut_api_adapter_verified')
on conflict (gate_key) do nothing;

create or replace function affiliate_private.is_managed_partners_flag(
  p_key text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(p_key, '') = any (
    array[
      'partners_enabled',
      'partners_invite_only',
      'partners_shadow_mode',
      'partners_payouts_live',
      'partners_tv_relay_enabled',
      'partners_revolut_api_enabled'
    ]::text[]
  );
$$;

-- The managed-flag trigger from the foundation migration intentionally blocks
-- direct writes. Migrations run as the table owner, but must still opt in to
-- the same narrow control context used by admin_partners_control().
select set_config(
  'norva.partners_control',
  'admin_partners_control',
  true
);

insert into public.admin_feature_flags (
  key,
  enabled,
  description,
  updated_at,
  updated_by
)
values (
  'partners_revolut_api_enabled',
  false,
  'Allows the dormant Revolut Business API payout worker after its dedicated release gate is verified.',
  now(),
  'migration'
)
on conflict (key) do update
set
  enabled = false,
  description = excluded.description,
  updated_at = now(),
  updated_by = 'migration';

select set_config('norva.partners_control', '', true);

-- Extend the existing granular Admin control map so the new gates and flag are
-- configurable without weakening any previous Support/Risk/Finance boundary.
create or replace function
affiliate_private.partners_require_control_access(
  p_action text,
  p_key text,
  p_enabled boolean
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_key text := lower(btrim(coalesce(p_key, '')));
  v_support boolean :=
    affiliate_private.partners_has_capability('support');
  v_risk boolean :=
    affiliate_private.partners_has_capability('risk');
  v_finance boolean :=
    affiliate_private.partners_has_capability('finance');
  v_release boolean :=
    affiliate_private.partners_is_release_manager();
  v_allowed boolean := false;
begin
  if v_action = 'set_allowlist' then
    v_allowed := case
      when p_enabled is true then v_risk
      when p_enabled is false then v_support or v_risk
      else v_risk
    end;
  elsif v_action = 'set_gate' then
    if v_key = any (
      array[
        'legal_and_tax_approved',
        'individual_payout_coverage_confirmed',
        'financial_data_contract_approved',
        'shadow_reconciliation_clean',
        'backup_restore_verified',
        'payout_execution_adapter_verified',
        'manual_payout_workflow_verified',
        'revolut_api_adapter_verified'
      ]::text[]
    ) then
      v_allowed := v_finance;
    elsif v_key = any (
      array[
        'privacy_approved',
        'individual_verification_coverage_confirmed',
        'country_policy_approved',
        'tv_relay_security_verified'
      ]::text[]
    ) then
      v_allowed := v_risk;
    elsif v_key = 'general_release_approved' then
      v_allowed := v_release;
    end if;
  elsif v_action = 'set_flag' then
    if v_key = 'partners_payouts_live' then
      v_allowed := v_finance and v_release;
    elsif v_key = 'partners_shadow_mode' then
      v_allowed := v_finance;
    elsif v_key = 'partners_enabled' then
      v_allowed := v_release
        or (p_enabled is false and v_support);
    elsif v_key = 'partners_invite_only' then
      v_allowed := v_release;
    elsif v_key = 'partners_tv_relay_enabled' then
      v_allowed := case
        when p_enabled is true then v_release and v_risk
        when p_enabled is false then v_release or v_risk or v_support
        else v_release and v_risk
      end;
    elsif v_key = 'partners_revolut_api_enabled' then
      v_allowed := case
        when p_enabled is true then v_finance and v_release
        when p_enabled is false then
          v_finance or v_release or v_support
        else v_finance and v_release
      end;
    end if;
  end if;

  if not coalesce(v_allowed, false) then
    raise exception 'Partners control capability is required'
      using errcode = '42501';
  end if;
  if p_enabled is true
    and (
      (
        v_action = 'set_gate'
        and v_key = any (
          array[
            'legal_and_tax_approved',
            'individual_payout_coverage_confirmed',
            'financial_data_contract_approved',
            'shadow_reconciliation_clean',
            'backup_restore_verified',
            'payout_execution_adapter_verified',
            'manual_payout_workflow_verified',
            'revolut_api_adapter_verified'
          ]::text[]
        )
      )
      or (
        v_action = 'set_flag'
        and v_key in (
          'partners_payouts_live',
          'partners_revolut_api_enabled'
        )
      )
    )
    and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
  then
    raise exception 'financial Partners activation requires AAL2'
      using errcode = '42501';
  end if;
end;
$$;

alter function affiliate_private.partners_ops_alert_snapshot()
rename to partners_ops_alert_snapshot_pre_revolut_basic;

revoke all on function
  affiliate_private.partners_ops_alert_snapshot_pre_revolut_basic()
from public, anon, authenticated, service_role;

create or replace function affiliate_private.partners_ops_alert_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_workers jsonb;
  v_alerts jsonb;
  v_missing_workers bigint;
  v_manual_actions bigint;
begin
  v_base :=
    affiliate_private.partners_ops_alert_snapshot_pre_revolut_basic();

  select coalesce(jsonb_agg(worker_item order by worker_item ->> 'worker'), '[]')
  into v_workers
  from jsonb_array_elements(coalesce(v_base -> 'workers', '[]')) worker_item
  where worker_item ->> 'worker' <> 'payout';

  select coalesce(jsonb_agg(alert_item), '[]')
  into v_alerts
  from jsonb_array_elements(coalesce(v_base -> 'alerts', '[]')) alert_item
  where alert_item ->> 'code' <> 'worker_heartbeat_missing';

  select count(*)
  into v_missing_workers
  from (
    values
      ('commission'::text),
      ('correction'::text),
      ('maturation'::text),
      ('reconciliation'::text),
      ('revenuecat_transfer'::text)
  ) expected(worker_name)
  left join affiliate_private.affiliate_worker_heartbeats heartbeat
    on heartbeat.worker_name = expected.worker_name
    and heartbeat.last_seen_at >= now() - interval '15 minutes'
  where heartbeat.worker_name is null;
  if v_missing_workers > 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'worker_heartbeat_missing',
      'severity', 'critical',
      'count', v_missing_workers
    ));
  end if;

  select
    (
      select count(*)
      from affiliate_private.affiliate_revolut_manual_cancellations
      where status = 'pending'
    )
    + (
      select count(*)
      from affiliate_private.affiliate_revolut_manual_unmapped_requests
      where status = 'pending'
    )
    + (
      select count(*)
      from affiliate_private.affiliate_revolut_reconciliation_incidents incident
      where not exists (
        select 1
        from
          affiliate_private
            .affiliate_revolut_reconciliation_incident_decisions decision
        where decision.incident_id = incident.id
          and decision.action <> 'quarantine'
      )
    )
    + (
      select count(distinct observation.id)
      from affiliate_private.affiliate_revolut_return_observations observation
      left join affiliate_private.affiliate_revolut_return_decisions decision
        on decision.observation_id = observation.id
      where decision.id is null or decision.decision = 'quarantined'
    )
    + (
      select count(distinct observation.id)
      from
        affiliate_private.affiliate_revolut_late_completion_observations
          observation
      left join
        affiliate_private.affiliate_revolut_late_completion_decisions decision
        on decision.observation_id = observation.id
      where decision.id is null or decision.decision = 'quarantined'
    )
  into v_manual_actions;
  if v_manual_actions > 0 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'code', 'revolut_manual_action_required',
      'severity', 'warning',
      'count', v_manual_actions
    ));
  end if;

  return jsonb_set(
    jsonb_set(v_base, '{workers}', v_workers, true),
    '{alerts}',
    v_alerts,
    true
  ) || jsonb_build_object(
    'payout_mode', 'revolut_manual',
    'manual_action_required', v_manual_actions
  );
end;
$$;

revoke all on function
  affiliate_private.partners_ops_alert_snapshot()
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_ops_alert_snapshot()
to service_role;

create or replace function
affiliate_private.admin_partners_revolut_reconciliation_incident_decide(
  p_review_key text,
  p_decision text,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_review_key, '')));
  v_checker_decision text := lower(btrim(coalesce(p_decision, '')));
  v_search_hash text := lower(
    btrim(coalesce(p_provider_search_evidence_hash, ''))
  );
  v_search_at timestamptz :=
    date_trunc('second', p_provider_search_observed_at);
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_hash text;
  v_target_token text;
  v_verdict_token text;
  v_effective_action text;
  -- The private evidence tables are created later in this migration. RECORD
  -- keeps this early fail-closed definition installable; every relation is
  -- resolved when the RPC is executed after the migration commits.
  v_review record;
  v_incident record;
  v_row record;
  v_execution record;
  v_batch record;
  v_item record;
  v_cycle record;
  v_account record;
  v_allocation record;
  v_resolution record;
  v_alias_id uuid;
  v_decision record;
  v_remaining integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'reconciliation incident decision requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rir_[0-9a-f]{24}$'
    or v_checker_decision not in ('approved', 'quarantined')
    or v_search_hash !~ '^[0-9a-f]{64}$'
    or p_provider_search_observed_at is null
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid reconciliation incident decision'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  select review.*
  into v_review
  from
    affiliate_private
      .affiliate_revolut_reconciliation_incident_reviews review
  where review.review_key = v_key;
  if not found then
    raise exception 'reconciliation incident review is unavailable'
      using errcode = 'P0002';
  end if;
  select incident.*
  into v_incident
  from affiliate_private.affiliate_revolut_reconciliation_incidents
    incident
  where incident.id = v_review.incident_id
  for update;
  if not found then
    raise exception 'reconciliation incident is unavailable'
      using errcode = 'P0002';
  end if;
  select review.*
  into v_review
  from
    affiliate_private
      .affiliate_revolut_reconciliation_incident_reviews review
  where review.id = v_review.id;
  select row.*
  into v_row
  from affiliate_private.affiliate_revolut_statement_rows row
  where row.id = v_incident.statement_row_id;
  if not found
    or v_row.statement_row_hash <> v_incident.source_evidence_hash
  then
    raise exception 'reconciliation source evidence is unavailable'
      using errcode = 'P0004';
  end if;

  v_target_token := coalesce(v_review.target_reference, 'NONE');
  v_verdict_token := case v_checker_decision
    when 'approved' then 'APPROVE'
    else 'QUARANTINE'
  end;
  v_effective_action := case
    when v_checker_decision = 'quarantined' then 'quarantine'
    else v_review.proposed_action
  end;
  if v_confirmation <>
      concat_ws(
        ':',
        'DECIDE-RECON',
        v_key,
        v_verdict_token,
        upper(v_review.proposed_action),
        v_target_token,
        left(v_incident.source_provider_transaction_hash, 12),
        v_incident.source_amount_minor::text,
        v_incident.source_currency,
        floor(extract(epoch from v_search_at))::bigint::text
      )
  then
    raise exception 'invalid typed reconciliation decision confirmation'
      using errcode = '22023';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_actor = v_review.review_actor_pseudonym then
    raise exception
      'incident reviewer and decision checker require distinct Finance actors'
      using errcode = '42501';
  end if;
  v_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:reconciliation-incident-decision:v1',
        v_actor,
        v_incident.source_evidence_hash,
        v_review.confirmation_hash,
        v_checker_decision,
        v_review.proposed_action,
        v_target_token,
        v_search_hash,
        v_search_at::text,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  select decision.*
  into v_decision
  from
    affiliate_private
      .affiliate_revolut_reconciliation_incident_decisions decision
  where decision.review_id = v_review.id;
  if found then
    if v_decision.action is distinct from v_effective_action
      or v_decision.decision_actor_pseudonym is distinct from v_actor
      or v_decision.provider_search_evidence_hash is distinct from
        v_search_hash
      or v_decision.provider_search_observed_at is distinct from
        v_search_at
      or v_decision.confirmation_hash is distinct from v_hash
      or v_decision.justification is distinct from v_justification
    then
      raise exception 'incident review already has another decision'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_reconciliation_incident_decided',
      'replayed', true,
      'decision', jsonb_build_object(
        'key', v_decision.decision_key,
        'incident_key', v_incident.incident_key,
        'status', case
          when v_decision.action = 'quarantine' then 'quarantined'
          else 'resolved'
        end,
        'verdict', v_checker_decision,
        'resolution', v_decision.action,
        'target_reference', v_review.target_reference
      )
    );
  end if;

  if v_search_at < now() - interval '2 minutes'
    or v_search_at > now() + interval '30 seconds'
    or v_search_at <= v_review.provider_search_observed_at
    or v_search_hash = v_review.provider_search_evidence_hash
  then
    raise exception
      'checker requires a distinct, newer fresh Revolut search'
      using errcode = 'P0004';
  end if;
  if exists (
    select 1
    from
      affiliate_private
        .affiliate_revolut_reconciliation_incident_decisions decision
    where decision.incident_id = v_incident.id
      and decision.action <> 'quarantine'
  ) then
    raise exception 'reconciliation incident is already resolved'
      using errcode = 'P0003';
  end if;

  if v_effective_action = 'quarantine' then
    insert into
      affiliate_private.affiliate_revolut_reconciliation_incident_decisions (
        incident_id,
        review_id,
        action,
        decision_actor_pseudonym,
        provider_search_evidence_hash,
        provider_search_observed_at,
        confirmation_hash,
        justification
      )
    values (
      v_incident.id,
      v_review.id,
      'quarantine',
      v_actor,
      v_search_hash,
      v_search_at,
      v_hash,
      v_justification
    )
    returning * into v_decision;
  else
    select execution.*
    into v_execution
    from affiliate_private.affiliate_revolut_payout_executions execution
    where execution.id = v_review.target_execution_id;
    if not found or v_execution.manual_batch_id is null then
      raise exception 'target execution is unavailable'
        using errcode = 'P0002';
    end if;
    select batch.*
    into v_batch
    from affiliate_private.affiliate_revolut_manual_batches batch
    where batch.id = v_execution.manual_batch_id;
    if not found then
      raise exception 'target manual batch is unavailable'
        using errcode = 'P0002';
    end if;
    perform pg_advisory_xact_lock(
      hashtextextended(
        'norva:partners:revolut-manual-batch:' || v_batch.batch_key,
        0
      )
    );
    select batch.*
    into v_batch
    from affiliate_private.affiliate_revolut_manual_batches batch
    where batch.id = v_execution.manual_batch_id
    for update;

    select item.*
    into v_item
    from affiliate_private.affiliate_payout_items item
    where item.id = v_execution.payout_item_id;
    if not found then
      raise exception 'target payout item is unavailable'
        using errcode = 'P0002';
    end if;
    select account.*
    into v_account
    from affiliate_private.affiliate_accounts account
    where account.id = v_item.account_id
    for update;
    if not found or v_account.status <> 'active' then
      raise exception 'target Partner account must remain active'
        using errcode = '55000';
    end if;
    perform affiliate_private.partners_balance_lock(
      v_account.id,
      v_execution.currency
    );

    select execution.*
    into v_execution
    from affiliate_private.affiliate_revolut_payout_executions execution
    where execution.id = v_review.target_execution_id
    for update;
    select item.*
    into v_item
    from affiliate_private.affiliate_payout_items item
    where item.id = v_execution.payout_item_id
    for update;
    select cycle.*
    into v_cycle
    from affiliate_private.affiliate_payout_cycles cycle
    where cycle.id = v_item.cycle_id
    for update;
    select allocation.*
    into v_allocation
    from affiliate_private.affiliate_commission_entries allocation
    where allocation.id = v_item.allocation_entry_id
      and allocation.entry_kind = 'payout_allocation'
    for update;

    if v_execution.adapter <> 'revolut_manual'
      or v_execution.manual_batch_id <> v_batch.id
      or v_execution.payout_reference <> v_review.target_reference
      or v_execution.amount_minor <> v_review.target_amount_minor
      or v_execution.currency <> v_review.target_currency
      or v_execution.currency_exponent <>
        v_review.target_currency_exponent
      or v_item.status not in ('pending', 'submitted')
      or v_item.account_id <> v_account.id
      or v_item.amount_minor <> v_execution.amount_minor
      or v_item.currency <> v_execution.currency
      or v_allocation.id is null
      or v_allocation.account_id <> v_account.id
      or v_allocation.amount_minor <> v_execution.amount_minor
      or v_allocation.currency <> v_execution.currency
      or v_allocation.currency_exponent <>
        v_execution.currency_exponent
      or v_cycle.id is null
      or v_cycle.status not in ('approved', 'submitted')
      or not v_cycle.live_execution
      or exists (
        select 1
        from affiliate_private.affiliate_commission_entries resolution
        where resolution.related_entry_id = v_allocation.id
          and resolution.entry_kind in (
            'payout_settlement',
            'payout_release'
          )
      )
      or exists (
        select 1
        from
          affiliate_private
            .affiliate_revolut_reconciliation_incident_decisions decision
        where decision.target_execution_id = v_execution.id
          and decision.action <> 'quarantine'
      )
    then
      raise exception 'target payout disposition changed during decision'
        using errcode = 'P0004';
    end if;
    if v_actor in (
      coalesce(v_execution.submitted_by_pseudonym, ''),
      coalesce(v_batch.submitted_by_pseudonym, ''),
      coalesce(v_batch.exported_by_pseudonym, '')
    ) then
      raise exception
        'submitter or exporter cannot decide reconciliation incident'
        using errcode = '42501';
    end if;

    if v_effective_action in (
      'settle_exact',
      'remap_exact_and_settle'
    ) then
      if v_row.provider_state <> 'COMPLETED'
        or v_row.amount_minor <> v_execution.amount_minor
        or v_row.currency <> v_execution.currency
        or exists (
          select 1
          from affiliate_private.affiliate_revolut_payout_executions other
          where other.provider_transaction_hash =
            v_row.provider_transaction_hash
            and other.id <> v_execution.id
        )
      then
        raise exception
          'exact settlement evidence is partial, cross-currency or reused'
          using errcode = 'P0004';
      end if;
      if v_effective_action = 'settle_exact'
        and (
          v_incident.source_execution_id <> v_execution.id
          or v_execution.provider_transaction_hash is distinct from
            v_row.provider_transaction_hash
        )
      then
        raise exception
          'settle_exact requires the unchanged statement identity'
          using errcode = 'P0004';
      end if;
      if v_effective_action = 'remap_exact_and_settle'
        and v_execution.provider_transaction_hash is not distinct from
          v_row.provider_transaction_hash
      then
        raise exception 'remap requires an absent or superseded identity'
          using errcode = 'P0004';
      end if;

      insert into affiliate_private.affiliate_commission_entries (
        account_id,
        entry_kind,
        related_entry_id,
        currency,
        currency_exponent,
        amount_minor
      )
      values (
        v_account.id,
        'payout_settlement',
        v_allocation.id,
        v_execution.currency,
        v_execution.currency_exponent,
        v_execution.amount_minor
      )
      returning * into v_resolution;
      insert into affiliate_private.affiliate_commission_postings (
        entry_id,
        ledger_account,
        direction,
        amount_minor,
        currency
      )
      values
        (
          v_resolution.id,
          'partner_payout_clearing',
          'debit',
          v_execution.amount_minor,
          v_execution.currency
        ),
        (
          v_resolution.id,
          'partner_cash_settled',
          'credit',
          v_execution.amount_minor,
          v_execution.currency
        );

      if v_effective_action = 'remap_exact_and_settle' then
        insert into
          affiliate_private.affiliate_revolut_transaction_aliases (
            incident_id,
            review_id,
            execution_id,
            superseded_provider_transaction_hash,
            authoritative_provider_transaction_hash,
            source_evidence_hash
          )
        values (
          v_incident.id,
          v_review.id,
          v_execution.id,
          v_execution.provider_transaction_hash,
          v_row.provider_transaction_hash,
          v_row.statement_row_hash
        )
        returning id into v_alias_id;
      end if;

      insert into
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions (
            incident_id,
            review_id,
            target_execution_id,
            action,
            decision_actor_pseudonym,
            provider_search_evidence_hash,
            provider_search_observed_at,
            confirmation_hash,
            justification,
            resolution_entry_id,
            alias_id
          )
      values (
        v_incident.id,
        v_review.id,
        v_execution.id,
        v_effective_action,
        v_actor,
        v_search_hash,
        v_search_at,
        v_hash,
        v_justification,
        v_resolution.id,
        v_alias_id
      )
      returning * into v_decision;

      update affiliate_private.affiliate_payout_items item
      set
        status = 'settled',
        provider_transfer_hash = v_row.provider_transaction_hash,
        updated_at = now()
      where item.id = v_item.id
        and item.status in ('pending', 'submitted');
      if not found then
        raise exception 'target payout item changed during settlement'
          using errcode = 'P0004';
      end if;
      update affiliate_private.affiliate_revolut_payout_executions execution
      set
        state = 'paid',
        reconciliation_status = 'confirmed',
        job_status = 'settled',
        worker_id = null,
        lease_token_hash = null,
        leased_until = null,
        paid_observed_at = coalesce(
          execution.paid_observed_at,
          v_row.observed_at
        ),
        last_error_code = null,
        updated_at = now()
      where execution.id = v_execution.id;

      select count(*)::integer
      into v_remaining
      from affiliate_private.affiliate_payout_items item
      where item.cycle_id = v_cycle.id
        and item.status <> 'settled';
      if v_remaining = 0 then
        update affiliate_private.affiliate_payout_cycles cycle
        set
          status = 'settled',
          settled_at = now(),
          updated_at = now()
        where cycle.id = v_cycle.id
          and cycle.status in ('approved', 'submitted');
        update affiliate_private.affiliate_revolut_manual_batches batch
        set
          status = 'settled',
          settled_at = now(),
          updated_at = now()
        where batch.id = v_batch.id
          and batch.status in (
            'submitted',
            'partially_reconciled',
            'exception'
          );
      else
        perform affiliate_private.refresh_revolut_payout_aggregate(
          v_execution.id
        );
      end if;
    else
      if not exists (
        select 1
        from affiliate_private.affiliate_revolut_return_observations
          return_observation
        join affiliate_private.affiliate_revolut_statement_rows return_row
          on return_row.id = return_observation.statement_row_id
        where return_observation.execution_id = v_execution.id
          and return_observation.provider_state in (
            'FAILED',
            'CANCELLED',
            'REVERTED'
          )
          and return_observation.amount_minor = v_execution.amount_minor
          and return_observation.currency = v_execution.currency
          and return_row.execution_id = v_execution.id
          and return_row.provider_state =
            return_observation.provider_state
          and return_row.amount_minor = v_execution.amount_minor
          and return_row.currency = v_execution.currency
          and return_row.payout_reference = v_execution.payout_reference
          and return_row.provider_transaction_hash =
            v_incident.source_provider_transaction_hash
          and return_observation.observed_at + interval '7 days' <= now()
      ) then
        raise exception
          'release_after_return requires exact terminal return evidence and cooldown'
          using errcode = 'P0004';
      end if;
      insert into affiliate_private.affiliate_commission_entries (
        account_id,
        entry_kind,
        related_entry_id,
        currency,
        currency_exponent,
        amount_minor
      )
      values (
        v_account.id,
        'payout_release',
        v_allocation.id,
        v_execution.currency,
        v_execution.currency_exponent,
        v_execution.amount_minor
      )
      returning * into v_resolution;
      insert into affiliate_private.affiliate_commission_postings (
        entry_id,
        ledger_account,
        direction,
        amount_minor,
        currency
      )
      values
        (
          v_resolution.id,
          'partner_payout_clearing',
          'debit',
          v_execution.amount_minor,
          v_execution.currency
        ),
        (
          v_resolution.id,
          'partner_commission_available',
          'credit',
          v_execution.amount_minor,
          v_execution.currency
        );
      insert into
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions (
            incident_id,
            review_id,
            target_execution_id,
            action,
            decision_actor_pseudonym,
            provider_search_evidence_hash,
            provider_search_observed_at,
            confirmation_hash,
            justification,
            resolution_entry_id
          )
      values (
        v_incident.id,
        v_review.id,
        v_execution.id,
        'release_after_return',
        v_actor,
        v_search_hash,
        v_search_at,
        v_hash,
        v_justification,
        v_resolution.id
      )
      returning * into v_decision;
      update affiliate_private.affiliate_payout_items item
      set status = 'failed', updated_at = now()
      where item.id = v_item.id
        and item.status in ('pending', 'submitted');
      update affiliate_private.affiliate_revolut_payout_executions execution
      set
        state = 'cancelled',
        reconciliation_status = 'confirmed',
        job_status = 'exception',
        worker_id = null,
        lease_token_hash = null,
        leased_until = null,
        next_attempt_at = now() + interval '100 years',
        last_error_code = 'reconciliation_release_confirmed',
        updated_at = now()
      where execution.id = v_execution.id;
      perform affiliate_private.refresh_revolut_payout_aggregate(
        v_execution.id
      );
    end if;
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_incident.incident_key,
    'revolut_reconciliation_incident_decided',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'decision_key', v_decision.decision_key,
      'verdict', v_checker_decision,
      'resolution', v_decision.action,
      'status', case
        when v_decision.action = 'quarantine' then 'quarantined'
        else 'resolved'
      end,
      'target_reference', v_review.target_reference,
      'source_reference', v_incident.source_reference,
      'amount_minor', v_incident.source_amount_minor,
      'currency', v_incident.source_currency
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_reconciliation_incident_decided',
    'replayed', false,
    'decision', jsonb_build_object(
      'key', v_decision.decision_key,
      'incident_key', v_incident.incident_key,
      'status', case
        when v_decision.action = 'quarantine' then 'quarantined'
        else 'resolved'
      end,
      'verdict', v_checker_decision,
      'resolution', v_decision.action,
      'target_reference', v_review.target_reference
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_reconciliation_incidents(
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default 'action_required'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'action_required')));
  v_total bigint;
  v_action_required bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'reconciliation incident queue requires AAL2'
      using errcode = '42501';
  end if;
  if v_status not in (
    'all',
    'action_required',
    'open',
    'quarantined',
    'resolved'
  ) then
    raise exception 'invalid reconciliation incident status filter'
      using errcode = '22023';
  end if;

  with derived as (
    select
      incident.*,
      case
        when terminal.id is not null then 'resolved'
        when latest.action = 'quarantine' then 'quarantined'
        else 'open'
      end as derived_status
    from affiliate_private.affiliate_revolut_reconciliation_incidents
      incident
    left join lateral (
      select decision.*
      from
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions decision
      where decision.incident_id = incident.id
        and decision.action <> 'quarantine'
      order by decision.created_at desc, decision.id desc
      limit 1
    ) terminal on true
    left join lateral (
      select decision.*
      from
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions decision
      where decision.incident_id = incident.id
      order by decision.created_at desc, decision.id desc
      limit 1
    ) latest on true
  )
  select
    count(*) filter (
      where v_status = 'all'
        or (
          v_status = 'action_required'
          and derived_status in ('open', 'quarantined')
        )
        or derived_status = v_status
    ),
    count(*) filter (
      where derived_status in ('open', 'quarantined')
    )
  into v_total, v_action_required
  from derived;

  with rows as (
    select
      incident.*,
      row.value_date,
      case
        when terminal.id is not null then 'resolved'
        when latest.action = 'quarantine' then 'quarantined'
        else 'open'
      end as derived_status,
      terminal.action as terminal_action,
      terminal.created_at as resolved_at,
      alias.alias_key,
      alias.superseded_provider_transaction_hash,
      alias.authoritative_provider_transaction_hash,
      source_currency.exponent as source_currency_exponent,
      expected_currency.exponent as expected_currency_exponent,
      pending_review.review_key as pending_review_key,
      pending_review.proposed_action,
      pending_review.target_reference,
      pending_review.created_at as review_requested_at,
      exists (
        select 1
        from affiliate_private.affiliate_revolut_return_observations
          return_observation
        join affiliate_private.affiliate_revolut_statement_rows return_row
          on return_row.id = return_observation.statement_row_id
        join affiliate_private.affiliate_revolut_payout_executions
          return_execution
          on return_execution.id = return_observation.execution_id
        where return_observation.execution_id =
            incident.source_execution_id
          and return_observation.provider_state in (
            'FAILED',
            'CANCELLED',
            'REVERTED'
          )
          and return_observation.amount_minor =
            return_execution.amount_minor
          and return_observation.currency = return_execution.currency
          and return_row.provider_transaction_hash =
            incident.source_provider_transaction_hash
          and return_row.payout_reference =
            return_execution.payout_reference
          and return_observation.observed_at + interval '7 days' <= now()
      ) as has_terminal_return_evidence,
      case incident.incident_kind
        when 'currency_mismatch' then 1
        when 'amount_mismatch' then 1
        when 'transaction_mismatch' then 2
        when 'execution_state_mismatch' then 2
        when 'unknown_reference' then 3
        else 4
      end as priority
    from affiliate_private.affiliate_revolut_reconciliation_incidents
      incident
    join affiliate_private.affiliate_revolut_statement_rows row
      on row.id = incident.statement_row_id
    left join lateral (
      select decision.*
      from
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions decision
      where decision.incident_id = incident.id
        and decision.action <> 'quarantine'
      order by decision.created_at desc, decision.id desc
      limit 1
    ) terminal on true
    left join affiliate_private.affiliate_revolut_transaction_aliases alias
      on alias.id = terminal.alias_id
    left join affiliate_private.affiliate_currency_metadata source_currency
      on source_currency.currency_code = incident.source_currency
    left join affiliate_private.affiliate_currency_metadata expected_currency
      on expected_currency.currency_code = incident.expected_currency
    left join lateral (
      select decision.*
      from
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions decision
      where decision.incident_id = incident.id
      order by decision.created_at desc, decision.id desc
      limit 1
    ) latest on true
    left join lateral (
      select review.*
      from
        affiliate_private
          .affiliate_revolut_reconciliation_incident_reviews review
      where review.incident_id = incident.id
        and not exists (
          select 1
          from
            affiliate_private
              .affiliate_revolut_reconciliation_incident_decisions decision
          where decision.review_id = review.id
        )
      order by review.review_cycle desc
      limit 1
    ) pending_review on true
  ),
  paged as (
    select *
    from rows
    where v_status = 'all'
      or (
        v_status = 'action_required'
        and derived_status in ('open', 'quarantined')
      )
      or derived_status = v_status
    order by
      case when derived_status = 'resolved' then 1 else 0 end,
      priority,
      observed_at,
      incident_key
    limit v_limit offset v_offset
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', paged.incident_key,
        'status', paged.derived_status,
        'priority', paged.priority,
        'kind', paged.incident_kind,
        'source_reference', paged.source_reference,
        'source_transaction_fingerprint',
          left(paged.source_provider_transaction_hash, 12),
        'source_state', paged.source_provider_state,
        'source_amount_minor', paged.source_amount_minor,
        'source_currency', paged.source_currency,
        'source_currency_exponent', paged.source_currency_exponent,
        'expected_reference', paged.expected_reference,
        'expected_amount_minor', paged.expected_amount_minor,
        'expected_currency', paged.expected_currency,
        'expected_currency_exponent', paged.expected_currency_exponent,
        'value_date', paged.value_date,
        'observed_at', paged.observed_at,
        'pending_review', case
          when paged.pending_review_key is null then null
          else jsonb_build_object(
            'key', paged.pending_review_key,
            'proposed_action', paged.proposed_action,
            'target_reference', paged.target_reference,
            'requested_at', paged.review_requested_at
          )
        end,
        'resolution', paged.terminal_action,
        'resolved_at', paged.resolved_at,
        'transaction_alias', case
          when paged.alias_key is null then null
          else jsonb_build_object(
            'key', paged.alias_key,
            'superseded_transaction_fingerprint',
              left(paged.superseded_provider_transaction_hash, 12),
            'authoritative_transaction_fingerprint',
              left(paged.authoritative_provider_transaction_hash, 12)
          )
        end,
        'eligible_actions', case
          when paged.derived_status = 'resolved' then '[]'::jsonb
          else
            case
              when paged.source_provider_state = 'COMPLETED'
                and paged.source_execution_id is not null
                and paged.source_amount_minor =
                  paged.expected_amount_minor
                and paged.source_currency = paged.expected_currency
                and paged.source_provider_transaction_hash is not distinct
                  from paged.expected_provider_transaction_hash
                then jsonb_build_array('settle_exact')
              else '[]'::jsonb
            end
            || case
              when paged.source_provider_state = 'COMPLETED'
                and paged.incident_kind in (
                  'unknown_reference',
                  'transaction_mismatch'
                )
                then jsonb_build_array('remap_exact_and_settle')
              else '[]'::jsonb
            end
            || case
              when paged.has_terminal_return_evidence
                then jsonb_build_array('release_after_return')
              else '[]'::jsonb
            end
            || jsonb_build_array('quarantine')
        end
      )
      order by
        case when paged.derived_status = 'resolved' then 1 else 0 end,
        paged.priority,
        paged.observed_at,
        paged.incident_key
    ),
    '[]'::jsonb
  )
  into v_items
  from paged;

  return jsonb_build_object(
    'schema_version', 1,
    'filter', v_status,
    'total', v_total,
    'action_required', v_action_required,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_reconciliation_incident_review(
  p_incident_key text,
  p_action text,
  p_target_reference text,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  raise exception 'reconciliation incident schema is still installing'
    using errcode = '55000';
end;
$$;

create or replace function
public.admin_partners_revolut_reconciliation_incident_review(
  p_incident_key text,
  p_action text,
  p_target_reference text,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private
      .admin_partners_revolut_reconciliation_incident_review(
        p_incident_key,
        p_action,
        p_target_reference,
        p_provider_search_evidence_hash,
        p_provider_search_observed_at,
        p_confirmation,
        p_justification
      );
$$;

create or replace function
public.admin_partners_revolut_reconciliation_incident_decide(
  p_review_key text,
  p_decision text,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private
      .admin_partners_revolut_reconciliation_incident_decide(
        p_review_key,
        p_decision,
        p_provider_search_evidence_hash,
        p_provider_search_observed_at,
        p_confirmation,
        p_justification
      );
$$;

create or replace function
public.admin_partners_revolut_reconciliation_incidents(
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default 'action_required'
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_reconciliation_incidents(
      p_limit,
      p_offset,
      p_status
    );
$$;

revoke all on function
  affiliate_private.admin_partners_revolut_reconciliation_incident_review(
    text, text, text, text, timestamptz, text, text
  ),
  affiliate_private.admin_partners_revolut_reconciliation_incident_decide(
    text, text, text, timestamptz, text, text
  ),
  affiliate_private.admin_partners_revolut_reconciliation_incidents(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_reconciliation_incident_review(
    text, text, text, text, timestamptz, text, text
  ),
  affiliate_private.admin_partners_revolut_reconciliation_incident_decide(
    text, text, text, timestamptz, text, text
  ),
  affiliate_private.admin_partners_revolut_reconciliation_incidents(
    integer, integer, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_reconciliation_incident_review(
    text, text, text, text, timestamptz, text, text
  ),
  public.admin_partners_revolut_reconciliation_incident_decide(
    text, text, text, timestamptz, text, text
  ),
  public.admin_partners_revolut_reconciliation_incidents(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_reconciliation_incident_review(
    text, text, text, text, timestamptz, text, text
  ),
  public.admin_partners_revolut_reconciliation_incident_decide(
    text, text, text, timestamptz, text, text
  ),
  public.admin_partners_revolut_reconciliation_incidents(
    integer, integer, text
  )
to authenticated;

create or replace function
affiliate_private.reject_revolut_evidence_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Revolut payout evidence is append-only'
    using errcode = '55000';
end;
$$;

create table
affiliate_private.affiliate_revolut_reconciliation_incidents (
  id                       uuid primary key default gen_random_uuid(),
  incident_key             text not null unique default (
    'rri_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  statement_row_id         uuid not null unique,
  source_execution_id      uuid,
  source_evidence_hash     text not null unique,
  incident_kind            text not null,
  source_reference         text not null,
  source_provider_transaction_hash text not null,
  source_provider_state    text not null,
  source_amount_minor      bigint not null,
  source_currency          text not null,
  expected_reference       text,
  expected_provider_transaction_hash text,
  expected_amount_minor    bigint,
  expected_currency        text,
  observed_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_reconciliation_incidents_key
    check (incident_key ~ '^rri_[0-9a-f]{24}$'),
  constraint affiliate_revolut_reconciliation_incidents_hashes
    check (
      source_evidence_hash ~ '^[0-9a-f]{64}$'
      and source_provider_transaction_hash ~ '^[0-9a-f]{64}$'
      and (
        expected_provider_transaction_hash is null
        or expected_provider_transaction_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_reconciliation_incidents_kind
    check (
      incident_kind in (
        'unknown_reference',
        'provider_not_completed',
        'amount_mismatch',
        'currency_mismatch',
        'transaction_mismatch',
        'execution_state_mismatch'
      )
    ),
  constraint affiliate_revolut_reconciliation_incidents_source
    check (
      source_reference ~ '^NORVA-[A-F0-9]{12}$'
      and source_provider_state in (
        'CREATED',
        'PENDING',
        'PROCESSING',
        'COMPLETED',
        'FAILED',
        'REVERTED',
        'CANCELLED'
      )
      and source_amount_minor between 1 and 9007199254740991
      and source_currency ~ '^[A-Z]{3}$'
    ),
  constraint affiliate_revolut_reconciliation_incidents_expected
    check (
      (
        source_execution_id is null
        and expected_reference is null
        and expected_provider_transaction_hash is null
        and expected_amount_minor is null
        and expected_currency is null
      )
      or (
        source_execution_id is not null
        and expected_reference ~ '^NORVA-[A-F0-9]{12}$'
        and expected_amount_minor between 1 and 9007199254740991
        and expected_currency ~ '^[A-Z]{3}$'
      )
    )
);

create table
affiliate_private.affiliate_revolut_reconciliation_incident_reviews (
  id                       uuid primary key default gen_random_uuid(),
  review_key               text not null unique default (
    'rir_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  incident_id              uuid not null,
  review_cycle             integer not null,
  proposed_action          text not null,
  target_execution_id      uuid,
  target_reference         text,
  target_amount_minor      bigint,
  target_currency          text,
  target_currency_exponent integer,
  provider_search_evidence_hash text not null,
  provider_search_observed_at timestamptz not null,
  review_actor_pseudonym   text not null,
  confirmation_hash        text not null,
  justification            text not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_reconciliation_incident_reviews_key
    check (review_key ~ '^rir_[0-9a-f]{24}$'),
  constraint affiliate_revolut_reconciliation_incident_reviews_cycle
    check (review_cycle between 1 and 100),
  constraint affiliate_revolut_reconciliation_incident_reviews_action
    check (
      proposed_action in (
        'settle_exact',
        'remap_exact_and_settle',
        'release_after_return',
        'quarantine'
      )
      and (
        (
          proposed_action = 'quarantine'
          and target_execution_id is null
          and target_reference is null
          and target_amount_minor is null
          and target_currency is null
          and target_currency_exponent is null
        )
        or (
          proposed_action <> 'quarantine'
          and target_execution_id is not null
          and target_reference ~ '^NORVA-[A-F0-9]{12}$'
          and target_amount_minor between 1 and 9007199254740991
          and target_currency ~ '^[A-Z]{3}$'
          and target_currency_exponent between 0 and 6
        )
      )
    ),
  constraint affiliate_revolut_reconciliation_incident_reviews_hashes
    check (
      provider_search_evidence_hash ~ '^[0-9a-f]{64}$'
      and review_actor_pseudonym ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_reconciliation_incident_reviews_evidence
    check (
      provider_search_observed_at
        between created_at - interval '3 minutes'
          and created_at + interval '30 seconds'
      and length(btrim(justification)) between 12 and 1000
    ),
  unique (incident_id, review_cycle)
);

create table
affiliate_private.affiliate_revolut_transaction_aliases (
  id                       uuid primary key default gen_random_uuid(),
  alias_key                text not null unique default (
    'rta_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  incident_id              uuid not null,
  review_id                uuid not null unique,
  execution_id             uuid not null,
  superseded_provider_transaction_hash text,
  authoritative_provider_transaction_hash text not null,
  source_evidence_hash     text not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_transaction_aliases_key
    check (alias_key ~ '^rta_[0-9a-f]{24}$'),
  constraint affiliate_revolut_transaction_aliases_hashes
    check (
      (
        superseded_provider_transaction_hash is null
        or superseded_provider_transaction_hash ~ '^[0-9a-f]{64}$'
      )
      and authoritative_provider_transaction_hash ~ '^[0-9a-f]{64}$'
      and source_evidence_hash ~ '^[0-9a-f]{64}$'
      and (
        superseded_provider_transaction_hash is null
        or superseded_provider_transaction_hash <>
          authoritative_provider_transaction_hash
      )
    ),
  unique (execution_id),
  unique (authoritative_provider_transaction_hash)
);

create table
affiliate_private.affiliate_revolut_reconciliation_incident_decisions (
  id                       uuid primary key default gen_random_uuid(),
  decision_key             text not null unique default (
    'rid_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  incident_id              uuid not null,
  review_id                uuid not null unique,
  target_execution_id      uuid,
  action                   text not null,
  decision_actor_pseudonym text not null,
  provider_search_evidence_hash text not null,
  provider_search_observed_at timestamptz not null,
  confirmation_hash        text not null,
  justification            text not null,
  resolution_entry_id      uuid unique,
  alias_id                 uuid unique,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_reconciliation_incident_decisions_key
    check (decision_key ~ '^rid_[0-9a-f]{24}$'),
  constraint affiliate_revolut_reconciliation_incident_decisions_action
    check (
      action in (
        'settle_exact',
        'remap_exact_and_settle',
        'release_after_return',
        'quarantine'
      )
      and (
        (
          action = 'quarantine'
          and target_execution_id is null
          and resolution_entry_id is null
          and alias_id is null
        )
        or (
          action = 'release_after_return'
          and target_execution_id is not null
          and resolution_entry_id is not null
          and alias_id is null
        )
        or (
          action = 'settle_exact'
          and target_execution_id is not null
          and resolution_entry_id is not null
          and alias_id is null
        )
        or (
          action = 'remap_exact_and_settle'
          and target_execution_id is not null
          and resolution_entry_id is not null
          and alias_id is not null
        )
      )
    ),
  constraint affiliate_revolut_reconciliation_incident_decisions_hashes
    check (
      decision_actor_pseudonym ~ '^[0-9a-f]{64}$'
      and provider_search_evidence_hash ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_reconciliation_incident_decisions_evidence
    check (
      provider_search_observed_at
        between created_at - interval '3 minutes'
          and created_at + interval '30 seconds'
      and length(btrim(justification)) between 12 and 1000
    )
);

create unique index
  affiliate_revolut_reconciliation_incident_terminal_idx
  on
    affiliate_private.affiliate_revolut_reconciliation_incident_decisions (
      incident_id
    )
  where action <> 'quarantine';
create unique index
  affiliate_revolut_reconciliation_target_disposition_idx
  on
    affiliate_private.affiliate_revolut_reconciliation_incident_decisions (
      target_execution_id
    )
  where action <> 'quarantine';
create index affiliate_revolut_reconciliation_incident_execution_idx
  on affiliate_private.affiliate_revolut_reconciliation_incidents (
    source_execution_id
  )
  where source_execution_id is not null;
create index affiliate_revolut_reconciliation_review_target_idx
  on affiliate_private.affiliate_revolut_reconciliation_incident_reviews (
    target_execution_id
  )
  where target_execution_id is not null;
create index affiliate_revolut_transaction_alias_incident_idx
  on affiliate_private.affiliate_revolut_transaction_aliases (
    incident_id
  );
create index affiliate_revolut_reconciliation_decision_history_idx
  on
    affiliate_private.affiliate_revolut_reconciliation_incident_decisions (
      incident_id,
      created_at desc,
      id desc
    );

alter table
  affiliate_private.affiliate_revolut_reconciliation_incidents
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_reconciliation_incident_reviews
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_transaction_aliases
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_reconciliation_incident_decisions
  enable row level security;
revoke all on table
  affiliate_private.affiliate_revolut_reconciliation_incidents,
  affiliate_private.affiliate_revolut_reconciliation_incident_reviews,
  affiliate_private.affiliate_revolut_transaction_aliases,
  affiliate_private.affiliate_revolut_reconciliation_incident_decisions
from public, anon, authenticated, service_role;

create trigger affiliate_revolut_reconciliation_incidents_append_only
before update or delete
on affiliate_private.affiliate_revolut_reconciliation_incidents
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_reconciliation_incident_reviews_append_only
before update or delete
on affiliate_private.affiliate_revolut_reconciliation_incident_reviews
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_transaction_aliases_append_only
before update or delete
on affiliate_private.affiliate_revolut_transaction_aliases
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_reconciliation_decisions_append_only
before update or delete
on affiliate_private.affiliate_revolut_reconciliation_incident_decisions
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();

create or replace function
affiliate_private.guard_revolut_api_feature_flag()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.key <> 'partners_revolut_api_enabled' then
    return new;
  end if;

  if new.enabled and not old.enabled then
    if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
      raise exception 'Revolut API activation requires AAL2'
        using errcode = '42501';
    end if;

    if not coalesce((
      select flag.enabled
      from public.admin_feature_flags flag
      where flag.key = 'partners_payouts_live'
    ), false) then
      raise exception 'live payouts must be enabled before Revolut API'
        using errcode = 'P0001';
    end if;

    if not affiliate_private.release_gates_satisfied(
      array['revolut_api_adapter_verified']::text[]
    ) then
      raise exception 'Revolut API adapter release gate is incomplete'
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1
      from affiliate_private.affiliate_payout_provider_configs config
      where config.provider = 'revolut'
        and config.execution_adapter = 'revolut_api'
    ) then
      raise exception 'a configured Revolut API corridor is required'
        using errcode = 'P0001';
    end if;
  elsif not new.enabled and old.enabled then
    -- The flag is the emergency kill switch. It must always be possible to
    -- turn it off. Atomically pausing active API corridors prevents a later
    -- payout cycle from moving money into clearing with no runnable worker.
    update affiliate_private.affiliate_payout_provider_configs config
    set
      status = 'disabled',
      justification =
        'Automatically disabled by the Revolut API kill switch.',
      updated_at = now()
    where config.provider = 'revolut'
      and config.status = 'active'
      and config.execution_adapter = 'revolut_api';
  end if;

  return new;
end;
$$;

drop trigger if exists admin_feature_flags_revolut_api_guard
  on public.admin_feature_flags;
create trigger admin_feature_flags_revolut_api_guard
before update on public.admin_feature_flags
for each row execute function
  affiliate_private.guard_revolut_api_feature_flag();

alter table affiliate_private.affiliate_payout_provider_configs
  add column execution_adapter text;

alter table affiliate_private.affiliate_payout_profiles
  add column beneficiary_payment_method_ref text;
alter table affiliate_private.affiliate_payout_profiles
  add constraint affiliate_payout_profiles_payment_method_ref
  check (
    beneficiary_payment_method_ref is null
    or beneficiary_payment_method_ref ~
      '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
  );

update affiliate_private.affiliate_payout_provider_configs config
set execution_adapter = case
  when config.provider = 'revolut' then 'revolut_manual'
  else 'legacy_disabled'
end
where config.execution_adapter is null;

alter table affiliate_private.affiliate_payout_provider_configs
  alter column execution_adapter set not null;

alter table affiliate_private.affiliate_payout_provider_configs
  add constraint affiliate_payout_provider_configs_execution_adapter
  check (
    (
      provider = 'revolut'
      and execution_adapter in ('revolut_manual', 'revolut_api')
    )
    or (
      provider in ('wise', 'stripe_connect')
      and execution_adapter = 'legacy_disabled'
      and status = 'disabled'
    )
  );

create or replace function
affiliate_private.guard_revolut_live_payout_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_routed_count integer;
  v_adapter_count integer;
  v_adapter text;
  v_invalid_api_profiles integer;
begin
  if tg_op = 'INSERT' and new.live_execution then
    if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
      raise exception 'live payout cycle creation requires AAL2'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_op <> 'UPDATE'
    or new.status <> 'approved'
    or old.status = 'approved'
    or not new.live_execution
  then
    return new;
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'live payout cycle approval requires AAL2'
      using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  -- Lock every corridor used by the draft. A concurrent kill-switch or route
  -- disable then waits for this approval transaction (or wins before it),
  -- so funds cannot move to clearing against a stale route snapshot.
  perform 1
  from affiliate_private.affiliate_payout_items item
  join affiliate_private.affiliate_accounts account
    on account.id = item.account_id
    and account.status = 'active'
  join affiliate_private.affiliate_payout_profiles profile
    on profile.id = item.payout_profile_id
    and profile.provider = 'revolut'
    and profile.status = 'active'
  join affiliate_private.affiliate_revolut_beneficiary_bindings binding
    on binding.id = profile.revolut_binding_id
    and binding.binding_version = profile.revolut_binding_version
    and binding.account_id = item.account_id
    and binding.currency = item.currency
    and binding.status = 'active'
  join affiliate_private.affiliate_payout_provider_configs config
    on config.provider = 'revolut'
    and config.country_code = account.country_code
    and config.currency = new.currency
    and config.status = 'active'
  where item.cycle_id = new.id
  for share of account, profile, binding, config;

  select
    count(*)::integer,
    count(distinct config.execution_adapter)::integer,
    min(config.execution_adapter)
  into v_routed_count, v_adapter_count, v_adapter
  from affiliate_private.affiliate_payout_items item
  join affiliate_private.affiliate_accounts account
    on account.id = item.account_id
    and account.status = 'active'
  join affiliate_private.affiliate_payout_profiles profile
    on profile.id = item.payout_profile_id
    and profile.provider = 'revolut'
    and profile.status = 'active'
  join affiliate_private.affiliate_revolut_beneficiary_bindings binding
    on binding.id = profile.revolut_binding_id
    and binding.binding_version = profile.revolut_binding_version
    and binding.account_id = item.account_id
    and binding.currency = item.currency
    and binding.status = 'active'
  join affiliate_private.affiliate_payout_provider_configs config
    on config.provider = 'revolut'
    and config.country_code = account.country_code
    and config.currency = new.currency
    and config.status = 'active'
  where item.cycle_id = new.id;

  if v_routed_count <> new.item_count
    or v_adapter_count <> 1
    or v_adapter not in ('revolut_manual', 'revolut_api')
  then
    raise exception
      'every live payout item requires one homogeneous active Revolut route'
      using errcode = 'P0001';
  end if;
  if v_adapter = 'revolut_manual' then
    if new.item_count > 5000
      or not affiliate_private.release_gates_satisfied(
        array['manual_payout_workflow_verified']::text[]
      )
    then
      raise exception
        'manual payout cycle exceeds the released batch capability'
        using errcode = 'P0001';
    end if;
  elsif not coalesce((
      select flag.enabled
      from public.admin_feature_flags flag
      where flag.key = 'partners_revolut_api_enabled'
    ), false)
    or not affiliate_private.release_gates_satisfied(
      array['revolut_api_adapter_verified']::text[]
    )
  then
    raise exception 'Revolut API payout route is not released'
      using errcode = 'P0001';
  end if;
  if v_adapter = 'revolut_api' then
    select count(*)::integer
    into v_invalid_api_profiles
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_profiles profile
      on profile.id = item.payout_profile_id
      and profile.provider = 'revolut'
      and profile.status = 'active'
    where item.cycle_id = new.id
      and (
        profile.beneficiary_token_ref is null
        or profile.beneficiary_token_ref !~
          '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
        or profile.beneficiary_payment_method_ref is null
        or profile.beneficiary_payment_method_ref !~
          '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
      );
    if v_invalid_api_profiles <> 0 then
      raise exception
        'Revolut API payout profiles require counterparty and payment method UUIDs'
        using errcode = 'P0004';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_payout_cycles_revolut_live_guard
  on affiliate_private.affiliate_payout_cycles;
create trigger affiliate_payout_cycles_revolut_live_guard
before insert or update of status
on affiliate_private.affiliate_payout_cycles
for each row execute function
  affiliate_private.guard_revolut_live_payout_cycle();

do $revolut_manual_preflight$
begin
  if exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs config
    where config.status = 'active'
      and (
        config.provider <> 'revolut'
        or config.execution_adapter not in (
          'revolut_manual',
          'revolut_api'
        )
      )
  ) then
    raise exception
      'disable non-Revolut payout routes before installing the Revolut rail'
      using errcode = 'P0001';
  end if;
end;
$revolut_manual_preflight$;

alter table affiliate_private.affiliate_payout_provider_configs
  drop constraint affiliate_payout_provider_configs_pilot_adapter;
alter table affiliate_private.affiliate_payout_provider_configs
  add constraint affiliate_payout_provider_configs_pilot_adapter
  check (
    status <> 'active'
    or (
      provider = 'revolut'
      and execution_adapter in ('revolut_manual', 'revolut_api')
    )
  );

comment on constraint
  affiliate_payout_provider_configs_pilot_adapter
  on affiliate_private.affiliate_payout_provider_configs
is
  'Initial production payout rail: only Revolut manual/API corridors can be active; the API additionally requires its managed flag.';

create or replace function
affiliate_private.guard_revolut_payout_route()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active'
    and new.execution_adapter = 'revolut_api'
    and not coalesce((
      select flag.enabled
      from public.admin_feature_flags flag
      where flag.key = 'partners_revolut_api_enabled'
    ), false)
  then
    raise exception 'Revolut API route requires its managed feature flag'
      using errcode = 'P0001';
  end if;

  if new.status = 'active'
    and new.execution_adapter = 'revolut_api'
    and exists (
      select 1
      from affiliate_private.affiliate_payout_profiles profile
      join affiliate_private.affiliate_accounts account
        on account.id = profile.account_id
      where account.country_code = new.country_code
        and profile.currency = new.currency
        and profile.provider = 'revolut'
        and profile.status = 'active'
        and (
          profile.beneficiary_token_ref is null
          or profile.beneficiary_token_ref !~
            '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
          or profile.beneficiary_payment_method_ref is null
          or profile.beneficiary_payment_method_ref !~
            '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
        )
    )
  then
    raise exception
      'Revolut API route has an incompatible beneficiary profile'
      using errcode = 'P0004';
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_payout_provider_revolut_route_guard
  on affiliate_private.affiliate_payout_provider_configs;
create trigger affiliate_payout_provider_revolut_route_guard
before insert or update
on affiliate_private.affiliate_payout_provider_configs
for each row execute function
  affiliate_private.guard_revolut_payout_route();

create table affiliate_private.affiliate_revolut_beneficiary_bindings (
  id                         uuid primary key default gen_random_uuid(),
  binding_key                text not null unique default (
    'rbb_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  account_id                 uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  currency                   text not null,
  binding_version            integer not null,
  beneficiary_token_ref      text not null,
  beneficiary_payment_method_ref text,
  destination_masked         text not null,
  beneficiary_fingerprint_hmac text not null,
  mapping_attestation_hmac   text not null,
  fingerprint_key_version    integer not null,
  mapping_evidence_hash      text not null,
  authorization_ticket_id   uuid not null unique,
  status                     text not null default 'pending',
  proposed_by_pseudonym      text not null,
  verified_by_pseudonym      text,
  revoked_by_pseudonym       text,
  proposal_justification     text not null,
  verification_justification text,
  revocation_justification   text,
  proposed_at                timestamptz not null default now(),
  verified_at                timestamptz,
  revoked_at                 timestamptz,
  constraint affiliate_revolut_beneficiary_bindings_key
    check (binding_key ~ '^rbb_[0-9a-f]{24}$'),
  constraint affiliate_revolut_beneficiary_bindings_version
    check (
      binding_version between 1 and 2147483646
      and fingerprint_key_version between 1 and 2147483646
    ),
  constraint affiliate_revolut_beneficiary_bindings_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_revolut_beneficiary_bindings_refs
    check (
      beneficiary_token_ref ~
        '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
      and (
        beneficiary_payment_method_ref is null
        or beneficiary_payment_method_ref ~
          '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
      )
    ),
  constraint affiliate_revolut_beneficiary_bindings_masked
    check (
      length(btrim(destination_masked)) between 4 and 64
      and destination_masked !~ '[[:cntrl:]]'
      and destination_masked ~ '[*•]'
      and regexp_replace(
        destination_masked,
        '[[:space:]-]',
        '',
        'g'
      ) !~* '[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}'
      and regexp_replace(
        destination_masked,
        '[^0-9]',
        '',
        'g'
      ) !~ '[0-9]{6,}'
    ),
  constraint affiliate_revolut_beneficiary_bindings_hashes
    check (
      beneficiary_fingerprint_hmac ~ '^[0-9a-f]{64}$'
      and mapping_attestation_hmac ~ '^[0-9a-f]{64}$'
      and mapping_evidence_hash ~ '^[0-9a-f]{64}$'
      and proposed_by_pseudonym ~ '^[0-9a-f]{64}$'
      and (
        verified_by_pseudonym is null
        or verified_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
      and (
        revoked_by_pseudonym is null
        or revoked_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_beneficiary_bindings_status
    check (
      status in ('pending', 'active', 'rejected', 'revoked')
      and (
        (
          status = 'pending'
          and verified_by_pseudonym is null
          and verification_justification is null
          and revoked_by_pseudonym is null
          and revocation_justification is null
          and verified_at is null
          and revoked_at is null
        )
        or (
          status = 'active'
          and verified_by_pseudonym is not null
          and verified_by_pseudonym <> proposed_by_pseudonym
          and length(btrim(verification_justification))
            between 12 and 1000
          and verified_at is not null
          and verified_at >= proposed_at
          and revoked_by_pseudonym is null
          and revocation_justification is null
          and revoked_at is null
        )
        or (
          status = 'rejected'
          and verified_by_pseudonym is not null
          and verified_by_pseudonym <> proposed_by_pseudonym
          and length(btrim(verification_justification))
            between 12 and 1000
          and verified_at is not null
          and verified_at >= proposed_at
          and revoked_by_pseudonym is null
          and revocation_justification is null
          and revoked_at is null
        )
        or (
          status = 'revoked'
          and verified_by_pseudonym is not null
          and verified_at is not null
          and revoked_by_pseudonym is not null
          and length(btrim(revocation_justification))
            between 12 and 1000
          and revoked_at is not null
          and revoked_at >= verified_at
        )
      )
    ),
  constraint affiliate_revolut_beneficiary_bindings_justification
    check (
      length(btrim(proposal_justification)) between 12 and 1000
    ),
  unique (id, binding_version),
  unique (account_id, currency, binding_version)
);

create unique index
  affiliate_revolut_beneficiary_bindings_active_idx
  on affiliate_private.affiliate_revolut_beneficiary_bindings (
    account_id,
    currency
  )
  where status = 'active';
create unique index
  affiliate_revolut_beneficiary_bindings_pending_idx
  on affiliate_private.affiliate_revolut_beneficiary_bindings (
    account_id,
    currency
  )
  where status = 'pending';

create table
affiliate_private.affiliate_revolut_beneficiary_binding_tickets (
  id                       uuid primary key default gen_random_uuid(),
  ticket_key               text not null unique default (
    'rbt_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  ticket_token_hash        text not null unique,
  account_id               uuid not null
    references affiliate_private.affiliate_accounts(id)
    on delete restrict,
  currency                 text not null,
  beneficiary_token_ref    text not null,
  beneficiary_payment_method_ref text,
  destination_masked       text not null,
  fingerprint_key_version  integer not null,
  mapping_evidence_hash    text not null,
  authorized_by_pseudonym  text not null,
  authorization_justification text not null,
  expires_at               timestamptz not null,
  consumed_at              timestamptz,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_binding_tickets_key
    check (ticket_key ~ '^rbt_[0-9a-f]{24}$'),
  constraint affiliate_revolut_binding_tickets_hashes
    check (
      ticket_token_hash ~ '^[0-9a-f]{64}$'
      and mapping_evidence_hash ~ '^[0-9a-f]{64}$'
      and authorized_by_pseudonym ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_binding_tickets_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_revolut_binding_tickets_refs
    check (
      beneficiary_token_ref ~
        '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
      and (
        beneficiary_payment_method_ref is null
        or beneficiary_payment_method_ref ~
          '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
      )
    ),
  constraint affiliate_revolut_binding_tickets_masked
    check (
      length(btrim(destination_masked)) between 4 and 64
      and destination_masked !~ '[[:cntrl:]]'
      and destination_masked ~ '[*•]'
      and regexp_replace(
        destination_masked,
        '[[:space:]-]',
        '',
        'g'
      ) !~* '[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}'
      and regexp_replace(
        destination_masked,
        '[^0-9]',
        '',
        'g'
      ) !~ '[0-9]{6,}'
    ),
  constraint affiliate_revolut_binding_tickets_lifecycle
    check (
      fingerprint_key_version between 1 and 2147483646
      and length(btrim(authorization_justification))
        between 12 and 1000
      and expires_at > created_at
      and expires_at <= created_at + interval '10 minutes'
      and (
        consumed_at is null
        or (
          consumed_at >= created_at
          and consumed_at <= expires_at
        )
      )
    )
);

alter table affiliate_private.affiliate_revolut_beneficiary_bindings
  add constraint affiliate_revolut_beneficiary_bindings_ticket_fk
  foreign key (authorization_ticket_id)
  references
    affiliate_private.affiliate_revolut_beneficiary_binding_tickets(id)
  on delete restrict;

create table
affiliate_private.affiliate_revolut_beneficiary_revocations (
  id                       uuid primary key default gen_random_uuid(),
  revocation_key           text not null unique default (
    'rbr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  binding_id               uuid not null unique
    references
      affiliate_private.affiliate_revolut_beneficiary_bindings(id)
    on delete restrict,
  status                   text not null default 'pending',
  requested_by_pseudonym   text not null,
  approved_by_pseudonym    text,
  request_confirmation_hash text not null,
  approval_confirmation_hash text,
  request_justification    text not null,
  approval_justification   text,
  requested_at             timestamptz not null default now(),
  approved_at              timestamptz,
  constraint affiliate_revolut_beneficiary_revocations_key
    check (revocation_key ~ '^rbr_[0-9a-f]{24}$'),
  constraint affiliate_revolut_beneficiary_revocations_hashes
    check (
      requested_by_pseudonym ~ '^[0-9a-f]{64}$'
      and request_confirmation_hash ~ '^[0-9a-f]{64}$'
      and (
        approved_by_pseudonym is null
        or approved_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
      and (
        approval_confirmation_hash is null
        or approval_confirmation_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_beneficiary_revocations_lifecycle
    check (
      status in ('pending', 'confirmed')
      and length(btrim(request_justification)) between 12 and 1000
      and (
        (
          status = 'pending'
          and approved_by_pseudonym is null
          and approval_confirmation_hash is null
          and approval_justification is null
          and approved_at is null
        )
        or (
          status = 'confirmed'
          and approved_by_pseudonym is not null
          and approved_by_pseudonym <> requested_by_pseudonym
          and approval_confirmation_hash is not null
          and length(btrim(approval_justification))
            between 12 and 1000
          and approved_at is not null
          and approved_at >= requested_at
        )
      )
    )
);

alter table affiliate_private.affiliate_payout_profiles
  add column revolut_binding_id uuid,
  add column revolut_binding_version integer;

-- Existing legacy Revolut profile rows have no independently verified
-- registry binding. Fail closed instead of silently grandfathering them.
update affiliate_private.affiliate_payout_profiles profile
set status = 'verification_required', updated_at = now()
where profile.provider = 'revolut'
  and profile.status = 'active';

alter table affiliate_private.affiliate_payout_profiles
  add constraint affiliate_payout_profiles_revolut_binding
  check (
    (
      provider = 'revolut'
      and (
        (
          status <> 'active'
          and revolut_binding_id is null
          and revolut_binding_version is null
        )
        or (
          status = 'active'
          and
          revolut_binding_id is not null
          and revolut_binding_version is not null
        )
      )
    )
    or (
      provider <> 'revolut'
      and revolut_binding_id is null
      and revolut_binding_version is null
    )
  );
alter table affiliate_private.affiliate_payout_profiles
  add constraint affiliate_payout_profiles_revolut_binding_fk
  foreign key (revolut_binding_id, revolut_binding_version)
  references
    affiliate_private.affiliate_revolut_beneficiary_bindings (
      id,
      binding_version
    )
  on delete restrict;

-- ---------------------------------------------------------------------------
-- Immutable execution identity and manual evidence
-- ---------------------------------------------------------------------------

alter table affiliate_private.affiliate_payout_items
  add column payout_reference text,
  add column execution_adapter text,
  add column execution_claimed_at timestamptz;

alter table affiliate_private.affiliate_payout_items
  add constraint affiliate_payout_items_execution_snapshot
  check (
    (
      payout_reference is null
      and execution_adapter is null
      and execution_claimed_at is null
    )
    or (
      payout_reference ~ '^NORVA-[A-F0-9]{12}$'
      and execution_adapter in (
        'revolut_manual',
        'revolut_api'
      )
      and execution_claimed_at is not null
    )
  );

create unique index affiliate_payout_items_reference_idx
  on affiliate_private.affiliate_payout_items (payout_reference)
  where payout_reference is not null;

create table affiliate_private.affiliate_revolut_reference_allocations (
  payout_item_id uuid not null unique
    references affiliate_private.affiliate_payout_items(id)
    on delete restrict,
  payout_reference text primary key,
  created_at timestamptz not null default now(),
  constraint affiliate_revolut_reference_allocations_reference
    check (payout_reference ~ '^NORVA-[A-F0-9]{12}$'),
  unique (payout_item_id, payout_reference)
);

create or replace function
affiliate_private.allocate_revolut_payout_reference(
  p_payout_item_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reference text;
  v_attempt integer;
begin
  if p_payout_item_id is null
    or not exists (
      select 1
      from affiliate_private.affiliate_payout_items item
      where item.id = p_payout_item_id
    )
  then
    raise exception 'payout item is unavailable for reference allocation'
      using errcode = 'P0002';
  end if;

  for v_attempt in 1..32 loop
    select allocation.payout_reference
    into v_reference
    from affiliate_private.affiliate_revolut_reference_allocations allocation
    where allocation.payout_item_id = p_payout_item_id;
    if found then
      return v_reference;
    end if;

    v_reference := 'NORVA-' || upper(encode(
      extensions.gen_random_bytes(6),
      'hex'
    ));
    insert into
      affiliate_private.affiliate_revolut_reference_allocations (
        payout_item_id,
        payout_reference
      )
    values (p_payout_item_id, v_reference)
    on conflict do nothing
    returning payout_reference into v_reference;
    if found then
      return v_reference;
    end if;
  end loop;

  raise exception 'could not allocate a unique payout reference'
    using errcode = '40001';
end;
$$;

create table affiliate_private.affiliate_revolut_manual_batches (
  id                       uuid primary key default gen_random_uuid(),
  batch_key                text not null unique default (
    'rmb_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  cycle_id                 uuid not null unique
    references affiliate_private.affiliate_payout_cycles(id)
    on delete restrict,
  status                   text not null default 'prepared',
  currency                 text not null,
  currency_exponent        integer not null,
  total_minor              bigint not null,
  item_count               integer not null,
  canonical_manifest_hash  text unique,
  export_file_hash         text unique,
  submission_hash          text unique,
  prepared_by_pseudonym    text not null,
  exported_by_pseudonym    text,
  submitted_by_pseudonym   text,
  prepared_at              timestamptz not null default now(),
  exported_at              timestamptz,
  submitted_at             timestamptz,
  settled_at               timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint affiliate_revolut_manual_batches_key
    check (batch_key ~ '^rmb_[0-9a-f]{24}$'),
  constraint affiliate_revolut_manual_batches_status
    check (
      status in (
        'prepared',
        'exported',
        'partially_submitted',
        'submitted',
        'partially_reconciled',
        'settled',
        'exception',
        'cancelled'
      )
    ),
  constraint affiliate_revolut_manual_batches_currency
    check (
      currency ~ '^[A-Z]{3}$'
      and currency_exponent between 0 and 6
    ),
  constraint affiliate_revolut_manual_batches_amounts
    check (
      total_minor between 1 and 9007199254740991
      and item_count between 1 and 5000
    ),
  constraint affiliate_revolut_manual_batches_hash
    check (
      (
        canonical_manifest_hash is null
        or canonical_manifest_hash ~ '^[0-9a-f]{64}$'
      )
      and (
        export_file_hash is null
        or export_file_hash ~ '^[0-9a-f]{64}$'
      )
      and (
        submission_hash is null
        or submission_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_manual_batches_actors
    check (
      prepared_by_pseudonym ~ '^[0-9a-f]{64}$'
      and (
        exported_by_pseudonym is null
        or exported_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
      and (
        submitted_by_pseudonym is null
        or submitted_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_manual_batches_lifecycle
    check (
      (
        status = 'prepared'
        and canonical_manifest_hash is null
        and export_file_hash is null
        and submission_hash is null
        and exported_by_pseudonym is null
        and submitted_by_pseudonym is null
        and exported_at is null
        and submitted_at is null
        and settled_at is null
      )
      or (
        status in ('exported', 'partially_submitted')
        and canonical_manifest_hash is not null
        and export_file_hash is not null
        and submission_hash is null
        and exported_by_pseudonym is not null
        and submitted_by_pseudonym is null
        and exported_at is not null
        and submitted_at is null
        and settled_at is null
      )
      or (
        status in ('submitted', 'partially_reconciled', 'exception')
        and canonical_manifest_hash is not null
        and export_file_hash is not null
        and submission_hash is not null
        and exported_by_pseudonym is not null
        and submitted_by_pseudonym is not null
        and exported_at is not null
        and submitted_at is not null
        and settled_at is null
      )
      or (
        status = 'settled'
        and canonical_manifest_hash is not null
        and export_file_hash is not null
        and submission_hash is not null
        and exported_by_pseudonym is not null
        and submitted_by_pseudonym is not null
        and exported_at is not null
        and submitted_at is not null
        and settled_at is not null
      )
      or (
        status = 'cancelled'
        and submission_hash is null
        and submitted_by_pseudonym is null
        and submitted_at is null
        and settled_at is null
        and (
          (
            canonical_manifest_hash is null
            and
            export_file_hash is null
            and exported_by_pseudonym is null
            and exported_at is null
          )
          or (
            canonical_manifest_hash is not null
            and
            export_file_hash is not null
            and exported_by_pseudonym is not null
            and exported_at is not null
          )
        )
      )
    ),
  constraint affiliate_revolut_manual_batches_chronology
    check (
      created_at <= prepared_at
      and (
        exported_at is null
        or exported_at >= prepared_at
      )
      and (
        submitted_at is null
        or (
          exported_at is not null
          and submitted_at >= exported_at
        )
      )
      and (
        settled_at is null
        or (
          submitted_at is not null
          and settled_at >= submitted_at
        )
      )
    )
);

create table affiliate_private.affiliate_revolut_payout_executions (
  id                       uuid primary key default gen_random_uuid(),
  execution_key            text not null unique default (
    'rpx_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  payout_item_id           uuid not null unique
    references affiliate_private.affiliate_payout_items(id)
    on delete restrict,
  manual_batch_id          uuid
    references affiliate_private.affiliate_revolut_manual_batches(id)
    on delete restrict,
  adapter                  text not null,
  payout_reference         text not null unique,
  request_id               uuid not null unique default gen_random_uuid(),
  beneficiary_token_ref    text not null,
  beneficiary_payment_method_ref text,
  beneficiary_binding_id   uuid not null,
  beneficiary_binding_version integer not null,
  beneficiary_fingerprint_hmac text not null,
  beneficiary_fingerprint_key_version integer not null,
  destination_masked       text not null,
  amount_minor             bigint not null,
  currency                 text not null,
  currency_exponent        integer not null,
  state                    text not null default 'prepared',
  reconciliation_status    text not null default 'not_ready',
  provider_transaction_id  text,
  provider_transaction_hash text,
  job_status               text not null,
  worker_id                text,
  lease_token_hash         text,
  leased_until             timestamptz,
  attempts                 integer not null default 0,
  next_attempt_at          timestamptz not null default now(),
  last_error_code          text,
  prepared_by_pseudonym    text not null,
  submitted_by_pseudonym   text,
  exported_at              timestamptz,
  submitted_at             timestamptz,
  paid_observed_at         timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint affiliate_revolut_payout_executions_key
    check (execution_key ~ '^rpx_[0-9a-f]{24}$'),
  constraint affiliate_revolut_payout_executions_adapter
    check (
      (
        adapter = 'revolut_manual'
        and manual_batch_id is not null
        and job_status in ('manual', 'observing', 'settled', 'exception')
      )
      or (
        adapter = 'revolut_api'
        and manual_batch_id is null
        and job_status in (
          'pending',
          'leased',
          'observing',
          'settled',
          'exception',
          'dead_letter'
        )
      )
    ),
  constraint affiliate_revolut_payout_executions_reference
    check (payout_reference ~ '^NORVA-[A-F0-9]{12}$'),
  constraint affiliate_revolut_payout_executions_beneficiary
    check (
      beneficiary_token_ref ~
        '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
      and (
        (
          adapter = 'revolut_manual'
          and beneficiary_payment_method_ref is null
        )
        or (
          adapter = 'revolut_api'
          and beneficiary_payment_method_ref ~
            '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
        )
      )
      and length(btrim(destination_masked)) between 4 and 64
      and destination_masked !~ '[[:cntrl:]]'
      and destination_masked ~ '[*•]'
      and regexp_replace(
        destination_masked,
        '[[:space:]-]',
        '',
        'g'
      ) !~* '[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}'
      and regexp_replace(
        destination_masked,
        '[^0-9]',
        '',
        'g'
      ) !~ '[0-9]{6,}'
      and beneficiary_binding_version between 1 and 2147483646
      and beneficiary_fingerprint_key_version
        between 1 and 2147483646
      and beneficiary_fingerprint_hmac ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_payout_executions_binding_fk
    foreign key (
      beneficiary_binding_id,
      beneficiary_binding_version
    )
    references
      affiliate_private.affiliate_revolut_beneficiary_bindings (
        id,
        binding_version
      )
    on delete restrict,
  constraint affiliate_revolut_payout_executions_money
    check (
      amount_minor between 1 and 9007199254740991
      and currency ~ '^[A-Z]{3}$'
      and currency_exponent between 0 and 6
    ),
  constraint affiliate_revolut_payout_executions_state
    check (
      state in (
        'prepared',
        'exported',
        'submitted',
        'processing',
        'paid',
        'failed',
        'cancelled',
        'exception'
      )
      and reconciliation_status in (
        'not_ready',
        'pending',
        'confirmed',
        'exception'
      )
    ),
  constraint affiliate_revolut_payout_executions_provider
    check (
      (
        provider_transaction_id is null
        and provider_transaction_hash is null
      )
      or (
        length(provider_transaction_id) between 8 and 128
        and provider_transaction_id !~ '[[:space:][:cntrl:]]'
        and provider_transaction_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_payout_executions_lease
    check (
      (
        job_status <> 'leased'
        and worker_id is null
        and lease_token_hash is null
        and leased_until is null
      )
      or (
        job_status = 'leased'
        and worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
        and lease_token_hash ~ '^[0-9a-f]{64}$'
        and leased_until is not null
      )
    ),
  constraint affiliate_revolut_payout_executions_attempts
    check (attempts between 0 and 20),
  constraint affiliate_revolut_payout_executions_error
    check (
      last_error_code is null
      or last_error_code ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
    ),
  constraint affiliate_revolut_payout_executions_actor
    check (
      prepared_by_pseudonym ~ '^[0-9a-f]{64}$'
      and (
        submitted_by_pseudonym is null
        or submitted_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_payout_executions_reference_fk
    foreign key (payout_item_id, payout_reference)
    references
      affiliate_private.affiliate_revolut_reference_allocations (
        payout_item_id,
        payout_reference
      )
    on delete restrict
);

create index affiliate_revolut_payout_executions_work_idx
  on affiliate_private.affiliate_revolut_payout_executions (
    adapter,
    job_status,
    next_attempt_at,
    created_at
  );

create index affiliate_revolut_payout_executions_reconcile_idx
  on affiliate_private.affiliate_revolut_payout_executions (
    reconciliation_status,
    paid_observed_at,
    created_at
  )
  where state = 'paid';

create index affiliate_revolut_payout_executions_batch_idx
  on affiliate_private.affiliate_revolut_payout_executions (
    manual_batch_id,
    created_at,
    id
  )
  where manual_batch_id is not null;

create unique index affiliate_revolut_payout_executions_provider_tx_idx
  on affiliate_private.affiliate_revolut_payout_executions (
    provider_transaction_hash
  )
  where provider_transaction_hash is not null;

create or replace function
affiliate_private.guard_revolut_execution_adapter_exclusive()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Serialize execution creation on the shared payout item so competing
  -- manual/API workers cannot claim the same transfer.
  perform 1
  from affiliate_private.affiliate_payout_items item
  where item.id = new.payout_item_id
  for update;
  if not found then
    raise exception 'payout item is unavailable'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_execution_adapter_exclusive
before insert on affiliate_private.affiliate_revolut_payout_executions
for each row execute function
  affiliate_private.guard_revolut_execution_adapter_exclusive();

create table affiliate_private.affiliate_revolut_api_worker_lease (
  lease_name               text primary key,
  worker_id                text,
  lease_token_hash         text,
  leased_until             timestamptz,
  generation               bigint not null default 0,
  updated_at               timestamptz not null default now(),
  constraint affiliate_revolut_api_worker_lease_singleton
    check (lease_name = 'oauth_refresh'),
  constraint affiliate_revolut_api_worker_lease_holder
    check (
      (
        worker_id is null
        and lease_token_hash is null
        and leased_until is null
      )
      or (
        worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
        and lease_token_hash ~ '^[0-9a-f]{64}$'
        and leased_until is not null
      )
    ),
  constraint affiliate_revolut_api_worker_lease_generation
    check (generation between 0 and 9223372036854775806)
);

insert into affiliate_private.affiliate_revolut_api_worker_lease (
  lease_name
)
values ('oauth_refresh');

create table affiliate_private.affiliate_revolut_payout_events (
  id                       uuid primary key default gen_random_uuid(),
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  provider_event_hash      text not null unique,
  provider_state           text not null,
  observed_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_payout_events_hash
    check (provider_event_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_revolut_payout_events_state
    check (
      provider_state in (
        'CREATED',
        'PENDING',
        'PROCESSING',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'REVERTED'
      )
    )
);

create index affiliate_revolut_payout_events_execution_idx
  on affiliate_private.affiliate_revolut_payout_events (
    execution_id,
    observed_at desc
  );

create table affiliate_private.affiliate_revolut_statement_tickets (
  id                       uuid primary key default gen_random_uuid(),
  ticket_key               text not null unique default (
    'rst_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  ticket_token_hash        text not null unique,
  actor_pseudonym          text not null,
  expires_at               timestamptz not null,
  consumed_at              timestamptz,
  source_file_hash         text,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_statement_tickets_key
    check (ticket_key ~ '^rst_[0-9a-f]{24}$'),
  constraint affiliate_revolut_statement_tickets_hashes
    check (
      ticket_token_hash ~ '^[0-9a-f]{64}$'
      and actor_pseudonym ~ '^[0-9a-f]{64}$'
      and (
        source_file_hash is null
        or source_file_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_statement_tickets_lifecycle
    check (
      expires_at > created_at
      and expires_at <= created_at + interval '10 minutes'
      and (
        (
          consumed_at is null
          and source_file_hash is null
        )
        or (
          consumed_at is not null
          and consumed_at >= created_at
          and consumed_at <= expires_at
          and source_file_hash is not null
        )
      )
    )
);

create table affiliate_private.affiliate_revolut_statement_imports (
  id                       uuid primary key default gen_random_uuid(),
  import_key               text not null unique default (
    'rsi_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  source_file_hash         text not null unique,
  period_start             date not null,
  period_end               date not null,
  currency                 text not null,
  status                   text not null default 'processing',
  accepted_row_count       integer not null default 0,
  matched_row_count        integer not null default 0,
  unmatched_row_count      integer not null default 0,
  mismatch_row_count       integer not null default 0,
  duplicate_row_count      integer not null default 0,
  imported_by_pseudonym    text not null,
  authorization_ticket_id  uuid not null unique
    references affiliate_private.affiliate_revolut_statement_tickets(id)
    on delete restrict,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_statement_imports_key
    check (import_key ~ '^rsi_[0-9a-f]{24}$'),
  constraint affiliate_revolut_statement_imports_hash
    check (source_file_hash ~ '^[0-9a-f]{64}$'),
  constraint affiliate_revolut_statement_imports_period
    check (
      period_end >= period_start
      and period_end <= period_start + 92
    ),
  constraint affiliate_revolut_statement_imports_currency
    check (currency ~ '^[A-Z]{3}$'),
  constraint affiliate_revolut_statement_imports_status
    check (
      status in ('processing', 'complete', 'exception')
      and (
        (status = 'processing' and completed_at is null)
        or (status <> 'processing' and completed_at is not null)
      )
    ),
  constraint affiliate_revolut_statement_imports_counts
    check (
      accepted_row_count between 0 and 5000
      and matched_row_count between 0 and accepted_row_count
      and unmatched_row_count between 0 and accepted_row_count
      and mismatch_row_count between 0 and accepted_row_count
      and duplicate_row_count between 0 and 5000
      and (
        matched_row_count
        + unmatched_row_count
        + mismatch_row_count
      ) = accepted_row_count
    ),
  constraint affiliate_revolut_statement_imports_actor
    check (imported_by_pseudonym ~ '^[0-9a-f]{64}$')
);

create table affiliate_private.affiliate_revolut_statement_rows (
  id                       uuid primary key default gen_random_uuid(),
  row_key                  text not null unique default (
    'rsr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  import_id                uuid not null
    references affiliate_private.affiliate_revolut_statement_imports(id)
    on delete restrict,
  execution_id             uuid
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  statement_row_hash       text not null unique,
  payout_reference         text not null,
  provider_transaction_hash text not null,
  provider_state           text not null,
  amount_minor             bigint not null,
  currency                 text not null,
  value_date               date not null,
  match_status             text not null,
  discrepancy_code         text,
  observed_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_statement_rows_key
    check (row_key ~ '^rsr_[0-9a-f]{24}$'),
  constraint affiliate_revolut_statement_rows_hashes
    check (
      statement_row_hash ~ '^[0-9a-f]{64}$'
      and provider_transaction_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_statement_rows_reference
    check (payout_reference ~ '^NORVA-[A-F0-9]{12}$'),
  constraint affiliate_revolut_statement_rows_provider_state
    check (
      provider_state in (
        'CREATED',
        'PENDING',
        'PROCESSING',
        'COMPLETED',
        'FAILED',
        'REVERTED',
        'CANCELLED'
      )
    ),
  constraint affiliate_revolut_statement_rows_money
    check (
      amount_minor between 1 and 9007199254740991
      and currency ~ '^[A-Z]{3}$'
      and value_date >= date '2020-01-01'
      and value_date <= current_date + 1
    ),
  constraint affiliate_revolut_statement_rows_match
    check (
      match_status in ('matched', 'unmatched', 'mismatch')
      and (
        (
          match_status = 'matched'
          and execution_id is not null
          and provider_state = 'COMPLETED'
          and discrepancy_code is null
        )
        or (
          match_status = 'unmatched'
          and execution_id is null
          and discrepancy_code = 'unknown_reference'
        )
        or (
          match_status = 'mismatch'
          and execution_id is not null
          and (
            (
              provider_state <> 'COMPLETED'
              and discrepancy_code in (
                'provider_not_completed',
                'post_settlement_return'
              )
            )
            or (
              provider_state = 'COMPLETED'
              and discrepancy_code in (
                'amount_mismatch',
                'currency_mismatch',
                'transaction_mismatch',
                'execution_state_mismatch'
              )
            )
          )
        )
      )
    )
);

create index affiliate_revolut_statement_rows_queue_idx
  on affiliate_private.affiliate_revolut_statement_rows (
    match_status,
    observed_at desc,
    created_at desc
  );

create index affiliate_revolut_statement_rows_import_idx
  on affiliate_private.affiliate_revolut_statement_rows (
    import_id,
    created_at,
    id
  );

create index affiliate_revolut_statement_rows_execution_idx
  on affiliate_private.affiliate_revolut_statement_rows (
    execution_id,
    observed_at desc,
    id
  )
  where execution_id is not null;

create table affiliate_private.affiliate_revolut_manual_reviews (
  id                       uuid primary key default gen_random_uuid(),
  review_key               text not null unique default (
    'rmr_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  statement_row_id         uuid not null unique
    references affiliate_private.affiliate_revolut_statement_rows(id)
    on delete restrict,
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  review_actor_pseudonym   text not null,
  confirmation_hash        text not null,
  justification            text not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_manual_reviews_key
    check (review_key ~ '^rmr_[0-9a-f]{24}$'),
  constraint affiliate_revolut_manual_reviews_hashes
    check (
      review_actor_pseudonym ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_manual_reviews_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create table affiliate_private.affiliate_revolut_manual_decisions (
  id                       uuid primary key default gen_random_uuid(),
  decision_key             text not null unique default (
    'rmd_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  statement_row_id         uuid not null unique
    references affiliate_private.affiliate_revolut_statement_rows(id)
    on delete restrict,
  review_id                uuid not null unique
    references affiliate_private.affiliate_revolut_manual_reviews(id)
    on delete restrict,
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  decision                 text not null,
  decision_actor_pseudonym text not null,
  confirmation_hash        text not null,
  justification            text not null,
  settlement_entry_id      uuid unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_manual_decisions_key
    check (decision_key ~ '^rmd_[0-9a-f]{24}$'),
  constraint affiliate_revolut_manual_decisions_value
    check (
      decision in ('confirmed', 'quarantined')
      and (
        (decision = 'confirmed' and settlement_entry_id is not null)
        or (decision = 'quarantined' and settlement_entry_id is null)
      )
    ),
  constraint affiliate_revolut_manual_decisions_hashes
    check (
      decision_actor_pseudonym ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_manual_decisions_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create unique index
  affiliate_revolut_manual_decisions_confirmed_execution_idx
  on affiliate_private.affiliate_revolut_manual_decisions (execution_id)
  where decision = 'confirmed';

-- Provider terminal states are evidence, not permission to rewrite an already
-- settled payout. They are reviewed through a separate append-only workflow.
create table
affiliate_private.affiliate_revolut_return_observations (
  id                       uuid primary key default gen_random_uuid(),
  observation_key          text not null unique default (
    'rro_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  statement_row_id         uuid unique
    references affiliate_private.affiliate_revolut_statement_rows(id)
    on delete restrict,
  payout_event_id          uuid unique
    references affiliate_private.affiliate_revolut_payout_events(id)
    on delete restrict,
  source_evidence_hash     text not null unique,
  return_kind              text not null,
  provider_state           text not null,
  amount_minor             bigint not null,
  currency                 text not null,
  observed_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_return_observations_key
    check (observation_key ~ '^rro_[0-9a-f]{24}$'),
  constraint affiliate_revolut_return_observations_source
    check (
      (statement_row_id is not null)::integer
      + (payout_event_id is not null)::integer = 1
      and source_evidence_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_return_observations_state
    check (
      provider_state in ('FAILED', 'CANCELLED', 'REVERTED')
      and return_kind in (
        'pre_settlement_release',
        'post_settlement_return'
      )
    ),
  constraint affiliate_revolut_return_observations_money
    check (
      amount_minor between 1 and 9007199254740991
      and currency ~ '^[A-Z]{3}$'
    )
);

create index affiliate_revolut_return_observations_queue_idx
  on affiliate_private.affiliate_revolut_return_observations (
    observed_at desc,
    created_at desc,
    id
  );

create table affiliate_private.affiliate_revolut_return_reviews (
  id                       uuid primary key default gen_random_uuid(),
  review_key               text not null unique default (
    'rrv_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  observation_id           uuid not null unique
    references
      affiliate_private.affiliate_revolut_return_observations(id)
    on delete restrict,
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  conclusion               text not null,
  review_actor_pseudonym   text not null,
  confirmation_hash        text not null,
  justification            text not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_return_reviews_key
    check (review_key ~ '^rrv_[0-9a-f]{24}$'),
  constraint affiliate_revolut_return_reviews_value
    check (conclusion in ('eligible', 'quarantine')),
  constraint affiliate_revolut_return_reviews_hashes
    check (
      review_actor_pseudonym ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_return_reviews_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create table affiliate_private.affiliate_revolut_return_decisions (
  id                       uuid primary key default gen_random_uuid(),
  decision_key             text not null unique default (
    'rrd_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  observation_id           uuid not null unique
    references
      affiliate_private.affiliate_revolut_return_observations(id)
    on delete restrict,
  review_id                uuid not null unique
    references affiliate_private.affiliate_revolut_return_reviews(id)
    on delete restrict,
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  decision                 text not null,
  decision_actor_pseudonym text not null,
  confirmation_hash        text not null,
  justification            text not null,
  resolution_entry_id      uuid unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_return_decisions_key
    check (decision_key ~ '^rrd_[0-9a-f]{24}$'),
  constraint affiliate_revolut_return_decisions_value
    check (
      decision in ('confirmed', 'quarantined')
      and (
        (decision = 'confirmed' and resolution_entry_id is not null)
        or (decision = 'quarantined' and resolution_entry_id is null)
      )
    ),
  constraint affiliate_revolut_return_decisions_hashes
    check (
      decision_actor_pseudonym ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_return_decisions_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create unique index
  affiliate_revolut_return_decisions_confirmed_execution_idx
  on affiliate_private.affiliate_revolut_return_decisions (execution_id)
  where decision = 'confirmed';
create unique index affiliate_revolut_return_observation_incident_idx
  on affiliate_private.affiliate_revolut_return_observations (
    execution_id,
    return_kind
  );

create table
affiliate_private.affiliate_revolut_late_completion_observations (
  id                       uuid primary key default gen_random_uuid(),
  observation_key          text not null unique default (
    'rlc_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  statement_row_id         uuid unique
    references affiliate_private.affiliate_revolut_statement_rows(id)
    on delete restrict,
  payout_event_id          uuid unique
    references affiliate_private.affiliate_revolut_payout_events(id)
    on delete restrict,
  release_entry_id         uuid not null
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  source_evidence_hash     text not null unique,
  amount_minor             bigint not null,
  currency                 text not null,
  observed_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_late_completion_observations_key
    check (observation_key ~ '^rlc_[0-9a-f]{24}$'),
  constraint affiliate_revolut_late_completion_observations_source
    check (
      (statement_row_id is not null)::integer
      + (payout_event_id is not null)::integer = 1
      and source_evidence_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_late_completion_observations_money
    check (
      amount_minor between 1 and 9007199254740991
      and currency ~ '^[A-Z]{3}$'
    )
);

create table affiliate_private.affiliate_revolut_late_completion_reviews (
  id                       uuid primary key default gen_random_uuid(),
  review_key               text not null unique default (
    'rlv_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  observation_id           uuid not null unique
    references
      affiliate_private.affiliate_revolut_late_completion_observations(id)
    on delete restrict,
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  conclusion               text not null,
  review_actor_pseudonym   text not null,
  confirmation_hash        text not null,
  justification            text not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_late_completion_reviews_key
    check (review_key ~ '^rlv_[0-9a-f]{24}$'),
  constraint affiliate_revolut_late_completion_reviews_conclusion
    check (conclusion in ('eligible', 'quarantine')),
  constraint affiliate_revolut_late_completion_reviews_hashes
    check (
      review_actor_pseudonym ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_late_completion_reviews_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create table
affiliate_private.affiliate_revolut_late_completion_decisions (
  id                       uuid primary key default gen_random_uuid(),
  decision_key             text not null unique default (
    'rld_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  observation_id           uuid not null unique
    references
      affiliate_private.affiliate_revolut_late_completion_observations(id)
    on delete restrict,
  review_id                uuid not null unique
    references
      affiliate_private.affiliate_revolut_late_completion_reviews(id)
    on delete restrict,
  execution_id             uuid not null
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  decision                 text not null,
  decision_actor_pseudonym text not null,
  confirmation_hash        text not null,
  justification            text not null,
  recovery_entry_id        uuid unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  available_debit_minor    bigint not null default 0,
  recovery_due_minor       bigint not null default 0,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_late_completion_decisions_key
    check (decision_key ~ '^rld_[0-9a-f]{24}$'),
  constraint affiliate_revolut_late_completion_decisions_value
    check (
      decision in ('confirmed', 'quarantined')
      and (
        (
          decision = 'quarantined'
          and recovery_entry_id is null
          and available_debit_minor = 0
          and recovery_due_minor = 0
        )
        or (
          decision = 'confirmed'
          and recovery_entry_id is not null
          and available_debit_minor >= 0
          and recovery_due_minor >= 0
          and available_debit_minor + recovery_due_minor > 0
        )
      )
    ),
  constraint affiliate_revolut_late_completion_decisions_hashes
    check (
      decision_actor_pseudonym ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_late_completion_decisions_justification
    check (length(btrim(justification)) between 12 and 1000)
);

create unique index
  affiliate_revolut_late_completion_confirmed_execution_idx
  on affiliate_private.affiliate_revolut_late_completion_decisions (
    execution_id
  )
  where decision = 'confirmed';
create unique index affiliate_revolut_late_completion_incident_idx
  on affiliate_private.affiliate_revolut_late_completion_observations (
    execution_id
  );

create or replace function
affiliate_private.guard_commission_entry_open_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform 1
  from affiliate_private.affiliate_accounts account
  where account.id = new.account_id
    and account.status <> 'closed'
  for update;
  if not found then
    raise exception 'closed Partner account cannot receive ledger writes'
      using errcode = '55000';
  end if;
  perform affiliate_private.partners_balance_lock(
    new.account_id,
    new.currency
  );
  return new;
end;
$$;

create trigger affiliate_commission_entries_open_account_guard
before insert on affiliate_private.affiliate_commission_entries
for each row execute function
  affiliate_private.guard_commission_entry_open_account();

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_kind;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_kind
  check (
    entry_kind in (
      'accrual',
      'reversal',
      'manual_reversal',
      'reinstatement',
      'release',
      'recovery_offset',
      'payout_allocation',
      'payout_settlement',
      'payout_release',
      'payout_return',
      'payout_late_settlement',
      'payout_duplicate_settlement'
    )
  );

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_attribution_scope;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_attribution_scope
  check (
    (
      entry_kind in (
        'accrual',
        'reversal',
        'manual_reversal',
        'reinstatement',
        'release'
      )
      and attribution_id is not null
    )
    or (
      entry_kind in (
        'recovery_offset',
        'payout_allocation',
        'payout_settlement',
        'payout_release',
        'payout_return',
        'payout_late_settlement',
        'payout_duplicate_settlement'
      )
      and attribution_id is null
    )
  );

alter table affiliate_private.affiliate_commission_entries
  drop constraint affiliate_commission_entries_relation;
alter table affiliate_private.affiliate_commission_entries
  add constraint affiliate_commission_entries_relation
  check (
    (
      entry_kind = 'accrual'
      and fact_id is not null
      and related_entry_id is null
      and matures_at is not null
    )
    or (
      entry_kind in ('reversal', 'reinstatement', 'release')
      and fact_id is not null
      and related_entry_id is not null
      and matures_at is null
    )
    or (
      entry_kind = 'manual_reversal'
      and fact_id is null
      and related_entry_id is not null
      and matures_at is null
    )
    or (
      entry_kind in ('payout_allocation', 'recovery_offset')
      and fact_id is null
      and related_entry_id is null
      and matures_at is null
    )
    or (
      entry_kind in (
        'payout_settlement',
        'payout_release',
        'payout_return',
        'payout_late_settlement',
        'payout_duplicate_settlement'
      )
      and fact_id is null
      and related_entry_id is not null
      and matures_at is null
    )
  );

create unique index affiliate_payout_release_allocation_once_idx
  on affiliate_private.affiliate_commission_entries (related_entry_id)
  where entry_kind = 'payout_release';
create unique index affiliate_payout_return_settlement_once_idx
  on affiliate_private.affiliate_commission_entries (related_entry_id)
  where entry_kind = 'payout_return';
create unique index affiliate_payout_late_settlement_release_once_idx
  on affiliate_private.affiliate_commission_entries (related_entry_id)
  where entry_kind = 'payout_late_settlement';
create unique index affiliate_payout_duplicate_settlement_once_idx
  on affiliate_private.affiliate_commission_entries (related_entry_id)
  where entry_kind = 'payout_duplicate_settlement';

alter table affiliate_private.affiliate_revolut_reference_allocations
  enable row level security;
alter table affiliate_private.affiliate_revolut_beneficiary_bindings
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_beneficiary_binding_tickets
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_beneficiary_revocations
  enable row level security;
alter table affiliate_private.affiliate_revolut_manual_batches
  enable row level security;
alter table affiliate_private.affiliate_revolut_payout_executions
  enable row level security;
alter table affiliate_private.affiliate_revolut_api_worker_lease
  enable row level security;
alter table affiliate_private.affiliate_revolut_payout_events
  enable row level security;
alter table affiliate_private.affiliate_revolut_statement_tickets
  enable row level security;
alter table affiliate_private.affiliate_revolut_statement_imports
  enable row level security;
alter table affiliate_private.affiliate_revolut_statement_rows
  enable row level security;
alter table affiliate_private.affiliate_revolut_manual_reviews
  enable row level security;
alter table affiliate_private.affiliate_revolut_manual_decisions
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_return_observations
  enable row level security;
alter table affiliate_private.affiliate_revolut_return_reviews
  enable row level security;
alter table affiliate_private.affiliate_revolut_return_decisions
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_late_completion_observations
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_late_completion_reviews
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_late_completion_decisions
  enable row level security;

revoke all on table
  affiliate_private.affiliate_revolut_reference_allocations,
  affiliate_private.affiliate_revolut_beneficiary_bindings,
  affiliate_private.affiliate_revolut_beneficiary_binding_tickets,
  affiliate_private.affiliate_revolut_beneficiary_revocations,
  affiliate_private.affiliate_revolut_manual_batches,
  affiliate_private.affiliate_revolut_payout_executions,
  affiliate_private.affiliate_revolut_api_worker_lease,
  affiliate_private.affiliate_revolut_payout_events,
  affiliate_private.affiliate_revolut_statement_tickets,
  affiliate_private.affiliate_revolut_statement_imports,
  affiliate_private.affiliate_revolut_statement_rows,
  affiliate_private.affiliate_revolut_manual_reviews,
  affiliate_private.affiliate_revolut_manual_decisions,
  affiliate_private.affiliate_revolut_return_observations,
  affiliate_private.affiliate_revolut_return_reviews,
  affiliate_private.affiliate_revolut_return_decisions,
  affiliate_private.affiliate_revolut_late_completion_observations,
  affiliate_private.affiliate_revolut_late_completion_reviews,
  affiliate_private.affiliate_revolut_late_completion_decisions
from public, anon, authenticated, service_role;

create or replace function
affiliate_private.guard_payout_profile_binding_and_hold()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.provider <> 'revolut' or new.status <> 'active' then
    new.revolut_binding_id := null;
    new.revolut_binding_version := null;
    return new;
  end if;

  if exists (
    select 1
    from
      affiliate_private.affiliate_revolut_late_completion_observations
        observation
    left join
      affiliate_private.affiliate_revolut_late_completion_decisions
        decision
      on decision.observation_id = observation.id
    join affiliate_private.affiliate_revolut_payout_executions execution
      on execution.id = observation.execution_id
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    where item.account_id = new.account_id
      and (
        decision.id is null
        or decision.decision = 'quarantined'
      )
  ) then
    raise exception 'partner payouts are held for late settlement review'
      using errcode = 'P0003';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_reconciliation_incidents incident
    where not exists (
      select 1
      from
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions decision
      where decision.incident_id = incident.id
        and decision.action <> 'quarantine'
    )
      and (
        exists (
          select 1
          from affiliate_private.affiliate_revolut_payout_executions execution
          join affiliate_private.affiliate_payout_items item
            on item.id = execution.payout_item_id
          where execution.id = incident.source_execution_id
            and item.account_id = new.account_id
        )
        or exists (
          select 1
          from
            affiliate_private
              .affiliate_revolut_reconciliation_incident_reviews review
          join affiliate_private.affiliate_revolut_payout_executions execution
            on execution.id = review.target_execution_id
          join affiliate_private.affiliate_payout_items item
            on item.id = execution.payout_item_id
          where review.incident_id = incident.id
            and item.account_id = new.account_id
        )
      )
  ) then
    raise exception
      'partner payouts are held for reconciliation incident review'
      using errcode = 'P0003';
  end if;

  if not exists (
    select 1
    from affiliate_private.affiliate_revolut_beneficiary_bindings binding
    where binding.id = new.revolut_binding_id
      and binding.binding_version = new.revolut_binding_version
      and binding.account_id = new.account_id
      and binding.currency = new.currency
      and binding.status = 'active'
      and binding.beneficiary_token_ref =
        new.beneficiary_token_ref
      and binding.beneficiary_payment_method_ref is not distinct from
        new.beneficiary_payment_method_ref
      and binding.destination_masked = new.display_masked
  ) then
    raise exception
      'active Revolut profile must exactly match its verified binding'
      using errcode = 'P0004';
  end if;
  return new;
end;
$$;

create trigger affiliate_payout_profiles_binding_and_hold_guard
before insert or update on affiliate_private.affiliate_payout_profiles
for each row execute function
  affiliate_private.guard_payout_profile_binding_and_hold();

-- Generic payout setup must never write a Revolut destination. Revolut
-- profiles are activated only by the independently verified binding flow.
create or replace function public.partners_service_payout_profile_set(
  p_user_id uuid,
  p_idempotency_key text,
  p_provider text,
  p_beneficiary_token_ref text,
  p_display_masked text,
  p_currency text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if lower(btrim(coalesce(p_provider, ''))) = 'revolut' then
    raise exception
      'Revolut payout profiles require verified beneficiary binding'
      using errcode = 'P0001';
  end if;
  select affiliate_private.partners_service_payout_profile_set(
    p_user_id,
    p_idempotency_key,
    p_provider,
    p_beneficiary_token_ref,
    p_display_masked,
    p_currency
  )
  into v_result;
  return v_result;
end;
$$;

revoke all on function
  affiliate_private.partners_service_payout_profile_set(
    uuid, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function public.partners_service_payout_profile_set(
  uuid, text, text, text, text, text
)
from public, anon, authenticated, service_role;
grant execute on function public.partners_service_payout_profile_set(
  uuid, text, text, text, text, text
)
to service_role;

-- Account deletion is retried explicitly after Finance resolves every
-- matured/recovery balance and every non-terminal payout batch. The wrapper
-- holds the global payout configuration lock, so no new claim can race the
-- financial-closure decision.
create or replace function
public.partners_service_prepare_account_deletion(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account record;
  v_currency text;
  v_open_batches bigint := 0;
  v_open_executions bigint := 0;
  v_open_items bigint := 0;
  v_open_commission_jobs bigint := 0;
  v_open_maturation_jobs bigint := 0;
  v_open_dispute_won_jobs bigint := 0;
  v_unresolved_returns bigint := 0;
  v_unresolved_late_completions bigint := 0;
  v_unresolved_reconciliation_incidents bigint := 0;
  v_balance_count bigint := 0;
  v_balances jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'account deletion user is required'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  for v_account in
    select account.id
    from affiliate_private.affiliate_accounts account
    where account.user_id = p_user_id
    order by account.id
    for update
  loop
    for v_currency in
      select distinct rows.currency
      from (
        select entry.currency
        from affiliate_private.affiliate_commission_entries entry
        where entry.account_id = v_account.id
        union
        select profile.currency
        from affiliate_private.affiliate_payout_profiles profile
        where profile.account_id = v_account.id
        union
        select item.currency
        from affiliate_private.affiliate_payout_items item
        where item.account_id = v_account.id
      ) rows
      where rows.currency is not null
      order by rows.currency
    loop
      perform affiliate_private.partners_balance_lock(
        v_account.id,
        v_currency
      );
    end loop;
  end loop;

  select count(distinct batch.id)
  into v_open_batches
  from affiliate_private.affiliate_accounts account
  join affiliate_private.affiliate_payout_items item
    on item.account_id = account.id
  join affiliate_private.affiliate_revolut_payout_executions execution
    on execution.payout_item_id = item.id
    and not (
      execution.reconciliation_status = 'confirmed'
      and execution.state in (
        'paid',
        'failed',
        'cancelled',
        'exception'
      )
    )
  join affiliate_private.affiliate_revolut_manual_batches batch
    on batch.id = execution.manual_batch_id
  where account.user_id = p_user_id;
  select count(distinct execution.id)
  into v_open_executions
  from affiliate_private.affiliate_accounts account
  join affiliate_private.affiliate_payout_items item
    on item.account_id = account.id
  join affiliate_private.affiliate_revolut_payout_executions execution
    on execution.payout_item_id = item.id
    and not (
      execution.reconciliation_status = 'confirmed'
      and execution.state in (
        'paid',
        'failed',
        'cancelled',
        'exception'
      )
    )
  where account.user_id = p_user_id;
  select count(distinct item.id)
  into v_open_items
  from affiliate_private.affiliate_accounts account
  join affiliate_private.affiliate_payout_items item
    on item.account_id = account.id
    and item.status in ('pending', 'submitted')
  where account.user_id = p_user_id;
  select count(distinct job.id)
  into v_open_commission_jobs
  from affiliate_private.affiliate_accounts account
  join affiliate_private.affiliate_attributions attribution
    on attribution.referrer_account_id = account.id
  join affiliate_private.affiliate_financial_facts fact
    on fact.attribution_id = attribution.id
  join affiliate_private.affiliate_commission_jobs job
    on job.fact_id = fact.id
    and job.status in ('pending', 'retry', 'leased')
  where account.user_id = p_user_id;
  select count(distinct job.id)
  into v_open_maturation_jobs
  from affiliate_private.affiliate_accounts account
  join affiliate_private.affiliate_commission_entries accrual
    on accrual.account_id = account.id
  join affiliate_private.affiliate_maturation_jobs job
    on job.accrual_entry_id = accrual.id
    and job.status in ('pending', 'retry', 'leased')
  where account.user_id = p_user_id;
  select count(distinct job.id)
  into v_open_dispute_won_jobs
  from affiliate_private.affiliate_accounts account
  join affiliate_private.affiliate_attributions attribution
    on attribution.referrer_account_id = account.id
  join affiliate_private.affiliate_revolut_dispute_won_jobs job
    on job.referred_user_id = attribution.referred_user_id
    and job.status in ('pending', 'retry', 'leased')
  where account.user_id = p_user_id;
  select count(distinct observation.id)
  into v_unresolved_returns
  from affiliate_private.affiliate_accounts account
  join affiliate_private.affiliate_payout_items item
    on item.account_id = account.id
  join affiliate_private.affiliate_revolut_payout_executions execution
    on execution.payout_item_id = item.id
  join affiliate_private.affiliate_revolut_return_observations observation
    on observation.execution_id = execution.id
  left join affiliate_private.affiliate_revolut_return_decisions decision
    on decision.observation_id = observation.id
  where account.user_id = p_user_id
    and (
      decision.id is null
      or decision.decision = 'quarantined'
    );
  select count(distinct incident.id)
  into v_unresolved_reconciliation_incidents
  from affiliate_private.affiliate_revolut_reconciliation_incidents incident
  where not exists (
      select 1
      from
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions decision
      where decision.incident_id = incident.id
        and decision.action <> 'quarantine'
    )
    and (
      exists (
        select 1
        from affiliate_private.affiliate_revolut_payout_executions execution
        join affiliate_private.affiliate_payout_items item
          on item.id = execution.payout_item_id
        join affiliate_private.affiliate_accounts account
          on account.id = item.account_id
        where execution.id = incident.source_execution_id
          and account.user_id = p_user_id
      )
      or exists (
        select 1
        from
          affiliate_private
            .affiliate_revolut_reconciliation_incident_reviews review
        join affiliate_private.affiliate_revolut_payout_executions execution
          on execution.id = review.target_execution_id
        join affiliate_private.affiliate_payout_items item
          on item.id = execution.payout_item_id
        join affiliate_private.affiliate_accounts account
          on account.id = item.account_id
        where review.incident_id = incident.id
          and account.user_id = p_user_id
      )
    );
  select count(distinct observation.id)
  into v_unresolved_late_completions
  from affiliate_private.affiliate_accounts account
  join affiliate_private.affiliate_payout_items item
    on item.account_id = account.id
  join affiliate_private.affiliate_revolut_payout_executions execution
    on execution.payout_item_id = item.id
  join
    affiliate_private.affiliate_revolut_late_completion_observations
      observation
    on observation.execution_id = execution.id
  left join
    affiliate_private.affiliate_revolut_late_completion_decisions decision
    on decision.observation_id = observation.id
  where account.user_id = p_user_id
    and (
      decision.id is null
      or decision.decision = 'quarantined'
    );

  select
    count(*) filter (
      where balances.pending_minor <> 0
        or balances.available_minor <> 0
        or balances.recovery_due_minor <> 0
        or balances.clearing_minor <> 0
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'account_key', balances.account_key,
          'currency', balances.currency,
          'pending_minor', balances.pending_minor,
          'available_minor', balances.available_minor,
          'recovery_due_minor', balances.recovery_due_minor,
          'clearing_minor', balances.clearing_minor
        )
        order by balances.account_key, balances.currency
      ) filter (
        where balances.pending_minor <> 0
          or balances.available_minor <> 0
          or balances.recovery_due_minor <> 0
          or balances.clearing_minor <> 0
      ),
      '[]'::jsonb
    )
  into v_balance_count, v_balances
  from (
    select
      account.user_pseudonym as account_key,
      posting.currency,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_commission_pending'
            then case
              when posting.direction = 'credit' then posting.amount_minor
              else -posting.amount_minor
            end
          else 0
        end
      ), 0)::bigint as pending_minor,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_commission_available'
            then case
              when posting.direction = 'credit' then posting.amount_minor
              else -posting.amount_minor
            end
          else 0
        end
      ), 0)::bigint as available_minor,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_recovery_due'
            then case
              when posting.direction = 'debit' then posting.amount_minor
              else -posting.amount_minor
            end
          else 0
        end
      ), 0)::bigint as recovery_due_minor,
      coalesce(sum(
        case
          when posting.ledger_account = 'partner_payout_clearing'
            then case
              when posting.direction = 'credit' then posting.amount_minor
              else -posting.amount_minor
            end
          else 0
        end
      ), 0)::bigint as clearing_minor
    from affiliate_private.affiliate_accounts account
    join affiliate_private.affiliate_commission_entries entry
      on entry.account_id = account.id
    join affiliate_private.affiliate_commission_postings posting
      on posting.entry_id = entry.id
      and posting.ledger_account in (
        'partner_commission_pending',
        'partner_commission_available',
        'partner_recovery_due',
        'partner_payout_clearing'
      )
    where account.user_id = p_user_id
    group by account.user_pseudonym, posting.currency
  ) balances;

  if v_open_batches > 0
    or v_open_executions > 0
    or v_open_items > 0
    or v_open_commission_jobs > 0
    or v_open_maturation_jobs > 0
    or v_open_dispute_won_jobs > 0
    or v_unresolved_returns > 0
    or v_unresolved_late_completions > 0
    or v_unresolved_reconciliation_incidents > 0
    or v_balance_count > 0
  then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'partners_account_deletion_pending_financial_closure',
      'ready', false,
      'state', 'pending_financial_closure',
      'open_batch_count', v_open_batches,
      'open_execution_count', v_open_executions,
      'open_item_count', v_open_items,
      'open_commission_job_count', v_open_commission_jobs,
      'open_maturation_job_count', v_open_maturation_jobs,
      'open_dispute_won_job_count', v_open_dispute_won_jobs,
      'unresolved_return_count', v_unresolved_returns,
      'unresolved_late_completion_count',
        v_unresolved_late_completions,
      'unresolved_reconciliation_incident_count',
        v_unresolved_reconciliation_incidents,
      'balances', v_balances,
      'retry_action', 'prepare_account_deletion'
    );
  end if;

  select
    affiliate_private.partners_service_prepare_account_deletion(p_user_id)
  into v_result;
  return v_result;
end;
$$;

revoke all on function
  affiliate_private.partners_service_prepare_account_deletion(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  public.partners_service_prepare_account_deletion(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_prepare_account_deletion(uuid)
to service_role;

create or replace function
affiliate_private.guard_payout_item_execution_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.payout_reference is not null and (
    new.payout_reference is distinct from old.payout_reference
    or new.execution_adapter is distinct from old.execution_adapter
    or new.execution_claimed_at is distinct from old.execution_claimed_at
  ) then
    raise exception 'payout execution snapshot is immutable'
      using errcode = '55000';
  end if;
  if old.execution_claimed_at is not null and (
    new.cycle_id is distinct from old.cycle_id
    or new.account_id is distinct from old.account_id
    or new.currency is distinct from old.currency
    or new.payout_profile_id is distinct from old.payout_profile_id
    or new.allocation_entry_id is distinct from old.allocation_entry_id
    or new.original_amount_minor is distinct from
      old.original_amount_minor
    or new.amount_minor is distinct from old.amount_minor
    or new.recovered_minor is distinct from old.recovered_minor
  ) then
    raise exception 'claimed payout item money is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_payout_items_execution_snapshot_guard
before update on affiliate_private.affiliate_payout_items
for each row execute function
  affiliate_private.guard_payout_item_execution_snapshot();

-- Once a payout has an immutable adapter/reference snapshot, a later refund
-- must become recovery_due for a future payout. It must never shrink the
-- already prepared transfer amount. This replaces the pre-adapter recovery
-- router with the same ledger contract plus the claim exclusion.
create or replace function
affiliate_private.partners_route_commission_recovery(
  p_entry_id uuid,
  p_account_id uuid,
  p_currency text,
  p_amount_minor bigint,
  p_pending_only boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_remaining bigint := p_amount_minor;
  v_pending_minor bigint := 0;
  v_available_minor bigint := 0;
  v_clearing_minor bigint := 0;
  v_recovery_due_minor bigint := 0;
  v_available_balance bigint := 0;
  v_take bigint;
  v_item record;
begin
  if p_entry_id is null
    or p_account_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or p_amount_minor is null
    or p_amount_minor not between 1 and 9007199254740991
    or p_pending_only is null
  then
    raise exception 'invalid Partner recovery route'
      using errcode = '22023';
  end if;

  select entry.*
  into v_entry
  from affiliate_private.affiliate_commission_entries entry
  where entry.id = p_entry_id
    and entry.account_id = p_account_id
    and entry.currency = v_currency
    and entry.amount_minor = p_amount_minor
    and entry.entry_kind in ('reversal', 'manual_reversal');
  if not found then
    raise exception 'Partner recovery entry is unavailable'
      using errcode = 'P0002';
  end if;

  perform affiliate_private.partners_balance_lock(
    p_account_id,
    v_currency
  );

  if p_pending_only then
    v_pending_minor := v_remaining;
    v_remaining := 0;
  else
    select coalesce(sum(
      case
        when posting.direction = 'credit' then posting.amount_minor
        else -posting.amount_minor
      end
    ), 0)::bigint
    into v_available_balance
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = p_account_id
      and posting.currency = v_currency
      and posting.ledger_account = 'partner_commission_available';

    v_available_minor := least(
      v_remaining,
      greatest(v_available_balance, 0)
    );
    v_remaining := v_remaining - v_available_minor;

    if v_remaining > 0 then
      for v_item in
        select
          item.id,
          item.original_amount_minor,
          item.amount_minor,
          item.recovered_minor,
          item.status,
          cycle.id as cycle_id,
          cycle.total_minor,
          cycle.item_count
        from affiliate_private.affiliate_payout_items item
        join affiliate_private.affiliate_payout_cycles cycle
          on cycle.id = item.cycle_id
        where item.account_id = p_account_id
          and cycle.currency = v_currency
          and item.allocation_entry_id is not null
          and item.status in ('pending', 'failed')
          and item.amount_minor > 0
          and item.execution_claimed_at is null
          and item.payout_reference is null
          and item.execution_adapter is null
          and cycle.status in ('approved', 'failed', 'cancelled')
        order by cycle.approved_at nulls last, item.created_at, item.id
        for update of item, cycle
      loop
        exit when v_remaining = 0;
        v_take := least(v_remaining, v_item.amount_minor);
        if v_item.total_minor < v_take or v_item.item_count < 1 then
          raise exception 'payout recovery totals are inconsistent'
            using errcode = '55000';
        end if;

        update affiliate_private.affiliate_payout_items item
        set
          amount_minor = item.amount_minor - v_take,
          recovered_minor = item.recovered_minor + v_take,
          status = case
            when item.amount_minor - v_take = 0 then 'reversed'
            else item.status
          end,
          updated_at = now()
        where item.id = v_item.id
          and item.execution_claimed_at is null
          and item.payout_reference is null
          and item.execution_adapter is null;
        if not found then
          raise exception 'payout was claimed during recovery routing'
            using errcode = 'P0004';
        end if;

        update affiliate_private.affiliate_payout_cycles cycle
        set
          total_minor = cycle.total_minor - v_take,
          item_count = cycle.item_count - case
            when v_item.amount_minor - v_take = 0 then 1
            else 0
          end,
          updated_at = now()
        where cycle.id = v_item.cycle_id;

        v_clearing_minor := v_clearing_minor + v_take;
        v_remaining := v_remaining - v_take;
      end loop;
    end if;

    v_recovery_due_minor := v_remaining;
    v_remaining := 0;
  end if;

  if v_pending_minor > 0 then
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    )
    values (
      p_entry_id,
      'partner_commission_pending',
      'debit',
      v_pending_minor,
      v_currency
    );
  end if;
  if v_available_minor > 0 then
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    )
    values (
      p_entry_id,
      'partner_commission_available',
      'debit',
      v_available_minor,
      v_currency
    );
  end if;
  if v_clearing_minor > 0 then
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    )
    values (
      p_entry_id,
      'partner_payout_clearing',
      'debit',
      v_clearing_minor,
      v_currency
    );
  end if;
  if v_recovery_due_minor > 0 then
    insert into affiliate_private.affiliate_commission_postings (
      entry_id, ledger_account, direction, amount_minor, currency
    )
    values (
      p_entry_id,
      'partner_recovery_due',
      'debit',
      v_recovery_due_minor,
      v_currency
    );
  end if;
  insert into affiliate_private.affiliate_commission_postings (
    entry_id, ledger_account, direction, amount_minor, currency
  )
  values (
    p_entry_id,
    'platform_commission_recovery',
    'credit',
    p_amount_minor,
    v_currency
  );

  return jsonb_build_object(
    'pending_minor', v_pending_minor,
    'available_minor', v_available_minor,
    'clearing_minor', v_clearing_minor,
    'recovery_due_minor', v_recovery_due_minor
  );
end;
$$;

alter table
  affiliate_private.affiliate_revolut_reconciliation_incidents
  add constraint affiliate_revolut_reconciliation_incidents_row_fk
    foreign key (statement_row_id)
    references affiliate_private.affiliate_revolut_statement_rows(id)
    on delete restrict,
  add constraint affiliate_revolut_reconciliation_incidents_execution_fk
    foreign key (source_execution_id)
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict;
alter table
  affiliate_private.affiliate_revolut_reconciliation_incident_reviews
  add constraint affiliate_revolut_reconciliation_reviews_incident_fk
    foreign key (incident_id)
    references
      affiliate_private.affiliate_revolut_reconciliation_incidents(id)
    on delete restrict,
  add constraint affiliate_revolut_reconciliation_reviews_execution_fk
    foreign key (target_execution_id)
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict;
alter table affiliate_private.affiliate_revolut_transaction_aliases
  add constraint affiliate_revolut_transaction_aliases_incident_fk
    foreign key (incident_id)
    references
      affiliate_private.affiliate_revolut_reconciliation_incidents(id)
    on delete restrict,
  add constraint affiliate_revolut_transaction_aliases_review_fk
    foreign key (review_id)
    references
      affiliate_private.affiliate_revolut_reconciliation_incident_reviews(id)
    on delete restrict,
  add constraint affiliate_revolut_transaction_aliases_execution_fk
    foreign key (execution_id)
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict;
alter table
  affiliate_private.affiliate_revolut_reconciliation_incident_decisions
  add constraint affiliate_revolut_reconciliation_decisions_incident_fk
    foreign key (incident_id)
    references
      affiliate_private.affiliate_revolut_reconciliation_incidents(id)
    on delete restrict,
  add constraint affiliate_revolut_reconciliation_decisions_review_fk
    foreign key (review_id)
    references
      affiliate_private.affiliate_revolut_reconciliation_incident_reviews(id)
    on delete restrict,
  add constraint affiliate_revolut_reconciliation_decisions_execution_fk
    foreign key (target_execution_id)
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  add constraint affiliate_revolut_reconciliation_decisions_entry_fk
    foreign key (resolution_entry_id)
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  add constraint affiliate_revolut_reconciliation_decisions_alias_fk
    foreign key (alias_id)
    references affiliate_private.affiliate_revolut_transaction_aliases(id)
    on delete restrict;

create or replace function
affiliate_private.capture_revolut_reconciliation_incident()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_alias affiliate_private.affiliate_revolut_transaction_aliases%rowtype;
  v_is_duplicate_completion boolean := false;
begin
  if new.execution_id is not null then
    select execution.*
    into v_execution
    from affiliate_private.affiliate_revolut_payout_executions execution
    where execution.id = new.execution_id;
    if found then
      select item.*
      into v_item
      from affiliate_private.affiliate_payout_items item
      where item.id = v_execution.payout_item_id;
    end if;
  end if;

  if new.provider_state = 'COMPLETED'
    and v_execution.id is not null
    and new.amount_minor = v_execution.amount_minor
    and new.currency = v_execution.currency
    and v_execution.state = 'paid'
    and v_execution.reconciliation_status = 'confirmed'
  then
    select alias.*
    into v_alias
    from affiliate_private.affiliate_revolut_transaction_aliases alias
    where alias.execution_id = v_execution.id;
    v_is_duplicate_completion :=
      (
        new.match_status = 'mismatch'
        and new.discrepancy_code = 'transaction_mismatch'
      )
      or (
        new.match_status = 'matched'
        and v_alias.id is not null
        and v_alias.superseded_provider_transaction_hash is not null
        and new.provider_transaction_hash =
          v_alias.superseded_provider_transaction_hash
      );
  end if;

  if v_is_duplicate_completion then
    perform affiliate_private.record_revolut_late_completion_observation(
      v_execution.id,
      'statement',
      new.id,
      new.statement_row_hash,
      new.observed_at
    );
    return new;
  end if;

  if new.match_status = 'matched'
    or new.discrepancy_code = 'post_settlement_return'
    or (
      new.discrepancy_code = 'provider_not_completed'
      and new.provider_state in ('FAILED', 'CANCELLED', 'REVERTED')
    )
    or (
      new.discrepancy_code = 'execution_state_mismatch'
      and v_item.id is not null
      and exists (
        select 1
        from affiliate_private.affiliate_commission_entries release
        where release.entry_kind = 'payout_release'
          and release.related_entry_id = v_item.allocation_entry_id
      )
    )
  then
    return new;
  end if;

  insert into
    affiliate_private.affiliate_revolut_reconciliation_incidents (
      statement_row_id,
      source_execution_id,
      source_evidence_hash,
      incident_kind,
      source_reference,
      source_provider_transaction_hash,
      source_provider_state,
      source_amount_minor,
      source_currency,
      expected_reference,
      expected_provider_transaction_hash,
      expected_amount_minor,
      expected_currency,
      observed_at
    )
  values (
    new.id,
    v_execution.id,
    new.statement_row_hash,
    new.discrepancy_code,
    new.payout_reference,
    new.provider_transaction_hash,
    new.provider_state,
    new.amount_minor,
    new.currency,
    v_execution.payout_reference,
    v_execution.provider_transaction_hash,
    v_execution.amount_minor,
    v_execution.currency,
    new.observed_at
  )
  on conflict (statement_row_id) do nothing;

  if v_item.id is not null then
    update affiliate_private.affiliate_payout_profiles profile
    set status = 'verification_required', updated_at = now()
    where profile.account_id = v_item.account_id
      and profile.status <> 'disabled';
    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      job_status = 'exception',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = coalesce(
        new.discrepancy_code,
        'reconciliation_incident'
      ),
      updated_at = now()
    where execution.id = v_execution.id
      and not (
        execution.state = 'paid'
        and execution.reconciliation_status = 'confirmed'
      );
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_statement_row_incident_capture
after insert on affiliate_private.affiliate_revolut_statement_rows
for each row execute function
  affiliate_private.capture_revolut_reconciliation_incident();

insert into
  affiliate_private.affiliate_revolut_reconciliation_incidents (
    statement_row_id,
    source_execution_id,
    source_evidence_hash,
    incident_kind,
    source_reference,
    source_provider_transaction_hash,
    source_provider_state,
    source_amount_minor,
    source_currency,
    expected_reference,
    expected_provider_transaction_hash,
    expected_amount_minor,
    expected_currency,
    observed_at
  )
select
  row.id,
  execution.id,
  row.statement_row_hash,
  row.discrepancy_code,
  row.payout_reference,
  row.provider_transaction_hash,
  row.provider_state,
  row.amount_minor,
  row.currency,
  execution.payout_reference,
  execution.provider_transaction_hash,
  execution.amount_minor,
  execution.currency,
  row.observed_at
from affiliate_private.affiliate_revolut_statement_rows row
left join affiliate_private.affiliate_revolut_payout_executions execution
  on execution.id = row.execution_id
left join affiliate_private.affiliate_payout_items item
  on item.id = execution.payout_item_id
where row.match_status in ('unmatched', 'mismatch')
  and row.discrepancy_code <> 'post_settlement_return'
  and not (
    row.discrepancy_code = 'provider_not_completed'
    and row.provider_state in ('FAILED', 'CANCELLED', 'REVERTED')
  )
  and not (
    row.discrepancy_code = 'execution_state_mismatch'
    and exists (
      select 1
      from affiliate_private.affiliate_commission_entries release
      where release.entry_kind = 'payout_release'
        and release.related_entry_id = item.allocation_entry_id
    )
  )
  and not (
    row.discrepancy_code = 'transaction_mismatch'
    and row.provider_state = 'COMPLETED'
    and row.amount_minor = execution.amount_minor
    and row.currency = execution.currency
    and execution.state = 'paid'
    and execution.reconciliation_status = 'confirmed'
  )
on conflict (statement_row_id) do nothing;

-- Financial mutations and account erasure share one global fence. The account
-- and currency balance are locked before the accrual row or any new ledger
-- entry so deletion can never close an account between entry creation and
-- posting.
create or replace function
affiliate_private.admin_partners_commission_reverse(
  p_entry_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry_key text := lower(btrim(coalesce(p_entry_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_account_id uuid;
  v_currency text;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_accrual affiliate_private.affiliate_commission_entries%rowtype;
  v_reversal affiliate_private.affiliate_commission_entries%rowtype;
  v_reversed bigint := 0;
  v_amount bigint := 0;
  v_recovery_route jsonb;
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_capability('risk');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual commission reversal requires AAL2'
      using errcode = '42501';
  end if;
  if v_entry_key !~ '^led_[0-9a-f]{24}$'
    or v_confirmation <> 'REVERSE:' || v_entry_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual reversal'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  select entry.account_id, entry.currency
  into v_account_id, v_currency
  from affiliate_private.affiliate_commission_entries entry
  where entry.entry_key = v_entry_key
    and entry.entry_kind = 'accrual';
  if not found then
    raise exception 'accrual entry is unavailable'
      using errcode = 'P0002';
  end if;

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = v_account_id
  for update;
  if not found or v_account.status = 'closed' then
    raise exception 'Partner account is unavailable for reversal'
      using errcode = '55000';
  end if;

  perform affiliate_private.partners_balance_lock(
    v_account_id,
    v_currency
  );

  select entry.*
  into v_accrual
  from affiliate_private.affiliate_commission_entries entry
  where entry.entry_key = v_entry_key
    and entry.entry_kind = 'accrual'
    and entry.account_id = v_account_id
    and entry.currency = v_currency
  for update;
  if not found then
    raise exception 'accrual entry changed during reversal'
      using errcode = 'P0004';
  end if;

  v_reversed :=
    affiliate_private.partners_net_reversed_minor(v_accrual.id);
  v_amount := greatest(v_accrual.amount_minor - v_reversed, 0);
  if v_amount = 0 then
    raise exception 'accrual has no reversible balance'
      using errcode = 'P0001';
  end if;

  insert into affiliate_private.affiliate_commission_entries (
    account_id,
    attribution_id,
    entry_kind,
    related_entry_id,
    currency,
    currency_exponent,
    amount_minor
  )
  values (
    v_accrual.account_id,
    v_accrual.attribution_id,
    'manual_reversal',
    v_accrual.id,
    v_accrual.currency,
    v_accrual.currency_exponent,
    v_amount
  )
  returning * into v_reversal;

  v_recovery_route :=
    affiliate_private.partners_route_commission_recovery(
      v_reversal.id,
      v_accrual.account_id,
      v_accrual.currency,
      v_amount,
      not exists (
        select 1
        from affiliate_private.affiliate_commission_entries release
        where release.related_entry_id = v_accrual.id
          and release.entry_kind = 'release'
      )
    );

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'commission',
    v_reversal.entry_key,
    'manual_commission_reversal',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'origin_entry_key', v_accrual.entry_key,
      'amount_minor', v_amount,
      'currency', v_accrual.currency,
      'recovery_route', v_recovery_route
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'manual_commission_reversal',
    'ledger_entry', jsonb_build_object(
      'key', v_reversal.entry_key,
      'status', 'reversed',
      'recovery_route', v_recovery_route
    )
  );
end;
$$;

revoke all on function
  affiliate_private.admin_partners_commission_reverse(text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_commission_reverse(text, text, text)
to authenticated;

alter function
  affiliate_private.partners_worker_commission_job_complete(
    text, text, text, text, text
  )
rename to partners_worker_commission_job_complete_pre_financial_fence;

revoke all on function
  affiliate_private
    .partners_worker_commission_job_complete_pre_financial_fence(
      text, text, text, text, text
    )
from public, anon, authenticated, service_role;

create or replace function
affiliate_private.partners_worker_commission_job_complete(
  p_job_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_outcome text := lower(btrim(coalesce(p_outcome, '')));
  v_account_id uuid;
  v_currency text;
  v_result jsonb;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  if v_outcome = 'succeeded' then
    select
      attribution.referrer_account_id,
      fact.currency
    into v_account_id, v_currency
    from affiliate_private.affiliate_commission_jobs job
    join affiliate_private.affiliate_financial_facts fact
      on fact.id = job.fact_id
    join affiliate_private.affiliate_attributions attribution
      on attribution.id = coalesce(
        fact.attribution_id,
        (
          select lineage.attribution_id
          from
            affiliate_private.affiliate_financial_fact_lineage_links
              lineage
          where lineage.child_fact_id = fact.id
        )
      )
    where job.job_key = lower(btrim(coalesce(p_job_key, '')));
    if not found or v_currency is null then
      raise exception 'commission job financial owner is unavailable'
        using errcode = 'P0004';
    end if;

    perform 1
    from affiliate_private.affiliate_accounts account
    where account.id = v_account_id
      and account.status <> 'closed'
    for update;
    if not found then
      raise exception 'closed Partner account cannot receive ledger writes'
        using errcode = '55000';
    end if;
    perform affiliate_private.partners_balance_lock(
      v_account_id,
      v_currency
    );
  end if;

  select
    affiliate_private
      .partners_worker_commission_job_complete_pre_financial_fence(
        p_job_key,
        p_worker_id,
        p_lease_token_hash,
        p_outcome,
        p_error_code
      )
  into v_result;
  return v_result;
end;
$$;

revoke all on function
  affiliate_private.partners_worker_commission_job_complete(
    text, text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_commission_job_complete(
    text, text, text, text, text
  )
to service_role;

create or replace function
affiliate_private.guard_revolut_execution_snapshot()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.execution_key is distinct from old.execution_key
    or new.payout_item_id is distinct from old.payout_item_id
    or new.manual_batch_id is distinct from old.manual_batch_id
    or new.adapter is distinct from old.adapter
    or new.payout_reference is distinct from old.payout_reference
    or new.request_id is distinct from old.request_id
    or new.beneficiary_token_ref is distinct from
      old.beneficiary_token_ref
    or new.beneficiary_payment_method_ref is distinct from
      old.beneficiary_payment_method_ref
    or new.beneficiary_binding_id is distinct from
      old.beneficiary_binding_id
    or new.beneficiary_binding_version is distinct from
      old.beneficiary_binding_version
    or new.beneficiary_fingerprint_hmac is distinct from
      old.beneficiary_fingerprint_hmac
    or new.beneficiary_fingerprint_key_version is distinct from
      old.beneficiary_fingerprint_key_version
    or new.destination_masked is distinct from old.destination_masked
    or new.amount_minor is distinct from old.amount_minor
    or new.currency is distinct from old.currency
    or new.currency_exponent is distinct from old.currency_exponent
    or new.prepared_by_pseudonym is distinct from
      old.prepared_by_pseudonym
    or new.created_at is distinct from old.created_at
    or new.updated_at < old.updated_at
  then
    raise exception 'Revolut payout execution snapshot is immutable'
      using errcode = '55000';
  end if;

  if old.provider_transaction_hash is not null and (
    new.provider_transaction_id is distinct from
      old.provider_transaction_id
    or new.provider_transaction_hash is distinct from
      old.provider_transaction_hash
  ) then
    raise exception 'Revolut transaction identity is immutable'
      using errcode = '55000';
  end if;
  if old.exported_at is not null
    and new.exported_at is distinct from old.exported_at
  then
    raise exception 'Revolut export evidence is immutable'
      using errcode = '55000';
  end if;
  if old.submitted_at is not null
    and new.submitted_at is distinct from old.submitted_at
  then
    raise exception 'Revolut submission evidence is immutable'
      using errcode = '55000';
  end if;
  if old.submitted_by_pseudonym is not null
    and new.submitted_by_pseudonym is distinct from
      old.submitted_by_pseudonym
  then
    raise exception 'Revolut submitter identity is immutable'
      using errcode = '55000';
  end if;
  if old.paid_observed_at is not null
    and new.paid_observed_at is distinct from old.paid_observed_at
  then
    raise exception 'Revolut paid observation is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_execution_snapshot_guard
before update
on affiliate_private.affiliate_revolut_payout_executions
for each row execute function
  affiliate_private.guard_revolut_execution_snapshot();

create or replace function
affiliate_private.reject_revolut_evidence_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Revolut payout evidence is append-only'
    using errcode = '55000';
end;
$$;

create or replace function
affiliate_private.guard_revolut_statement_ticket_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.consumed_at is not null
    or new.id is distinct from old.id
    or new.ticket_key is distinct from old.ticket_key
    or new.ticket_token_hash is distinct from old.ticket_token_hash
    or new.actor_pseudonym is distinct from old.actor_pseudonym
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at
    or new.consumed_at is null
    or new.source_file_hash is null
  then
    raise exception 'invalid statement ticket transition'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function
affiliate_private.guard_revolut_beneficiary_binding_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.binding_key is distinct from old.binding_key
    or new.account_id is distinct from old.account_id
    or new.currency is distinct from old.currency
    or new.binding_version is distinct from old.binding_version
    or new.beneficiary_token_ref is distinct from
      old.beneficiary_token_ref
    or new.beneficiary_payment_method_ref is distinct from
      old.beneficiary_payment_method_ref
    or new.destination_masked is distinct from old.destination_masked
    or new.beneficiary_fingerprint_hmac is distinct from
      old.beneficiary_fingerprint_hmac
    or new.mapping_attestation_hmac is distinct from
      old.mapping_attestation_hmac
    or new.fingerprint_key_version is distinct from
      old.fingerprint_key_version
    or new.mapping_evidence_hash is distinct from
      old.mapping_evidence_hash
    or new.authorization_ticket_id is distinct from
      old.authorization_ticket_id
    or new.proposed_by_pseudonym is distinct from
      old.proposed_by_pseudonym
    or new.proposal_justification is distinct from
      old.proposal_justification
    or new.proposed_at is distinct from old.proposed_at
    or (
      old.status = 'pending'
      and (
        new.status not in ('active', 'rejected')
        or new.verified_by_pseudonym is null
        or new.verified_by_pseudonym =
          old.proposed_by_pseudonym
        or new.verification_justification is null
        or new.verified_at is null
        or new.revoked_by_pseudonym is not null
        or new.revocation_justification is not null
        or new.revoked_at is not null
      )
    )
    or (
      old.status = 'active'
      and (
        new.status <> 'revoked'
        or new.verified_by_pseudonym is distinct from
          old.verified_by_pseudonym
        or new.verification_justification is distinct from
          old.verification_justification
        or new.verified_at is distinct from old.verified_at
        or new.revoked_by_pseudonym is null
        or new.revocation_justification is null
        or new.revoked_at is null
      )
    )
    or old.status in ('rejected', 'revoked')
  then
    raise exception 'invalid Revolut beneficiary binding transition'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function
affiliate_private.guard_revolut_binding_ticket_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.consumed_at is not null
    or new.id is distinct from old.id
    or new.ticket_key is distinct from old.ticket_key
    or new.ticket_token_hash is distinct from old.ticket_token_hash
    or new.account_id is distinct from old.account_id
    or new.currency is distinct from old.currency
    or new.beneficiary_token_ref is distinct from
      old.beneficiary_token_ref
    or new.beneficiary_payment_method_ref is distinct from
      old.beneficiary_payment_method_ref
    or new.destination_masked is distinct from old.destination_masked
    or new.fingerprint_key_version is distinct from
      old.fingerprint_key_version
    or new.mapping_evidence_hash is distinct from
      old.mapping_evidence_hash
    or new.authorized_by_pseudonym is distinct from
      old.authorized_by_pseudonym
    or new.authorization_justification is distinct from
      old.authorization_justification
    or new.expires_at is distinct from old.expires_at
    or new.created_at is distinct from old.created_at
    or new.consumed_at is null
  then
    raise exception 'invalid beneficiary binding ticket transition'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create or replace function
affiliate_private.guard_revolut_beneficiary_revocation_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'pending'
    or new.status <> 'confirmed'
    or new.id is distinct from old.id
    or new.revocation_key is distinct from old.revocation_key
    or new.binding_id is distinct from old.binding_id
    or new.requested_by_pseudonym is distinct from
      old.requested_by_pseudonym
    or new.request_confirmation_hash is distinct from
      old.request_confirmation_hash
    or new.request_justification is distinct from
      old.request_justification
    or new.requested_at is distinct from old.requested_at
    or new.approved_by_pseudonym is null
    or new.approved_by_pseudonym = old.requested_by_pseudonym
    or new.approval_confirmation_hash is null
    or new.approval_justification is null
    or new.approved_at is null
  then
    raise exception 'invalid beneficiary revocation transition'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_beneficiary_binding_transition_guard
before update
on affiliate_private.affiliate_revolut_beneficiary_bindings
for each row execute function
  affiliate_private.guard_revolut_beneficiary_binding_transition();
create trigger affiliate_revolut_beneficiary_binding_delete_guard
before delete
on affiliate_private.affiliate_revolut_beneficiary_bindings
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_binding_ticket_transition_guard
before update
on affiliate_private.affiliate_revolut_beneficiary_binding_tickets
for each row execute function
  affiliate_private.guard_revolut_binding_ticket_transition();
create trigger affiliate_revolut_binding_ticket_delete_guard
before delete
on affiliate_private.affiliate_revolut_beneficiary_binding_tickets
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_beneficiary_revocation_transition_guard
before update
on affiliate_private.affiliate_revolut_beneficiary_revocations
for each row execute function
  affiliate_private.guard_revolut_beneficiary_revocation_transition();
create trigger affiliate_revolut_beneficiary_revocation_delete_guard
before delete
on affiliate_private.affiliate_revolut_beneficiary_revocations
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();

create trigger affiliate_revolut_payout_events_append_only
before update or delete
on affiliate_private.affiliate_revolut_payout_events
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_statement_ticket_transition_guard
before update on affiliate_private.affiliate_revolut_statement_tickets
for each row execute function
  affiliate_private.guard_revolut_statement_ticket_transition();
create trigger affiliate_revolut_statement_ticket_delete_guard
before delete on affiliate_private.affiliate_revolut_statement_tickets
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_manual_batches_delete_guard
before delete
on affiliate_private.affiliate_revolut_manual_batches
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_reference_allocations_delete_guard
before update or delete
on affiliate_private.affiliate_revolut_reference_allocations
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_payout_executions_delete_guard
before delete
on affiliate_private.affiliate_revolut_payout_executions
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_api_worker_lease_delete_guard
before delete
on affiliate_private.affiliate_revolut_api_worker_lease
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_statement_rows_append_only
before update or delete
on affiliate_private.affiliate_revolut_statement_rows
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_manual_reviews_append_only
before update or delete
on affiliate_private.affiliate_revolut_manual_reviews
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_manual_decisions_append_only
before update or delete
on affiliate_private.affiliate_revolut_manual_decisions
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_return_observations_append_only
before update or delete
on affiliate_private.affiliate_revolut_return_observations
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_return_reviews_append_only
before update or delete
on affiliate_private.affiliate_revolut_return_reviews
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_return_decisions_append_only
before update or delete
on affiliate_private.affiliate_revolut_return_decisions
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();

create or replace function
affiliate_private.guard_revolut_statement_import_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'processing' then
    raise exception 'completed statement import is immutable'
      using errcode = '55000';
  end if;
  if new.status not in ('complete', 'exception')
    or new.id is distinct from old.id
    or new.import_key is distinct from old.import_key
    or new.source_file_hash is distinct from old.source_file_hash
    or new.period_start is distinct from old.period_start
    or new.period_end is distinct from old.period_end
    or new.currency is distinct from old.currency
    or new.imported_by_pseudonym is distinct from old.imported_by_pseudonym
    or new.authorization_ticket_id is distinct from
      old.authorization_ticket_id
    or new.created_at is distinct from old.created_at
    or new.completed_at is null
    or new.completed_at < old.created_at
  then
    raise exception 'invalid statement import transition'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_statement_import_transition_guard
before update on affiliate_private.affiliate_revolut_statement_imports
for each row execute function
  affiliate_private.guard_revolut_statement_import_transition();

create or replace function
affiliate_private.record_revolut_return_observation(
  p_execution_id uuid,
  p_source_kind text,
  p_source_id uuid,
  p_source_evidence_hash text,
  p_provider_state text,
  p_observed_at timestamptz
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_source_kind text := lower(btrim(coalesce(p_source_kind, '')));
  v_evidence_hash text :=
    lower(btrim(coalesce(p_source_evidence_hash, '')));
  v_state text := upper(btrim(coalesce(p_provider_state, '')));
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_kind text;
  v_observation_id uuid;
begin
  if p_execution_id is null
    or p_source_id is null
    or v_source_kind not in ('statement', 'api_event')
    or v_evidence_hash !~ '^[0-9a-f]{64}$'
    or v_state not in ('FAILED', 'CANCELLED', 'REVERTED')
    or p_observed_at is null
  then
    raise exception 'invalid Revolut return observation'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  select execution.*
  into v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = p_execution_id
  for update;
  if not found then
    raise exception 'Revolut execution is unavailable'
      using errcode = 'P0002';
  end if;

  if v_source_kind = 'statement' then
    if not exists (
      select 1
      from affiliate_private.affiliate_revolut_statement_rows row
      where row.id = p_source_id
        and row.execution_id = v_execution.id
        and row.statement_row_hash = v_evidence_hash
        and row.provider_state = v_state
        and row.amount_minor = v_execution.amount_minor
        and row.currency = v_execution.currency
        and (
          row.provider_transaction_hash is not distinct from
            v_execution.provider_transaction_hash
          or exists (
            select 1
            from affiliate_private.affiliate_revolut_transaction_aliases alias
            where alias.execution_id = v_execution.id
              and alias.authoritative_provider_transaction_hash =
                row.provider_transaction_hash
          )
        )
    ) then
      raise exception 'statement return evidence does not match execution'
        using errcode = 'P0004';
    end if;
  elsif not exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_events event
    where event.id = p_source_id
      and event.execution_id = v_execution.id
      and event.provider_event_hash = v_evidence_hash
      and event.provider_state = v_state
  ) then
    raise exception 'API return evidence does not match execution'
      using errcode = 'P0004';
  end if;

  v_kind := case
    when exists (
      select 1
      from affiliate_private.affiliate_payout_items item
      join affiliate_private.affiliate_commission_entries settlement
        on settlement.related_entry_id = item.allocation_entry_id
        and settlement.entry_kind = 'payout_settlement'
      where item.id = v_execution.payout_item_id
    ) then 'post_settlement_return'
    else 'pre_settlement_release'
  end;

  insert into
    affiliate_private.affiliate_revolut_return_observations (
      execution_id,
      statement_row_id,
      payout_event_id,
      source_evidence_hash,
      return_kind,
      provider_state,
      amount_minor,
      currency,
      observed_at
    )
  values (
    v_execution.id,
    case when v_source_kind = 'statement' then p_source_id end,
    case when v_source_kind = 'api_event' then p_source_id end,
    v_evidence_hash,
    v_kind,
    v_state,
    v_execution.amount_minor,
    v_execution.currency,
    p_observed_at
  )
  on conflict do nothing
  returning id into v_observation_id;

  if v_observation_id is null then
    select observation.id
    into v_observation_id
    from affiliate_private.affiliate_revolut_return_observations observation
    where observation.execution_id = v_execution.id
      and observation.return_kind = v_kind
      and observation.amount_minor = v_execution.amount_minor
      and observation.currency = v_execution.currency;
    if not found then
      raise exception 'conflicting Revolut return evidence replay'
        using errcode = 'P0005';
    end if;
  end if;
  return v_observation_id;
end;
$$;

create or replace function
affiliate_private.record_revolut_late_completion_observation(
  p_execution_id uuid,
  p_source_kind text,
  p_source_id uuid,
  p_source_evidence_hash text,
  p_observed_at timestamptz
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_source_kind text := lower(btrim(coalesce(p_source_kind, '')));
  v_evidence_hash text :=
    lower(btrim(coalesce(p_source_evidence_hash, '')));
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_release affiliate_private.affiliate_commission_entries%rowtype;
  v_observation_id uuid;
  v_new boolean := false;
begin
  if p_execution_id is null
    or p_source_id is null
    or v_source_kind not in ('statement', 'api_event')
    or v_evidence_hash !~ '^[0-9a-f]{64}$'
    or p_observed_at is null
  then
    raise exception 'invalid late Revolut completion observation'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  select execution.*
  into v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = p_execution_id
  for update;
  if not found then
    raise exception 'Revolut execution is unavailable'
      using errcode = 'P0002';
  end if;
  select item.*
  into v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_execution.payout_item_id
  for update;
  select release.*
  into v_release
  from affiliate_private.affiliate_commission_entries release
  where release.entry_kind in ('payout_release', 'payout_settlement')
    and release.related_entry_id = v_item.allocation_entry_id
    and release.account_id = v_item.account_id
    and release.amount_minor = v_execution.amount_minor
    and release.currency = v_execution.currency
  order by case release.entry_kind
    when 'payout_release' then 1
    else 2
  end
  limit 1;
  if not found
    or v_execution.reconciliation_status <> 'confirmed'
    or (
      v_release.entry_kind = 'payout_release'
      and (
        v_execution.state not in ('failed', 'cancelled', 'exception')
        or v_item.status not in ('failed', 'reversed')
      )
    )
    or (
      v_release.entry_kind = 'payout_settlement'
      and (
        v_execution.state <> 'paid'
        or v_item.status <> 'settled'
      )
    )
  then
    raise exception 'execution has no confirmed payout disposition'
      using errcode = 'P0004';
  end if;

  if v_source_kind = 'statement' then
    if not exists (
      select 1
      from affiliate_private.affiliate_revolut_statement_rows row
      where row.id = p_source_id
        and row.execution_id = v_execution.id
        and row.statement_row_hash = v_evidence_hash
        and row.provider_state = 'COMPLETED'
        and row.amount_minor = v_execution.amount_minor
        and row.currency = v_execution.currency
        and (
          v_release.entry_kind = 'payout_settlement'
          or v_execution.provider_transaction_hash is null
          or row.provider_transaction_hash = v_execution.provider_transaction_hash
        )
    ) then
      raise exception 'late statement completion does not match execution'
        using errcode = 'P0004';
    end if;
  elsif not exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_events event
    where event.id = p_source_id
      and event.execution_id = v_execution.id
      and event.provider_event_hash = v_evidence_hash
      and event.provider_state = 'COMPLETED'
  ) then
    raise exception 'late API completion does not match execution'
      using errcode = 'P0004';
  end if;

  insert into
    affiliate_private.affiliate_revolut_late_completion_observations (
      execution_id,
      statement_row_id,
      payout_event_id,
      release_entry_id,
      source_evidence_hash,
      amount_minor,
      currency,
      observed_at
    )
  values (
    v_execution.id,
    case when v_source_kind = 'statement' then p_source_id end,
    case when v_source_kind = 'api_event' then p_source_id end,
    v_release.id,
    v_evidence_hash,
    v_execution.amount_minor,
    v_execution.currency,
    p_observed_at
  )
  on conflict do nothing
  returning id into v_observation_id;
  if v_observation_id is null then
    select observation.id
    into v_observation_id
    from
      affiliate_private.affiliate_revolut_late_completion_observations
        observation
    where observation.execution_id = v_execution.id
      and observation.release_entry_id = v_release.id;
    if not found then
      raise exception 'conflicting late completion evidence replay'
        using errcode = 'P0005';
    end if;
  else
    v_new := true;
  end if;

  -- The released balance may already have been reused. Apply a payout-only
  -- hold immediately. The account status is deliberately not changed:
  -- foundation link invariants reject an account hold while a referral link
  -- is active, which would roll back the financial evidence itself.
  update affiliate_private.affiliate_payout_profiles profile
  set
    status = 'verification_required',
    revolut_binding_id = null,
    revolut_binding_version = null,
    updated_at = now()
  where profile.account_id = v_item.account_id;
  update affiliate_private.affiliate_revolut_payout_executions execution
  set
    job_status = 'exception',
    last_error_code = case v_release.entry_kind
      when 'payout_release' then 'late_completed_after_release'
      else 'duplicate_completed_after_settlement'
    end,
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    next_attempt_at = now() + interval '100 years',
    updated_at = now()
  where execution.id = v_execution.id;

  if v_new then
    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'payout',
      v_execution.execution_key,
      case v_release.entry_kind
        when 'payout_release' then 'revolut_late_completion_observed'
        else 'revolut_duplicate_completion_observed'
      end,
      'system',
      encode(
        extensions.digest(
          'norva:partners:revolut-late-completion:v1',
          'sha256'
        ),
        'hex'
      ),
      case v_release.entry_kind
        when 'payout_release'
          then 'Exact COMPLETED evidence arrived after payout release.'
        else 'A second exact COMPLETED evidence row arrived after settlement.'
      end,
      jsonb_build_object(
        'observation_id', v_observation_id,
        'basis_entry_kind', v_release.entry_kind,
        'reference', v_execution.payout_reference,
        'amount_minor', v_execution.amount_minor,
        'currency', v_execution.currency,
        'payout_hold_scope', 'account',
        'payout_profile_status', 'verification_required'
      )
    );
  end if;
  return v_observation_id;
end;
$$;

do $$
declare
  v_candidate record;
begin
  for v_candidate in
    select distinct on (execution.id)
      execution.id as execution_id,
      row.id as statement_row_id,
      row.statement_row_hash,
      row.observed_at
    from affiliate_private.affiliate_revolut_statement_rows row
    join affiliate_private.affiliate_revolut_payout_executions execution
      on execution.id = row.execution_id
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    left join affiliate_private.affiliate_revolut_transaction_aliases alias
      on alias.execution_id = execution.id
    where row.provider_state = 'COMPLETED'
      and row.amount_minor = execution.amount_minor
      and row.currency = execution.currency
      and execution.state = 'paid'
      and execution.reconciliation_status = 'confirmed'
      and item.status = 'settled'
      and (
        (
          row.match_status = 'mismatch'
          and row.discrepancy_code = 'transaction_mismatch'
        )
        or (
          row.match_status = 'matched'
          and alias.superseded_provider_transaction_hash is not null
          and row.provider_transaction_hash =
            alias.superseded_provider_transaction_hash
        )
      )
      and not exists (
        select 1
        from
          affiliate_private
            .affiliate_revolut_late_completion_observations observation
        where observation.execution_id = execution.id
      )
    order by execution.id, row.observed_at, row.id
  loop
    perform affiliate_private.record_revolut_late_completion_observation(
      v_candidate.execution_id,
      'statement',
      v_candidate.statement_row_id,
      v_candidate.statement_row_hash,
      v_candidate.observed_at
    );
  end loop;
end;
$$;

create trigger affiliate_revolut_late_completion_observations_append_only
before update or delete
on affiliate_private.affiliate_revolut_late_completion_observations
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_late_completion_reviews_append_only
before update or delete
on affiliate_private.affiliate_revolut_late_completion_reviews
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();
create trigger affiliate_revolut_late_completion_decisions_append_only
before update or delete
on affiliate_private.affiliate_revolut_late_completion_decisions
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();

create or replace function
affiliate_private.assert_revolut_payout_resolution_semantics()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_related affiliate_private.affiliate_commission_entries%rowtype;
  v_posting_count integer;
  v_expected_count integer;
begin
  if new.entry_kind not in (
    'payout_release',
    'payout_return',
    'payout_late_settlement',
    'payout_duplicate_settlement'
  ) then
    return null;
  end if;

  select related.*
  into v_related
  from affiliate_private.affiliate_commission_entries related
  where related.id = new.related_entry_id;
  if not found
    or v_related.account_id is distinct from new.account_id
    or v_related.currency is distinct from new.currency
    or v_related.currency_exponent is distinct from
      new.currency_exponent
    or v_related.amount_minor is distinct from new.amount_minor
    or (
      new.entry_kind = 'payout_release'
      and v_related.entry_kind <> 'payout_allocation'
    )
    or (
      new.entry_kind = 'payout_return'
      and v_related.entry_kind <> 'payout_settlement'
    )
    or (
      new.entry_kind = 'payout_late_settlement'
      and v_related.entry_kind <> 'payout_release'
    )
    or (
      new.entry_kind = 'payout_duplicate_settlement'
      and v_related.entry_kind <> 'payout_settlement'
    )
    or (
      new.entry_kind = 'payout_release'
      and exists (
        select 1
        from affiliate_private.affiliate_commission_entries settlement
        where settlement.entry_kind = 'payout_settlement'
          and settlement.related_entry_id = v_related.id
      )
    )
  then
    raise exception 'payout resolution does not match its ledger predecessor'
      using errcode = '23514';
  end if;

  if new.entry_kind in (
    'payout_late_settlement',
    'payout_duplicate_settlement'
  ) then
    select
      count(*)::integer,
      count(*) filter (
        where posting.currency = new.currency
          and (
            (
              posting.ledger_account in (
                'partner_commission_available',
                'partner_recovery_due'
              )
              and posting.direction = 'debit'
            )
            or (
              posting.ledger_account = 'partner_cash_settled'
              and posting.direction = 'credit'
              and posting.amount_minor = new.amount_minor
            )
          )
      )::integer
    into v_posting_count, v_expected_count
    from affiliate_private.affiliate_commission_postings posting
    where posting.entry_id = new.id;
    if v_posting_count not between 2 and 3
      or v_expected_count <> v_posting_count
      or (
        select coalesce(sum(posting.amount_minor), 0)
        from affiliate_private.affiliate_commission_postings posting
        where posting.entry_id = new.id
          and posting.direction = 'debit'
      ) <> new.amount_minor
    then
      raise exception 'late settlement postings are not canonical'
        using errcode = '23514';
    end if;
  else
    select
      count(*)::integer,
      count(*) filter (
        where posting.currency = new.currency
          and posting.amount_minor = new.amount_minor
          and (
            (
              posting.ledger_account = case new.entry_kind
                when 'payout_release' then 'partner_payout_clearing'
                else 'partner_cash_settled'
              end
              and posting.direction = 'debit'
            )
            or (
              posting.ledger_account = 'partner_commission_available'
              and posting.direction = 'credit'
            )
          )
      )::integer
    into v_posting_count, v_expected_count
    from affiliate_private.affiliate_commission_postings posting
    where posting.entry_id = new.id;
    if v_posting_count <> 2 or v_expected_count <> 2 then
      raise exception 'payout resolution postings are not canonical'
        using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$;

create constraint trigger affiliate_revolut_payout_resolution_semantics
after insert on affiliate_private.affiliate_commission_entries
deferrable initially deferred
for each row execute function
  affiliate_private.assert_revolut_payout_resolution_semantics();

create trigger affiliate_revolut_statement_import_delete_guard
before delete on affiliate_private.affiliate_revolut_statement_imports
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();

create or replace function
affiliate_private.guard_revolut_manual_batch_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.batch_key is distinct from old.batch_key
    or new.cycle_id is distinct from old.cycle_id
    or new.currency is distinct from old.currency
    or new.currency_exponent is distinct from old.currency_exponent
    or new.total_minor is distinct from old.total_minor
    or new.item_count is distinct from old.item_count
    or new.prepared_by_pseudonym is distinct from old.prepared_by_pseudonym
    or new.prepared_at is distinct from old.prepared_at
    or new.created_at is distinct from old.created_at
    or new.updated_at < old.updated_at
  then
    raise exception 'manual payout batch financial fields are immutable'
      using errcode = '55000';
  end if;

  if old.canonical_manifest_hash is not null and (
    new.canonical_manifest_hash is distinct from
      old.canonical_manifest_hash
    or new.export_file_hash is distinct from old.export_file_hash
    or new.exported_by_pseudonym is distinct from old.exported_by_pseudonym
    or new.exported_at is distinct from old.exported_at
  ) then
    raise exception 'manual payout export evidence is immutable'
      using errcode = '55000';
  end if;

  if old.submission_hash is not null and (
    new.submission_hash is distinct from old.submission_hash
    or new.submitted_by_pseudonym is distinct from
      old.submitted_by_pseudonym
    or new.submitted_at is distinct from old.submitted_at
  ) then
    raise exception 'manual payout submission evidence is immutable'
      using errcode = '55000';
  end if;

  if old.settled_at is not null
    and new.settled_at is distinct from old.settled_at
  then
    raise exception 'manual payout settlement evidence is immutable'
      using errcode = '55000';
  end if;

  if old.status in ('settled', 'cancelled') then
    if new is distinct from old then
      raise exception 'terminal manual payout batch is immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;

  if not (
    new.status = old.status
    or (old.status = 'prepared' and new.status in ('exported', 'cancelled'))
    or (
      old.status = 'exported'
      and new.status in (
        'partially_submitted',
        'submitted',
        'cancelled'
      )
    )
    or (
      old.status = 'partially_submitted'
      and new.status in ('submitted', 'cancelled')
    )
    or (
      old.status = 'submitted'
      and new.status in (
        'partially_reconciled',
        'settled',
        'exception'
      )
    )
    or (
      old.status = 'partially_reconciled'
      and new.status in ('settled', 'exception')
    )
    or (
      old.status = 'exception'
      and new.status in ('partially_reconciled', 'settled')
    )
  ) then
    raise exception 'invalid manual payout batch transition'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_manual_batch_transition_guard
before update on affiliate_private.affiliate_revolut_manual_batches
for each row execute function
  affiliate_private.guard_revolut_manual_batch_transition();

-- ---------------------------------------------------------------------------
-- Finance configuration and beneficiary administration
-- ---------------------------------------------------------------------------

create or replace function
affiliate_private.admin_partners_payout_route_set(
  p_provider text,
  p_execution_adapter text,
  p_country_code text,
  p_currency text,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_adapter text := lower(btrim(coalesce(p_execution_adapter, '')));
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'payout route mutation requires AAL2'
      using errcode = '42501';
  end if;
  if v_provider <> 'revolut'
    or v_adapter not in ('revolut_manual', 'revolut_api')
    or v_country !~ '^[A-Z]{2}$'
    or v_currency !~ '^[A-Z]{3}$'
    or v_status not in ('active', 'disabled')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Revolut payout route configuration'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  if v_status = 'active' and not exists (
    select 1
    from affiliate_private.affiliate_currency_metadata metadata
    where metadata.currency_code = v_currency
      and metadata.status = 'active'
  ) then
    raise exception 'active currency metadata is required'
      using errcode = 'P0001';
  end if;
  if v_status = 'active'
    and v_adapter = 'revolut_api'
    and not coalesce((
      select flag.enabled
      from public.admin_feature_flags flag
      where flag.key = 'partners_revolut_api_enabled'
    ), false)
  then
    raise exception 'Revolut API feature flag is disabled'
      using errcode = 'P0001';
  end if;
  if v_status = 'active'
    and v_adapter = 'revolut_manual'
    and not affiliate_private.release_gates_satisfied(
      array['manual_payout_workflow_verified']::text[]
    )
  then
    raise exception 'manual payout workflow release gate is incomplete'
      using errcode = 'P0001';
  end if;
  if v_status = 'active'
    and v_adapter = 'revolut_api'
    and not affiliate_private.release_gates_satisfied(
      array['revolut_api_adapter_verified']::text[]
    )
  then
    raise exception 'Revolut API adapter release gate is incomplete'
      using errcode = 'P0001';
  end if;
  if v_status = 'active' and exists (
    select 1
    from affiliate_private.affiliate_payout_provider_configs config
    where config.provider = 'revolut'
      and config.currency = v_currency
      and config.country_code <> v_country
      and config.status = 'active'
      and config.execution_adapter <> v_adapter
  ) then
    raise exception
      'one payout currency cannot mix manual and API adapters'
      using errcode = 'P0003';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
      and cycle.status in ('approved', 'submitted')
    join affiliate_private.affiliate_accounts account
      on account.id = item.account_id
      and account.country_code = v_country
    where item.currency = v_currency
      and item.execution_claimed_at is null
  ) then
    raise exception
      'route mutation is blocked by an approved unclaimed payout'
      using errcode = 'P0003';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_payout_provider_configs (
    provider,
    country_code,
    currency,
    status,
    configured_by_pseudonym,
    justification,
    execution_adapter,
    updated_at
  )
  values (
    v_provider,
    v_country,
    v_currency,
    v_status,
    v_actor,
    v_justification,
    v_adapter,
    now()
  )
  on conflict (provider, country_code, currency) do update
  set
    status = excluded.status,
    configured_by_pseudonym = excluded.configured_by_pseudonym,
    justification = excluded.justification,
    execution_adapter = excluded.execution_adapter,
    updated_at = now();

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    concat_ws(':', v_provider, v_country, v_currency),
    'payout_route_set',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'provider', v_provider,
      'execution_adapter', v_adapter,
      'country_code', v_country,
      'currency', v_currency,
      'status', v_status
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_route_set',
    'route', jsonb_build_object(
      'provider', v_provider,
      'execution_adapter', v_adapter,
      'country_code', v_country,
      'currency', v_currency,
      'status', v_status
    )
  );
end;
$$;

-- Compatibility wrapper for the existing Admin. Revolut defaults to the
-- production Basic/manual rail; every other provider can only be disabled.
create or replace function
affiliate_private.admin_partners_payout_provider_set(
  p_provider text,
  p_country_code text,
  p_currency text,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_country text := upper(btrim(coalesce(p_country_code, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'payout provider mutation requires AAL2'
      using errcode = '42501';
  end if;

  if v_provider = 'revolut' then
    return affiliate_private.admin_partners_payout_route_set(
      'revolut',
      'revolut_manual',
      p_country_code,
      p_currency,
      p_status,
      p_justification
    );
  end if;
  if v_status <> 'disabled'
    or v_provider not in ('wise', 'stripe_connect')
    or v_country !~ '^[A-Z]{2}$'
    or v_currency !~ '^[A-Z]{3}$'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid legacy payout route disable request'
      using errcode = '22023';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  update affiliate_private.affiliate_payout_provider_configs config
  set
    status = 'disabled',
    configured_by_pseudonym = v_actor,
    justification = v_justification,
    updated_at = now()
  where config.provider = v_provider
    and config.country_code = v_country
    and config.currency = v_currency;
  if not found then
    raise exception 'legacy payout route is unavailable'
      using errcode = 'P0002';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    concat_ws(':', v_provider, v_country, v_currency),
    'payout_provider_disabled',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'provider', v_provider,
      'country_code', v_country,
      'currency', v_currency,
      'status', 'disabled'
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'payout_provider_disabled',
    'status', 'disabled',
    'route', jsonb_build_object(
      'provider', v_provider,
      'country_code', v_country,
      'currency', v_currency,
      'status', 'disabled'
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_profile_set(
  p_account_id uuid,
  p_currency text,
  p_beneficiary_token_ref text,
  p_beneficiary_payment_method_ref text,
  p_display_masked text,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_token text := btrim(coalesce(p_beneficiary_token_ref, ''));
  v_payment_method text := nullif(
    btrim(coalesce(p_beneficiary_payment_method_ref, '')),
    ''
  );
  v_masked text := btrim(coalesce(p_display_masked, ''));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_profile affiliate_private.affiliate_payout_profiles%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Revolut beneficiary mutation requires AAL2'
      using errcode = '42501';
  end if;
  if p_account_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or v_token !~
      '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
    or (
      v_payment_method is not null
      and v_payment_method !~
        '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
    )
    or length(v_masked) not between 4 and 64
    or v_masked ~ '[[:cntrl:]]'
    or v_masked !~ '[*•]'
    or regexp_replace(v_masked, '[[:space:]-]', '', 'g')
      ~* '[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}'
    or regexp_replace(v_masked, '[^0-9]', '', 'g') ~ '[0-9]{6,}'
    or v_status not in ('disabled', 'verification_required')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid tokenized Revolut beneficiary profile'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id
  for update;
  if not found then
    raise exception 'partner account is unavailable'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
      and cycle.status in ('approved', 'submitted')
    where item.account_id = v_account.id
      and item.currency = v_currency
      and item.execution_claimed_at is null
  ) then
    raise exception
      'beneficiary mutation is blocked by an approved unclaimed payout'
      using errcode = 'P0003';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_payout_profiles (
    account_id,
    provider,
    beneficiary_token_ref,
    beneficiary_payment_method_ref,
    display_masked,
    currency,
    status,
    revolut_binding_id,
    revolut_binding_version,
    updated_at
  )
  values (
    v_account.id,
    'revolut',
    v_token,
    v_payment_method,
    v_masked,
    v_currency,
    v_status,
    null,
    null,
    now()
  )
  on conflict (account_id, currency) do update
  set
    provider = 'revolut',
    beneficiary_token_ref = excluded.beneficiary_token_ref,
    beneficiary_payment_method_ref =
      excluded.beneficiary_payment_method_ref,
    display_masked = excluded.display_masked,
    status = excluded.status,
    revolut_binding_id = excluded.revolut_binding_id,
    revolut_binding_version = excluded.revolut_binding_version,
    updated_at = now()
  returning * into v_profile;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_account.user_pseudonym || ':' || v_currency,
    'revolut_beneficiary_profile_set',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'provider', 'revolut',
      'currency', v_currency,
      'status', v_status,
      'payment_method_configured', v_payment_method is not null,
      'binding_verified', false,
      'binding_version', null,
      'display_masked', v_masked
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_beneficiary_profile_set',
    'profile', jsonb_build_object(
      'provider', 'revolut',
      'currency', v_profile.currency,
      'status', v_profile.status,
      'payment_method_configured',
        v_profile.beneficiary_payment_method_ref is not null,
      'binding_verified', v_profile.revolut_binding_id is not null,
      'binding_version', v_profile.revolut_binding_version,
      'display_masked', v_profile.display_masked
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_profile_hold(
  p_account_id uuid,
  p_currency text,
  p_status text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_profile affiliate_private.affiliate_payout_profiles%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Revolut beneficiary hold requires AAL2'
      using errcode = '42501';
  end if;
  if p_account_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or v_status not in ('disabled', 'verification_required')
    or v_confirmation <> concat_ws(
      ':',
      'HOLD',
      p_account_id::text,
      v_currency,
      v_status
    )
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Revolut beneficiary hold'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform 1
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id
  for update;
  if not found then
    raise exception 'partner account is unavailable'
      using errcode = 'P0002';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  update affiliate_private.affiliate_payout_profiles profile
  set
    status = v_status,
    revolut_binding_id = null,
    revolut_binding_version = null,
    updated_at = now()
  where profile.account_id = p_account_id
    and profile.currency = v_currency
    and profile.provider = 'revolut'
  returning * into v_profile;
  if not found then
    raise exception 'Revolut beneficiary profile is unavailable'
      using errcode = 'P0002';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    p_account_id::text || ':' || v_currency,
    'revolut_beneficiary_profile_held',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'currency', v_currency,
      'status', v_status,
      'binding_verified', false
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_beneficiary_profile_held',
    'profile', jsonb_build_object(
      'currency', v_profile.currency,
      'status', v_profile.status,
      'display_masked', v_profile.display_masked,
      'binding_verified', false
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_beneficiary_binding_authorize(
  p_account_id uuid,
  p_currency text,
  p_beneficiary_token_ref text,
  p_beneficiary_payment_method_ref text,
  p_display_masked text,
  p_fingerprint_key_version integer,
  p_mapping_evidence_hash text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_token text := btrim(coalesce(p_beneficiary_token_ref, ''));
  v_payment_method text := nullif(
    btrim(coalesce(p_beneficiary_payment_method_ref, '')),
    ''
  );
  v_masked text := btrim(coalesce(p_display_masked, ''));
  v_evidence text :=
    lower(btrim(coalesce(p_mapping_evidence_hash, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_ticket_key text :=
    'rbt_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24);
  v_ticket_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_ticket_token text;
  v_ticket_token_hash text;
  v_fingerprint_payload text;
  v_attestation_payload text;
  v_ticket
    affiliate_private.affiliate_revolut_beneficiary_binding_tickets%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'beneficiary binding authorization requires AAL2'
      using errcode = '42501';
  end if;
  if p_account_id is null
    or v_currency !~ '^[A-Z]{3}$'
    or v_token !~
      '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
    or (
      v_payment_method is not null
      and v_payment_method !~
        '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
    )
    or length(v_masked) not between 4 and 64
    or v_masked ~ '[[:cntrl:]]'
    or v_masked !~ '[*•]'
    or regexp_replace(v_masked, '[[:space:]-]', '', 'g')
      ~* '[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}'
    or regexp_replace(v_masked, '[^0-9]', '', 'g') ~ '[0-9]{6,}'
    or p_fingerprint_key_version not between 1 and 2147483646
    or v_evidence !~ '^[0-9a-f]{64}$'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid beneficiary binding authorization'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform 1
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id
    and account.status = 'active'
  for update;
  if not found then
    raise exception 'partner account is unavailable'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_beneficiary_bindings binding
    where binding.account_id = p_account_id
      and binding.currency = v_currency
      and binding.status = 'pending'
  ) then
    raise exception 'a beneficiary binding proposal is already pending'
      using errcode = 'P0003';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  v_ticket_token := v_ticket_key || '.' || v_ticket_secret;
  v_ticket_token_hash := encode(
    extensions.digest(v_ticket_token, 'sha256'),
    'hex'
  );
  v_fingerprint_payload := concat_ws(
    E'\n',
    'norva:partners:revolut-beneficiary-fingerprint:v1',
    'beneficiary_token_ref=' || lower(v_token),
    'beneficiary_payment_method_ref=' ||
      lower(coalesce(v_payment_method, ''))
  );
  v_attestation_payload := concat_ws(
    E'\n',
    'norva:partners:revolut-beneficiary-attestation:v1',
    'ticket_key=' || v_ticket_key,
    'account_id=' || p_account_id::text,
    'currency=' || v_currency,
    'beneficiary_token_ref=' || lower(v_token),
    'beneficiary_payment_method_ref=' ||
      lower(coalesce(v_payment_method, '')),
    'destination_masked_utf8_hex=' ||
      encode(convert_to(v_masked, 'UTF8'), 'hex'),
    'fingerprint_key_version=' || p_fingerprint_key_version::text,
    'mapping_evidence_hash=' || v_evidence
  );

  insert into
    affiliate_private.affiliate_revolut_beneficiary_binding_tickets (
      ticket_key,
      ticket_token_hash,
      account_id,
      currency,
      beneficiary_token_ref,
      beneficiary_payment_method_ref,
      destination_masked,
      fingerprint_key_version,
      mapping_evidence_hash,
      authorized_by_pseudonym,
      authorization_justification,
      expires_at
    )
  values (
    v_ticket_key,
    v_ticket_token_hash,
    p_account_id,
    v_currency,
    v_token,
    v_payment_method,
    v_masked,
    p_fingerprint_key_version,
    v_evidence,
    v_actor,
    v_justification,
    now() + interval '5 minutes'
  )
  returning * into v_ticket;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_ticket.ticket_key,
    'revolut_beneficiary_binding_authorized',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'account_id', p_account_id,
      'currency', v_currency,
      'ticket_key', v_ticket.ticket_key,
      'fingerprint_key_version', p_fingerprint_key_version,
      'status', 'authorized',
      'display_masked', v_masked,
      'payment_method_configured', v_payment_method is not null
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_beneficiary_binding_authorized',
    'binding_ticket', v_ticket_token,
    'ticket_key', v_ticket.ticket_key,
    'fingerprint_payload', v_fingerprint_payload,
    'attestation_payload', v_attestation_payload,
    'fingerprint_key_version', v_ticket.fingerprint_key_version,
    'expires_at', v_ticket.expires_at
  );
end;
$$;

create or replace function
affiliate_private.partners_service_revolut_beneficiary_binding_propose(
  p_beneficiary_fingerprint_hmac text,
  p_mapping_attestation_hmac text,
  p_binding_ticket text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fingerprint text :=
    lower(btrim(coalesce(p_beneficiary_fingerprint_hmac, '')));
  v_attestation text :=
    lower(btrim(coalesce(p_mapping_attestation_hmac, '')));
  v_ticket_token text := lower(btrim(coalesce(p_binding_ticket, '')));
  v_ticket_hash text;
  v_version integer;
  v_ticket
    affiliate_private.affiliate_revolut_beneficiary_binding_tickets%rowtype;
  v_binding
    affiliate_private.affiliate_revolut_beneficiary_bindings%rowtype;
begin
  if v_fingerprint !~ '^[0-9a-f]{64}$'
    or v_attestation !~ '^[0-9a-f]{64}$'
    or v_ticket_token !~ '^rbt_[0-9a-f]{24}\.[0-9a-f]{64}$'
  then
    raise exception 'invalid beneficiary binding proposal'
      using errcode = '22023';
  end if;
  v_ticket_hash := encode(
    extensions.digest(v_ticket_token, 'sha256'),
    'hex'
  );

  select ticket.*
  into v_ticket
  from affiliate_private.affiliate_revolut_beneficiary_binding_tickets ticket
  where ticket.ticket_token_hash = v_ticket_hash
  for update;
  if not found then
    raise exception 'beneficiary binding ticket is unavailable'
      using errcode = '42501';
  end if;
  if v_ticket.consumed_at is not null then
    select binding.*
    into v_binding
    from affiliate_private.affiliate_revolut_beneficiary_bindings binding
    where binding.authorization_ticket_id = v_ticket.id;
    if found
      and v_binding.beneficiary_fingerprint_hmac = v_fingerprint
      and v_binding.mapping_attestation_hmac = v_attestation
    then
      return jsonb_build_object(
        'schema_version', 1,
        'action', 'revolut_beneficiary_binding_proposed',
        'replayed', true,
        'binding', jsonb_build_object(
          'key', v_binding.binding_key,
          'currency', v_binding.currency,
          'version', v_binding.binding_version,
          'fingerprint_key_version',
            v_binding.fingerprint_key_version,
          'status', v_binding.status,
          'display_masked', v_binding.destination_masked,
          'payment_method_configured',
            v_binding.beneficiary_payment_method_ref is not null
        )
      );
    end if;
    raise exception 'beneficiary binding ticket was already consumed'
      using errcode = 'P0003';
  end if;
  if v_ticket.expires_at <= now() then
    raise exception 'beneficiary binding ticket expired'
      using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform 1
  from affiliate_private.affiliate_accounts account
  where account.id = v_ticket.account_id
    and account.status = 'active'
  for update;
  if not found then
    raise exception 'partner account is unavailable'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_beneficiary_bindings binding
    where binding.account_id = v_ticket.account_id
      and binding.currency = v_ticket.currency
      and binding.status = 'pending'
  ) then
    raise exception 'a beneficiary binding proposal is already pending'
      using errcode = 'P0003';
  end if;

  select coalesce(max(binding.binding_version), 0) + 1
  into v_version
  from affiliate_private.affiliate_revolut_beneficiary_bindings binding
  where binding.account_id = v_ticket.account_id
    and binding.currency = v_ticket.currency;

  insert into affiliate_private.affiliate_revolut_beneficiary_bindings (
    account_id,
    currency,
    binding_version,
    beneficiary_token_ref,
    beneficiary_payment_method_ref,
    destination_masked,
    beneficiary_fingerprint_hmac,
    mapping_attestation_hmac,
    fingerprint_key_version,
    mapping_evidence_hash,
    authorization_ticket_id,
    proposed_by_pseudonym,
    proposal_justification
  )
  values (
    v_ticket.account_id,
    v_ticket.currency,
    v_version,
    v_ticket.beneficiary_token_ref,
    v_ticket.beneficiary_payment_method_ref,
    v_ticket.destination_masked,
    v_fingerprint,
    v_attestation,
    v_ticket.fingerprint_key_version,
    v_ticket.mapping_evidence_hash,
    v_ticket.id,
    v_ticket.authorized_by_pseudonym,
    v_ticket.authorization_justification
  )
  returning * into v_binding;

  update
    affiliate_private.affiliate_revolut_beneficiary_binding_tickets ticket
  set consumed_at = now()
  where ticket.id = v_ticket.id
    and ticket.consumed_at is null;
  if not found then
    raise exception 'beneficiary binding ticket changed during proposal'
      using errcode = 'P0004';
  end if;
  if exists (
    select 1
    from
      affiliate_private.affiliate_revolut_late_completion_observations
        observation
    join affiliate_private.affiliate_revolut_payout_executions execution
      on execution.id = observation.execution_id
    join affiliate_private.affiliate_payout_items released_item
      on released_item.id = execution.payout_item_id
    left join
      affiliate_private.affiliate_revolut_late_completion_decisions
        decision
      on decision.observation_id = observation.id
    where released_item.account_id = v_ticket.account_id
      and (
        decision.id is null
        or decision.decision = 'quarantined'
      )
  ) then
    raise exception
      'partner account is held for late settlement review'
      using errcode = 'P0003';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_binding.binding_key,
    'revolut_beneficiary_binding_proposed',
    'system',
    v_ticket.authorized_by_pseudonym,
    v_ticket.authorization_justification,
    jsonb_build_object(
      'currency', v_binding.currency,
      'binding_version', v_binding.binding_version,
      'fingerprint_key_version', v_binding.fingerprint_key_version,
      'status', v_binding.status,
      'display_masked', v_binding.destination_masked,
      'payment_method_configured',
        v_binding.beneficiary_payment_method_ref is not null
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_beneficiary_binding_proposed',
    'replayed', false,
    'binding', jsonb_build_object(
      'key', v_binding.binding_key,
      'currency', v_binding.currency,
      'version', v_binding.binding_version,
      'fingerprint_key_version', v_binding.fingerprint_key_version,
      'status', v_binding.status,
      'display_masked', v_binding.destination_masked,
      'payment_method_configured',
        v_binding.beneficiary_payment_method_ref is not null
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_beneficiary_binding_verify(
  p_binding_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_binding_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_binding
    affiliate_private.affiliate_revolut_beneficiary_bindings%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'beneficiary binding verification requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rbb_[0-9a-f]{24}$'
    or v_confirmation <> 'VERIFY:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid beneficiary binding verification'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  select binding.*
  into v_binding
  from affiliate_private.affiliate_revolut_beneficiary_bindings binding
  where binding.binding_key = v_key
  for update;
  if not found or v_binding.status <> 'pending' then
    raise exception 'pending beneficiary binding is unavailable'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_beneficiary_bindings active
    join affiliate_private.affiliate_revolut_beneficiary_revocations
      revocation
      on revocation.binding_id = active.id
      and revocation.status = 'pending'
    where active.account_id = v_binding.account_id
      and active.currency = v_binding.currency
      and active.status = 'active'
  ) then
    raise exception
      'resolve the pending beneficiary revocation before verification'
      using errcode = 'P0003';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_actor = v_binding.proposed_by_pseudonym then
    raise exception
      'beneficiary binding maker and checker require distinct actors'
      using errcode = '42501';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
      and cycle.status in ('approved', 'submitted')
    where item.account_id = v_binding.account_id
      and item.currency = v_binding.currency
      and item.execution_claimed_at is null
  ) then
    raise exception
      'beneficiary verification is blocked by an approved payout'
      using errcode = 'P0003';
  end if;
  if v_binding.beneficiary_payment_method_ref is null
    and exists (
      select 1
      from affiliate_private.affiliate_accounts account
      join affiliate_private.affiliate_payout_provider_configs config
        on config.provider = 'revolut'
        and config.country_code = account.country_code
        and config.currency = v_binding.currency
        and config.status = 'active'
        and config.execution_adapter = 'revolut_api'
      where account.id = v_binding.account_id
    )
  then
    raise exception
      'API beneficiary binding requires a payment-method UUID'
      using errcode = 'P0004';
  end if;

  update affiliate_private.affiliate_revolut_beneficiary_bindings binding
  set
    status = 'revoked',
    revoked_by_pseudonym = v_actor,
    revocation_justification =
      'Superseded by verified binding ' || v_binding.binding_key,
    revoked_at = now()
  where binding.account_id = v_binding.account_id
    and binding.currency = v_binding.currency
    and binding.status = 'active';

  update affiliate_private.affiliate_revolut_beneficiary_bindings binding
  set
    status = 'active',
    verified_by_pseudonym = v_actor,
    verification_justification = v_justification,
    verified_at = now()
  where binding.id = v_binding.id
    and binding.status = 'pending'
  returning * into v_binding;
  if not found then
    raise exception 'beneficiary binding changed during verification'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_payout_profiles (
    account_id,
    provider,
    beneficiary_token_ref,
    beneficiary_payment_method_ref,
    display_masked,
    currency,
    status,
    revolut_binding_id,
    revolut_binding_version,
    updated_at
  )
  values (
    v_binding.account_id,
    'revolut',
    v_binding.beneficiary_token_ref,
    v_binding.beneficiary_payment_method_ref,
    v_binding.destination_masked,
    v_binding.currency,
    'active',
    v_binding.id,
    v_binding.binding_version,
    now()
  )
  on conflict (account_id, currency) do update
  set
    provider = 'revolut',
    beneficiary_token_ref = excluded.beneficiary_token_ref,
    beneficiary_payment_method_ref =
      excluded.beneficiary_payment_method_ref,
    display_masked = excluded.display_masked,
    status = 'active',
    revolut_binding_id = excluded.revolut_binding_id,
    revolut_binding_version = excluded.revolut_binding_version,
    updated_at = now();

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_binding.binding_key,
    'revolut_beneficiary_binding_verified',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'currency', v_binding.currency,
      'binding_version', v_binding.binding_version,
      'status', v_binding.status,
      'display_masked', v_binding.destination_masked,
      'payment_method_configured',
        v_binding.beneficiary_payment_method_ref is not null
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_beneficiary_binding_verified',
    'binding', jsonb_build_object(
      'key', v_binding.binding_key,
      'currency', v_binding.currency,
      'version', v_binding.binding_version,
      'status', v_binding.status,
      'display_masked', v_binding.destination_masked,
      'payment_method_configured',
        v_binding.beneficiary_payment_method_ref is not null
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_beneficiary_binding_reject(
  p_binding_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_binding_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_binding
    affiliate_private.affiliate_revolut_beneficiary_bindings%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'beneficiary binding rejection requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rbb_[0-9a-f]{24}$'
    or v_confirmation <> 'REJECT:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid beneficiary binding rejection'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  select binding.*
  into v_binding
  from affiliate_private.affiliate_revolut_beneficiary_bindings binding
  where binding.binding_key = v_key
  for update;
  if not found or v_binding.status <> 'pending' then
    raise exception 'pending beneficiary binding is unavailable'
      using errcode = 'P0002';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_actor = v_binding.proposed_by_pseudonym then
    raise exception
      'beneficiary binding maker and checker require distinct actors'
      using errcode = '42501';
  end if;
  update affiliate_private.affiliate_revolut_beneficiary_bindings binding
  set
    status = 'rejected',
    verified_by_pseudonym = v_actor,
    verification_justification = v_justification,
    verified_at = now()
  where binding.id = v_binding.id
    and binding.status = 'pending'
  returning * into v_binding;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_binding.binding_key,
    'revolut_beneficiary_binding_rejected',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'currency', v_binding.currency,
      'binding_version', v_binding.binding_version,
      'status', v_binding.status
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_beneficiary_binding_rejected',
    'binding', jsonb_build_object(
      'key', v_binding.binding_key,
      'currency', v_binding.currency,
      'version', v_binding.binding_version,
      'status', v_binding.status
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_beneficiary_binding_revoke(
  p_binding_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_binding_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_hash text;
  v_binding
    affiliate_private.affiliate_revolut_beneficiary_bindings%rowtype;
  v_revocation
    affiliate_private.affiliate_revolut_beneficiary_revocations%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'beneficiary binding revocation requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rbb_[0-9a-f]{24}$'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid beneficiary binding revocation'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  select binding.*
  into v_binding
  from affiliate_private.affiliate_revolut_beneficiary_bindings binding
  where binding.binding_key = v_key
  for update;
  if not found then
    raise exception 'beneficiary binding is unavailable'
      using errcode = 'P0002';
  end if;
  select revocation.*
  into v_revocation
  from affiliate_private.affiliate_revolut_beneficiary_revocations
    revocation
  where revocation.binding_id = v_binding.id
  for update;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();

  if not found then
    if v_binding.status <> 'active'
      or v_confirmation <> 'REQUEST-REVOKE:' || v_key
    then
      raise exception 'active beneficiary binding cannot be revoked'
        using errcode = 'P0003';
    end if;
    v_hash := encode(
      extensions.digest(
        concat_ws(
          ':',
          'norva:partners:revolut-beneficiary-revoke-request:v1',
          v_actor,
          v_key,
          v_confirmation,
          v_justification
        ),
        'sha256'
      ),
      'hex'
    );
    insert into
      affiliate_private.affiliate_revolut_beneficiary_revocations (
        binding_id,
        requested_by_pseudonym,
        request_confirmation_hash,
        request_justification
      )
    values (
      v_binding.id,
      v_actor,
      v_hash,
      v_justification
    )
    returning * into v_revocation;

    update affiliate_private.affiliate_payout_profiles profile
    set
      status = 'verification_required',
      revolut_binding_id = null,
      revolut_binding_version = null,
      updated_at = now()
    where profile.account_id = v_binding.account_id
      and profile.currency = v_binding.currency
      and profile.provider = 'revolut'
      and profile.revolut_binding_id = v_binding.id;

    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'payout',
      v_binding.binding_key,
      'revolut_beneficiary_binding_revocation_requested',
      'admin',
      v_actor,
      v_justification,
      jsonb_build_object(
        'revocation_key', v_revocation.revocation_key,
        'currency', v_binding.currency,
        'binding_version', v_binding.binding_version,
        'status', v_revocation.status,
        'profile_status', 'verification_required'
      )
    );

    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_beneficiary_binding_revocation_requested',
      'replayed', false,
      'revocation', jsonb_build_object(
        'key', v_revocation.revocation_key,
        'binding_key', v_binding.binding_key,
        'status', v_revocation.status
      )
    );
  end if;

  if v_revocation.status = 'confirmed' then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_beneficiary_binding_revoked',
      'replayed', true,
      'revocation', jsonb_build_object(
        'key', v_revocation.revocation_key,
        'binding_key', v_binding.binding_key,
        'status', v_revocation.status
      )
    );
  end if;
  if v_confirmation <>
      'CONFIRM-REVOKE:' || v_revocation.revocation_key
  then
    raise exception 'invalid beneficiary binding revocation approval'
      using errcode = '22023';
  end if;
  if v_actor = v_revocation.requested_by_pseudonym then
    raise exception
      'beneficiary revocation maker and checker require distinct actors'
      using errcode = '42501';
  end if;
  if v_binding.status <> 'active' then
    raise exception 'beneficiary binding changed during revocation'
      using errcode = 'P0004';
  end if;
  v_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-beneficiary-revoke-approval:v1',
        v_actor,
        v_revocation.revocation_key,
        v_revocation.request_confirmation_hash,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  update affiliate_private.affiliate_revolut_beneficiary_revocations
    revocation
  set
    status = 'confirmed',
    approved_by_pseudonym = v_actor,
    approval_confirmation_hash = v_hash,
    approval_justification = v_justification,
    approved_at = now()
  where revocation.id = v_revocation.id
    and revocation.status = 'pending'
  returning * into v_revocation;
  if not found then
    raise exception 'beneficiary revocation changed during approval'
      using errcode = 'P0004';
  end if;

  update affiliate_private.affiliate_revolut_beneficiary_bindings binding
  set
    status = 'revoked',
    revoked_by_pseudonym = v_actor,
    revocation_justification = v_justification,
    revoked_at = now()
  where binding.id = v_binding.id
    and binding.status = 'active';
  if not found then
    raise exception 'beneficiary binding changed during revocation'
      using errcode = 'P0004';
  end if;

  update affiliate_private.affiliate_payout_profiles profile
  set
    status = 'verification_required',
    revolut_binding_id = null,
    revolut_binding_version = null,
    updated_at = now()
  where profile.account_id = v_binding.account_id
    and profile.currency = v_binding.currency
    and profile.provider = 'revolut'
    and profile.revolut_binding_id = v_binding.id;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_binding.binding_key,
    'revolut_beneficiary_binding_revoked',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'revocation_key', v_revocation.revocation_key,
      'currency', v_binding.currency,
      'binding_version', v_binding.binding_version,
      'status', 'revoked'
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_beneficiary_binding_revoked',
    'replayed', false,
    'revocation', jsonb_build_object(
      'key', v_revocation.revocation_key,
      'binding_key', v_binding.binding_key,
      'status', v_revocation.status
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_profile_status(
  p_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account_key text;
  v_profiles jsonb;
  v_bindings jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if p_account_id is null then
    raise exception 'partner account is required'
      using errcode = '22023';
  end if;

  select account.user_pseudonym
  into v_account_key
  from affiliate_private.affiliate_accounts account
  where account.id = p_account_id;
  if not found then
    raise exception 'partner account is unavailable'
      using errcode = 'P0002';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'provider', profile.provider,
        'currency', profile.currency,
        'status', profile.status,
        'display_masked', profile.display_masked,
        'payment_method_configured',
          profile.beneficiary_payment_method_ref is not null,
        'binding_verified', profile.revolut_binding_id is not null,
        'binding_version', profile.revolut_binding_version,
        'updated_at', profile.updated_at
      )
      order by profile.currency
    ),
    '[]'::jsonb
  )
  into v_profiles
  from affiliate_private.affiliate_payout_profiles profile
  where profile.account_id = p_account_id
    and profile.provider = 'revolut';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', binding.binding_key,
        'currency', binding.currency,
        'version', binding.binding_version,
        'status', binding.status,
        'display_masked', binding.destination_masked,
        'fingerprint_key_version', binding.fingerprint_key_version,
        'payment_method_configured',
          binding.beneficiary_payment_method_ref is not null,
        'proposed_at', binding.proposed_at,
        'verified_at', binding.verified_at,
        'revoked_at', binding.revoked_at,
        'revocation', case
          when revocation.id is null then null
          else jsonb_build_object(
            'key', revocation.revocation_key,
            'status', revocation.status,
            'requested_at', revocation.requested_at,
            'approved_at', revocation.approved_at
          )
        end
      )
      order by binding.currency, binding.binding_version desc
    ),
    '[]'::jsonb
  )
  into v_bindings
  from affiliate_private.affiliate_revolut_beneficiary_bindings binding
  left join affiliate_private.affiliate_revolut_beneficiary_revocations
    revocation
    on revocation.binding_id = binding.id
  where binding.account_id = p_account_id;

  return jsonb_build_object(
    'schema_version', 1,
    'account_key', v_account_key,
    'profiles', v_profiles,
    'bindings', v_bindings
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Revolut Basic: batch preparation, deterministic export and submission
-- ---------------------------------------------------------------------------

create or replace function
affiliate_private.admin_partners_revolut_manual_batch_prepare(
  p_cycle_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cycle_key text := lower(btrim(coalesce(p_cycle_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_count integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual payout batch preparation requires AAL2'
      using errcode = '42501';
  end if;
  if v_cycle_key !~ '^pay_[0-9a-f]{24}$'
    or v_confirmation <> 'PREPARE:' || v_cycle_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual payout batch preparation'
      using errcode = '22023';
  end if;
  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_payouts_live'
  ), false)
    or not affiliate_private.release_gates_satisfied(
      array['manual_payout_workflow_verified']::text[]
    )
  then
    raise exception 'manual payout workflow is not released'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:revolut-manual:' || v_cycle_key, 0)
  );

  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.cycle_key = v_cycle_key
  for update;
  if not found
    or not v_cycle.live_execution
    or v_cycle.status <> 'approved'
    or v_cycle.approved_at is null
    or v_cycle.item_count < 1
  then
    raise exception 'approved live payout cycle is unavailable'
      using errcode = 'P0002';
  end if;

  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.cycle_id = v_cycle.id;
  if found then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_batch_prepared',
      'replayed', true,
      'batch', jsonb_build_object(
        'key', v_batch.batch_key,
        'status', v_batch.status,
        'item_count', v_batch.item_count,
        'total_minor', v_batch.total_minor,
        'currency', v_batch.currency
      )
    );
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_payout_items item
    where item.cycle_id = v_cycle.id
      and (
        item.status <> 'pending'
        or item.allocation_entry_id is null
        or item.payout_reference is not null
        or item.execution_adapter is not null
      )
  ) then
    raise exception 'payout cycle contains an unavailable item'
      using errcode = 'P0004';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_revolut_manual_batches (
    cycle_id,
    currency,
    currency_exponent,
    total_minor,
    item_count,
    prepared_by_pseudonym
  )
  values (
    v_cycle.id,
    v_cycle.currency,
    v_cycle.currency_exponent,
    v_cycle.total_minor,
    v_cycle.item_count,
    v_actor
  )
  returning * into v_batch;

  insert into affiliate_private.affiliate_revolut_payout_executions (
    payout_item_id,
    manual_batch_id,
    adapter,
    payout_reference,
    beneficiary_token_ref,
    beneficiary_payment_method_ref,
    beneficiary_binding_id,
    beneficiary_binding_version,
    beneficiary_fingerprint_hmac,
    beneficiary_fingerprint_key_version,
    destination_masked,
    amount_minor,
    currency,
    currency_exponent,
    job_status,
    prepared_by_pseudonym
  )
  select
    item.id,
    v_batch.id,
    'revolut_manual',
    affiliate_private.allocate_revolut_payout_reference(item.id),
    profile.beneficiary_token_ref,
    null::text,
    binding.id,
    binding.binding_version,
    binding.beneficiary_fingerprint_hmac,
    binding.fingerprint_key_version,
    profile.display_masked,
    item.amount_minor,
    item.currency,
    v_cycle.currency_exponent,
    'manual',
    v_actor
  from affiliate_private.affiliate_payout_items item
  join affiliate_private.affiliate_payout_profiles profile
    on profile.id = item.payout_profile_id
    and profile.provider = 'revolut'
    and profile.status = 'active'
  join affiliate_private.affiliate_accounts account
    on account.id = item.account_id
    and account.status = 'active'
  join affiliate_private.affiliate_revolut_beneficiary_bindings binding
    on binding.id = profile.revolut_binding_id
    and binding.binding_version = profile.revolut_binding_version
    and binding.account_id = item.account_id
    and binding.currency = item.currency
    and binding.status = 'active'
    and binding.beneficiary_token_ref = profile.beneficiary_token_ref
    and binding.beneficiary_payment_method_ref is not distinct from
      profile.beneficiary_payment_method_ref
    and binding.destination_masked = profile.display_masked
  join affiliate_private.affiliate_payout_provider_configs config
    on config.provider = 'revolut'
    and config.country_code = account.country_code
    and config.currency = item.currency
    and config.status = 'active'
    and config.execution_adapter = 'revolut_manual'
  where item.cycle_id = v_cycle.id
    and item.status = 'pending'
    and item.allocation_entry_id is not null
  order by item.account_id, item.id;
  get diagnostics v_count = row_count;
  if v_count <> v_cycle.item_count then
    raise exception 'manual batch does not cover every payout item'
      using errcode = 'P0004';
  end if;

  update affiliate_private.affiliate_payout_items item
  set
    payout_reference = execution.payout_reference,
    execution_adapter = execution.adapter,
    execution_claimed_at = now(),
    updated_at = now()
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.payout_item_id = item.id
    and execution.manual_batch_id = v_batch.id;
  get diagnostics v_count = row_count;
  if v_count <> v_cycle.item_count then
    raise exception 'manual batch execution claim is incomplete'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_batch.batch_key,
    'revolut_manual_batch_prepared',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'cycle_key', v_cycle.cycle_key,
      'adapter', 'revolut_manual',
      'item_count', v_batch.item_count,
      'total_minor', v_batch.total_minor,
      'currency', v_batch.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_manual_batch_prepared',
    'replayed', false,
    'batch', jsonb_build_object(
      'key', v_batch.batch_key,
      'status', v_batch.status,
      'item_count', v_batch.item_count,
      'total_minor', v_batch.total_minor,
      'currency', v_batch.currency
    )
  );
end;
$$;

create or replace function
affiliate_private.revolut_manual_batch_manifest_hash(
  p_batch_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(
      concat_ws(
        E'\n',
        'norva:partners:revolut-manual-export:v1',
        'batch_key=' || batch.batch_key,
        'currency=' || batch.currency,
        'currency_exponent=' || batch.currency_exponent::text,
        'total_minor=' || batch.total_minor::text,
        'item_count=' || batch.item_count::text,
        coalesce(
          string_agg(
            concat_ws(
              E'\x1f',
              execution.payout_reference,
              lower(execution.beneficiary_token_ref),
              lower(coalesce(
                execution.beneficiary_payment_method_ref,
                ''
              )),
              encode(
                convert_to(execution.destination_masked, 'UTF8'),
                'hex'
              ),
              execution.amount_minor::text,
              execution.currency,
              execution.currency_exponent::text,
              execution.beneficiary_binding_id::text,
              execution.beneficiary_binding_version::text,
              execution.beneficiary_fingerprint_hmac,
              execution.beneficiary_fingerprint_key_version::text
            ),
            E'\n'
            order by execution.payout_reference
          ),
          ''
        )
      ),
      'sha256'
    ),
    'hex'
  )
  from affiliate_private.affiliate_revolut_manual_batches batch
  join affiliate_private.affiliate_revolut_payout_executions execution
    on execution.manual_batch_id = batch.id
  where batch.id = p_batch_id
  group by
    batch.batch_key,
    batch.currency,
    batch.currency_exponent,
    batch.total_minor,
    batch.item_count;
$$;

create or replace function
affiliate_private.admin_partners_revolut_manual_batch_payload(
  p_batch_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_batch_key, '')));
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_items jsonb;
  v_manifest_hash text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual payout export requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rmb_[0-9a-f]{24}$' then
    raise exception 'invalid manual payout batch key'
      using errcode = '22023';
  end if;

  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.batch_key = v_key;
  if not found
    or v_batch.status not in (
      'prepared',
      'exported',
      'partially_submitted',
      'submitted',
      'partially_reconciled',
      'settled',
      'exception'
    )
  then
    raise exception 'manual payout batch is not exportable'
      using errcode = 'P0002';
  end if;
  if v_batch.status in ('prepared', 'exported', 'partially_submitted')
    and (
      exists (
        select 1
        from affiliate_private.affiliate_revolut_manual_cancellations
          cancellation
        where cancellation.manual_batch_id = v_batch.id
          and cancellation.status = 'pending'
      )
      or exists (
        select 1
        from
          affiliate_private.affiliate_revolut_manual_unmapped_requests
            request
        where request.manual_batch_id = v_batch.id
          and request.status = 'pending'
      )
    )
  then
    raise exception 'manual payout batch is frozen for Finance review'
      using errcode = 'P0003';
  end if;
  if v_batch.status in ('prepared', 'exported', 'partially_submitted')
    and exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    left join affiliate_private.affiliate_revolut_beneficiary_bindings
      binding
      on binding.id = execution.beneficiary_binding_id
      and binding.binding_version =
        execution.beneficiary_binding_version
    left join affiliate_private.affiliate_payout_profiles profile
      on profile.id = item.payout_profile_id
    where execution.manual_batch_id = v_batch.id
      and (
        binding.id is null
        or binding.status <> 'active'
        or profile.status <> 'active'
        or profile.revolut_binding_id is distinct from binding.id
        or profile.revolut_binding_version is distinct from
          binding.binding_version
      )
  ) then
    raise exception 'manual payout beneficiary binding is on hold'
      using errcode = 'P0003';
  end if;
  v_manifest_hash :=
    affiliate_private.revolut_manual_batch_manifest_hash(v_batch.id);
  if v_manifest_hash is null then
    raise exception 'manual payout export manifest is incomplete'
      using errcode = 'P0004';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'execution_key', execution.execution_key,
      'reference', execution.payout_reference,
      'beneficiary_token_ref', execution.beneficiary_token_ref,
      'destination_masked', execution.destination_masked,
      'amount_minor', execution.amount_minor,
      'currency', execution.currency,
      'currency_exponent', execution.currency_exponent,
      'provider_transaction_id', execution.provider_transaction_id,
      'mapped', execution.provider_transaction_hash is not null,
      'submitted', execution.submitted_by_pseudonym is not null,
      'state', execution.state
    )
    order by execution.payout_reference
  ), '[]'::jsonb)
  into v_items
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_manual_batch_payload',
    'batch', jsonb_build_object(
      'key', v_batch.batch_key,
      'status', v_batch.status,
      'item_count', v_batch.item_count,
      'total_minor', v_batch.total_minor,
      'currency', v_batch.currency,
      'currency_exponent', v_batch.currency_exponent,
      'canonical_export_hash', v_manifest_hash
    ),
    'items', v_items
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_manual_batch_mark_exported(
  p_batch_key text,
  p_canonical_manifest_hash text,
  p_export_file_hash text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_batch_key, '')));
  v_manifest_input text :=
    lower(btrim(coalesce(p_canonical_manifest_hash, '')));
  v_hash text := lower(btrim(coalesce(p_export_file_hash, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_manifest_hash text;
  v_count integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual payout export confirmation requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rmb_[0-9a-f]{24}$'
    or v_manifest_input !~ '^[0-9a-f]{64}$'
    or v_hash !~ '^[0-9a-f]{64}$'
    or v_confirmation <> 'EXPORT:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual payout export confirmation'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-manual-batch:' || v_key,
      0
    )
  );
  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.batch_key = v_key
  for update;
  if not found then
    raise exception 'manual payout batch is unavailable'
      using errcode = 'P0002';
  end if;
  if v_batch.canonical_manifest_hash = v_manifest_input
    and v_batch.export_file_hash = v_hash
    and v_batch.status in (
      'exported',
      'partially_submitted',
      'submitted',
      'partially_reconciled',
      'settled',
      'exception'
    )
  then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_batch_exported',
      'replayed', true,
      'batch', jsonb_build_object(
        'key', v_batch.batch_key,
        'status', v_batch.status
      )
    );
  end if;
  if v_batch.status <> 'prepared' then
    raise exception 'manual payout batch is not ready for export'
      using errcode = 'P0004';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    where cancellation.manual_batch_id = v_batch.id
      and cancellation.status = 'pending'
  ) then
    raise exception 'manual payout batch cancellation is pending'
      using errcode = 'P0003';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    left join affiliate_private.affiliate_revolut_beneficiary_bindings
      binding
      on binding.id = execution.beneficiary_binding_id
      and binding.binding_version =
        execution.beneficiary_binding_version
    left join affiliate_private.affiliate_payout_profiles profile
      on profile.id = item.payout_profile_id
    where execution.manual_batch_id = v_batch.id
      and (
        binding.id is null
        or binding.status <> 'active'
        or profile.status <> 'active'
        or profile.revolut_binding_id is distinct from binding.id
        or profile.revolut_binding_version is distinct from
          binding.binding_version
      )
  ) then
    raise exception 'manual payout beneficiary binding is on hold'
      using errcode = 'P0003';
  end if;
  v_manifest_hash :=
    affiliate_private.revolut_manual_batch_manifest_hash(v_batch.id);
  if v_manifest_hash is null
    or v_manifest_input is distinct from v_manifest_hash
  then
    raise exception
      'canonical manifest hash does not match the Norva batch'
      using errcode = 'P0005';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  update affiliate_private.affiliate_revolut_manual_batches batch
  set
    status = 'exported',
    canonical_manifest_hash = v_manifest_hash,
    export_file_hash = v_hash,
    exported_by_pseudonym = v_actor,
    exported_at = now(),
    updated_at = now()
  where batch.id = v_batch.id
  returning * into v_batch;

  update affiliate_private.affiliate_revolut_payout_executions execution
  set state = 'exported', exported_at = now(), updated_at = now()
  where execution.manual_batch_id = v_batch.id
    and execution.state = 'prepared';
  get diagnostics v_count = row_count;
  if v_count <> v_batch.item_count then
    raise exception 'manual payout batch execution set changed during export'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_batch.batch_key,
    'revolut_manual_batch_exported',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'status', v_batch.status,
      'export_file_hash', v_hash,
      'canonical_export_hash', v_manifest_hash
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_manual_batch_exported',
    'replayed', false,
    'batch', jsonb_build_object(
      'key', v_batch.batch_key,
      'status', v_batch.status
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_manual_batch_export(
  p_batch_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_batch_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_manifest_hash text;
  v_file_hash text;
  v_tsv text;
  v_progress_file_hash text;
  v_progress_tsv text;
  v_items jsonb;
  v_count integer;
  v_is_initial boolean;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual payout export requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rmb_[0-9a-f]{24}$'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual payout export request'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-manual-batch:' || v_key,
      0
    )
  );
  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.batch_key = v_key
  for update;
  if not found
    or v_batch.status not in (
      'prepared',
      'exported',
      'partially_submitted',
      'submitted',
      'partially_reconciled',
      'settled',
      'exception'
    )
  then
    raise exception 'manual payout batch is unavailable for export'
      using errcode = 'P0002';
  end if;
  v_is_initial := v_batch.status = 'prepared';
  if v_confirmation <> (case
    when v_is_initial then 'EXPORT:' || v_key
    else 'ACCESS-EXPORT:' || v_key
  end)
  then
    raise exception 'invalid manual payout export confirmation'
      using errcode = '22023';
  end if;
  if (
    exists (
      select 1
      from affiliate_private.affiliate_revolut_manual_cancellations
        cancellation
      where cancellation.manual_batch_id = v_batch.id
        and cancellation.status = 'pending'
    )
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_manual_unmapped_requests
        request
      where request.manual_batch_id = v_batch.id
        and request.status = 'pending'
    )
  ) then
    raise exception 'manual payout batch is frozen for Finance review'
      using errcode = 'P0003';
  end if;
  if v_is_initial and exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    left join affiliate_private.affiliate_revolut_beneficiary_bindings
      binding
      on binding.id = execution.beneficiary_binding_id
      and binding.binding_version =
        execution.beneficiary_binding_version
    left join affiliate_private.affiliate_payout_profiles profile
      on profile.id = item.payout_profile_id
    where execution.manual_batch_id = v_batch.id
      and (
        binding.id is null
        or binding.status <> 'active'
        or profile.status <> 'active'
        or profile.revolut_binding_id is distinct from binding.id
        or profile.revolut_binding_version is distinct from
          binding.binding_version
      )
  ) then
    raise exception 'manual payout beneficiary binding is on hold'
      using errcode = 'P0003';
  end if;

  v_manifest_hash :=
    affiliate_private.revolut_manual_batch_manifest_hash(v_batch.id);
  if v_manifest_hash is null then
    raise exception 'manual payout export manifest is incomplete'
      using errcode = 'P0004';
  end if;
  select
    'norva_reference'
      || E'\tbeneficiary_token_ref'
      || E'\tdestination_masked'
      || E'\tamount_minor'
      || E'\tcurrency'
      || E'\tcurrency_exponent'
      || E'\tentered_in_revolut'
      || E'\r\n'
      || string_agg(
        execution.payout_reference
          || E'\t'
          || case
            when execution.beneficiary_token_ref ~ '^[=+@-]'
              then '''' || execution.beneficiary_token_ref
            else execution.beneficiary_token_ref
          end
          || E'\t'
          || case
            when execution.destination_masked ~ '^[=+@-]'
              then '''' || execution.destination_masked
            else execution.destination_masked
          end
          || E'\t'
          || execution.amount_minor::text
          || E'\t'
          || execution.currency
          || E'\t'
          || execution.currency_exponent::text
          || E'\t'
          || E'\r\n',
        ''
        order by execution.payout_reference
      ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'execution_key', execution.execution_key,
          'reference', execution.payout_reference,
          'destination_masked', execution.destination_masked,
          'amount_minor', execution.amount_minor,
          'currency', execution.currency,
          'currency_exponent', execution.currency_exponent,
          'entered_in_revolut',
            execution.submitted_by_pseudonym is not null,
          'statement_matched',
            execution.provider_transaction_hash is not null,
          'state', execution.state
        )
        order by execution.payout_reference
      ),
      '[]'::jsonb
    )
  into v_tsv, v_items
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id;
  if v_tsv is null
    or octet_length(convert_to(v_tsv, 'UTF8')) > 5000000
    or jsonb_array_length(v_items) <> v_batch.item_count
  then
    raise exception 'manual payout export payload is incomplete or too large'
      using errcode = '54000';
  end if;
  v_file_hash := encode(
    extensions.digest(convert_to(v_tsv, 'UTF8'), 'sha256'),
    'hex'
  );
  select
    'norva_reference'
      || E'\tentered_in_revolut'
      || E'\tstatement_matched'
      || E'\tstate'
      || E'\treconciliation_status'
      || E'\r\n'
      || string_agg(
        execution.payout_reference
          || E'\t'
          || case
            when execution.submitted_by_pseudonym is null then ''
            else 'YES'
          end
          || E'\t'
          || case
            when execution.provider_transaction_hash is null then ''
            else 'YES'
          end
          || E'\t'
          || execution.state
          || E'\t'
          || execution.reconciliation_status
          || E'\r\n',
        ''
        order by execution.payout_reference
      )
  into v_progress_tsv
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id;
  if v_progress_tsv is null
    or octet_length(convert_to(v_progress_tsv, 'UTF8')) > 5000000
  then
    raise exception 'manual payout progress payload is incomplete or too large'
      using errcode = '54000';
  end if;
  v_progress_file_hash := encode(
    extensions.digest(convert_to(v_progress_tsv, 'UTF8'), 'sha256'),
    'hex'
  );

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_is_initial then
    update affiliate_private.affiliate_revolut_manual_batches batch
    set
      status = 'exported',
      canonical_manifest_hash = v_manifest_hash,
      export_file_hash = v_file_hash,
      exported_by_pseudonym = v_actor,
      exported_at = now(),
      updated_at = now()
    where batch.id = v_batch.id
      and batch.status = 'prepared'
    returning * into v_batch;
    if not found then
      raise exception 'manual payout batch changed during export'
        using errcode = 'P0004';
    end if;
    update affiliate_private.affiliate_revolut_payout_executions execution
    set state = 'exported', exported_at = now(), updated_at = now()
    where execution.manual_batch_id = v_batch.id
      and execution.state = 'prepared';
    get diagnostics v_count = row_count;
    if v_count <> v_batch.item_count then
      raise exception 'manual payout execution set changed during export'
        using errcode = 'P0004';
    end if;
  elsif v_batch.canonical_manifest_hash is distinct from v_manifest_hash
    or v_batch.export_file_hash is distinct from v_file_hash
  then
    raise exception 'stored export evidence does not match regenerated TSV'
      using errcode = 'P0005';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_batch.batch_key,
    case
      when v_is_initial then 'revolut_manual_batch_exported'
      else 'revolut_manual_batch_export_accessed'
    end,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'status', v_batch.status,
      'canonical_manifest_hash', v_manifest_hash,
      'export_file_hash', v_file_hash,
      'progress_file_hash', case
        when v_is_initial then null
        else v_progress_file_hash
      end,
      'item_count', v_batch.item_count,
      'byte_count', octet_length(convert_to(v_tsv, 'UTF8'))
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_manual_batch_export',
    'replayed', not v_is_initial,
    'batch', jsonb_build_object(
      'key', v_batch.batch_key,
      'status', v_batch.status,
      'item_count', v_batch.item_count,
      'total_minor', v_batch.total_minor,
      'currency', v_batch.currency,
      'currency_exponent', v_batch.currency_exponent,
      'canonical_manifest_hash', v_manifest_hash,
      'export_file_hash', v_file_hash,
      'file_name', 'norva-revolut-' || v_batch.batch_key || '.tsv',
      'progress_file_hash', case
        when v_is_initial then null
        else v_progress_file_hash
      end,
      'progress_file_name', case
        when v_is_initial then null
        else
          'norva-revolut-progress-' || v_batch.batch_key || '.tsv'
      end
    ),
    'items', v_items,
    'tsv', v_tsv,
    'progress_tsv', case
      when v_is_initial then null
      else v_progress_tsv
    end
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(
  p_batch_key text,
  p_transfers jsonb,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_batch_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_transfer jsonb;
  v_reference text;
  v_provider_id text;
  v_provider_hash text;
  v_submission_hash text;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_input_count integer;
  v_submitted_count integer;
  v_confirmed_count integer;
  v_released_count integer;
  v_applied_count integer := 0;
  v_replayed_count integer := 0;
  v_count integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual payout submission requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rmb_[0-9a-f]{24}$'
    or jsonb_typeof(p_transfers) <> 'array'
    or jsonb_array_length(p_transfers) not between 1 and 5000
    or v_confirmation <> 'SUBMIT:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual payout submission'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-manual-batch:' || v_key,
      0
    )
  );
  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.batch_key = v_key
  for update;
  if not found then
    raise exception 'manual payout batch is unavailable'
      using errcode = 'P0002';
  end if;
  if v_batch.status not in (
    'exported',
    'partially_submitted',
    'submitted',
    'partially_reconciled',
    'settled',
    'exception'
  ) then
    raise exception 'manual payout batch must be exported first'
      using errcode = 'P0004';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    where cancellation.manual_batch_id = v_batch.id
      and cancellation.status = 'pending'
  )
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_manual_unmapped_requests
        request
      where request.manual_batch_id = v_batch.id
        and request.status = 'pending'
    )
  then
    raise exception 'manual payout batch Finance review is pending'
      using errcode = 'P0003';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    left join affiliate_private.affiliate_revolut_beneficiary_bindings
      binding
      on binding.id = execution.beneficiary_binding_id
      and binding.binding_version =
        execution.beneficiary_binding_version
    left join affiliate_private.affiliate_payout_profiles profile
      on profile.id = item.payout_profile_id
    where execution.manual_batch_id = v_batch.id
      and execution.provider_transaction_hash is null
      and (
        binding.id is null
        or binding.status <> 'active'
        or profile.status <> 'active'
        or profile.revolut_binding_id is distinct from binding.id
        or profile.revolut_binding_version is distinct from
          binding.binding_version
      )
  ) then
    raise exception 'manual payout beneficiary binding is on hold'
      using errcode = 'P0003';
  end if;
  v_input_count := jsonb_array_length(p_transfers);

  -- Validate the complete subset before applying any mapping. Each call may
  -- record only the transfers that Finance has actually completed in Revolut.
  for v_transfer in
    select value
    from jsonb_array_elements(p_transfers) value
  loop
    if jsonb_typeof(v_transfer) <> 'object'
      or (
        select count(*)
        from jsonb_object_keys(v_transfer)
      ) <> 2
      or not (v_transfer ? 'reference')
      or not (v_transfer ? 'provider_transaction_id')
    then
      raise exception 'invalid manual transfer record'
        using errcode = '22023';
    end if;

    v_reference := upper(btrim(coalesce(v_transfer ->> 'reference', '')));
    v_provider_id := btrim(
      coalesce(v_transfer ->> 'provider_transaction_id', '')
    );
    if v_reference !~ '^NORVA-[A-F0-9]{12}$'
      or length(v_provider_id) not between 8 and 128
      or v_provider_id ~ '[[:space:][:cntrl:]]'
    then
      raise exception 'invalid manual transfer identity'
        using errcode = '22023';
    end if;
  end loop;

  if (
    select count(distinct upper(btrim(value ->> 'reference')))
    from jsonb_array_elements(p_transfers) value
  ) <> v_input_count
    or (
      select count(distinct btrim(value ->> 'provider_transaction_id'))
      from jsonb_array_elements(p_transfers) value
    ) <> v_input_count
  then
    raise exception 'manual payout transfer identities must be unique'
      using errcode = '22023';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  for v_transfer in
    select value
    from jsonb_array_elements(p_transfers) value
  loop
    v_reference := upper(btrim(coalesce(v_transfer ->> 'reference', '')));
    v_provider_id := btrim(
      coalesce(v_transfer ->> 'provider_transaction_id', '')
    );
    v_provider_hash := encode(
      extensions.digest(v_provider_id, 'sha256'),
      'hex'
    );

    select execution.*
    into v_execution
    from affiliate_private.affiliate_revolut_payout_executions execution
    where execution.manual_batch_id = v_batch.id
      and execution.payout_reference = v_reference
    for update;
    if not found
      or v_execution.adapter <> 'revolut_manual'
    then
      raise exception 'manual transfer does not match the exported batch'
        using errcode = 'P0004';
    end if;

    if v_execution.provider_transaction_hash is not null then
      if v_execution.provider_transaction_hash <> v_provider_hash
        or v_execution.provider_transaction_id <> v_provider_id
      then
        raise exception 'manual transfer replay changes provider identity'
          using errcode = 'P0005';
      end if;
      if not exists (
        select 1
        from affiliate_private.affiliate_payout_items item
        where item.id = v_execution.payout_item_id
          and item.status in ('submitted', 'settled')
          and item.provider_transfer_hash = v_provider_hash
      ) then
        -- A normalized statement may authoritatively report FAILED,
        -- CANCELLED or REVERTED before the operator acknowledges the transfer
        -- in Norva. Acknowledgement moves only the payout item to submitted;
        -- the terminal execution and append-only return evidence are kept.
        update affiliate_private.affiliate_payout_items item
        set
          status = 'submitted',
          provider_transfer_hash = v_provider_hash,
          updated_at = now()
        where item.id = v_execution.payout_item_id
          and item.status = 'pending'
          and exists (
            select 1
            from
              affiliate_private.affiliate_revolut_return_observations
                observation
            where observation.execution_id = v_execution.id
              and observation.return_kind = 'pre_settlement_release'
          )
          and not exists (
            select 1
            from affiliate_private.affiliate_revolut_return_decisions
              decision
            where decision.execution_id = v_execution.id
              and decision.decision = 'confirmed'
          );
        if not found then
          raise exception 'manual transfer evidence is inconsistent'
            using errcode = 'P0004';
        end if;
      end if;
      if v_execution.submitted_by_pseudonym is null then
        if v_batch.status not in ('exported', 'partially_submitted')
          or v_batch.submission_hash is not null
        then
          raise exception 'manual transfer acknowledgement is inconsistent'
            using errcode = 'P0004';
        end if;
        update affiliate_private.affiliate_revolut_payout_executions execution
        set
          submitted_by_pseudonym = v_actor,
          submitted_at = coalesce(execution.submitted_at, now()),
          updated_at = now()
        where execution.id = v_execution.id
          and execution.submitted_by_pseudonym is null;
        get diagnostics v_count = row_count;
        if v_count <> 1 then
          raise exception 'manual transfer acknowledgement changed'
            using errcode = 'P0004';
        end if;
        v_applied_count := v_applied_count + 1;
      else
        v_replayed_count := v_replayed_count + 1;
      end if;
      continue;
    end if;

    if v_execution.state <> 'exported'
      or v_batch.status not in ('exported', 'partially_submitted')
    then
      raise exception 'manual transfer cannot be added to this batch'
        using errcode = 'P0004';
    end if;
    if exists (
      select 1
      from affiliate_private.affiliate_revolut_payout_executions execution
      where execution.provider_transaction_hash = v_provider_hash
        and execution.id <> v_execution.id
    ) then
      raise exception 'Revolut transaction is already mapped'
        using errcode = 'P0005';
    end if;

    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      state = 'submitted',
      reconciliation_status = 'pending',
      provider_transaction_id = v_provider_id,
      provider_transaction_hash = v_provider_hash,
      job_status = 'observing',
      submitted_by_pseudonym = v_actor,
      submitted_at = now(),
      updated_at = now()
    where execution.id = v_execution.id;

    update affiliate_private.affiliate_payout_items item
    set
      status = 'submitted',
      provider_transfer_hash = v_provider_hash,
      updated_at = now()
    where item.id = v_execution.payout_item_id
      and item.status = 'pending'
      and item.execution_adapter = 'revolut_manual'
      and item.payout_reference = v_reference;
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'payout item changed during manual submission'
        using errcode = 'P0004';
    end if;
    v_applied_count := v_applied_count + 1;
  end loop;

  select count(*)::integer
  into v_submitted_count
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id
    and execution.provider_transaction_hash is not null;
  if v_submitted_count > v_batch.item_count then
    raise exception 'manual payout submission count is inconsistent'
      using errcode = 'P0004';
  end if;
  select count(*)::integer
  into v_confirmed_count
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id
    and execution.submitted_by_pseudonym is not null;
  if v_confirmed_count > v_submitted_count then
    raise exception 'manual payout confirmation count is inconsistent'
      using errcode = 'P0004';
  end if;
  select count(*)::integer
  into v_released_count
  from affiliate_private.affiliate_revolut_payout_executions execution
  join affiliate_private.affiliate_payout_items item
    on item.id = execution.payout_item_id
  where execution.manual_batch_id = v_batch.id
    and exists (
      select 1
      from affiliate_private.affiliate_commission_entries release_entry
      where release_entry.entry_kind = 'payout_release'
        and release_entry.related_entry_id = item.allocation_entry_id
    );
  if v_released_count > v_batch.item_count
    or v_confirmed_count + v_released_count > v_batch.item_count
  then
    raise exception 'manual payout resolved count is inconsistent'
      using errcode = 'P0004';
  end if;

  if v_submitted_count + v_released_count < v_batch.item_count
    or v_confirmed_count + v_released_count < v_batch.item_count
  then
    if v_batch.submission_hash is not null
      or v_batch.status not in ('exported', 'partially_submitted')
    then
      raise exception 'completed manual payout evidence is incomplete'
        using errcode = 'P0005';
    end if;
    if v_applied_count = 0
      and v_batch.status = 'partially_submitted'
    then
      return jsonb_build_object(
        'schema_version', 1,
        'action', 'revolut_manual_batch_submission_progressed',
        'replayed', true,
        'batch', jsonb_build_object(
          'key', v_batch.batch_key,
          'status', v_batch.status,
          'mapped_count', v_submitted_count,
          'submitted_count', v_confirmed_count,
          'released_count', v_released_count,
          'remaining_count',
            v_batch.item_count - v_confirmed_count - v_released_count,
          'completed', false
        )
      );
    end if;

    update affiliate_private.affiliate_revolut_manual_batches batch
    set
      status = 'partially_submitted',
      updated_at = now()
    where batch.id = v_batch.id
    returning * into v_batch;

    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'payout',
      v_batch.batch_key,
      'revolut_manual_batch_submission_progressed',
      'admin',
      v_actor,
      v_justification,
      jsonb_build_object(
        'status', v_batch.status,
        'mapped_count', v_submitted_count,
        'submitted_count', v_confirmed_count,
        'released_count', v_released_count,
        'remaining_count',
          v_batch.item_count - v_confirmed_count - v_released_count,
        'applied_count', v_applied_count,
        'replayed_count', v_replayed_count
      )
    );

    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_batch_submission_progressed',
      'replayed', v_applied_count = 0,
      'batch', jsonb_build_object(
        'key', v_batch.batch_key,
        'status', v_batch.status,
        'mapped_count', v_submitted_count,
        'submitted_count', v_confirmed_count,
        'released_count', v_released_count,
        'remaining_count',
          v_batch.item_count - v_confirmed_count - v_released_count,
        'completed', false
      )
    );
  end if;

  select encode(
    extensions.digest(
      string_agg(
        execution.payout_reference
          || ':'
          || execution.provider_transaction_hash,
        ','
        order by execution.payout_reference
      ),
      'sha256'
    ),
    'hex'
  )
  into v_submission_hash
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id;

  if v_batch.submission_hash is not null then
    if v_batch.submission_hash <> v_submission_hash then
      raise exception 'manual payout submission replay conflicts with evidence'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_batch_submitted',
      'replayed', true,
      'batch', jsonb_build_object(
        'key', v_batch.batch_key,
        'status', v_batch.status,
        'mapped_count', v_submitted_count,
        'submitted_count', v_confirmed_count,
        'remaining_count', 0,
        'completed', true
      )
    );
  end if;
  if v_batch.status not in ('exported', 'partially_submitted') then
    raise exception 'manual payout finalization state is inconsistent'
      using errcode = 'P0005';
  end if;

  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_batch.cycle_id
  for update;
  if not found or v_cycle.status not in ('approved', 'submitted') then
    raise exception 'payout cycle changed during manual submission'
      using errcode = 'P0004';
  end if;

  if v_cycle.status = 'approved' then
    update affiliate_private.affiliate_payout_cycles cycle
    set
      status = 'submitted',
      submitted_at = now(),
      updated_at = now()
    where cycle.id = v_cycle.id
      and cycle.status = 'approved';
    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'payout cycle changed during manual submission'
        using errcode = 'P0004';
    end if;
  end if;

  update affiliate_private.affiliate_revolut_manual_batches batch
  set
    status = 'submitted',
    submission_hash = v_submission_hash,
    submitted_by_pseudonym = v_actor,
    submitted_at = now(),
    updated_at = now()
  where batch.id = v_batch.id
  returning * into v_batch;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_batch.batch_key,
    'revolut_manual_batch_submitted',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'status', v_batch.status,
      'item_count', v_batch.item_count,
      'mapped_count', v_submitted_count,
      'submitted_count', v_confirmed_count,
      'released_count', v_released_count,
      'total_minor', v_batch.total_minor,
      'currency', v_batch.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_manual_batch_submitted',
    'replayed', v_applied_count = 0,
    'batch', jsonb_build_object(
      'key', v_batch.batch_key,
      'status', v_batch.status,
      'mapped_count', v_submitted_count,
      'submitted_count', v_confirmed_count,
      'released_count', v_released_count,
      'remaining_count', 0,
      'completed', true
    )
  );
end;
$$;

-- The Edge parser passes only normalized Norva rows. The raw CSV and every
-- foreign/non-Norva row are discarded before this service-role boundary.
create or replace function
affiliate_private.partners_service_revolut_statement_ingest(
  p_source_file_hash text,
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_rows jsonb,
  p_worker_id text,
  p_import_ticket text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_file_hash text := lower(btrim(coalesce(p_source_file_hash, '')));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_ticket_token text := lower(btrim(coalesce(p_import_ticket, '')));
  v_ticket_hash text;
  v_ticket
    affiliate_private.affiliate_revolut_statement_tickets%rowtype;
  v_actor text;
  v_import affiliate_private.affiliate_revolut_statement_imports%rowtype;
  v_row jsonb;
  v_reference text;
  v_provider_id text;
  v_provider_hash text;
  v_provider_state text;
  v_amount bigint;
  v_row_currency text;
  v_value_date date;
  v_row_hash text;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_execution_found boolean;
  v_manual_batch_key text;
  v_match_status text;
  v_discrepancy text;
  v_accepted integer := 0;
  v_matched integer := 0;
  v_unmatched integer := 0;
  v_mismatch integer := 0;
  v_duplicate integer := 0;
  v_inserted integer;
  v_statement_row_id uuid;
begin
  if v_file_hash !~ '^[0-9a-f]{64}$'
    or p_period_start is null
    or p_period_end is null
    or p_period_end < p_period_start
    or p_period_end > p_period_start + 92
    or v_currency !~ '^[A-Z]{3}$'
    or jsonb_typeof(p_rows) <> 'array'
    or jsonb_array_length(p_rows) not between 1 and 5000
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_ticket_token !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid Revolut statement import'
      using errcode = '22023';
  end if;

  -- Global payout configuration is always locked before the statement-import
  -- mutex. This serializes account financial closure against every RETURN or
  -- late COMPLETED mutation and gives all statement files one lock order.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-statement-import',
      0
    )
  );

  v_ticket_hash := encode(
    extensions.digest(v_ticket_token, 'sha256'),
    'hex'
  );
  select ticket.*
  into v_ticket
  from affiliate_private.affiliate_revolut_statement_tickets ticket
  where ticket.ticket_token_hash = v_ticket_hash
  for update;
  if not found
    or v_ticket.consumed_at is not null
    or v_ticket.expires_at <= now()
  then
    raise exception 'Revolut statement import ticket is unavailable'
      using errcode = '42501';
  end if;
  update affiliate_private.affiliate_revolut_statement_tickets ticket
  set
    consumed_at = now(),
    source_file_hash = v_file_hash
  where ticket.id = v_ticket.id
    and ticket.consumed_at is null;
  if not found then
    raise exception 'Revolut statement import ticket was already consumed'
      using errcode = 'P0003';
  end if;
  v_actor := v_ticket.actor_pseudonym;

  select import.*
  into v_import
  from affiliate_private.affiliate_revolut_statement_imports import
  where import.source_file_hash = v_file_hash;
  if found then
    if v_import.period_start is distinct from p_period_start
      or v_import.period_end is distinct from p_period_end
      or v_import.currency is distinct from v_currency
    then
      raise exception 'Revolut statement replay metadata conflicts'
        using errcode = 'P0005';
    end if;
    if v_import.status = 'processing' then
      raise exception 'Revolut statement import is already processing'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_statement_ingested',
      'replayed', true,
      'import', jsonb_build_object(
        'key', v_import.import_key,
        'status', v_import.status,
        'accepted', v_import.accepted_row_count,
        'matched', v_import.matched_row_count,
        'unmatched', v_import.unmatched_row_count,
        'mismatch', v_import.mismatch_row_count,
        'duplicate', v_import.duplicate_row_count
      )
    );
  end if;

  insert into affiliate_private.affiliate_revolut_statement_imports (
    source_file_hash,
    period_start,
    period_end,
    currency,
    imported_by_pseudonym,
    authorization_ticket_id
  )
  values (
    v_file_hash,
    p_period_start,
    p_period_end,
    v_currency,
    v_actor,
    v_ticket.id
  )
  returning * into v_import;

  for v_row in
    select value
    from jsonb_array_elements(p_rows) value
  loop
    if jsonb_typeof(v_row) <> 'object'
      or (
        select count(*)
        from jsonb_object_keys(v_row)
      ) <> 6
      or not (v_row ? 'reference')
      or not (v_row ? 'provider_transaction_id')
      or not (v_row ? 'provider_state')
      or not (v_row ? 'amount_minor')
      or not (v_row ? 'currency')
      or not (v_row ? 'value_date')
    then
      raise exception 'invalid normalized Revolut statement row'
        using errcode = '22023';
    end if;

    v_reference := upper(btrim(coalesce(v_row ->> 'reference', '')));
    v_provider_id := btrim(
      coalesce(v_row ->> 'provider_transaction_id', '')
    );
    v_provider_state := upper(
      btrim(coalesce(v_row ->> 'provider_state', ''))
    );
    v_row_currency := upper(btrim(coalesce(v_row ->> 'currency', '')));
    begin
      v_amount := (v_row ->> 'amount_minor')::bigint;
      v_value_date := (v_row ->> 'value_date')::date;
    exception
      when others then
        raise exception 'invalid normalized Revolut statement value'
          using errcode = '22023';
    end;

    if v_reference !~ '^NORVA-[A-F0-9]{12}$'
      or length(v_provider_id) not between 8 and 128
      or v_provider_id ~ '[[:space:][:cntrl:]]'
      or v_provider_state not in (
        'CREATED',
        'PENDING',
        'PROCESSING',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'REVERTED'
      )
      or v_amount not between 1 and 9007199254740991
      or v_row_currency !~ '^[A-Z]{3}$'
      or v_row_currency <> v_currency
      or v_value_date < date '2020-01-01'
      or v_value_date > current_date + 1
      or v_value_date < p_period_start
      or v_value_date > p_period_end
    then
      raise exception 'invalid normalized Revolut statement row'
        using errcode = '22023';
    end if;

    v_provider_hash := encode(
      extensions.digest(v_provider_id, 'sha256'),
      'hex'
    );
    v_row_hash := encode(
      extensions.digest(
        concat_ws(
          ':',
          'norva:partners:revolut-statement-row:v1',
          v_reference,
          v_provider_hash,
          v_provider_state,
          v_amount::text,
          v_row_currency,
          v_value_date::text
        ),
        'sha256'
      ),
      'hex'
    );

    if exists (
      select 1
      from affiliate_private.affiliate_revolut_statement_rows row
      where row.statement_row_hash = v_row_hash
    ) then
      v_duplicate := v_duplicate + 1;
      continue;
    end if;

    select execution.*
    into v_execution
    from affiliate_private.affiliate_revolut_payout_executions execution
    where execution.payout_reference = v_reference;
    v_execution_found := found;
    if v_execution_found then
      if v_execution.manual_batch_id is not null then
        select batch.batch_key
        into v_manual_batch_key
        from affiliate_private.affiliate_revolut_manual_batches batch
        where batch.id = v_execution.manual_batch_id;
        if not found then
          raise exception 'manual payout batch is unavailable'
            using errcode = 'P0002';
        end if;
        perform pg_advisory_xact_lock(
          hashtextextended(
            'norva:partners:revolut-manual-batch:'
              || v_manual_batch_key,
            0
          )
        );
      end if;
      select execution.*
      into v_execution
      from affiliate_private.affiliate_revolut_payout_executions execution
      where execution.payout_reference = v_reference
      for update;
      if not found then
        raise exception 'payout execution changed during statement import'
          using errcode = 'P0004';
      end if;
    end if;

    if not v_execution_found then
      v_match_status := 'unmatched';
      v_discrepancy := 'unknown_reference';
    elsif v_execution.currency <> v_row_currency then
      v_match_status := 'mismatch';
      v_discrepancy := 'currency_mismatch';
    elsif v_execution.amount_minor <> v_amount then
      v_match_status := 'mismatch';
      v_discrepancy := 'amount_mismatch';
    elsif v_execution.provider_transaction_hash is not null
      and v_execution.provider_transaction_hash <> v_provider_hash
    then
      v_match_status := 'mismatch';
      v_discrepancy := 'transaction_mismatch';
    elsif v_provider_state <> 'COMPLETED' then
      v_match_status := 'mismatch';
      v_discrepancy := case
        when v_execution.state = 'paid'
          and v_execution.reconciliation_status = 'confirmed'
          then 'post_settlement_return'
        else 'provider_not_completed'
      end;
    elsif not (
      (
        v_execution.adapter = 'revolut_manual'
        and v_execution.state = 'exported'
        and v_execution.reconciliation_status = 'not_ready'
        and v_execution.provider_transaction_hash is null
      )
      or (
        v_execution.adapter = 'revolut_api'
        and v_execution.state in (
          'prepared',
          'submitted',
          'processing'
        )
        and v_execution.reconciliation_status = 'not_ready'
      )
      or (
        v_execution.state in ('submitted', 'processing', 'paid')
        and v_execution.reconciliation_status = 'pending'
      )
      or (
        v_execution.state = 'paid'
        and v_execution.reconciliation_status = 'confirmed'
      )
      or (
        v_execution.state = 'exception'
        and v_execution.reconciliation_status = 'exception'
        and exists (
          select 1
          from affiliate_private.affiliate_revolut_manual_decisions
            decision
          where decision.execution_id = v_execution.id
            and decision.decision = 'quarantined'
        )
        and not exists (
          select 1
          from affiliate_private.affiliate_revolut_manual_decisions
            decision
          where decision.execution_id = v_execution.id
            and decision.decision = 'confirmed'
        )
      )
    )
    then
      v_match_status := 'mismatch';
      v_discrepancy := 'execution_state_mismatch';
    else
      v_match_status := 'matched';
      v_discrepancy := null;
    end if;

    insert into affiliate_private.affiliate_revolut_statement_rows (
      import_id,
      execution_id,
      statement_row_hash,
      payout_reference,
      provider_transaction_hash,
      provider_state,
      amount_minor,
      currency,
      value_date,
      match_status,
      discrepancy_code,
      observed_at
    )
    values (
      v_import.id,
      case when v_execution_found then v_execution.id else null end,
      v_row_hash,
      v_reference,
      v_provider_hash,
      v_provider_state,
      v_amount,
      v_row_currency,
      v_value_date,
      v_match_status,
      v_discrepancy,
      now()
    )
    on conflict (statement_row_hash) do nothing
    returning id into v_statement_row_id;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      v_duplicate := v_duplicate + 1;
      continue;
    end if;

    v_accepted := v_accepted + 1;
    if v_match_status = 'matched' then
      v_matched := v_matched + 1;
    elsif v_match_status = 'unmatched' then
      v_unmatched := v_unmatched + 1;
    else
      v_mismatch := v_mismatch + 1;
    end if;

    if v_match_status = 'mismatch'
      and v_discrepancy = 'execution_state_mismatch'
      and v_provider_state = 'COMPLETED'
      and exists (
        select 1
        from affiliate_private.affiliate_payout_items item
        join affiliate_private.affiliate_commission_entries release
          on release.related_entry_id = item.allocation_entry_id
          and release.entry_kind = 'payout_release'
        where item.id = v_execution.payout_item_id
      )
    then
      perform
        affiliate_private.record_revolut_late_completion_observation(
          v_execution.id,
          'statement',
          v_statement_row_id,
          v_row_hash,
          now()
        );
      continue;
    end if;

    if v_match_status = 'matched'
      and not (
        v_execution.state = 'paid'
        and v_execution.reconciliation_status = 'confirmed'
      )
    then
      update affiliate_private.affiliate_revolut_payout_executions execution
      set
        state = 'paid',
        reconciliation_status = 'pending',
        provider_transaction_id = coalesce(
          execution.provider_transaction_id,
          v_provider_id
        ),
        provider_transaction_hash = coalesce(
          execution.provider_transaction_hash,
          v_provider_hash
        ),
        submitted_at = coalesce(execution.submitted_at, now()),
        paid_observed_at = coalesce(execution.paid_observed_at, now()),
        job_status = 'observing',
        worker_id = null,
        lease_token_hash = null,
        leased_until = null,
        attempts = 0,
        updated_at = now()
      where execution.id = v_execution.id;

      update affiliate_private.affiliate_payout_items item
      set
        status = case
          when item.status = 'pending' then 'submitted'
          else item.status
        end,
        provider_transfer_hash = coalesce(
          item.provider_transfer_hash,
          v_provider_hash
        ),
        updated_at = now()
      where item.id = v_execution.payout_item_id
        and item.status in ('pending', 'submitted')
        and (
          item.provider_transfer_hash is null
          or item.provider_transfer_hash = v_provider_hash
        );
      get diagnostics v_inserted = row_count;
      if v_inserted <> 1 then
        raise exception 'payout item changed during statement matching'
          using errcode = 'P0004';
      end if;

      if v_execution.manual_batch_id is not null then
        update affiliate_private.affiliate_revolut_manual_batches batch
        set
          status = 'partially_submitted',
          updated_at = now()
        where batch.id = v_execution.manual_batch_id
          and batch.status in ('exported', 'partially_submitted');
      elsif v_execution.adapter = 'revolut_api' then
        perform 1
        from affiliate_private.affiliate_payout_items item
        join affiliate_private.affiliate_payout_cycles cycle
          on cycle.id = item.cycle_id
        where item.id = v_execution.payout_item_id
          and cycle.status in ('approved', 'submitted')
          and cycle.live_execution
        for update of cycle;
        if not found then
          raise exception 'API payout cycle changed during statement recovery'
            using errcode = 'P0004';
        end if;
        update affiliate_private.affiliate_payout_cycles cycle
        set
          status = 'submitted',
          submitted_at = coalesce(cycle.submitted_at, now()),
          updated_at = now()
        where cycle.id = (
          select item.cycle_id
          from affiliate_private.affiliate_payout_items item
          where item.id = v_execution.payout_item_id
        )
          and cycle.status = 'approved';
      end if;
    elsif v_match_status = 'mismatch'
      and (
        v_discrepancy <> 'provider_not_completed'
        or v_provider_state in ('FAILED', 'CANCELLED', 'REVERTED')
      )
    then
      if v_discrepancy in (
        'provider_not_completed',
        'post_settlement_return'
      )
        and v_provider_state in ('FAILED', 'CANCELLED', 'REVERTED')
      then
        update affiliate_private.affiliate_revolut_payout_executions execution
        set
          provider_transaction_id = coalesce(
            execution.provider_transaction_id,
            v_provider_id
          ),
          provider_transaction_hash = coalesce(
            execution.provider_transaction_hash,
            v_provider_hash
          ),
          state = case
            when v_discrepancy = 'post_settlement_return'
              then execution.state
            else 'exception'
          end,
          reconciliation_status = case
            when v_discrepancy = 'post_settlement_return'
              then execution.reconciliation_status
            else 'exception'
          end,
          job_status = case
            when v_discrepancy = 'post_settlement_return'
              then execution.job_status
            else 'exception'
          end,
          worker_id = null,
          lease_token_hash = null,
          leased_until = null,
          last_error_code = v_discrepancy,
          updated_at = now()
        where execution.id = v_execution.id;

        perform affiliate_private.record_revolut_return_observation(
          v_execution.id,
          'statement',
          v_statement_row_id,
          v_row_hash,
          v_provider_state,
          now()
        );
      else
        if not (
          v_execution.state = 'paid'
          and v_execution.reconciliation_status = 'confirmed'
        ) then
          update affiliate_private.affiliate_revolut_payout_executions
            execution
          set
            state = 'exception',
            reconciliation_status = 'exception',
            job_status = 'exception',
            worker_id = null,
            lease_token_hash = null,
            leased_until = null,
            last_error_code = v_discrepancy,
            updated_at = now()
          where execution.id = v_execution.id;
        end if;
      end if;
    end if;
  end loop;

  update affiliate_private.affiliate_revolut_statement_imports import
  set
    status = 'complete',
    accepted_row_count = v_accepted,
    matched_row_count = v_matched,
    unmatched_row_count = v_unmatched,
    mismatch_row_count = v_mismatch,
    duplicate_row_count = v_duplicate,
    completed_at = now()
  where import.id = v_import.id
  returning * into v_import;

  update affiliate_private.affiliate_revolut_manual_batches batch
  set
    status = case
      when exists (
        select 1
        from affiliate_private.affiliate_revolut_payout_executions execution
        where execution.manual_batch_id = batch.id
          and execution.reconciliation_status = 'exception'
          and not exists (
            select 1
            from
              affiliate_private.affiliate_revolut_return_observations
                observation
            where observation.execution_id = execution.id
              and observation.return_kind = 'pre_settlement_release'
          )
      ) then 'exception'
      when exists (
        select 1
        from affiliate_private.affiliate_revolut_payout_executions execution
        where execution.manual_batch_id = batch.id
          and execution.state = 'paid'
      ) then 'partially_reconciled'
      else batch.status
    end,
    updated_at = now()
  where batch.status in (
      'submitted',
      'partially_reconciled',
      'exception'
    )
    and exists (
      select 1
      from affiliate_private.affiliate_revolut_payout_executions execution
      join affiliate_private.affiliate_revolut_statement_rows row
        on row.execution_id = execution.id
        and row.import_id = v_import.id
      where execution.manual_batch_id = batch.id
    );

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_import.import_key,
    'revolut_statement_ingested',
    'service',
    v_actor,
    'Normalized Revolut statement evidence was ingested without raw banking data.',
    jsonb_build_object(
      'accepted', v_import.accepted_row_count,
      'matched', v_import.matched_row_count,
      'unmatched', v_import.unmatched_row_count,
      'mismatch', v_import.mismatch_row_count,
      'duplicate', v_import.duplicate_row_count,
      'currency', v_import.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_statement_ingested',
    'replayed', false,
    'import', jsonb_build_object(
      'key', v_import.import_key,
      'status', v_import.status,
      'accepted', v_import.accepted_row_count,
      'matched', v_import.matched_row_count,
      'unmatched', v_import.unmatched_row_count,
      'mismatch', v_import.mismatch_row_count,
      'duplicate', v_import.duplicate_row_count
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_reconciliation_review(
  p_statement_row_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_statement_row_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_confirmation_hash text;
  v_row affiliate_private.affiliate_revolut_statement_rows%rowtype;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_review affiliate_private.affiliate_revolut_manual_reviews%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Revolut reconciliation review requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rsr_[0-9a-f]{24}$'
    or v_confirmation <> 'REVIEW:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Revolut reconciliation review'
      using errcode = '22023';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  select row.*
  into v_row
  from affiliate_private.affiliate_revolut_statement_rows row
  where row.row_key = v_key;
  if not found then
    raise exception 'Revolut statement row is unavailable'
      using errcode = 'P0002';
  end if;

  select execution.*
  into v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = v_row.execution_id
  for update;
  if not found then
    raise exception 'Revolut payout execution is unavailable'
      using errcode = 'P0002';
  end if;

  v_confirmation_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-reconciliation-review:v1',
        v_actor,
        v_row.statement_row_hash,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  select review.*
  into v_review
  from affiliate_private.affiliate_revolut_manual_reviews review
  where review.statement_row_id = v_row.id;
  if found then
    if v_review.review_actor_pseudonym is distinct from v_actor
      or v_review.confirmation_hash is distinct from v_confirmation_hash
      or v_review.justification is distinct from v_justification
    then
      raise exception 'statement row already has another Finance review'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_reconciliation_reviewed',
      'replayed', true,
      'review', jsonb_build_object(
        'key', v_review.review_key,
        'statement_row_key', v_key
      )
    );
  end if;

  select item.*
  into v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_execution.payout_item_id
  for update;
  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id
  for update;

  if v_row.match_status <> 'matched'
    or v_row.discrepancy_code is not null
    or v_execution.state <> 'paid'
    or v_execution.reconciliation_status <> 'pending'
    or v_execution.provider_transaction_hash is null
    or v_execution.provider_transaction_hash is distinct from
      v_row.provider_transaction_hash
    or v_item.status <> 'submitted'
    or v_item.provider_transfer_hash is distinct from
      v_execution.provider_transaction_hash
    or v_item.amount_minor is distinct from v_row.amount_minor
    or v_item.currency is distinct from v_row.currency
    or v_cycle.status <> 'submitted'
    or not v_cycle.live_execution
    or v_cycle.currency is distinct from v_row.currency
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_manual_decisions decision
      where decision.execution_id = v_execution.id
        and decision.decision = 'confirmed'
    )
  then
    raise exception 'Revolut reconciliation review guards are incomplete'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_revolut_manual_reviews (
    statement_row_id,
    execution_id,
    review_actor_pseudonym,
    confirmation_hash,
    justification
  )
  values (
    v_row.id,
    v_execution.id,
    v_actor,
    v_confirmation_hash,
    v_justification
  )
  returning * into v_review;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_execution.execution_key,
    'revolut_reconciliation_reviewed',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'statement_row_key', v_row.row_key,
      'review_key', v_review.review_key,
      'reference', v_execution.payout_reference,
      'destination_masked', v_execution.destination_masked,
      'amount_minor', v_row.amount_minor,
      'currency', v_row.currency,
      'value_date', v_row.value_date
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_reconciliation_reviewed',
    'replayed', false,
    'review', jsonb_build_object(
      'key', v_review.review_key,
      'statement_row_key', v_row.row_key
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_reconciliation_decide(
  p_review_key text,
  p_decision text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_review_key, '')));
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_confirmation_hash text;
  v_review affiliate_private.affiliate_revolut_manual_reviews%rowtype;
  v_existing affiliate_private.affiliate_revolut_manual_decisions%rowtype;
  v_row affiliate_private.affiliate_revolut_statement_rows%rowtype;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_decision_row
    affiliate_private.affiliate_revolut_manual_decisions%rowtype;
  v_remaining integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Revolut reconciliation decision requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rmr_[0-9a-f]{24}$'
    or v_decision not in ('confirmed', 'quarantined')
    or v_confirmation <> (case
      when v_decision = 'confirmed' then 'CONFIRM:' || v_key
      else 'QUARANTINE:' || v_key
    end)
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Revolut reconciliation decision'
      using errcode = '22023';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  select review.*
  into v_review
  from affiliate_private.affiliate_revolut_manual_reviews review
  where review.review_key = v_key;
  if not found then
    raise exception 'Revolut Finance review is unavailable'
      using errcode = 'P0002';
  end if;
  if v_actor = v_review.review_actor_pseudonym then
    raise exception 'review and decision require distinct Finance actors'
      using errcode = '42501';
  end if;

  select row.*
  into v_row
  from affiliate_private.affiliate_revolut_statement_rows row
  where row.id = v_review.statement_row_id;
  select execution.*
  into v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = v_review.execution_id
  for update;
  if v_execution.manual_batch_id is not null then
    select batch.*
    into v_batch
    from affiliate_private.affiliate_revolut_manual_batches batch
    where batch.id = v_execution.manual_batch_id;
    if not found
      or v_execution.submitted_by_pseudonym is null
      or v_batch.submitted_by_pseudonym is null
    then
      raise exception 'manual payout submitter evidence is incomplete'
        using errcode = 'P0004';
    end if;
    if v_actor = v_batch.submitted_by_pseudonym then
      raise exception
        'batch submitter and final decision require distinct Finance actors'
        using errcode = '42501';
    end if;
    if v_actor = v_execution.submitted_by_pseudonym then
      raise exception
        'transfer submitter and final decision require distinct Finance actors'
        using errcode = '42501';
    end if;
  end if;

  v_confirmation_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-reconciliation-decision:v1',
        v_actor,
        v_row.statement_row_hash,
        v_review.confirmation_hash,
        v_decision,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  select decision.*
  into v_existing
  from affiliate_private.affiliate_revolut_manual_decisions decision
  where decision.review_id = v_review.id;
  if found then
    if v_existing.decision is distinct from v_decision
      or v_existing.decision_actor_pseudonym is distinct from v_actor
      or v_existing.confirmation_hash is distinct from v_confirmation_hash
      or v_existing.justification is distinct from v_justification
    then
      raise exception 'Finance review already has another decision'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_reconciliation_decided',
      'replayed', true,
      'decision', jsonb_build_object(
        'key', v_existing.decision_key,
        'status', v_existing.decision
      )
    );
  end if;

  select item.*
  into v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_execution.payout_item_id
  for update;
  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id
  for update;

  if v_decision = 'quarantined' then
    insert into affiliate_private.affiliate_revolut_manual_decisions (
      statement_row_id,
      review_id,
      execution_id,
      decision,
      decision_actor_pseudonym,
      confirmation_hash,
      justification
    )
    values (
      v_row.id,
      v_review.id,
      v_execution.id,
      'quarantined',
      v_actor,
      v_confirmation_hash,
      v_justification
    )
    returning * into v_decision_row;

    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      job_status = 'exception',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = 'reconciliation_quarantined',
      updated_at = now()
    where execution.id = v_execution.id;

    update affiliate_private.affiliate_revolut_manual_batches batch
    set status = 'exception', updated_at = now()
    where batch.id = v_execution.manual_batch_id
      and batch.status in ('submitted', 'partially_reconciled');
  else
    if v_row.match_status <> 'matched'
      or v_row.discrepancy_code is not null
      or v_execution.state <> 'paid'
      or v_execution.reconciliation_status <> 'pending'
      or v_execution.provider_transaction_hash is null
      or v_execution.provider_transaction_hash is distinct from
        v_row.provider_transaction_hash
      or v_item.status <> 'submitted'
      or v_item.provider_transfer_hash is distinct from
        v_execution.provider_transaction_hash
      or v_item.amount_minor is distinct from v_row.amount_minor
      or v_item.currency is distinct from v_row.currency
      or v_item.allocation_entry_id is null
      or v_cycle.status <> 'submitted'
      or not v_cycle.live_execution
      or v_cycle.currency is distinct from v_row.currency
      or not exists (
        select 1
        from affiliate_private.affiliate_commission_entries allocation
        where allocation.id = v_item.allocation_entry_id
          and allocation.account_id = v_item.account_id
          and allocation.entry_kind = 'payout_allocation'
          and allocation.currency = v_row.currency
          and allocation.currency_exponent = v_cycle.currency_exponent
          and allocation.amount_minor = v_row.amount_minor
      )
      or exists (
        select 1
        from affiliate_private.affiliate_revolut_manual_decisions decision
        where decision.execution_id = v_execution.id
          and decision.decision = 'confirmed'
      )
    then
      raise exception 'Revolut settlement confirmation guards are incomplete'
        using errcode = 'P0004';
    end if;

    insert into affiliate_private.affiliate_commission_entries (
      account_id,
      entry_kind,
      related_entry_id,
      currency,
      currency_exponent,
      amount_minor
    )
    values (
      v_item.account_id,
      'payout_settlement',
      v_item.allocation_entry_id,
      v_row.currency,
      v_cycle.currency_exponent,
      v_row.amount_minor
    )
    returning * into v_entry;

    insert into affiliate_private.affiliate_commission_postings (
      entry_id,
      ledger_account,
      direction,
      amount_minor,
      currency
    )
    values
      (
        v_entry.id,
        'partner_payout_clearing',
        'debit',
        v_row.amount_minor,
        v_row.currency
      ),
      (
        v_entry.id,
        'partner_cash_settled',
        'credit',
        v_row.amount_minor,
        v_row.currency
      );

    insert into affiliate_private.affiliate_revolut_manual_decisions (
      statement_row_id,
      review_id,
      execution_id,
      decision,
      decision_actor_pseudonym,
      confirmation_hash,
      justification,
      settlement_entry_id
    )
    values (
      v_row.id,
      v_review.id,
      v_execution.id,
      'confirmed',
      v_actor,
      v_confirmation_hash,
      v_justification,
      v_entry.id
    )
    returning * into v_decision_row;

    update affiliate_private.affiliate_payout_items item
    set status = 'settled', updated_at = now()
    where item.id = v_item.id
      and item.status = 'submitted'
      and item.amount_minor = v_row.amount_minor
      and item.currency = v_row.currency;
    get diagnostics v_remaining = row_count;
    if v_remaining <> 1 then
      raise exception 'payout item changed during Revolut settlement'
        using errcode = 'P0004';
    end if;

    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      reconciliation_status = 'confirmed',
      job_status = 'settled',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      last_error_code = null,
      updated_at = now()
    where execution.id = v_execution.id
      and execution.state = 'paid'
      and execution.reconciliation_status = 'pending';
    get diagnostics v_remaining = row_count;
    if v_remaining <> 1 then
      raise exception 'Revolut execution changed during settlement'
        using errcode = 'P0004';
    end if;

    select count(*)::integer
    into v_remaining
    from affiliate_private.affiliate_payout_items item
    where item.cycle_id = v_cycle.id
      and item.status <> 'settled';
    if v_remaining = 0 then
      update affiliate_private.affiliate_payout_cycles cycle
      set
        status = 'settled',
        settled_at = now(),
        updated_at = now()
      where cycle.id = v_cycle.id
        and cycle.status = 'submitted';
      get diagnostics v_remaining = row_count;
      if v_remaining <> 1 then
        raise exception 'payout cycle changed during Revolut settlement'
          using errcode = 'P0004';
      end if;

      update affiliate_private.affiliate_revolut_manual_batches batch
      set
        status = 'settled',
        settled_at = now(),
        updated_at = now()
      where batch.id = v_execution.manual_batch_id
        and batch.status in (
          'submitted',
          'partially_reconciled',
          'exception'
        );
    elsif v_execution.manual_batch_id is not null then
      perform affiliate_private.refresh_revolut_payout_aggregate(
        v_execution.id
      );
    end if;
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_execution.execution_key,
    case
      when v_decision = 'confirmed'
        then 'revolut_settlement_confirmed'
      else 'revolut_settlement_quarantined'
    end,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'review_key', v_review.review_key,
      'decision_key', v_decision_row.decision_key,
      'decision', v_decision_row.decision,
      'reference', v_execution.payout_reference,
      'amount_minor', v_row.amount_minor,
      'currency', v_row.currency,
      'value_date', v_row.value_date
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_reconciliation_decided',
    'replayed', false,
    'decision', jsonb_build_object(
      'key', v_decision_row.decision_key,
      'status', v_decision_row.decision
    )
  );
end;
$$;

create or replace function
affiliate_private.guard_revolut_manual_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_review affiliate_private.affiliate_revolut_manual_reviews%rowtype;
  v_row affiliate_private.affiliate_revolut_statement_rows%rowtype;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_settlement affiliate_private.affiliate_commission_entries%rowtype;
begin
  select review.*
  into v_review
  from affiliate_private.affiliate_revolut_manual_reviews review
  where review.id = new.review_id;
  select row.*
  into v_row
  from affiliate_private.affiliate_revolut_statement_rows row
  where row.id = new.statement_row_id;
  select execution.*
  into v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = new.execution_id;

  if v_review.id is null
    or v_row.id is null
    or v_execution.id is null
    or v_review.statement_row_id is distinct from v_row.id
    or v_review.execution_id is distinct from v_execution.id
    or v_row.execution_id is distinct from v_execution.id
    or new.decision_actor_pseudonym =
      v_review.review_actor_pseudonym
    or new.decision_actor_pseudonym =
      v_execution.submitted_by_pseudonym
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_manual_batches batch
      where batch.id = v_execution.manual_batch_id
        and batch.submitted_by_pseudonym =
          new.decision_actor_pseudonym
    )
  then
    raise exception 'Revolut decision does not match its independent review'
      using errcode = '23514';
  end if;

  if new.decision = 'confirmed' then
    select settlement.*
    into v_settlement
    from affiliate_private.affiliate_commission_entries settlement
    where settlement.id = new.settlement_entry_id;
    if v_settlement.id is null
      or v_settlement.entry_kind <> 'payout_settlement'
      or v_settlement.related_entry_id is distinct from (
        select item.allocation_entry_id
        from affiliate_private.affiliate_payout_items item
        where item.id = v_execution.payout_item_id
      )
      or v_settlement.amount_minor is distinct from v_row.amount_minor
      or v_settlement.currency is distinct from v_row.currency
    then
      raise exception 'Revolut settlement decision ledger is inconsistent'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_manual_decision_guard
before insert on affiliate_private.affiliate_revolut_manual_decisions
for each row execute function
  affiliate_private.guard_revolut_manual_decision();

-- A payout item can settle only from confirmed Revolut evidence.
create or replace function
affiliate_private.partners_payout_item_has_confirmed_settlement(
  p_item_id uuid,
  p_provider_transfer_hash text
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_revolut_manual_decisions decision
      on decision.execution_id = execution.id
      and decision.decision = 'confirmed'
    join affiliate_private.affiliate_commission_entries settlement
      on settlement.id = decision.settlement_entry_id
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    where execution.payout_item_id = p_item_id
      and execution.state = 'paid'
      and execution.reconciliation_status in ('pending', 'confirmed')
      and execution.provider_transaction_hash is not distinct from
        p_provider_transfer_hash
      and settlement.related_entry_id is not distinct from
        item.allocation_entry_id
      and settlement.account_id is not distinct from item.account_id
      and settlement.amount_minor is not distinct from item.amount_minor
      and settlement.currency is not distinct from item.currency
  ) or exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    join
      affiliate_private
        .affiliate_revolut_reconciliation_incident_decisions decision
      on decision.target_execution_id = execution.id
      and decision.action in (
        'settle_exact',
        'remap_exact_and_settle'
      )
    left join affiliate_private.affiliate_revolut_transaction_aliases alias
      on alias.id = decision.alias_id
    join affiliate_private.affiliate_commission_entries settlement
      on settlement.id = decision.resolution_entry_id
      and settlement.entry_kind = 'payout_settlement'
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    where execution.payout_item_id = p_item_id
      and (
        (
          decision.action = 'settle_exact'
          and decision.alias_id is null
          and execution.provider_transaction_hash is not distinct from
            p_provider_transfer_hash
        )
        or (
          decision.action = 'remap_exact_and_settle'
          and alias.authoritative_provider_transaction_hash is not distinct
            from p_provider_transfer_hash
        )
      )
      and settlement.related_entry_id is not distinct from
        item.allocation_entry_id
      and settlement.account_id is not distinct from item.account_id
      and settlement.amount_minor is not distinct from item.amount_minor
      and settlement.currency is not distinct from item.currency
  );
$$;

create or replace function
affiliate_private.guard_partners_settled_payout_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'settled' then
      raise exception 'new payout item cannot start settled'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status <> 'settled' then
    if new.status = 'settled' and (
      new.provider_transfer_hash is null
      or new.amount_minor is distinct from old.amount_minor
      or new.original_amount_minor is distinct from old.original_amount_minor
      or new.recovered_minor is distinct from old.recovered_minor
      or new.allocation_entry_id is distinct from old.allocation_entry_id
      or new.account_id is distinct from old.account_id
      or new.cycle_id is distinct from old.cycle_id
      or new.currency is distinct from old.currency
      or new.payout_profile_id is distinct from old.payout_profile_id
      or not affiliate_private.partners_payout_item_has_confirmed_settlement(
        old.id,
        new.provider_transfer_hash
      )
    ) then
      raise exception 'payout item cannot settle without confirmed evidence'
        using errcode = 'P0004';
    end if;
    return new;
  end if;

  if new.amount_minor is distinct from old.amount_minor
    or new.original_amount_minor is distinct from old.original_amount_minor
    or new.recovered_minor is distinct from old.recovered_minor
    or new.allocation_entry_id is distinct from old.allocation_entry_id
    or new.account_id is distinct from old.account_id
    or new.cycle_id is distinct from old.cycle_id
    or new.currency is distinct from old.currency
    or new.payout_profile_id is distinct from old.payout_profile_id
    or new.provider_transfer_hash is distinct from old.provider_transfer_hash
    or new.payout_reference is distinct from old.payout_reference
    or new.execution_adapter is distinct from old.execution_adapter
    or new.execution_claimed_at is distinct from old.execution_claimed_at
  then
    raise exception 'settled payout financial fields are immutable'
      using errcode = '55000';
  end if;

  if new.status <> 'settled' then
    new.status := 'settled';
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_partners_settled_payout_item_guard
  on affiliate_private.affiliate_payout_items;
create trigger affiliate_partners_settled_payout_item_guard
before insert or update on affiliate_private.affiliate_payout_items
for each row execute function
  affiliate_private.guard_partners_settled_payout_item();

create or replace function
affiliate_private.guard_partners_settled_payout_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_items integer;
  v_settled integer;
  v_total bigint;
begin
  if tg_op = 'INSERT' then
    if new.status = 'settled' then
      raise exception 'new payout cycle cannot start settled'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status <> 'settled' and new.status = 'settled' then
    select
      count(*)::integer,
      count(*) filter (where item.status = 'settled')::integer,
      coalesce(sum(item.amount_minor), 0)::bigint
    into v_items, v_settled, v_total
    from affiliate_private.affiliate_payout_items item
    where item.cycle_id = old.id;

    if not new.live_execution
      or new.settled_at is null
      or v_items < 1
      or v_items <> new.item_count
      or v_settled <> v_items
      or v_total <> new.total_minor
      or exists (
        select 1
        from affiliate_private.affiliate_payout_items item
        where item.cycle_id = old.id
          and not
            affiliate_private.partners_payout_item_has_confirmed_settlement(
              item.id,
              item.provider_transfer_hash
            )
      )
    then
      raise exception 'payout cycle cannot settle with incomplete items'
        using errcode = 'P0004';
    end if;
    return new;
  end if;

  if old.status = 'settled' and new is distinct from old then
    raise exception 'settled payout cycle is immutable'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_partners_settled_payout_cycle_guard
  on affiliate_private.affiliate_payout_cycles;
create trigger affiliate_partners_settled_payout_cycle_guard
before insert or update on affiliate_private.affiliate_payout_cycles
for each row execute function
  affiliate_private.guard_partners_settled_payout_cycle();

-- ---------------------------------------------------------------------------
-- Dormant Revolut Business API worker
-- ---------------------------------------------------------------------------

create or replace function
affiliate_private.revolut_api_global_lease_is_held(
  p_worker_id text,
  p_lease_token_hash text,
  p_generation bigint
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from affiliate_private.affiliate_revolut_api_worker_lease lease
    where lease.lease_name = 'oauth_refresh'
      and lease.worker_id = p_worker_id
      and lease.lease_token_hash = p_lease_token_hash
      and lease.generation = p_generation
      and lease.leased_until > now()
  );
$$;

create or replace function
affiliate_private.partners_worker_revolut_global_lease_acquire(
  p_worker_id text,
  p_lease_token_hash text,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_until timestamptz;
  v_row affiliate_private.affiliate_revolut_api_worker_lease%rowtype;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_lease_seconds not between 30 and 300
  then
    raise exception 'invalid Revolut global worker lease'
      using errcode = '22023';
  end if;

  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_revolut_api_enabled'
  ), false) then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_api_disabled',
      'acquired', false
    );
  end if;
  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_payouts_live'
  ), false)
    or not affiliate_private.release_gates_satisfied(
      array['revolut_api_adapter_verified']::text[]
    )
  then
    raise exception 'Revolut API payout rail is not released'
      using errcode = 'P0001';
  end if;

  v_until := now() + make_interval(secs => p_lease_seconds);
  insert into affiliate_private.affiliate_revolut_api_worker_lease as lease (
    lease_name,
    worker_id,
    lease_token_hash,
    leased_until,
    generation,
    updated_at
  )
  values (
    'oauth_refresh',
    v_worker,
    v_lease,
    v_until,
    1,
    now()
  )
  on conflict (lease_name) do update
  set
    worker_id = excluded.worker_id,
    lease_token_hash = excluded.lease_token_hash,
    leased_until = excluded.leased_until,
    generation = case
      when lease.worker_id = excluded.worker_id
        and lease.lease_token_hash = excluded.lease_token_hash
        and lease.leased_until > now()
      then lease.generation
      else lease.generation + 1
    end,
    updated_at = now()
  where lease.leased_until is null
    or lease.leased_until <= now()
    or (
      lease.worker_id = excluded.worker_id
      and lease.lease_token_hash = excluded.lease_token_hash
    )
  returning * into v_row;

  if not found then
    select lease.*
    into v_row
    from affiliate_private.affiliate_revolut_api_worker_lease lease
    where lease.lease_name = 'oauth_refresh';
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_api_global_lease_busy',
      'acquired', false,
      'leased_until', v_row.leased_until
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_api_global_lease_acquired',
    'acquired', true,
    'generation', v_row.generation,
    'leased_until', v_row.leased_until
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_revolut_global_lease_renew(
  p_worker_id text,
  p_lease_token_hash text,
  p_generation bigint,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_until timestamptz;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_generation is null
    or p_generation < 1
    or p_lease_seconds not between 30 and 300
  then
    raise exception 'invalid Revolut global worker lease renewal'
      using errcode = '22023';
  end if;
  -- A kill switch blocks new global/item leases, but an already fenced
  -- invocation must be able to renew long enough to record the outcome of a
  -- transfer that Revolut may already have accepted.
  v_until := now() + make_interval(secs => p_lease_seconds);
  update affiliate_private.affiliate_revolut_api_worker_lease lease
  set
    leased_until = v_until,
    updated_at = now()
  where lease.lease_name = 'oauth_refresh'
    and lease.worker_id = v_worker
    and lease.lease_token_hash = v_lease
    and lease.generation = p_generation
    and lease.leased_until > now();
  if not found then
    raise exception 'Revolut global worker lease is unavailable'
      using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_api_global_lease_renewed',
    'generation', p_generation,
    'leased_until', v_until
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_revolut_global_lease_release(
  p_worker_id text,
  p_lease_token_hash text,
  p_generation bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_generation is null
    or p_generation < 1
  then
    raise exception 'invalid Revolut global worker lease release'
      using errcode = '22023';
  end if;

  update affiliate_private.affiliate_revolut_api_worker_lease lease
  set
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    updated_at = now()
  where lease.lease_name = 'oauth_refresh'
    and lease.worker_id = v_worker
    and lease.lease_token_hash = v_lease
    and lease.generation = p_generation;
  if not found then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_api_global_lease_release_ignored',
      'released', false
    );
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_api_global_lease_released',
    'released', true,
    'generation', p_generation
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_revolut_payout_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_global_lease_generation bigint,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_actor text;
  v_until timestamptz;
  v_global_until timestamptz;
  v_jobs jsonb;
begin
  if v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_global_lease_generation is null
    or p_global_lease_generation < 1
    or p_limit not between 1 and 25
    or p_lease_seconds not between 30 and 300
  then
    raise exception 'invalid Revolut payout lease'
      using errcode = '22023';
  end if;

  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_revolut_api_enabled'
  ), false) then
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_api_disabled',
      'jobs', '[]'::jsonb
    );
  end if;
  if not coalesce((
    select flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_payouts_live'
  ), false)
    or not affiliate_private.release_gates_satisfied(
      array['revolut_api_adapter_verified']::text[]
    )
  then
    raise exception 'Revolut API payout rail is not released'
      using errcode = 'P0001';
  end if;

  if not affiliate_private.revolut_api_global_lease_is_held(
    v_worker,
    v_lease,
    p_global_lease_generation
  ) then
    raise exception 'Revolut global worker lease is unavailable'
      using errcode = 'P0002';
  end if;

  select lease.leased_until
  into v_global_until
  from affiliate_private.affiliate_revolut_api_worker_lease lease
  where lease.lease_name = 'oauth_refresh'
    and lease.worker_id = v_worker
    and lease.lease_token_hash = v_lease
    and lease.generation = p_global_lease_generation
  for share;
  if v_global_until is null
    or v_global_until <= now() + interval '30 seconds'
  then
    raise exception
      'renew the Revolut global lease before leasing payout jobs'
      using errcode = 'P0003';
  end if;

  if exists (
    select 1
    from affiliate_private.affiliate_payout_items item
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
      and cycle.live_execution
      and cycle.status in ('approved', 'submitted')
      and cycle.approved_at is not null
    join affiliate_private.affiliate_payout_profiles profile
      on profile.id = item.payout_profile_id
      and profile.provider = 'revolut'
      and profile.status = 'active'
    join affiliate_private.affiliate_accounts account
      on account.id = item.account_id
      and account.status = 'active'
    join affiliate_private.affiliate_payout_provider_configs config
      on config.provider = 'revolut'
      and config.country_code = account.country_code
      and config.currency = item.currency
      and config.status = 'active'
      and config.execution_adapter = 'revolut_api'
    where item.status = 'pending'
      and item.amount_minor > 0
      and item.allocation_entry_id is not null
      and item.payout_reference is null
      and item.execution_adapter is null
      and (
        profile.beneficiary_token_ref is null
        or profile.beneficiary_token_ref !~
          '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
        or profile.beneficiary_payment_method_ref is null
        or profile.beneficiary_payment_method_ref !~
          '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
      )
  ) then
    raise exception
      'Revolut API payout profile requires counterparty and payment-method UUIDs'
      using errcode = 'P0004';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('norva:partners:revolut-api-claim', 0)
  );
  v_actor := encode(
    extensions.digest(
      'norva:partners:revolut-api-worker:v1:' || v_worker,
      'sha256'
    ),
    'hex'
  );

  -- Recovery routing locks the same item/cycle rows before reducing an
  -- unclaimed allocation. Taking these locks before snapshot insertion makes
  -- claim versus recovery serializable.
  perform item.id
  from affiliate_private.affiliate_payout_items item
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = item.cycle_id
    and cycle.live_execution
    and cycle.status in ('approved', 'submitted')
    and cycle.approved_at is not null
  join affiliate_private.affiliate_payout_profiles profile
    on profile.id = item.payout_profile_id
    and profile.provider = 'revolut'
    and profile.status = 'active'
  join affiliate_private.affiliate_accounts account
    on account.id = item.account_id
    and account.status = 'active'
  join affiliate_private.affiliate_payout_provider_configs config
    on config.provider = 'revolut'
    and config.country_code = account.country_code
    and config.currency = item.currency
    and config.status = 'active'
    and config.execution_adapter = 'revolut_api'
  where item.status = 'pending'
    and item.amount_minor > 0
    and item.allocation_entry_id is not null
    and item.payout_reference is null
    and item.execution_adapter is null
    and not exists (
      select 1
      from
        affiliate_private.affiliate_revolut_late_completion_observations
          observation
      join affiliate_private.affiliate_revolut_payout_executions held_execution
        on held_execution.id = observation.execution_id
      join affiliate_private.affiliate_payout_items held_item
        on held_item.id = held_execution.payout_item_id
        and held_item.account_id = item.account_id
      left join
        affiliate_private.affiliate_revolut_late_completion_decisions
          decision
        on decision.observation_id = observation.id
      where decision.id is null
        or decision.decision = 'quarantined'
    )
  order by cycle.approved_at, item.created_at, item.id
  limit p_limit
  for update of item, cycle;

  insert into affiliate_private.affiliate_revolut_payout_executions (
    payout_item_id,
    adapter,
    payout_reference,
    beneficiary_token_ref,
    beneficiary_payment_method_ref,
    beneficiary_binding_id,
    beneficiary_binding_version,
    beneficiary_fingerprint_hmac,
    beneficiary_fingerprint_key_version,
    destination_masked,
    amount_minor,
    currency,
    currency_exponent,
    job_status,
    prepared_by_pseudonym
  )
  select
    item.id,
    'revolut_api',
    affiliate_private.allocate_revolut_payout_reference(item.id),
    profile.beneficiary_token_ref,
    profile.beneficiary_payment_method_ref,
    binding.id,
    binding.binding_version,
    binding.beneficiary_fingerprint_hmac,
    binding.fingerprint_key_version,
    profile.display_masked,
    item.amount_minor,
    item.currency,
    cycle.currency_exponent,
    'pending',
    v_actor
  from affiliate_private.affiliate_payout_items item
  join affiliate_private.affiliate_payout_cycles cycle
    on cycle.id = item.cycle_id
    and cycle.live_execution
    and cycle.status in ('approved', 'submitted')
    and cycle.approved_at is not null
  join affiliate_private.affiliate_payout_profiles profile
    on profile.id = item.payout_profile_id
    and profile.provider = 'revolut'
    and profile.status = 'active'
  join affiliate_private.affiliate_accounts account
    on account.id = item.account_id
    and account.status = 'active'
  join affiliate_private.affiliate_revolut_beneficiary_bindings binding
    on binding.id = profile.revolut_binding_id
    and binding.binding_version = profile.revolut_binding_version
    and binding.account_id = item.account_id
    and binding.currency = item.currency
    and binding.status = 'active'
    and binding.beneficiary_token_ref = profile.beneficiary_token_ref
    and binding.beneficiary_payment_method_ref is not distinct from
      profile.beneficiary_payment_method_ref
    and binding.destination_masked = profile.display_masked
  join affiliate_private.affiliate_payout_provider_configs config
    on config.provider = 'revolut'
    and config.country_code = account.country_code
    and config.currency = item.currency
    and config.status = 'active'
    and config.execution_adapter = 'revolut_api'
  where item.status = 'pending'
    and item.amount_minor > 0
    and item.allocation_entry_id is not null
    and item.payout_reference is null
    and item.execution_adapter is null
    and not exists (
      select 1
      from
        affiliate_private.affiliate_revolut_late_completion_observations
          observation
      join affiliate_private.affiliate_revolut_payout_executions held_execution
        on held_execution.id = observation.execution_id
      join affiliate_private.affiliate_payout_items held_item
        on held_item.id = held_execution.payout_item_id
        and held_item.account_id = item.account_id
      left join
        affiliate_private.affiliate_revolut_late_completion_decisions
          decision
        on decision.observation_id = observation.id
      where decision.id is null
        or decision.decision = 'quarantined'
    )
  order by cycle.approved_at, item.created_at, item.id
  limit p_limit
  on conflict (payout_item_id) do nothing;

  update affiliate_private.affiliate_payout_items item
  set
    payout_reference = execution.payout_reference,
    execution_adapter = execution.adapter,
    execution_claimed_at = execution.created_at,
    updated_at = now()
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.payout_item_id = item.id
    and execution.adapter = 'revolut_api'
    and item.payout_reference is null
    and item.execution_adapter is null
    and item.amount_minor = execution.amount_minor
    and item.currency = execution.currency;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    where execution.adapter = 'revolut_api'
      and item.payout_reference is null
      and (
        item.amount_minor is distinct from execution.amount_minor
        or item.currency is distinct from execution.currency
      )
  ) then
    raise exception 'Revolut API payout claim snapshot changed'
      using errcode = 'P0004';
  end if;

  v_until := least(
    now() + make_interval(secs => p_lease_seconds),
    v_global_until
  );
  with candidates as (
    select execution.id
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    left join affiliate_private.affiliate_revolut_beneficiary_bindings
      binding
      on binding.id = execution.beneficiary_binding_id
      and binding.binding_version =
        execution.beneficiary_binding_version
    left join affiliate_private.affiliate_payout_profiles profile
      on profile.id = item.payout_profile_id
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
    where execution.adapter = 'revolut_api'
      and not exists (
        select 1
        from
          affiliate_private.affiliate_revolut_late_completion_observations
            observation
        join
          affiliate_private.affiliate_revolut_payout_executions held_execution
          on held_execution.id = observation.execution_id
        join affiliate_private.affiliate_payout_items held_item
          on held_item.id = held_execution.payout_item_id
          and held_item.account_id = item.account_id
        left join
          affiliate_private.affiliate_revolut_late_completion_decisions
            decision
          on decision.observation_id = observation.id
        where decision.id is null
          or decision.decision = 'quarantined'
      )
      and (
        (
          execution.state in ('prepared', 'submitted', 'processing')
          and cycle.status in ('approved', 'submitted')
        )
        or (
          execution.state = 'paid'
          and execution.reconciliation_status in ('not_ready', 'pending')
          and execution.paid_observed_at >=
            now() - interval '90 days'
          and cycle.status in ('submitted', 'settled')
        )
      )
      and execution.attempts < 8
      and execution.next_attempt_at <= now()
      and (
        execution.job_status in ('pending', 'observing')
        or (
          execution.job_status = 'leased'
          and execution.leased_until < now()
        )
      )
      and cycle.live_execution
      and (
        execution.state <> 'prepared'
        or (
          binding.status = 'active'
          and profile.status = 'active'
          and profile.revolut_binding_id = binding.id
          and profile.revolut_binding_version =
            binding.binding_version
        )
      )
    order by
      case when execution.state = 'paid' then 1 else 0 end,
      cycle.approved_at,
      execution.created_at,
      execution.id
    for update of execution skip locked
    limit p_limit
  ),
  leased as (
    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      job_status = 'leased',
      worker_id = v_worker,
      lease_token_hash = v_lease,
      leased_until = v_until,
      attempts = execution.attempts + 1,
      updated_at = now()
    from candidates candidate
    where execution.id = candidate.id
    returning execution.*
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'execution_key', execution.execution_key,
      'request_id', execution.request_id,
      'reference', execution.payout_reference,
      'provider_transaction_id', execution.provider_transaction_id,
      'beneficiary_token_ref', execution.beneficiary_token_ref,
      'beneficiary_payment_method_ref',
        execution.beneficiary_payment_method_ref,
      'beneficiary_binding_id', execution.beneficiary_binding_id,
      'beneficiary_binding_version',
        execution.beneficiary_binding_version,
      'beneficiary_fingerprint_hmac',
        execution.beneficiary_fingerprint_hmac,
      'beneficiary_fingerprint_key_version',
        execution.beneficiary_fingerprint_key_version,
      'amount_minor', execution.amount_minor,
      'currency', execution.currency,
      'currency_exponent', execution.currency_exponent
    )
    order by execution.created_at, execution.id
  ), '[]'::jsonb)
  into v_jobs
  from leased execution;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_api_jobs_leased',
    'global_lease_generation', p_global_lease_generation,
    'leased_until', v_until,
    'jobs', v_jobs
  );
end;
$$;

create or replace function
affiliate_private.partners_worker_revolut_payout_retry(
  p_execution_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_global_lease_generation bigint,
  p_error_code text,
  p_retryable boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_execution_key, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_error text := lower(btrim(coalesce(p_error_code, '')));
  v_retryable boolean := coalesce(p_retryable, false);
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
begin
  if v_key !~ '^rpx_[0-9a-f]{24}$'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_global_lease_generation is null
    or p_global_lease_generation < 1
    or v_error !~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  then
    raise exception 'invalid Revolut payout retry'
      using errcode = '22023';
  end if;

  if not affiliate_private.revolut_api_global_lease_is_held(
    v_worker,
    v_lease,
    p_global_lease_generation
  ) then
    raise exception 'Revolut global worker lease is unavailable'
      using errcode = 'P0002';
  end if;

  perform 1
  from affiliate_private.affiliate_revolut_api_worker_lease lease
  where lease.lease_name = 'oauth_refresh'
    and lease.worker_id = v_worker
    and lease.lease_token_hash = v_lease
    and lease.generation = p_global_lease_generation
    and lease.leased_until > now()
  for share;
  if not found then
    raise exception 'Revolut global worker lease is unavailable'
      using errcode = 'P0002';
  end if;

  select execution.*
  into v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.execution_key = v_key
  for update;
  if not found
    or v_execution.adapter <> 'revolut_api'
    or v_execution.job_status <> 'leased'
    or v_execution.worker_id <> v_worker
    or v_execution.lease_token_hash <> v_lease
    or v_execution.leased_until <= now()
  then
    raise exception 'Revolut payout lease is unavailable'
      using errcode = 'P0002';
  end if;

  update affiliate_private.affiliate_revolut_payout_executions execution
  set
    job_status = case
      when not v_retryable or execution.attempts >= 8
        then 'dead_letter'
      else 'pending'
    end,
    state = case
      when not v_retryable then 'exception'
      else execution.state
    end,
    reconciliation_status = case
      when not v_retryable then 'exception'
      else execution.reconciliation_status
    end,
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    next_attempt_at = case
      when not v_retryable or execution.attempts >= 8
        then now() + interval '100 years'
      else now() + make_interval(
        secs => least(
          21600,
          30 * power(2, least(execution.attempts, 9))
        )::double precision
      )
    end,
    last_error_code = v_error,
    updated_at = now()
  where execution.id = v_execution.id
  returning * into v_execution;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_api_job_retried',
    'execution', jsonb_build_object(
      'key', v_execution.execution_key,
      'job_status', v_execution.job_status,
      'attempts', v_execution.attempts,
      'retryable', v_retryable
    )
  );
end;
$$;

create or replace function
affiliate_private.revolut_api_state_transition_allowed(
  p_previous text,
  p_next text
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case coalesce(p_previous, '')
    when '' then p_next in (
      'CREATED',
      'PENDING',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'REVERTED'
    )
    when 'CREATED' then p_next in (
      'CREATED',
      'PENDING',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'REVERTED'
    )
    when 'PENDING' then p_next in (
      'PENDING',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'REVERTED'
    )
    when 'PROCESSING' then p_next in (
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'REVERTED'
    )
    when 'COMPLETED' then p_next in ('COMPLETED', 'REVERTED')
    when 'FAILED' then p_next in ('FAILED', 'REVERTED')
    when 'CANCELLED' then p_next in ('CANCELLED', 'REVERTED')
    when 'REVERTED' then p_next = 'REVERTED'
    else false
  end;
$$;

create or replace function
affiliate_private.partners_worker_revolut_payout_observe(
  p_execution_key text,
  p_provider_transaction_id text,
  p_provider_state text,
  p_provider_event_hash text,
  p_observed_at timestamptz,
  p_worker_id text,
  p_lease_token_hash text,
  p_global_lease_generation bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_execution_key, '')));
  v_provider_id text := btrim(coalesce(p_provider_transaction_id, ''));
  v_state text := upper(btrim(coalesce(p_provider_state, '')));
  v_event_hash text := lower(btrim(coalesce(p_provider_event_hash, '')));
  v_worker text := btrim(coalesce(p_worker_id, ''));
  v_lease text := lower(btrim(coalesce(p_lease_token_hash, '')));
  v_provider_hash text;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_existing_event
    affiliate_private.affiliate_revolut_payout_events%rowtype;
  v_payout_event_id uuid;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_previous_state text;
  v_previous_observed_at timestamptz;
  v_is_late_completion boolean := false;
begin
  if v_key !~ '^rpx_[0-9a-f]{24}$'
    or length(v_provider_id) not between 8 and 128
    or v_provider_id ~ '[[:space:][:cntrl:]]'
    or v_state not in (
      'CREATED',
      'PENDING',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'REVERTED'
    )
    or v_event_hash !~ '^[0-9a-f]{64}$'
    or p_observed_at is null
    or p_observed_at > now() + interval '5 minutes'
    or v_worker !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$'
    or v_lease !~ '^[0-9a-f]{64}$'
    or p_global_lease_generation is null
    or p_global_lease_generation < 1
  then
    raise exception 'invalid Revolut API payout observation'
      using errcode = '22023';
  end if;

  -- Do not re-check the feature flag here. It is a claim-time kill switch;
  -- rejecting a valid fenced observation could leave a real transfer
  -- unjournaled after Finance disables new API payouts.
  if not affiliate_private.revolut_api_global_lease_is_held(
    v_worker,
    v_lease,
    p_global_lease_generation
  ) then
    raise exception 'Revolut global worker lease is unavailable'
      using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  perform 1
  from affiliate_private.affiliate_revolut_api_worker_lease lease
  where lease.lease_name = 'oauth_refresh'
    and lease.worker_id = v_worker
    and lease.lease_token_hash = v_lease
    and lease.generation = p_global_lease_generation
    and lease.leased_until > now()
  for share;
  if not found then
    raise exception 'Revolut global worker lease is unavailable'
      using errcode = 'P0002';
  end if;

  select execution.*
  into v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.execution_key = v_key
  for update;
  if not found or v_execution.adapter <> 'revolut_api' then
    raise exception 'Revolut API payout lease is unavailable'
      using errcode = 'P0002';
  end if;
  v_is_late_completion :=
    v_state = 'COMPLETED'
    and v_execution.state in ('failed', 'cancelled', 'exception')
    and v_execution.reconciliation_status = 'confirmed'
    and exists (
      select 1
      from affiliate_private.affiliate_payout_items item
      join affiliate_private.affiliate_commission_entries release
        on release.related_entry_id = item.allocation_entry_id
        and release.entry_kind = 'payout_release'
        and release.account_id = item.account_id
        and release.amount_minor = v_execution.amount_minor
        and release.currency = v_execution.currency
      where item.id = v_execution.payout_item_id
    );
  if not v_is_late_completion
    and (
      v_execution.job_status <> 'leased'
      or v_execution.worker_id <> v_worker
      or v_execution.lease_token_hash <> v_lease
      or v_execution.leased_until <= now()
    )
  then
    raise exception 'Revolut API payout lease is unavailable'
      using errcode = 'P0002';
  end if;

  v_provider_hash := encode(
    extensions.digest(v_provider_id, 'sha256'),
    'hex'
  );
  if v_execution.provider_transaction_hash is not null
    and v_execution.provider_transaction_hash <> v_provider_hash
  then
    raise exception 'Revolut transaction identity changed'
      using errcode = 'P0004';
  end if;

  select event.*
  into v_existing_event
  from affiliate_private.affiliate_revolut_payout_events event
  where event.provider_event_hash = v_event_hash;
  if found then
    if v_existing_event.execution_id <> v_execution.id
      or v_existing_event.provider_state <> v_state
    then
      raise exception 'conflicting Revolut payout event replay'
        using errcode = 'P0005';
    end if;

    if v_is_late_completion then
      perform affiliate_private.record_revolut_late_completion_observation(
        v_execution.id,
        'api_event',
        v_existing_event.id,
        v_event_hash,
        p_observed_at
      );
      return jsonb_build_object(
        'schema_version', 1,
        'action', 'revolut_api_late_completion_recorded',
        'replayed', true,
        'execution', jsonb_build_object(
          'key', v_execution.execution_key,
          'state', v_execution.state,
          'reconciliation_status', v_execution.reconciliation_status
        )
      );
    end if;

    -- A repeated provider event is still a successful poll. Release the
    -- item-level lease and reset the transient retry budget exactly as the
    -- original observation did; otherwise harmless provider replays can
    -- strand a job or push it into the dead-letter path.
    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      job_status = case
        when execution.state in (
          'failed',
          'cancelled',
          'exception'
        ) then 'exception'
        else 'observing'
      end,
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      attempts = 0,
      next_attempt_at = case
        when execution.state in (
          'failed',
          'cancelled',
          'exception'
        ) then now() + interval '100 years'
        when execution.state = 'paid' then now() + interval '6 hours'
        else now() + interval '5 minutes'
      end,
      updated_at = now()
    where execution.id = v_execution.id
    returning * into v_execution;

    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_api_observation_recorded',
      'replayed', true,
      'execution', jsonb_build_object(
        'key', v_execution.execution_key,
        'state', v_execution.state,
        'reconciliation_status', v_execution.reconciliation_status
      )
    );
  end if;

  if v_is_late_completion then
    insert into affiliate_private.affiliate_revolut_payout_events (
      execution_id,
      provider_event_hash,
      provider_state,
      observed_at
    )
    values (
      v_execution.id,
      v_event_hash,
      v_state,
      p_observed_at
    )
    returning id into v_payout_event_id;
    perform affiliate_private.record_revolut_late_completion_observation(
      v_execution.id,
      'api_event',
      v_payout_event_id,
      v_event_hash,
      p_observed_at
    );
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_api_late_completion_recorded',
      'replayed', false,
      'execution', jsonb_build_object(
        'key', v_execution.execution_key,
        'state', v_execution.state,
        'reconciliation_status', v_execution.reconciliation_status
      )
    );
  end if;

  select event.provider_state, event.observed_at
  into v_previous_state, v_previous_observed_at
  from affiliate_private.affiliate_revolut_payout_events event
  where event.execution_id = v_execution.id
  order by event.observed_at desc, event.created_at desc
  limit 1;
  if v_previous_observed_at is not null
    and p_observed_at < v_previous_observed_at
  then
    insert into affiliate_private.affiliate_revolut_payout_events (
      execution_id,
      provider_event_hash,
      provider_state,
      observed_at
    )
    values (
      v_execution.id,
      v_event_hash,
      v_state,
      p_observed_at
    );
    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      job_status = case
        when execution.reconciliation_status = 'confirmed'
          then 'settled'
        when execution.state in ('failed', 'cancelled', 'exception')
          then 'exception'
        else 'observing'
      end,
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      attempts = 0,
      next_attempt_at = case
        when execution.reconciliation_status = 'confirmed'
          or execution.state in ('failed', 'cancelled', 'exception')
          then now() + interval '100 years'
        when execution.state = 'paid' then now() + interval '6 hours'
        else now() + interval '5 minutes'
      end,
      updated_at = now()
    where execution.id = v_execution.id
    returning * into v_execution;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_api_observation_recorded',
      'replayed', false,
      'late_evidence_only', true,
      'execution', jsonb_build_object(
        'key', v_execution.execution_key,
        'state', v_execution.state,
        'reconciliation_status', v_execution.reconciliation_status
      )
    );
  end if;
  if not affiliate_private.revolut_api_state_transition_allowed(
    v_previous_state,
    v_state
  ) then
    raise exception 'invalid Revolut API payout state transition'
      using errcode = 'P0006';
  end if;

  insert into affiliate_private.affiliate_revolut_payout_events (
    execution_id,
    provider_event_hash,
    provider_state,
    observed_at
  )
  values (
    v_execution.id,
    v_event_hash,
    v_state,
    p_observed_at
  )
  returning id into v_payout_event_id;

  update affiliate_private.affiliate_revolut_payout_executions execution
  set
    state = case v_state
      when 'CREATED' then 'submitted'
      when 'PENDING' then 'submitted'
      when 'PROCESSING' then 'processing'
      when 'COMPLETED' then 'paid'
      when 'FAILED' then case
        when execution.state = 'paid'
          and execution.reconciliation_status = 'confirmed'
          then execution.state
        else 'failed'
      end
      when 'CANCELLED' then case
        when execution.state = 'paid'
          and execution.reconciliation_status = 'confirmed'
          then execution.state
        else 'cancelled'
      end
      else case
        when execution.state = 'paid'
          and execution.reconciliation_status = 'confirmed'
          then execution.state
        else 'exception'
      end
    end,
    reconciliation_status = case
      when v_state = 'COMPLETED'
        and execution.state = 'paid'
        and execution.reconciliation_status = 'confirmed'
        then execution.reconciliation_status
      when v_state = 'COMPLETED' then 'pending'
      when v_state in ('FAILED', 'CANCELLED', 'REVERTED')
        and execution.state = 'paid'
        and execution.reconciliation_status = 'confirmed'
        then execution.reconciliation_status
      when v_state in ('FAILED', 'CANCELLED', 'REVERTED')
        then 'exception'
      else 'not_ready'
    end,
    provider_transaction_id = v_provider_id,
    provider_transaction_hash = v_provider_hash,
    job_status = case
      when v_state = 'COMPLETED'
        and execution.state = 'paid'
        and execution.reconciliation_status = 'confirmed'
        then 'settled'
      when v_state in ('FAILED', 'CANCELLED', 'REVERTED')
        and execution.state = 'paid'
        and execution.reconciliation_status = 'confirmed'
        then 'settled'
      when v_state in ('FAILED', 'CANCELLED', 'REVERTED')
        then 'exception'
      else 'observing'
    end,
    worker_id = null,
    lease_token_hash = null,
    leased_until = null,
    attempts = 0,
    next_attempt_at = case
      when v_state in ('FAILED', 'CANCELLED', 'REVERTED')
        then now() + interval '100 years'
      when v_state = 'COMPLETED' then now() + interval '6 hours'
      else now() + interval '5 minutes'
    end,
    last_error_code = case
      when v_state in ('FAILED', 'CANCELLED', 'REVERTED')
        and execution.state = 'paid'
        and execution.reconciliation_status = 'confirmed'
        then 'post_settlement_return'
      when v_state in ('FAILED', 'CANCELLED', 'REVERTED')
        then lower(v_state)
      else null
    end,
    submitted_at = coalesce(execution.submitted_at, now()),
    paid_observed_at = case
      when v_state = 'COMPLETED'
        then coalesce(execution.paid_observed_at, p_observed_at)
      else execution.paid_observed_at
    end,
    updated_at = now()
  where execution.id = v_execution.id
  returning * into v_execution;

  if v_state in ('FAILED', 'CANCELLED', 'REVERTED') then
    perform affiliate_private.record_revolut_return_observation(
      v_execution.id,
      'api_event',
      v_payout_event_id,
      v_event_hash,
      v_state,
      p_observed_at
    );
  end if;

  select item.*
  into v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_execution.payout_item_id
  for update;
  if v_item.status = 'pending' then
    update affiliate_private.affiliate_payout_items item
    set
      status = 'submitted',
      provider_transfer_hash = v_provider_hash,
      updated_at = now()
    where item.id = v_item.id;
  elsif v_item.provider_transfer_hash is distinct from v_provider_hash then
    raise exception 'payout item transaction identity changed'
      using errcode = 'P0004';
  end if;

  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id
  for update;
  if v_cycle.status = 'approved' then
    update affiliate_private.affiliate_payout_cycles cycle
    set
      status = 'submitted',
      submitted_at = coalesce(cycle.submitted_at, now()),
      updated_at = now()
    where cycle.id = v_cycle.id;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_api_observation_recorded',
    'replayed', false,
    'execution', jsonb_build_object(
      'key', v_execution.execution_key,
      'state', v_execution.state,
      'reconciliation_status', v_execution.reconciliation_status
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_payout_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_routes jsonb;
  v_action_required bigint;
begin
  perform affiliate_private.partners_require_capability('finance');
  select
    (
      select count(*)
      from affiliate_private.affiliate_revolut_manual_cancellations
      where status = 'pending'
    )
    + (
      select count(*)
      from affiliate_private.affiliate_revolut_manual_unmapped_requests
      where status = 'pending'
    )
    + (
      select count(distinct observation.id)
      from affiliate_private.affiliate_revolut_return_observations observation
      left join affiliate_private.affiliate_revolut_return_decisions decision
        on decision.observation_id = observation.id
      where decision.id is null or decision.decision = 'quarantined'
    )
    + (
      select count(distinct observation.id)
      from
        affiliate_private.affiliate_revolut_late_completion_observations
          observation
      left join
        affiliate_private.affiliate_revolut_late_completion_decisions decision
        on decision.observation_id = observation.id
      where decision.id is null or decision.decision = 'quarantined'
    )
    + (
      select count(*)
      from affiliate_private.affiliate_revolut_reconciliation_incidents incident
      where not exists (
        select 1
        from
          affiliate_private
            .affiliate_revolut_reconciliation_incident_decisions decision
        where decision.incident_id = incident.id
          and decision.action <> 'quarantine'
      )
    )
  into v_action_required;
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'country_code', config.country_code,
      'currency', config.currency,
      'status', config.status,
      'execution_adapter', config.execution_adapter,
      'updated_at', config.updated_at
    )
    order by config.country_code, config.currency
  ), '[]'::jsonb)
  into v_routes
  from affiliate_private.affiliate_payout_provider_configs config
  where config.provider = 'revolut';

  return jsonb_build_object(
    'schema_version', 1,
    'provider', 'revolut_business',
    'production_mode', 'revolut_manual',
    'plan', 'basic',
    'api_enabled', coalesce((
      select flag.enabled
      from public.admin_feature_flags flag
      where flag.key = 'partners_revolut_api_enabled'
    ), false),
    'api_adapter_verified', coalesce((
      select gate.satisfied
      from affiliate_private.affiliate_release_gates gate
      where gate.gate_key = 'revolut_api_adapter_verified'
    ), false),
    'action_required', v_action_required,
    'routes', v_routes,
    'counts', jsonb_build_object(
      'manual_batches_open', (
        select count(*)
        from affiliate_private.affiliate_revolut_manual_batches batch
        where batch.status not in ('settled', 'cancelled')
      ),
      'manual_batches_exception', (
        select count(*)
        from affiliate_private.affiliate_revolut_manual_batches batch
        where batch.status = 'exception'
      ),
      'reconciliation_pending', (
        select count(*)
        from affiliate_private.affiliate_revolut_payout_executions execution
        where execution.adapter = 'revolut_manual'
          and execution.reconciliation_status = 'pending'
          and execution.submitted_by_pseudonym is not null
          and execution.state in ('submitted', 'paid')
          and not exists (
            select 1
            from
              affiliate_private
                .affiliate_revolut_reconciliation_incidents incident
            where not exists (
                select 1
                from
                  affiliate_private
                    .affiliate_revolut_reconciliation_incident_decisions
                      decision
                where decision.incident_id = incident.id
                  and decision.action <> 'quarantine'
              )
              and (
                incident.source_execution_id = execution.id
                or exists (
                  select 1
                  from
                    affiliate_private
                      .affiliate_revolut_reconciliation_incident_reviews review
                  where review.incident_id = incident.id
                    and review.target_execution_id = execution.id
                )
              )
          )
      ),
      'manual_statement_pending', (
        select count(*)
        from affiliate_private.affiliate_revolut_payout_executions execution
        where execution.adapter = 'revolut_manual'
          and execution.state = 'submitted'
          and execution.reconciliation_status = 'pending'
          and execution.submitted_by_pseudonym is not null
          and execution.provider_transaction_hash is null
          and not exists (
            select 1
            from
              affiliate_private
                .affiliate_revolut_reconciliation_incidents incident
            where not exists (
                select 1
                from
                  affiliate_private
                    .affiliate_revolut_reconciliation_incident_decisions
                      decision
                where decision.incident_id = incident.id
                  and decision.action <> 'quarantine'
              )
              and (
                incident.source_execution_id = execution.id
                or exists (
                  select 1
                  from
                    affiliate_private
                      .affiliate_revolut_reconciliation_incident_reviews review
                  where review.incident_id = incident.id
                    and review.target_execution_id = execution.id
                )
              )
          )
      ),
      'statement_matched_review_pending', (
        select count(*)
        from affiliate_private.affiliate_revolut_payout_executions execution
        where execution.adapter = 'revolut_manual'
          and execution.state = 'paid'
          and execution.reconciliation_status = 'pending'
          and execution.provider_transaction_hash is not null
          and not exists (
            select 1
            from
              affiliate_private
                .affiliate_revolut_reconciliation_incidents incident
            where not exists (
                select 1
                from
                  affiliate_private
                    .affiliate_revolut_reconciliation_incident_decisions
                      decision
                where decision.incident_id = incident.id
                  and decision.action <> 'quarantine'
              )
              and (
                incident.source_execution_id = execution.id
                or exists (
                  select 1
                  from
                    affiliate_private
                      .affiliate_revolut_reconciliation_incident_reviews review
                  where review.incident_id = incident.id
                    and review.target_execution_id = execution.id
                )
              )
          )
      ),
      'api_jobs_ready', (
        select count(*)
        from affiliate_private.affiliate_revolut_payout_executions execution
        where execution.adapter = 'revolut_api'
          and execution.job_status in ('pending', 'observing')
      ),
      'api_dead_letter', (
        select count(*)
        from affiliate_private.affiliate_revolut_payout_executions execution
        where execution.adapter = 'revolut_api'
          and execution.job_status = 'dead_letter'
      ),
      'manual_cancellation_pending', (
        select count(*)
        from affiliate_private.affiliate_revolut_manual_cancellations
          cancellation
        where cancellation.status = 'pending'
      ),
      'manual_unmapped_release_pending', (
        select count(*)
        from affiliate_private.affiliate_revolut_manual_unmapped_requests
          request
        where request.status = 'pending'
      ),
      'return_review_pending', (
        select count(*)
        from affiliate_private.affiliate_revolut_return_observations
          observation
        where not exists (
          select 1
          from affiliate_private.affiliate_revolut_return_decisions decision
          where decision.observation_id = observation.id
        )
      ),
      'return_quarantined', (
        select count(*)
        from affiliate_private.affiliate_revolut_return_decisions decision
        where decision.decision = 'quarantined'
      ),
      'late_completion_pending', (
        select count(*)
        from
          affiliate_private.affiliate_revolut_late_completion_observations
            observation
        where not exists (
          select 1
          from
            affiliate_private.affiliate_revolut_late_completion_decisions
              decision
          where decision.observation_id = observation.id
        )
      ),
      'late_completion_quarantined', (
        select count(*)
        from
          affiliate_private.affiliate_revolut_late_completion_decisions
            decision
        where decision.decision = 'quarantined'
      ),
      'late_completion_account_holds', (
        select count(distinct item.account_id)
        from
          affiliate_private.affiliate_revolut_late_completion_observations
            observation
        join affiliate_private.affiliate_revolut_payout_executions execution
          on execution.id = observation.execution_id
        join affiliate_private.affiliate_payout_items item
          on item.id = execution.payout_item_id
        left join
          affiliate_private.affiliate_revolut_late_completion_decisions
            decision
          on decision.observation_id = observation.id
        where decision.id is null
          or decision.decision = 'quarantined'
      ),
      'reconciliation_incident_open', (
        select count(*)
        from
          affiliate_private.affiliate_revolut_reconciliation_incidents incident
        where not exists (
          select 1
          from
            affiliate_private
              .affiliate_revolut_reconciliation_incident_decisions decision
          where decision.incident_id = incident.id
        )
      ),
      'reconciliation_incident_quarantined', (
        select count(*)
        from
          affiliate_private.affiliate_revolut_reconciliation_incidents incident
        where not exists (
          select 1
          from
            affiliate_private
              .affiliate_revolut_reconciliation_incident_decisions terminal
          where terminal.incident_id = incident.id
            and terminal.action <> 'quarantine'
        )
          and exists (
            select 1
            from
              affiliate_private
                .affiliate_revolut_reconciliation_incident_decisions quarantine
            where quarantine.incident_id = incident.id
              and quarantine.action = 'quarantine'
          )
      )
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_manual_batches(
  p_limit integer,
  p_offset integer,
  p_status text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_total bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual payout batch list requires AAL2'
      using errcode = '42501';
  end if;
  if v_status not in (
    'all',
    'prepared',
    'exported',
    'partially_submitted',
    'submitted',
    'partially_reconciled',
    'settled',
    'exception',
    'cancelled'
  ) then
    raise exception 'invalid manual payout batch filter'
      using errcode = '22023';
  end if;

  select count(*)
  into v_total
  from affiliate_private.affiliate_revolut_manual_batches batch
  where v_status = 'all' or batch.status = v_status;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key', rows.batch_key,
      'cycle_key', rows.cycle_key,
      'status', rows.status,
      'execution_adapter', 'revolut_manual',
      'currency', rows.currency,
      'currency_exponent', rows.currency_exponent,
      'total_minor', rows.total_minor,
      'item_count', rows.item_count,
      'canonical_manifest_hash', rows.canonical_manifest_hash,
      'export_file_hash', rows.export_file_hash,
      'reference_set_hash', coalesce(
        rows.canonical_manifest_hash,
        affiliate_private.revolut_manual_batch_manifest_hash(rows.id)
      ),
      'unmapped_references', (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'reference', execution.payout_reference,
              'amount_minor', execution.amount_minor,
              'currency', execution.currency,
              'currency_exponent', execution.currency_exponent
            )
            order by execution.payout_reference
          ),
          '[]'::jsonb
        )
        from affiliate_private.affiliate_revolut_payout_executions
          execution
        join affiliate_private.affiliate_payout_items item
          on item.id = execution.payout_item_id
        where execution.manual_batch_id = rows.id
          and execution.state = 'exported'
          and execution.reconciliation_status = 'not_ready'
          and execution.provider_transaction_hash is null
          and execution.submitted_by_pseudonym is null
          and execution.submitted_at is null
          and item.status = 'pending'
          and item.provider_transfer_hash is null
      ),
      'mapped_count', rows.mapped_count,
      'submitted_count', rows.submitted_count,
      'paid_count', rows.paid_count,
      'settled_count', rows.settled_count,
      'exception_count', rows.exception_count,
      'prepared_at', rows.prepared_at,
      'exported_at', rows.exported_at,
      'submitted_at', rows.submitted_at,
      'settled_at', rows.settled_at,
      'cancellation', (
        select jsonb_build_object(
          'key', cancellation.cancellation_key,
          'status', cancellation.status,
          'reference_set_hash', cancellation.reference_set_hash,
          'requested_at', cancellation.requested_at,
          'approved_at', cancellation.approved_at
        )
        from affiliate_private.affiliate_revolut_manual_cancellations
          cancellation
        where cancellation.manual_batch_id = rows.id
      ),
      'unmapped_requests', (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'key', request.request_key,
              'status', request.status,
              'reference_set_hash', request.reference_set_hash,
              'reference_count', request.reference_count,
              'requested_at', request.requested_at,
              'approved_at', request.approved_at
            )
            order by request.requested_at, request.request_key
          ),
          '[]'::jsonb
        )
        from
          affiliate_private.affiliate_revolut_manual_unmapped_requests
            request
        where request.manual_batch_id = rows.id
      )
    )
    order by rows.created_at desc, rows.batch_key
  ), '[]'::jsonb)
  into v_items
  from (
    select
      batch.*,
      cycle.cycle_key,
      count(*) filter (
        where execution.provider_transaction_hash is not null
      )::integer as mapped_count,
      count(*) filter (
        where execution.submitted_by_pseudonym is not null
      )::integer as submitted_count,
      count(*) filter (
        where execution.state = 'paid'
      )::integer as paid_count,
      count(*) filter (
        where execution.reconciliation_status = 'confirmed'
      )::integer as settled_count,
      count(*) filter (
        where execution.reconciliation_status = 'exception'
      )::integer as exception_count
    from affiliate_private.affiliate_revolut_manual_batches batch
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = batch.cycle_id
    join affiliate_private.affiliate_revolut_payout_executions execution
      on execution.manual_batch_id = batch.id
    where v_status = 'all' or batch.status = v_status
    group by batch.id, cycle.cycle_key
    order by batch.created_at desc, batch.batch_key
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_reconciliation_queue(
  p_limit integer,
  p_offset integer,
  p_status text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_total bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_status not in (
    'all',
    'matched',
    'unmatched',
    'mismatch',
    'reviewed',
    'confirmed',
    'quarantined'
  ) then
    raise exception 'invalid Revolut reconciliation filter'
      using errcode = '22023';
  end if;

  with queue as (
    select
      row.id,
      case
        when decision.decision is not null then decision.decision
        when review.id is not null then 'reviewed'
        else row.match_status
      end as effective_status
    from affiliate_private.affiliate_revolut_statement_rows row
    left join affiliate_private.affiliate_revolut_manual_reviews review
      on review.statement_row_id = row.id
    left join affiliate_private.affiliate_revolut_manual_decisions decision
      on decision.statement_row_id = row.id
  )
  select count(*)
  into v_total
  from queue
  where v_status = 'all' or effective_status = v_status;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'statement_row_key', rows.row_key,
      'reference', rows.payout_reference,
      'destination_masked', rows.destination_masked,
      'provider_state', rows.provider_state,
      'amount_minor', rows.amount_minor,
      'currency', rows.currency,
      'value_date', rows.value_date,
      'match_status', rows.match_status,
      'discrepancy_code', rows.discrepancy_code,
      'effective_status', rows.effective_status,
      'review_key', rows.review_key,
      'decision', rows.decision,
      'observed_at', rows.observed_at
    )
    order by rows.observed_at desc, rows.row_key
  ), '[]'::jsonb)
  into v_items
  from (
    select
      row.*,
      execution.destination_masked,
      review.review_key,
      decision.decision,
      case
        when decision.decision is not null then decision.decision
        when review.id is not null then 'reviewed'
        else row.match_status
      end as effective_status
    from affiliate_private.affiliate_revolut_statement_rows row
    left join affiliate_private.affiliate_revolut_payout_executions execution
      on execution.id = row.execution_id
    left join affiliate_private.affiliate_revolut_manual_reviews review
      on review.statement_row_id = row.id
    left join affiliate_private.affiliate_revolut_manual_decisions decision
      on decision.statement_row_id = row.id
    where v_status = 'all'
      or case
        when decision.decision is not null then decision.decision
        when review.id is not null then 'reviewed'
        else row.match_status
      end = v_status
    order by row.observed_at desc, row.row_key
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Public RPC wrappers and explicit grants
-- ---------------------------------------------------------------------------

create or replace function public.admin_partners_payout_route_set(
  p_provider text,
  p_execution_adapter text,
  p_country_code text,
  p_currency text,
  p_status text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_route_set(
    p_provider,
    p_execution_adapter,
    p_country_code,
    p_currency,
    p_status,
    p_justification
  );
$$;

create or replace function public.admin_partners_revolut_profile_set(
  p_account_id uuid,
  p_currency text,
  p_beneficiary_token_ref text,
  p_beneficiary_payment_method_ref text,
  p_display_masked text,
  p_status text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_profile_set(
    p_account_id,
    p_currency,
    p_beneficiary_token_ref,
    p_beneficiary_payment_method_ref,
    p_display_masked,
    p_status,
    p_justification
  );
$$;

create or replace function
public.admin_partners_revolut_profile_hold(
  p_account_id uuid,
  p_currency text,
  p_status text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_profile_hold(
    p_account_id,
    p_currency,
    p_status,
    p_confirmation,
    p_justification
  );
$$;

create or replace function
public.admin_partners_revolut_profile_status(
  p_account_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_profile_status(
      p_account_id
    );
$$;

create or replace function
public.admin_partners_revolut_beneficiary_binding_authorize(
  p_account_id uuid,
  p_currency text,
  p_beneficiary_token_ref text,
  p_beneficiary_payment_method_ref text,
  p_display_masked text,
  p_fingerprint_key_version integer,
  p_mapping_evidence_hash text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private
      .admin_partners_revolut_beneficiary_binding_authorize(
        p_account_id,
        p_currency,
        p_beneficiary_token_ref,
        p_beneficiary_payment_method_ref,
        p_display_masked,
        p_fingerprint_key_version,
        p_mapping_evidence_hash,
        p_justification
      );
$$;

create or replace function
public.partners_service_revolut_beneficiary_binding_propose(
  p_beneficiary_fingerprint_hmac text,
  p_mapping_attestation_hmac text,
  p_binding_ticket text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private
      .partners_service_revolut_beneficiary_binding_propose(
        p_beneficiary_fingerprint_hmac,
        p_mapping_attestation_hmac,
        p_binding_ticket
      );
$$;

create or replace function
public.admin_partners_revolut_beneficiary_binding_verify(
  p_binding_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_beneficiary_binding_verify(
      p_binding_key,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_beneficiary_binding_reject(
  p_binding_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_beneficiary_binding_reject(
      p_binding_key,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_beneficiary_binding_revoke(
  p_binding_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_beneficiary_binding_revoke(
      p_binding_key,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_manual_batch_prepare(
  p_cycle_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_batch_prepare(
      p_cycle_key,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_manual_batch_payload(
  p_batch_key text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_batch_payload(
      p_batch_key
    );
$$;

create or replace function
public.admin_partners_revolut_manual_batch_mark_exported(
  p_batch_key text,
  p_canonical_manifest_hash text,
  p_export_file_hash text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_batch_mark_exported(
      p_batch_key,
      p_canonical_manifest_hash,
      p_export_file_hash,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_manual_batch_export(
  p_batch_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_batch_export(
      p_batch_key,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_manual_batch_mark_submitted(
  p_batch_key text,
  p_transfers jsonb,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(
      p_batch_key,
      p_transfers,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.partners_service_revolut_statement_ingest(
  p_source_file_hash text,
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_rows jsonb,
  p_worker_id text,
  p_import_ticket text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_service_revolut_statement_ingest(
    p_source_file_hash,
    p_period_start,
    p_period_end,
    p_currency,
    p_rows,
    p_worker_id,
    p_import_ticket
  );
$$;

create or replace function
public.admin_partners_revolut_reconciliation_review(
  p_statement_row_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_reconciliation_review(
      p_statement_row_key,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_reconciliation_decide(
  p_review_key text,
  p_decision text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_reconciliation_decide(
      p_review_key,
      p_decision,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.partners_worker_revolut_global_lease_acquire(
  p_worker_id text,
  p_lease_token_hash text,
  p_lease_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_revolut_global_lease_acquire(
      p_worker_id,
      p_lease_token_hash,
      p_lease_seconds
    );
$$;

create or replace function
public.partners_worker_revolut_global_lease_renew(
  p_worker_id text,
  p_lease_token_hash text,
  p_generation bigint,
  p_lease_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_revolut_global_lease_renew(
      p_worker_id,
      p_lease_token_hash,
      p_generation,
      p_lease_seconds
    );
$$;

create or replace function
public.partners_worker_revolut_global_lease_release(
  p_worker_id text,
  p_lease_token_hash text,
  p_generation bigint
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.partners_worker_revolut_global_lease_release(
      p_worker_id,
      p_lease_token_hash,
      p_generation
    );
$$;

create or replace function
public.partners_worker_revolut_payout_lease(
  p_worker_id text,
  p_lease_token_hash text,
  p_global_lease_generation bigint,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_revolut_payout_lease(
    p_worker_id,
    p_lease_token_hash,
    p_global_lease_generation,
    p_limit,
    p_lease_seconds
  );
$$;

create or replace function
public.partners_worker_revolut_payout_retry(
  p_execution_key text,
  p_worker_id text,
  p_lease_token_hash text,
  p_global_lease_generation bigint,
  p_error_code text,
  p_retryable boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_revolut_payout_retry(
    p_execution_key,
    p_worker_id,
    p_lease_token_hash,
    p_global_lease_generation,
    p_error_code,
    p_retryable
  );
$$;

create or replace function
public.partners_worker_revolut_payout_observe(
  p_execution_key text,
  p_provider_transaction_id text,
  p_provider_state text,
  p_provider_event_hash text,
  p_observed_at timestamptz,
  p_worker_id text,
  p_lease_token_hash text,
  p_global_lease_generation bigint
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.partners_worker_revolut_payout_observe(
    p_execution_key,
    p_provider_transaction_id,
    p_provider_state,
    p_provider_event_hash,
    p_observed_at,
    p_worker_id,
    p_lease_token_hash,
    p_global_lease_generation
  );
$$;

create or replace function
public.admin_partners_revolut_payout_status()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_payout_status();
$$;

create or replace function
public.admin_partners_revolut_manual_batches(
  p_limit integer default 25,
  p_offset integer default 0,
  p_status text default 'all'
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_manual_batches(
    p_limit,
    p_offset,
    p_status
  );
$$;

create or replace function
public.admin_partners_revolut_reconciliation_queue(
  p_limit integer default 25,
  p_offset integer default 0,
  p_status text default 'all'
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_reconciliation_queue(
    p_limit,
    p_offset,
    p_status
  );
$$;

-- Trigger/helper functions are never callable through the API.
revoke all on function
  affiliate_private.partners_require_control_access(text, text, boolean)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_api_feature_flag()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.allocate_revolut_payout_reference(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_live_payout_cycle()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_payout_route()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_payout_item_execution_snapshot()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_execution_snapshot()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_execution_adapter_exclusive()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.reject_revolut_evidence_mutation()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_statement_ticket_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_beneficiary_binding_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_binding_ticket_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_beneficiary_revocation_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_statement_import_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_manual_batch_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_manual_decision()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.partners_payout_item_has_confirmed_settlement(uuid, text)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_settled_payout_item()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_partners_settled_payout_cycle()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.revolut_api_state_transition_allowed(text, text)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.revolut_api_global_lease_is_held(text, text, bigint)
from public, anon, authenticated, service_role;

-- Admin mutations/read models are protected again inside each SECURITY DEFINER
-- function by Finance capability and, for money-moving actions, AAL2.
revoke all on function
  affiliate_private.admin_partners_payout_provider_set(
    text, text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_payout_provider_set(
    text, text, text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_payout_route_set(
    text, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_payout_route_set(
    text, text, text, text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_profile_set(
    uuid, text, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_revolut_profile_hold(
    uuid, text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_profile_hold(
    uuid, text, text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_profile_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_profile_status(uuid)
to authenticated;
revoke all on function
  affiliate_private
    .admin_partners_revolut_beneficiary_binding_authorize(
      uuid, text, text, text, text, integer, text, text
    )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private
    .admin_partners_revolut_beneficiary_binding_authorize(
      uuid, text, text, text, text, integer, text, text
    )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_verify(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_verify(
    text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_reject(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_reject(
    text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_revoke(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_beneficiary_binding_revoke(
    text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_manual_batch_prepare(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_manual_batch_prepare(
    text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_manual_batch_payload(text)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_revolut_manual_batch_mark_exported(
    text, text, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_revolut_manual_batch_export(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_manual_batch_export(
    text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(
    text, jsonb, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(
    text, jsonb, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_reconciliation_review(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_reconciliation_review(
    text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_reconciliation_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_reconciliation_decide(
    text, text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_payout_status()
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_payout_status()
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_manual_batches(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_manual_batches(
    integer, integer, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_reconciliation_queue(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_reconciliation_queue(
    integer, integer, text
  )
to authenticated;

-- Service-only statement and API worker RPCs.
revoke all on function
  affiliate_private.partners_service_revolut_beneficiary_binding_propose(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_revolut_beneficiary_binding_propose(
    text, text, text
  )
to service_role;
revoke all on function
  affiliate_private.partners_service_revolut_statement_ingest(
    text, date, date, text, jsonb, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_revolut_statement_ingest(
    text, date, date, text, jsonb, text, text
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_revolut_global_lease_acquire(
    text, text, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_global_lease_acquire(
    text, text, integer
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_revolut_global_lease_renew(
    text, text, bigint, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_global_lease_renew(
    text, text, bigint, integer
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_revolut_global_lease_release(
    text, text, bigint
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_global_lease_release(
    text, text, bigint
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_revolut_payout_lease(
    text, text, bigint, integer, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_payout_lease(
    text, text, bigint, integer, integer
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_revolut_payout_retry(
    text, text, text, bigint, text, boolean
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_payout_retry(
    text, text, text, bigint, text, boolean
  )
to service_role;
revoke all on function
  affiliate_private.partners_worker_revolut_payout_observe(
    text, text, text, text, timestamptz, text, text, bigint
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_worker_revolut_payout_observe(
    text, text, text, text, timestamptz, text, text, bigint
  )
to service_role;

revoke all on function
  public.admin_partners_payout_provider_set(text, text, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_payout_provider_set(text, text, text, text, text)
to authenticated;
revoke all on function
  public.admin_partners_payout_route_set(
    text, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_payout_route_set(
    text, text, text, text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_profile_set(
    uuid, text, text, text, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  public.admin_partners_revolut_profile_hold(
    uuid, text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_profile_hold(
    uuid, text, text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_profile_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_profile_status(uuid)
to authenticated;
revoke all on function
  public.admin_partners_revolut_beneficiary_binding_authorize(
    uuid, text, text, text, text, integer, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_beneficiary_binding_authorize(
    uuid, text, text, text, text, integer, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_beneficiary_binding_verify(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_beneficiary_binding_verify(
    text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_beneficiary_binding_reject(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_beneficiary_binding_reject(
    text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_beneficiary_binding_revoke(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_beneficiary_binding_revoke(
    text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_manual_batch_prepare(text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_manual_batch_prepare(text, text, text)
to authenticated;
revoke all on function
  public.admin_partners_revolut_manual_batch_payload(text)
from public, anon, authenticated, service_role;
revoke all on function
  public.admin_partners_revolut_manual_batch_mark_exported(
    text, text, text, text, text
  )
from public, anon, authenticated, service_role;
revoke all on function
  public.admin_partners_revolut_manual_batch_export(text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_manual_batch_export(text, text, text)
to authenticated;
revoke all on function
  public.admin_partners_revolut_manual_batch_mark_submitted(
    text, jsonb, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_manual_batch_mark_submitted(
    text, jsonb, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_reconciliation_review(text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_reconciliation_review(text, text, text)
to authenticated;
revoke all on function
  public.admin_partners_revolut_reconciliation_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_reconciliation_decide(
    text, text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_payout_status()
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_payout_status()
to authenticated;
revoke all on function
  public.admin_partners_revolut_manual_batches(integer, integer, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_manual_batches(integer, integer, text)
to authenticated;
revoke all on function
  public.admin_partners_revolut_reconciliation_queue(integer, integer, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_reconciliation_queue(integer, integer, text)
to authenticated;

revoke all on function
  public.partners_service_revolut_beneficiary_binding_propose(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_revolut_beneficiary_binding_propose(
    text, text, text
  )
to service_role;
revoke all on function
  public.partners_service_revolut_statement_ingest(
    text, date, date, text, jsonb, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_service_revolut_statement_ingest(
    text, date, date, text, jsonb, text, text
  )
to service_role;
revoke all on function
  public.partners_worker_revolut_global_lease_acquire(text, text, integer)
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_revolut_global_lease_acquire(text, text, integer)
to service_role;
revoke all on function
  public.partners_worker_revolut_global_lease_renew(
    text, text, bigint, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_revolut_global_lease_renew(
    text, text, bigint, integer
  )
to service_role;
revoke all on function
  public.partners_worker_revolut_global_lease_release(text, text, bigint)
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_revolut_global_lease_release(text, text, bigint)
to service_role;
revoke all on function
  public.partners_worker_revolut_payout_lease(
    text, text, bigint, integer, integer
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_revolut_payout_lease(
    text, text, bigint, integer, integer
  )
to service_role;
revoke all on function
  public.partners_worker_revolut_payout_retry(
    text, text, text, bigint, text, boolean
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_revolut_payout_retry(
    text, text, text, bigint, text, boolean
  )
to service_role;
revoke all on function
  public.partners_worker_revolut_payout_observe(
    text, text, text, text, timestamptz, text, text, bigint
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.partners_worker_revolut_payout_observe(
    text, text, text, text, timestamptz, text, text, bigint
  )
to service_role;

comment on table affiliate_private.affiliate_revolut_manual_batches is
  'Exact-money Revolut Business Basic batches prepared by Norva and entered manually by Finance.';
comment on table affiliate_private.affiliate_revolut_payout_executions is
  'Adapter-snapshotted Revolut payout executions shared by the manual and dormant API rails.';
comment on table affiliate_private.affiliate_revolut_api_worker_lease is
  'Singleton renewable fenced lease serializing the dormant Revolut API worker and OAuth refresh.';
comment on table affiliate_private.affiliate_revolut_statement_imports is
  'Metadata and counters for a normalized statement import; the raw statement is never persisted.';
comment on table affiliate_private.affiliate_revolut_statement_rows is
  'Minimal normalized Norva-only statement evidence used for exact completed-state, reference, amount and currency reconciliation.';

create or replace function
affiliate_private.admin_partners_revolut_statement_authorize()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_token_hash text;
  v_actor text;
  v_expires_at timestamptz := now() + interval '5 minutes';
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Revolut statement import requires AAL2'
      using errcode = '42501';
  end if;
  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(
    extensions.digest(v_token, 'sha256'),
    'hex'
  );
  insert into affiliate_private.affiliate_revolut_statement_tickets (
    ticket_token_hash,
    actor_pseudonym,
    expires_at
  )
  values (
    v_token_hash,
    v_actor,
    v_expires_at
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_statement_authorized',
    'allowed', true,
    'import_ticket', v_token,
    'expires_at', v_expires_at
  );
end;
$$;

create or replace function
public.admin_partners_revolut_statement_authorize()
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_statement_authorize();
$$;

create or replace function
affiliate_private.admin_partners_revolut_statement_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_currency_exponents jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Revolut statement context requires AAL2'
      using errcode = '42501';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_payout_executions execution
    group by execution.currency
    having count(distinct execution.currency_exponent) <> 1
  ) then
    raise exception 'conflicting currency exponent snapshots'
      using errcode = 'P0004';
  end if;

  select coalesce(
    jsonb_object_agg(
      currency_rows.currency,
      currency_rows.currency_exponent
      order by currency_rows.currency
    ),
    '{}'::jsonb
  )
  into v_currency_exponents
  from (
    select
      execution.currency,
      min(execution.currency_exponent) as currency_exponent
    from affiliate_private.affiliate_revolut_payout_executions execution
    group by execution.currency
  ) currency_rows;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_statement_context',
    'currency_exponents', v_currency_exponents
  );
end;
$$;

create or replace function
public.admin_partners_revolut_statement_context()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_statement_context();
$$;

create or replace function affiliate_private.admin_partners_currency_set(
  p_currency text,
  p_exponent integer,
  p_status text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_existing_exponent integer;
  v_has_history boolean := false;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'currency metadata mutation requires AAL2'
      using errcode = '42501';
  end if;
  if v_currency !~ '^[A-Z]{3}$'
    or p_exponent is null
    or p_exponent not between 0 and 6
    or v_status not in ('active', 'disabled')
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid currency metadata'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  select metadata.exponent
  into v_existing_exponent
  from affiliate_private.affiliate_currency_metadata metadata
  where metadata.currency_code = v_currency
  for update;

  v_has_history :=
    exists (
      select 1
      from affiliate_private.affiliate_financial_facts fact
      where fact.currency = v_currency
    )
    or exists (
      select 1
      from affiliate_private.affiliate_commission_entries entry
      where entry.currency = v_currency
    )
    or exists (
      select 1
      from affiliate_private.affiliate_payout_cycles cycle
      where cycle.currency = v_currency
    )
    or exists (
      select 1
      from affiliate_private.affiliate_payout_items item
      where item.currency = v_currency
    )
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_payout_executions execution
      where execution.currency = v_currency
    );
  if v_has_history
    and (
      v_existing_exponent is null
      or v_existing_exponent <> p_exponent
      or exists (
        select 1
        from affiliate_private.affiliate_financial_facts fact
        where fact.currency = v_currency
          and fact.currency_exponent is distinct from p_exponent
      )
      or exists (
        select 1
        from affiliate_private.affiliate_commission_entries entry
        where entry.currency = v_currency
          and entry.currency_exponent <> p_exponent
      )
      or exists (
        select 1
        from affiliate_private.affiliate_payout_cycles cycle
        where cycle.currency = v_currency
          and cycle.currency_exponent <> p_exponent
      )
      or exists (
        select 1
        from affiliate_private.affiliate_revolut_payout_executions execution
        where execution.currency = v_currency
          and execution.currency_exponent <> p_exponent
      )
    )
  then
    raise exception
      'currency exponent is immutable after financial history exists'
      using errcode = 'P0003';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  insert into affiliate_private.affiliate_currency_metadata (
    currency_code,
    exponent,
    status,
    configured_by_pseudonym,
    justification,
    updated_at
  )
  values (
    v_currency,
    p_exponent,
    v_status,
    v_actor,
    v_justification,
    now()
  )
  on conflict (currency_code) do update
  set
    exponent = excluded.exponent,
    status = excluded.status,
    configured_by_pseudonym = excluded.configured_by_pseudonym,
    justification = excluded.justification,
    updated_at = now();
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'currency_metadata_set',
    'status', v_status
  );
end;
$$;

revoke all on function
  affiliate_private.admin_partners_revolut_statement_authorize()
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_statement_authorize()
to authenticated;
revoke all on function
  public.admin_partners_revolut_statement_authorize()
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_statement_authorize()
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_statement_context()
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_statement_context()
to authenticated;
revoke all on function
  public.admin_partners_revolut_statement_context()
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_statement_context()
to authenticated;

-- Deprecated and deliberately not executable by API roles. Statement rows
-- must cross the trusted Edge parser and service-role RPC instead.
create or replace function
affiliate_private.admin_partners_revolut_statement_ingest(
  p_source_file_hash text,
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_rows jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  raise exception
    'Direct statement ingestion is disabled; use the trusted Edge parser'
    using errcode = '0A000';
end;
$$;

create or replace function
public.admin_partners_revolut_statement_ingest(
  p_source_file_hash text,
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_rows jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_statement_ingest(
    p_source_file_hash,
    p_period_start,
    p_period_end,
    p_currency,
    p_rows
  );
$$;

revoke all on function
  affiliate_private.admin_partners_revolut_statement_ingest(
    text, date, date, text, jsonb
  )
from public, anon, authenticated, service_role;
revoke all on function
  public.admin_partners_revolut_statement_ingest(
    text, date, date, text, jsonb
  )
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Explicit return/release resolution (Finance maker-checker)
-- ---------------------------------------------------------------------------

create or replace function
affiliate_private.guard_revolut_return_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_observation
    affiliate_private.affiliate_revolut_return_observations%rowtype;
  v_review affiliate_private.affiliate_revolut_return_reviews%rowtype;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_resolution affiliate_private.affiliate_commission_entries%rowtype;
begin
  select observation.*
  into strict v_observation
  from affiliate_private.affiliate_revolut_return_observations observation
  where observation.id = new.observation_id
    and observation.execution_id = new.execution_id;
  select review.*
  into strict v_review
  from affiliate_private.affiliate_revolut_return_reviews review
  where review.id = new.review_id
    and review.observation_id = new.observation_id
    and review.execution_id = new.execution_id;
  select execution.*
  into strict v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = new.execution_id;

  if v_review.review_actor_pseudonym =
      new.decision_actor_pseudonym
    or v_execution.submitted_by_pseudonym =
      new.decision_actor_pseudonym
  then
    raise exception
      'return review, transfer submitter and decision require distinct actors'
      using errcode = '42501';
  end if;

  if new.decision = 'confirmed' then
    if v_review.conclusion <> 'eligible' then
      raise exception 'only an eligible return review can be confirmed'
        using errcode = '23514';
    end if;
    select resolution.*
    into v_resolution
    from affiliate_private.affiliate_commission_entries resolution
    where resolution.id = new.resolution_entry_id;
    if not found
      or v_resolution.entry_kind <> (case v_observation.return_kind
        when 'pre_settlement_release' then 'payout_release'
        else 'payout_return'
      end)
      or v_resolution.amount_minor is distinct from
        v_observation.amount_minor
      or v_resolution.currency is distinct from v_observation.currency
    then
      raise exception 'return decision ledger is inconsistent'
        using errcode = '23514';
    end if;
  elsif v_review.conclusion <> 'quarantine' then
    raise exception 'quarantined decision requires a quarantine review'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger affiliate_revolut_return_decision_guard
before insert on affiliate_private.affiliate_revolut_return_decisions
for each row execute function
  affiliate_private.guard_revolut_return_decision();

create or replace function
affiliate_private.admin_partners_revolut_return_review(
  p_observation_key text,
  p_conclusion text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_observation_key, '')));
  v_conclusion text := lower(btrim(coalesce(p_conclusion, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_hash text;
  v_observation
    affiliate_private.affiliate_revolut_return_observations%rowtype;
  v_review affiliate_private.affiliate_revolut_return_reviews%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Revolut return review requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rro_[0-9a-f]{24}$'
    or v_conclusion not in ('eligible', 'quarantine')
    or v_confirmation <> 'REVIEW:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Revolut return review'
      using errcode = '22023';
  end if;

  select observation.*
  into v_observation
  from affiliate_private.affiliate_revolut_return_observations observation
  where observation.observation_key = v_key
  for update;
  if not found then
    raise exception 'Revolut return observation is unavailable'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_return_decisions decision
    where decision.execution_id = v_observation.execution_id
      and decision.decision = 'confirmed'
  ) then
    raise exception 'Revolut return execution is already resolved'
      using errcode = 'P0003';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  v_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-return-review:v1',
        v_actor,
        v_observation.source_evidence_hash,
        v_conclusion,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  select review.*
  into v_review
  from affiliate_private.affiliate_revolut_return_reviews review
  where review.observation_id = v_observation.id;
  if found then
    if v_review.conclusion is distinct from v_conclusion
      or v_review.review_actor_pseudonym is distinct from v_actor
      or v_review.confirmation_hash is distinct from v_hash
      or v_review.justification is distinct from v_justification
    then
      raise exception 'return observation already has another review'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_return_reviewed',
      'replayed', true,
      'review', jsonb_build_object(
        'key', v_review.review_key,
        'conclusion', v_review.conclusion
      )
    );
  end if;

  insert into affiliate_private.affiliate_revolut_return_reviews (
    observation_id,
    execution_id,
    conclusion,
    review_actor_pseudonym,
    confirmation_hash,
    justification
  )
  values (
    v_observation.id,
    v_observation.execution_id,
    v_conclusion,
    v_actor,
    v_hash,
    v_justification
  )
  returning * into v_review;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_return_reviewed',
    'replayed', false,
    'review', jsonb_build_object(
      'key', v_review.review_key,
      'conclusion', v_review.conclusion
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_return_decide(
  p_review_key text,
  p_decision text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_review_key, '')));
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_confirmation_hash text;
  v_review affiliate_private.affiliate_revolut_return_reviews%rowtype;
  v_observation
    affiliate_private.affiliate_revolut_return_observations%rowtype;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_related affiliate_private.affiliate_commission_entries%rowtype;
  v_resolution affiliate_private.affiliate_commission_entries%rowtype;
  v_decision_row
    affiliate_private.affiliate_revolut_return_decisions%rowtype;
  v_debit_account text;
  v_entry_kind text;
  v_remaining integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Revolut return decision requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rrv_[0-9a-f]{24}$'
    or v_decision not in ('confirmed', 'quarantined')
    or v_confirmation <> (case v_decision
      when 'confirmed' then 'CONFIRM:' || v_key
      else 'QUARANTINE:' || v_key
    end)
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid Revolut return decision'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  select review.*
  into v_review
  from affiliate_private.affiliate_revolut_return_reviews review
  where review.review_key = v_key
  for update;
  if not found then
    raise exception 'Revolut return review is unavailable'
      using errcode = 'P0002';
  end if;
  if v_actor = v_review.review_actor_pseudonym then
    raise exception 'return review and decision require distinct actors'
      using errcode = '42501';
  end if;

  select observation.*
  into strict v_observation
  from affiliate_private.affiliate_revolut_return_observations observation
  where observation.id = v_review.observation_id;
  select execution.*
  into strict v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = v_review.execution_id
  for update;
  if v_execution.submitted_by_pseudonym is not null
    and v_actor = v_execution.submitted_by_pseudonym
  then
    raise exception
      'transfer submitter and return decision require distinct actors'
      using errcode = '42501';
  end if;
  if v_execution.manual_batch_id is not null then
    select batch.*
    into strict v_batch
    from affiliate_private.affiliate_revolut_manual_batches batch
    where batch.id = v_execution.manual_batch_id;
    if v_batch.submitted_by_pseudonym is not null
      and v_actor = v_batch.submitted_by_pseudonym
    then
      raise exception
        'batch submitter and return decision require distinct actors'
        using errcode = '42501';
    end if;
    if v_observation.return_kind = 'pre_settlement_release'
      and (
        v_batch.status not in (
          'submitted',
          'partially_reconciled',
          'exception'
        )
        or v_batch.submission_hash is null
        or v_batch.submitted_by_pseudonym is null
        or v_batch.submitted_at is null
        or v_execution.submitted_by_pseudonym is null
        or v_execution.submitted_at is null
      )
    then
      raise exception
        'acknowledge and finalize the manual batch before releasing a failed transfer'
        using errcode = 'P0003';
    end if;
  end if;

  select item.*
  into strict v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_execution.payout_item_id
  for update;
  select cycle.*
  into strict v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id
  for update;

  v_confirmation_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-return-decision:v1',
        v_actor,
        v_observation.source_evidence_hash,
        v_review.confirmation_hash,
        v_decision,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );
  select decision.*
  into v_decision_row
  from affiliate_private.affiliate_revolut_return_decisions decision
  where decision.observation_id = v_observation.id;
  if found then
    if v_decision_row.review_id is distinct from v_review.id
      or v_decision_row.decision is distinct from v_decision
      or v_decision_row.decision_actor_pseudonym is distinct from v_actor
      or v_decision_row.confirmation_hash is distinct from
        v_confirmation_hash
      or v_decision_row.justification is distinct from v_justification
    then
      raise exception 'return execution already has another decision'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_return_decided',
      'replayed', true,
      'decision', jsonb_build_object(
        'key', v_decision_row.decision_key,
        'status', v_decision_row.decision,
        'return_kind', v_observation.return_kind
      )
    );
  end if;
  if v_decision = 'confirmed'
    and exists (
      select 1
      from affiliate_private.affiliate_revolut_return_decisions decision
      where decision.execution_id = v_execution.id
        and decision.decision = 'confirmed'
    )
  then
    raise exception 'return execution already has a confirmed resolution'
      using errcode = 'P0003';
  end if;

  if v_decision = 'confirmed' then
    if v_review.conclusion <> 'eligible'
      or v_observation.amount_minor <> v_execution.amount_minor
      or v_observation.currency <> v_execution.currency
      or v_item.amount_minor <> v_execution.amount_minor
      or v_item.currency <> v_execution.currency
      or v_item.allocation_entry_id is null
    then
      raise exception 'Revolut return confirmation guards are incomplete'
        using errcode = 'P0004';
    end if;

    if v_observation.return_kind = 'pre_settlement_release' then
      select allocation.*
      into v_related
      from affiliate_private.affiliate_commission_entries allocation
      where allocation.id = v_item.allocation_entry_id
        and allocation.entry_kind = 'payout_allocation'
        and allocation.account_id = v_item.account_id
        and allocation.amount_minor = v_execution.amount_minor
        and allocation.currency = v_execution.currency
        and allocation.currency_exponent = v_cycle.currency_exponent
      for update;
      if not found
        or v_item.status <> 'submitted'
        or exists (
          select 1
          from affiliate_private.affiliate_commission_entries settlement
          where settlement.entry_kind = 'payout_settlement'
            and settlement.related_entry_id = v_related.id
        )
      then
        raise exception 'payout allocation is no longer releasable'
          using errcode = 'P0004';
      end if;
      v_entry_kind := 'payout_release';
      v_debit_account := 'partner_payout_clearing';
    else
      select settlement.*
      into v_related
      from affiliate_private.affiliate_revolut_manual_decisions decision
      join affiliate_private.affiliate_commission_entries settlement
        on settlement.id = decision.settlement_entry_id
      where decision.execution_id = v_execution.id
        and decision.decision = 'confirmed'
        and settlement.entry_kind = 'payout_settlement'
        and settlement.account_id = v_item.account_id
        and settlement.amount_minor = v_execution.amount_minor
        and settlement.currency = v_execution.currency
        and settlement.currency_exponent = v_cycle.currency_exponent
      for update of settlement;
      if not found or v_item.status <> 'settled' then
        raise exception 'confirmed payout settlement is unavailable'
          using errcode = 'P0004';
      end if;
      v_entry_kind := 'payout_return';
      v_debit_account := 'partner_cash_settled';
    end if;

    insert into affiliate_private.affiliate_commission_entries (
      account_id,
      entry_kind,
      related_entry_id,
      currency,
      currency_exponent,
      amount_minor
    )
    values (
      v_item.account_id,
      v_entry_kind,
      v_related.id,
      v_execution.currency,
      v_cycle.currency_exponent,
      v_execution.amount_minor
    )
    returning * into v_resolution;

    insert into affiliate_private.affiliate_commission_postings (
      entry_id,
      ledger_account,
      direction,
      amount_minor,
      currency
    )
    values
      (
        v_resolution.id,
        v_debit_account,
        'debit',
        v_execution.amount_minor,
        v_execution.currency
      ),
      (
        v_resolution.id,
        'partner_commission_available',
        'credit',
        v_execution.amount_minor,
        v_execution.currency
      );

    update affiliate_private.affiliate_payout_profiles profile
    set status = 'verification_required', updated_at = now()
    where profile.id = v_item.payout_profile_id;

    if v_observation.return_kind = 'pre_settlement_release' then
      update affiliate_private.affiliate_payout_items item
      set status = 'failed', updated_at = now()
      where item.id = v_item.id
        and item.status in ('pending', 'submitted', 'failed');
      if not found then
        raise exception 'payout item is no longer releasable'
          using errcode = 'P0004';
      end if;

      update affiliate_private.affiliate_revolut_payout_executions execution
      set
        reconciliation_status = 'confirmed',
        job_status = 'exception',
        worker_id = null,
        lease_token_hash = null,
        leased_until = null,
        next_attempt_at = now() + interval '100 years',
        last_error_code = 'terminal_release_confirmed',
        updated_at = now()
      where execution.id = v_execution.id;

      perform affiliate_private.refresh_revolut_payout_aggregate(
        v_execution.id
      );
    end if;
  elsif v_review.conclusion <> 'quarantine' then
    raise exception 'quarantined decision requires a quarantine review'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_revolut_return_decisions (
    observation_id,
    review_id,
    execution_id,
    decision,
    decision_actor_pseudonym,
    confirmation_hash,
    justification,
    resolution_entry_id
  )
  values (
    v_observation.id,
    v_review.id,
    v_execution.id,
    v_decision,
    v_actor,
    v_confirmation_hash,
    v_justification,
    v_resolution.id
  )
  returning * into v_decision_row;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_execution.execution_key,
    case v_decision
      when 'confirmed' then 'revolut_return_confirmed'
      else 'revolut_return_quarantined'
    end,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'observation_key', v_observation.observation_key,
      'return_kind', v_observation.return_kind,
      'provider_state', v_observation.provider_state,
      'decision', v_decision,
      'amount_minor', v_observation.amount_minor,
      'currency', v_observation.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_return_decided',
    'replayed', false,
    'decision', jsonb_build_object(
      'key', v_decision_row.decision_key,
      'status', v_decision_row.decision,
      'return_kind', v_observation.return_kind
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_return_queue(
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_total bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if v_status not in (
    'all',
    'pending',
    'reviewed',
    'confirmed',
    'quarantined'
  ) then
    raise exception 'invalid return queue status'
      using errcode = '22023';
  end if;

  select count(*)
  into v_total
  from affiliate_private.affiliate_revolut_return_observations observation
  left join affiliate_private.affiliate_revolut_return_reviews review
    on review.observation_id = observation.id
  left join affiliate_private.affiliate_revolut_return_decisions decision
    on decision.observation_id = observation.id
  where v_status = 'all'
    or case
      when decision.decision is not null then decision.decision
      when review.id is not null then 'reviewed'
      else 'pending'
    end = v_status;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'observation_key', rows.observation_key,
        'execution_key', rows.execution_key,
        'reference', rows.payout_reference,
        'adapter', rows.adapter,
        'destination_masked', rows.destination_masked,
        'return_kind', rows.return_kind,
        'provider_state', rows.provider_state,
        'amount_minor', rows.amount_minor,
        'currency', rows.currency,
        'observed_at', rows.observed_at,
        'status', rows.effective_status,
        'review_key', rows.review_key,
        'review_conclusion', rows.review_conclusion
      )
      order by rows.observed_at desc, rows.observation_key
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      observation.*,
      execution.execution_key,
      execution.payout_reference,
      execution.adapter,
      execution.destination_masked,
      review.review_key,
      review.conclusion as review_conclusion,
      case
        when decision.decision is not null then decision.decision
        when review.id is not null then 'reviewed'
        else 'pending'
      end as effective_status
    from affiliate_private.affiliate_revolut_return_observations observation
    join affiliate_private.affiliate_revolut_payout_executions execution
      on execution.id = observation.execution_id
    left join affiliate_private.affiliate_revolut_return_reviews review
      on review.observation_id = observation.id
    left join affiliate_private.affiliate_revolut_return_decisions decision
      on decision.observation_id = observation.id
    where v_status = 'all'
      or case
        when decision.decision is not null then decision.decision
        when review.id is not null then 'reviewed'
        else 'pending'
      end = v_status
    order by observation.observed_at desc, observation.observation_key
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

create or replace function
public.admin_partners_revolut_return_review(
  p_observation_key text,
  p_conclusion text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_return_review(
    p_observation_key,
    p_conclusion,
    p_confirmation,
    p_justification
  );
$$;

create or replace function
public.admin_partners_revolut_return_decide(
  p_review_key text,
  p_decision text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_return_decide(
    p_review_key,
    p_decision,
    p_confirmation,
    p_justification
  );
$$;

create or replace function
public.admin_partners_revolut_return_queue(
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default 'all'
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_revolut_return_queue(
    p_limit,
    p_offset,
    p_status
  );
$$;

revoke all on function
  affiliate_private.guard_revolut_return_decision()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.record_revolut_return_observation(
    uuid, text, uuid, text, text, timestamptz
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.assert_revolut_payout_resolution_semantics()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_revolut_return_review(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_return_review(
    text, text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_return_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_return_decide(
    text, text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_return_queue(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_return_queue(
    integer, integer, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_return_review(text, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_return_review(text, text, text, text)
to authenticated;
revoke all on function
  public.admin_partners_revolut_return_decide(text, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_return_decide(text, text, text, text)
to authenticated;
revoke all on function
  public.admin_partners_revolut_return_queue(integer, integer, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_return_queue(integer, integer, text)
to authenticated;

comment on table
  affiliate_private.affiliate_revolut_return_observations is
  'Append-only exact terminal provider evidence; post-settlement returns never rewrite the confirmed payout projection.';
comment on table affiliate_private.affiliate_revolut_return_decisions is
  'Maker-checker Finance decisions posting one idempotent payout release or return counter-entry.';

create or replace function
affiliate_private.refresh_revolut_payout_aggregate(
  p_execution_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_active integer;
  v_settled integer;
  v_failed integer;
begin
  select execution.*
  into v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = p_execution_id;
  if not found then
    raise exception 'Revolut execution is unavailable'
      using errcode = 'P0002';
  end if;
  select item.*
  into strict v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_execution.payout_item_id;
  select cycle.*
  into strict v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_item.cycle_id
  for update;

  select
    count(*) filter (
      where item.status in ('pending', 'submitted')
    )::integer,
    count(*) filter (where item.status = 'settled')::integer,
    count(*) filter (
      where item.status in ('failed', 'reversed')
    )::integer
  into v_active, v_settled, v_failed
  from affiliate_private.affiliate_payout_items item
  where item.cycle_id = v_cycle.id;

  if v_active = 0 and v_failed > 0 then
    update affiliate_private.affiliate_payout_cycles cycle
    set status = 'failed', updated_at = now()
    where cycle.id = v_cycle.id
      and cycle.status in ('approved', 'submitted');
    if v_execution.manual_batch_id is not null then
      update affiliate_private.affiliate_revolut_manual_batches batch
      set status = 'exception', updated_at = now()
      where batch.id = v_execution.manual_batch_id
        and batch.status not in ('settled', 'cancelled', 'exception')
        and batch.submission_hash is not null;
    end if;
  elsif v_active > 0
    and v_settled > 0
    and v_execution.manual_batch_id is not null
  then
    update affiliate_private.affiliate_revolut_manual_batches batch
    set status = 'partially_reconciled', updated_at = now()
    where batch.id = v_execution.manual_batch_id
      and batch.status in ('submitted', 'exception');
  end if;
end;
$$;

create table affiliate_private.affiliate_revolut_manual_cancellations (
  id                       uuid primary key default gen_random_uuid(),
  cancellation_key         text not null unique default (
    'rmc_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  manual_batch_id          uuid not null unique
    references affiliate_private.affiliate_revolut_manual_batches(id)
    on delete restrict,
  cycle_id                 uuid not null unique
    references affiliate_private.affiliate_payout_cycles(id)
    on delete restrict,
  status                   text not null default 'pending',
  reference_set_hash       text not null,
  request_search_evidence_hash text not null,
  request_search_observed_at timestamptz not null,
  approval_search_evidence_hash text,
  approval_search_observed_at timestamptz,
  requested_by_pseudonym   text not null,
  approved_by_pseudonym    text,
  request_confirmation_hash text not null,
  approval_confirmation_hash text,
  request_justification    text not null,
  approval_justification   text,
  released_minor           bigint not null default 0,
  released_item_count      integer not null default 0,
  requested_at             timestamptz not null default now(),
  approved_at              timestamptz,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_manual_cancellations_key
    check (cancellation_key ~ '^rmc_[0-9a-f]{24}$'),
  constraint affiliate_revolut_manual_cancellations_hashes
    check (
      reference_set_hash ~ '^[0-9a-f]{64}$'
      and request_search_evidence_hash ~ '^[0-9a-f]{64}$'
      and (
        approval_search_evidence_hash is null
        or approval_search_evidence_hash ~ '^[0-9a-f]{64}$'
      )
      and requested_by_pseudonym ~ '^[0-9a-f]{64}$'
      and request_confirmation_hash ~ '^[0-9a-f]{64}$'
      and (
        approved_by_pseudonym is null
        or approved_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
      and (
        approval_confirmation_hash is null
        or approval_confirmation_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_manual_cancellations_justification
    check (
      length(btrim(request_justification)) between 12 and 1000
      and (
        approval_justification is null
        or length(btrim(approval_justification)) between 12 and 1000
      )
    ),
  constraint affiliate_revolut_manual_cancellations_lifecycle
    check (
      status in ('pending', 'confirmed', 'rejected')
      and request_search_observed_at
        between requested_at - interval '3 minutes'
          and requested_at + interval '30 seconds'
      and (
        (
          status = 'pending'
          and approved_by_pseudonym is null
          and approval_search_evidence_hash is null
          and approval_search_observed_at is null
          and approval_confirmation_hash is null
          and approval_justification is null
          and released_minor = 0
          and released_item_count = 0
          and approved_at is null
        )
        or (
          status = 'confirmed'
          and approved_by_pseudonym is not null
          and approved_by_pseudonym <> requested_by_pseudonym
          and approval_search_evidence_hash is not null
          and approval_search_evidence_hash <>
            request_search_evidence_hash
          and approval_search_observed_at is not null
          and approval_search_observed_at >
            request_search_observed_at
          and approval_confirmation_hash is not null
          and approval_justification is not null
          and released_minor between 1 and 9007199254740991
          and released_item_count between 1 and 5000
          and approved_at is not null
          and approved_at >= requested_at
          and approval_search_observed_at
            between approved_at - interval '3 minutes'
              and approved_at + interval '30 seconds'
        )
        or (
          status = 'rejected'
          and approved_by_pseudonym is not null
          and approved_by_pseudonym <> requested_by_pseudonym
          and approval_search_evidence_hash is null
          and approval_search_observed_at is null
          and approval_confirmation_hash is not null
          and approval_justification is not null
          and released_minor = 0
          and released_item_count = 0
          and approved_at is not null
          and approved_at >= requested_at
        )
      )
    )
);

alter table affiliate_private.affiliate_revolut_manual_cancellations
  enable row level security;
revoke all on table
  affiliate_private.affiliate_revolut_manual_cancellations
from public, anon, authenticated, service_role;
create or replace function
affiliate_private.guard_revolut_manual_cancellation_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'pending'
    or new.status not in ('confirmed', 'rejected')
    or new.id is distinct from old.id
    or new.cancellation_key is distinct from old.cancellation_key
    or new.manual_batch_id is distinct from old.manual_batch_id
    or new.cycle_id is distinct from old.cycle_id
    or new.reference_set_hash is distinct from old.reference_set_hash
    or new.request_search_evidence_hash is distinct from
      old.request_search_evidence_hash
    or new.request_search_observed_at is distinct from
      old.request_search_observed_at
    or new.requested_by_pseudonym is distinct from
      old.requested_by_pseudonym
    or new.request_confirmation_hash is distinct from
      old.request_confirmation_hash
    or new.request_justification is distinct from
      old.request_justification
    or new.requested_at is distinct from old.requested_at
    or (
      new.status = 'confirmed'
      and (
        new.approved_by_pseudonym is null
        or new.approved_by_pseudonym = old.requested_by_pseudonym
        or new.approval_search_evidence_hash is null
        or new.approval_search_evidence_hash =
          old.request_search_evidence_hash
        or new.approval_search_observed_at is null
        or new.approval_search_observed_at <=
          old.request_search_observed_at
        or new.approval_confirmation_hash is null
        or new.approval_justification is null
        or new.released_minor < 1
        or new.released_item_count < 1
        or new.approved_at is null
      )
    )
    or (
      new.status = 'rejected'
      and (
        new.approved_by_pseudonym is null
        or new.approved_by_pseudonym = old.requested_by_pseudonym
        or new.approval_search_evidence_hash is not null
        or new.approval_search_observed_at is not null
        or new.approval_confirmation_hash is null
        or new.approval_justification is null
        or new.released_minor <> 0
        or new.released_item_count <> 0
        or new.approved_at is null
      )
    )
  then
    raise exception 'invalid manual cancellation transition'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger affiliate_revolut_manual_cancellations_transition_guard
before update
on affiliate_private.affiliate_revolut_manual_cancellations
for each row execute function
  affiliate_private.guard_revolut_manual_cancellation_transition();
create trigger affiliate_revolut_manual_cancellations_delete_guard
before delete
on affiliate_private.affiliate_revolut_manual_cancellations
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();

create or replace function
affiliate_private.admin_partners_revolut_manual_batch_cancel(
  p_batch_key text,
  p_reference_set_hash text,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_batch_key, '')));
  v_reference_set_hash text :=
    lower(btrim(coalesce(p_reference_set_hash, '')));
  v_search_hash text :=
    lower(btrim(coalesce(p_provider_search_evidence_hash, '')));
  v_search_observed_at timestamptz :=
    date_trunc('second', p_provider_search_observed_at);
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_request_hash text;
  v_approval_hash text;
  v_manifest_hash text;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_cancellation
    affiliate_private.affiliate_revolut_manual_cancellations%rowtype;
  v_row record;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_released_minor bigint := 0;
  v_released_count integer := 0;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual payout cancellation requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rmb_[0-9a-f]{24}$'
    or v_reference_set_hash !~ '^[0-9a-f]{64}$'
    or v_search_hash !~ '^[0-9a-f]{64}$'
    or v_search_observed_at is null
    or v_search_observed_at < clock_timestamp() - interval '2 minutes'
    or v_search_observed_at > clock_timestamp() + interval '30 seconds'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual payout cancellation'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-manual-batch:' || v_key,
      0
    )
  );
  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.batch_key = v_key
  for update;
  if not found then
    raise exception 'manual payout batch is unavailable'
      using errcode = 'P0002';
  end if;

  v_manifest_hash :=
    affiliate_private.revolut_manual_batch_manifest_hash(v_batch.id);
  if v_manifest_hash is null
    or v_reference_set_hash is distinct from v_manifest_hash
  then
    raise exception
      'cancellation reference set must match the canonical batch manifest'
      using errcode = 'P0005';
  end if;
  if v_batch.status not in ('prepared', 'exported', 'cancelled')
    or (
      v_batch.status in ('prepared', 'exported')
      and exists (
      select 1
      from affiliate_private.affiliate_revolut_payout_executions execution
      where execution.manual_batch_id = v_batch.id
        and (
          execution.provider_transaction_hash is not null
          or execution.submitted_at is not null
          or execution.submitted_by_pseudonym is not null
          or execution.state not in (
            'prepared',
            'exported',
            'cancelled'
          )
          or execution.reconciliation_status <> 'not_ready'
        )
      )
    )
  then
    raise exception
      'only a never-submitted manual batch can be cancelled'
      using errcode = 'P0003';
  end if;
  if v_batch.exported_at is not null
    and clock_timestamp() < v_batch.exported_at + interval '7 days'
  then
    raise exception
      'exported manual batches require a seven-day Revolut search window'
      using errcode = 'P0003',
        detail = 'eligible_at='
          || (v_batch.exported_at + interval '7 days')::text;
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  select cancellation.*
  into v_cancellation
  from affiliate_private.affiliate_revolut_manual_cancellations
    cancellation
  where cancellation.manual_batch_id = v_batch.id
  for update;

  if not found then
    if v_batch.status not in ('prepared', 'exported')
      or v_confirmation <> concat_ws(
        ':',
        'REQUEST-CANCEL',
        v_key,
        v_reference_set_hash,
        v_search_hash,
        floor(extract(epoch from v_search_observed_at))::bigint::text
      )
    then
      raise exception 'invalid manual payout cancellation request'
        using errcode = '22023';
    end if;
    v_request_hash := encode(
      extensions.digest(
        concat_ws(
          ':',
          'norva:partners:revolut-manual-cancel-request:v1',
          v_actor,
          v_batch.batch_key,
          v_reference_set_hash,
          v_search_hash,
          v_confirmation,
          v_justification
        ),
        'sha256'
      ),
      'hex'
    );
    insert into affiliate_private.affiliate_revolut_manual_cancellations (
      manual_batch_id,
      cycle_id,
      reference_set_hash,
      request_search_evidence_hash,
      request_search_observed_at,
      requested_by_pseudonym,
      request_confirmation_hash,
      request_justification
    )
    values (
      v_batch.id,
      v_batch.cycle_id,
      v_reference_set_hash,
      v_search_hash,
      v_search_observed_at,
      v_actor,
      v_request_hash,
      v_justification
    )
    returning * into v_cancellation;

    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'payout',
      v_batch.batch_key,
      'revolut_manual_batch_cancellation_requested',
      'admin',
      v_actor,
      v_justification,
      jsonb_build_object(
        'cancellation_key', v_cancellation.cancellation_key,
        'status', v_cancellation.status,
        'reference_set_hash', v_reference_set_hash,
        'request_search_evidence_hash', v_search_hash,
        'request_search_observed_at', v_search_observed_at
      )
    );

    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_batch_cancellation_requested',
      'replayed', false,
      'cancellation', jsonb_build_object(
        'key', v_cancellation.cancellation_key,
        'batch_key', v_batch.batch_key,
        'status', v_cancellation.status
      )
    );
  end if;
  if v_cancellation.reference_set_hash is distinct from
      v_reference_set_hash
  then
    raise exception 'cancellation retry conflicts with its reference set'
      using errcode = 'P0005';
  end if;
  if v_cancellation.status = 'pending'
    and v_confirmation = concat_ws(
      ':',
      'REQUEST-CANCEL',
      v_key,
      v_reference_set_hash,
      v_search_hash,
      floor(extract(epoch from v_search_observed_at))::bigint::text
    )
  then
    if v_cancellation.requested_by_pseudonym is distinct from v_actor
      or v_cancellation.request_search_evidence_hash is distinct from
        v_search_hash
      or v_cancellation.request_search_observed_at is distinct from
        v_search_observed_at
      or v_cancellation.request_justification is distinct from
        v_justification
    then
      raise exception 'cancellation request retry conflicts with evidence'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_batch_cancellation_requested',
      'replayed', true,
      'cancellation', jsonb_build_object(
        'key', v_cancellation.cancellation_key,
        'batch_key', v_batch.batch_key,
        'status', v_cancellation.status
      )
    );
  end if;
  if v_confirmation <>
      concat_ws(
        ':',
        'CONFIRM-CANCEL',
        v_cancellation.cancellation_key,
        v_search_hash,
        floor(extract(epoch from v_search_observed_at))::bigint::text
      )
  then
    raise exception 'invalid manual payout cancellation approval'
      using errcode = '22023';
  end if;
  v_approval_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-manual-cancel-approval:v1',
        v_actor,
        v_cancellation.cancellation_key,
        v_cancellation.request_confirmation_hash,
        v_search_hash,
        floor(extract(epoch from v_search_observed_at))::bigint::text,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );
  if v_cancellation.status = 'confirmed' then
    if v_cancellation.approved_by_pseudonym is distinct from v_actor
      or v_cancellation.approval_confirmation_hash is distinct from
        v_approval_hash
      or v_cancellation.approval_search_evidence_hash is distinct from
        v_search_hash
      or v_cancellation.approval_search_observed_at is distinct from
        v_search_observed_at
      or v_cancellation.approval_justification is distinct from
        v_justification
    then
      raise exception 'cancellation retry conflicts with its approval'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_batch_cancelled',
      'replayed', true,
      'batch', jsonb_build_object(
        'key', v_batch.batch_key,
        'status', 'cancelled',
        'released_minor', v_cancellation.released_minor,
        'released_item_count', v_cancellation.released_item_count
      )
    );
  end if;
  if v_actor = v_cancellation.requested_by_pseudonym then
    raise exception
      'cancellation maker and checker require distinct Finance actors'
      using errcode = '42501';
  end if;
  if v_search_hash = v_cancellation.request_search_evidence_hash
    or v_search_observed_at <=
      v_cancellation.request_search_observed_at
  then
    raise exception
      'checker requires a distinct, newer exact Revolut search'
      using errcode = 'P0004';
  end if;
  if v_batch.status not in ('prepared', 'exported') then
    raise exception 'manual payout batch changed during cancellation'
      using errcode = 'P0004';
  end if;

  for v_row in
    select
      execution.id as execution_id,
      item.id as item_id,
      item.account_id,
      item.allocation_entry_id,
      item.amount_minor,
      item.currency,
      cycle.currency_exponent
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
      and item.status = 'pending'
    join affiliate_private.affiliate_payout_cycles cycle
      on cycle.id = item.cycle_id
      and cycle.id = v_batch.cycle_id
      and cycle.status = 'approved'
    join affiliate_private.affiliate_commission_entries allocation
      on allocation.id = item.allocation_entry_id
      and allocation.entry_kind = 'payout_allocation'
      and allocation.account_id = item.account_id
      and allocation.amount_minor = item.amount_minor
      and allocation.currency = item.currency
      and allocation.currency_exponent = cycle.currency_exponent
    where execution.manual_batch_id = v_batch.id
    order by execution.id
    for update of execution, item, cycle, allocation
  loop
    insert into affiliate_private.affiliate_commission_entries (
      account_id,
      entry_kind,
      related_entry_id,
      currency,
      currency_exponent,
      amount_minor
    )
    values (
      v_row.account_id,
      'payout_release',
      v_row.allocation_entry_id,
      v_row.currency,
      v_row.currency_exponent,
      v_row.amount_minor
    )
    returning * into v_entry;

    insert into affiliate_private.affiliate_commission_postings (
      entry_id,
      ledger_account,
      direction,
      amount_minor,
      currency
    )
    values
      (
        v_entry.id,
        'partner_payout_clearing',
        'debit',
        v_row.amount_minor,
        v_row.currency
      ),
      (
        v_entry.id,
        'partner_commission_available',
        'credit',
        v_row.amount_minor,
        v_row.currency
      );

    update affiliate_private.affiliate_payout_items item
    set status = 'failed', updated_at = now()
    where item.id = v_row.item_id;
    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      state = 'cancelled',
      reconciliation_status = 'confirmed',
      job_status = 'exception',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + interval '100 years',
      last_error_code = 'operator_cancelled_before_submission',
      updated_at = now()
    where execution.id = v_row.execution_id;

    v_released_minor := v_released_minor + v_row.amount_minor;
    v_released_count := v_released_count + 1;
  end loop;

  if v_released_count <> v_batch.item_count
    or v_released_minor <> v_batch.total_minor
  then
    raise exception 'manual payout cancellation snapshot is incomplete'
      using errcode = 'P0004';
  end if;

  update affiliate_private.affiliate_revolut_manual_batches batch
  set status = 'cancelled', updated_at = now()
  where batch.id = v_batch.id
    and batch.status in ('prepared', 'exported');
  if not found then
    raise exception 'manual payout batch changed during cancellation'
      using errcode = 'P0004';
  end if;
  update affiliate_private.affiliate_payout_cycles cycle
  set status = 'failed', updated_at = now()
  where cycle.id = v_batch.cycle_id
    and cycle.status = 'approved';
  if not found then
    raise exception 'payout cycle changed during cancellation'
      using errcode = 'P0004';
  end if;

  update affiliate_private.affiliate_revolut_manual_cancellations
    cancellation
  set
    status = 'confirmed',
    approved_by_pseudonym = v_actor,
    approval_search_evidence_hash = v_search_hash,
    approval_search_observed_at = v_search_observed_at,
    approval_confirmation_hash = v_approval_hash,
    approval_justification = v_justification,
    released_minor = v_released_minor,
    released_item_count = v_released_count,
    approved_at = now()
  where cancellation.id = v_cancellation.id
    and cancellation.status = 'pending'
  returning * into v_cancellation;
  if not found then
    raise exception 'manual cancellation changed during approval'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_batch.batch_key,
    'revolut_manual_batch_cancelled',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'status', 'cancelled',
      'cancellation_key', v_cancellation.cancellation_key,
      'reference_set_hash', v_reference_set_hash,
      'request_search_evidence_hash',
        v_cancellation.request_search_evidence_hash,
      'approval_search_evidence_hash', v_search_hash,
      'released_minor', v_released_minor,
      'released_item_count', v_released_count,
      'currency', v_batch.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_manual_batch_cancelled',
    'replayed', false,
    'batch', jsonb_build_object(
      'key', v_batch.batch_key,
      'status', 'cancelled',
      'released_minor', v_released_minor,
      'released_item_count', v_released_count
    )
  );
end;
$$;

create or replace function
public.admin_partners_revolut_manual_batch_cancel(
  p_batch_key text,
  p_reference_set_hash text,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_batch_cancel(
      p_batch_key,
      p_reference_set_hash,
      p_provider_search_evidence_hash,
      p_provider_search_observed_at,
      p_confirmation,
      p_justification
    );
$$;

revoke all on function
  affiliate_private.admin_partners_revolut_manual_batch_cancel(
    text, text, text, timestamptz, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_manual_batch_cancel(
    text, text, text, timestamptz, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_manual_batch_cancel(
    text, text, text, timestamptz, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_manual_batch_cancel(
    text, text, text, timestamptz, text, text
  )
to authenticated;

comment on table
  affiliate_private.affiliate_revolut_manual_cancellations is
  'Maker-checker Finance evidence for releasing a never-submitted Revolut Basic batch after an exact all-reference search in Revolut.';

create table
affiliate_private.affiliate_revolut_manual_unmapped_requests (
  id                       uuid primary key default gen_random_uuid(),
  request_key              text not null unique default (
    'ruq_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  manual_batch_id          uuid not null
    references affiliate_private.affiliate_revolut_manual_batches(id)
    on delete restrict,
  status                   text not null default 'pending',
  reference_set_hash       text not null,
  references_snapshot      jsonb not null,
  request_search_evidence_hash text not null,
  request_search_observed_at timestamptz not null,
  approval_search_evidence_hash text,
  approval_search_observed_at timestamptz,
  requested_by_pseudonym   text not null,
  approved_by_pseudonym    text,
  request_confirmation_hash text not null,
  approval_confirmation_hash text,
  request_justification    text not null,
  approval_justification   text,
  reference_count          integer not null,
  released_count           integer not null default 0,
  requested_at             timestamptz not null default now(),
  approved_at              timestamptz,
  constraint affiliate_revolut_unmapped_requests_key
    check (request_key ~ '^ruq_[0-9a-f]{24}$'),
  constraint affiliate_revolut_unmapped_requests_hashes
    check (
      reference_set_hash ~ '^[0-9a-f]{64}$'
      and request_search_evidence_hash ~ '^[0-9a-f]{64}$'
      and (
        approval_search_evidence_hash is null
        or approval_search_evidence_hash ~ '^[0-9a-f]{64}$'
      )
      and requested_by_pseudonym ~ '^[0-9a-f]{64}$'
      and request_confirmation_hash ~ '^[0-9a-f]{64}$'
      and (
        approved_by_pseudonym is null
        or approved_by_pseudonym ~ '^[0-9a-f]{64}$'
      )
      and (
        approval_confirmation_hash is null
        or approval_confirmation_hash ~ '^[0-9a-f]{64}$'
      )
    ),
  constraint affiliate_revolut_unmapped_requests_lifecycle
    check (
      status in ('pending', 'confirmed', 'rejected')
      and reference_count between 1 and 5000
      and jsonb_typeof(references_snapshot) = 'array'
      and jsonb_array_length(references_snapshot) = reference_count
      and request_search_observed_at
        between requested_at - interval '3 minutes'
          and requested_at + interval '30 seconds'
      and length(btrim(request_justification)) between 12 and 1000
      and (
        (
          status = 'pending'
          and approved_by_pseudonym is null
          and approval_search_evidence_hash is null
          and approval_search_observed_at is null
          and approval_confirmation_hash is null
          and approval_justification is null
          and released_count = 0
          and approved_at is null
        )
        or (
          status = 'confirmed'
          and approved_by_pseudonym is not null
          and approved_by_pseudonym <> requested_by_pseudonym
          and approval_search_evidence_hash is not null
          and approval_search_evidence_hash <>
            request_search_evidence_hash
          and approval_search_observed_at is not null
          and approval_search_observed_at >
            request_search_observed_at
          and approval_confirmation_hash is not null
          and length(btrim(approval_justification))
            between 12 and 1000
          and released_count = reference_count
          and approved_at is not null
          and approved_at >= requested_at
          and approval_search_observed_at
            between approved_at - interval '3 minutes'
              and approved_at + interval '30 seconds'
        )
        or (
          status = 'rejected'
          and approved_by_pseudonym is not null
          and approved_by_pseudonym <> requested_by_pseudonym
          and approval_search_evidence_hash is null
          and approval_search_observed_at is null
          and approval_confirmation_hash is not null
          and length(btrim(approval_justification))
            between 12 and 1000
          and released_count = 0
          and approved_at is not null
          and approved_at >= requested_at
        )
      )
    ),
  unique (manual_batch_id, reference_set_hash)
);

create table
affiliate_private.affiliate_revolut_manual_unmapped_releases (
  id                       uuid primary key default gen_random_uuid(),
  release_key              text not null unique default (
    'rur_' || left(encode(extensions.gen_random_bytes(16), 'hex'), 24)
  ),
  manual_batch_id          uuid not null
    references affiliate_private.affiliate_revolut_manual_batches(id)
    on delete restrict,
  request_id               uuid not null
    references
      affiliate_private.affiliate_revolut_manual_unmapped_requests(id)
    on delete restrict,
  execution_id             uuid not null unique
    references affiliate_private.affiliate_revolut_payout_executions(id)
    on delete restrict,
  resolution_entry_id      uuid not null unique
    references affiliate_private.affiliate_commission_entries(id)
    on delete restrict,
  released_by_pseudonym    text not null,
  confirmation_hash        text not null,
  justification            text not null,
  created_at               timestamptz not null default now(),
  constraint affiliate_revolut_manual_unmapped_releases_key
    check (release_key ~ '^rur_[0-9a-f]{24}$'),
  constraint affiliate_revolut_manual_unmapped_releases_hashes
    check (
      released_by_pseudonym ~ '^[0-9a-f]{64}$'
      and confirmation_hash ~ '^[0-9a-f]{64}$'
    ),
  constraint affiliate_revolut_manual_unmapped_releases_justification
    check (length(btrim(justification)) between 12 and 1000)
);

alter table
  affiliate_private.affiliate_revolut_manual_unmapped_requests
  enable row level security;
alter table
  affiliate_private.affiliate_revolut_manual_unmapped_releases
  enable row level security;
revoke all on table
  affiliate_private.affiliate_revolut_manual_unmapped_requests,
  affiliate_private.affiliate_revolut_manual_unmapped_releases
from public, anon, authenticated, service_role;
create trigger affiliate_revolut_manual_unmapped_releases_append_only
before update or delete
on affiliate_private.affiliate_revolut_manual_unmapped_releases
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();

create or replace function
affiliate_private.guard_revolut_unmapped_request_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'pending'
    or new.status not in ('confirmed', 'rejected')
    or new.id is distinct from old.id
    or new.request_key is distinct from old.request_key
    or new.manual_batch_id is distinct from old.manual_batch_id
    or new.reference_set_hash is distinct from old.reference_set_hash
    or new.references_snapshot is distinct from old.references_snapshot
    or new.request_search_evidence_hash is distinct from
      old.request_search_evidence_hash
    or new.request_search_observed_at is distinct from
      old.request_search_observed_at
    or new.requested_by_pseudonym is distinct from
      old.requested_by_pseudonym
    or new.request_confirmation_hash is distinct from
      old.request_confirmation_hash
    or new.request_justification is distinct from
      old.request_justification
    or new.reference_count is distinct from old.reference_count
    or new.requested_at is distinct from old.requested_at
    or (
      new.status = 'confirmed'
      and (
        new.approved_by_pseudonym is null
        or new.approved_by_pseudonym = old.requested_by_pseudonym
        or new.approval_search_evidence_hash is null
        or new.approval_search_evidence_hash =
          old.request_search_evidence_hash
        or new.approval_search_observed_at is null
        or new.approval_search_observed_at <=
          old.request_search_observed_at
        or new.approval_confirmation_hash is null
        or new.approval_justification is null
        or new.released_count <> old.reference_count
        or new.approved_at is null
      )
    )
    or (
      new.status = 'rejected'
      and (
        new.approved_by_pseudonym is null
        or new.approved_by_pseudonym = old.requested_by_pseudonym
        or new.approval_search_evidence_hash is not null
        or new.approval_search_observed_at is not null
        or new.approval_confirmation_hash is null
        or new.approval_justification is null
        or new.released_count <> 0
        or new.approved_at is null
      )
    )
  then
    raise exception 'invalid unmapped release request transition'
      using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger affiliate_revolut_unmapped_request_transition_guard
before update
on affiliate_private.affiliate_revolut_manual_unmapped_requests
for each row execute function
  affiliate_private.guard_revolut_unmapped_request_transition();
create trigger affiliate_revolut_unmapped_request_delete_guard
before delete
on affiliate_private.affiliate_revolut_manual_unmapped_requests
for each row execute function
  affiliate_private.reject_revolut_evidence_mutation();

create or replace function
affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(
  p_batch_key text,
  p_references jsonb,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_batch_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_search_hash text :=
    lower(btrim(coalesce(p_provider_search_evidence_hash, '')));
  v_search_observed_at timestamptz :=
    date_trunc('second', p_provider_search_observed_at);
  v_actor text;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_reference_json jsonb;
  v_reference text;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_entry affiliate_private.affiliate_commission_entries%rowtype;
  v_hash text;
  v_reference_set_hash text;
  v_references_snapshot jsonb;
  v_request_hash text;
  v_approval_hash text;
  v_request
    affiliate_private.affiliate_revolut_manual_unmapped_requests%rowtype;
  v_submission_hash text;
  v_input_count integer;
  v_released_count integer := 0;
  v_pending_count integer;
  v_submitted_count integer;
  v_confirmed_count integer;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual unmapped release requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rmb_[0-9a-f]{24}$'
    or jsonb_typeof(p_references) <> 'array'
    or jsonb_array_length(p_references) not between 1 and 5000
    or v_search_hash !~ '^[0-9a-f]{64}$'
    or v_search_observed_at is null
    or v_search_observed_at < clock_timestamp() - interval '2 minutes'
    or v_search_observed_at > clock_timestamp() + interval '30 seconds'
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual unmapped release'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_references) value
    where jsonb_typeof(value) <> 'string'
      or upper(btrim(value #>> '{}')) !~ '^NORVA-[A-F0-9]{12}$'
  ) then
    raise exception 'invalid unmapped payout reference'
      using errcode = '22023';
  end if;
  v_input_count := jsonb_array_length(p_references);
  if (
    select count(distinct upper(btrim(value #>> '{}')))
    from jsonb_array_elements(p_references) value
  ) <> v_input_count then
    raise exception 'unmapped payout references must be unique'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-manual-batch:' || v_key,
      0
    )
  );
  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.batch_key = v_key
  for update;
  if not found
    or v_batch.status not in ('exported', 'partially_submitted')
    or v_batch.submission_hash is not null
  then
    raise exception 'manual batch has no releasable unmapped transfers'
      using errcode = 'P0003';
  end if;
  if v_batch.exported_at is null
    or clock_timestamp() < v_batch.exported_at + interval '7 days'
  then
    raise exception
      'unmapped releases require a seven-day Revolut search window'
      using errcode = 'P0003',
        detail = 'eligible_at='
          || (v_batch.exported_at + interval '7 days')::text;
  end if;
  select cycle.*
  into strict v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_batch.cycle_id
    and cycle.status in ('approved', 'submitted')
  for update;

  select
    count(*)::integer,
    encode(
      extensions.digest(
        concat_ws(
          E'\n',
          'norva:partners:revolut-unmapped-reference-set:v1',
          'batch_key=' || v_batch.batch_key,
          string_agg(
            concat_ws(
              E'\x1f',
              execution.payout_reference,
              execution.amount_minor::text,
              execution.currency,
              execution.currency_exponent::text,
              execution.beneficiary_binding_id::text,
              execution.beneficiary_binding_version::text,
              execution.beneficiary_fingerprint_hmac,
              execution.beneficiary_fingerprint_key_version::text
            ),
            E'\n'
            order by execution.payout_reference
          )
        ),
        'sha256'
      ),
      'hex'
    ),
    jsonb_agg(
      jsonb_build_object(
        'reference', execution.payout_reference,
        'amount_minor', execution.amount_minor,
        'currency', execution.currency,
        'currency_exponent', execution.currency_exponent
      )
      order by execution.payout_reference
    )
  into
    v_confirmed_count,
    v_reference_set_hash,
    v_references_snapshot
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id
    and execution.payout_reference in (
      select upper(btrim(value #>> '{}'))
      from jsonb_array_elements(p_references) value
    );
  if v_confirmed_count <> v_input_count
    or v_reference_set_hash is null
  then
    raise exception 'unmapped payout reference set is incomplete'
      using errcode = 'P0004';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_references) value
    left join affiliate_private.affiliate_revolut_payout_executions
      execution
      on execution.manual_batch_id = v_batch.id
      and execution.payout_reference = upper(btrim(value #>> '{}'))
    left join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    where execution.id is null
      or execution.state <> 'exported'
      or execution.reconciliation_status <> 'not_ready'
      or execution.provider_transaction_hash is not null
      or execution.submitted_by_pseudonym is not null
      or execution.submitted_at is not null
      or item.status <> 'pending'
      or item.provider_transfer_hash is not null
  ) then
    raise exception 'payout reference is no longer unmapped'
      using errcode = 'P0004';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  select request.*
  into v_request
  from affiliate_private.affiliate_revolut_manual_unmapped_requests
    request
  where request.manual_batch_id = v_batch.id
    and request.reference_set_hash = v_reference_set_hash
  for update;
  if not found then
    if v_confirmation <>
        concat_ws(
          ':',
          'REQUEST-RELEASE-UNMAPPED',
          v_key,
          v_search_hash,
          floor(extract(epoch from v_search_observed_at))::bigint::text
        )
    then
      raise exception 'invalid unmapped release request'
        using errcode = '22023';
    end if;
    v_request_hash := encode(
      extensions.digest(
        concat_ws(
          ':',
          'norva:partners:revolut-unmapped-request:v1',
          v_actor,
          v_key,
          v_reference_set_hash,
          v_search_hash,
          v_confirmation,
          v_justification
        ),
        'sha256'
      ),
      'hex'
    );
    insert into
      affiliate_private.affiliate_revolut_manual_unmapped_requests (
        manual_batch_id,
        reference_set_hash,
        references_snapshot,
        request_search_evidence_hash,
        request_search_observed_at,
        requested_by_pseudonym,
        request_confirmation_hash,
        request_justification,
        reference_count
      )
    values (
      v_batch.id,
      v_reference_set_hash,
      v_references_snapshot,
      v_search_hash,
      v_search_observed_at,
      v_actor,
      v_request_hash,
      v_justification,
      v_input_count
    )
    returning * into v_request;

    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'payout',
      v_batch.batch_key,
      'revolut_manual_unmapped_release_requested',
      'admin',
      v_actor,
      v_justification,
      jsonb_build_object(
        'request_key', v_request.request_key,
        'reference_set_hash', v_reference_set_hash,
        'request_search_evidence_hash', v_search_hash,
        'request_search_observed_at', v_search_observed_at,
        'reference_count', v_input_count,
        'status', v_request.status
      )
    );
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_unmapped_release_requested',
      'replayed', false,
      'request', jsonb_build_object(
        'key', v_request.request_key,
        'batch_key', v_batch.batch_key,
        'status', v_request.status,
        'reference_set_hash', v_reference_set_hash,
        'reference_count', v_input_count
      )
    );
  end if;
  if v_request.reference_count <> v_input_count
    or v_request.references_snapshot is distinct from
      v_references_snapshot
  then
    raise exception 'unmapped release retry conflicts with its evidence'
      using errcode = 'P0005';
  end if;
  if v_request.status = 'pending'
    and v_confirmation = concat_ws(
      ':',
      'REQUEST-RELEASE-UNMAPPED',
      v_key,
      v_search_hash,
      floor(extract(epoch from v_search_observed_at))::bigint::text
    )
  then
    if v_request.requested_by_pseudonym is distinct from v_actor
      or v_request.request_search_evidence_hash is distinct from
        v_search_hash
      or v_request.request_search_observed_at is distinct from
        v_search_observed_at
      or v_request.request_justification is distinct from
        v_justification
    then
      raise exception 'unmapped release request retry conflicts'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_unmapped_release_requested',
      'replayed', true,
      'request', jsonb_build_object(
        'key', v_request.request_key,
        'batch_key', v_batch.batch_key,
        'status', v_request.status,
        'reference_set_hash', v_reference_set_hash,
        'reference_count', v_input_count
      )
    );
  end if;
  if v_confirmation <>
      concat_ws(
        ':',
        'CONFIRM-RELEASE-UNMAPPED',
        v_request.request_key,
        v_search_hash,
        floor(extract(epoch from v_search_observed_at))::bigint::text
      )
  then
    raise exception 'invalid unmapped release approval'
      using errcode = '22023';
  end if;
  v_approval_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-unmapped-approval:v1',
        v_actor,
        v_request.request_key,
        v_request.request_confirmation_hash,
        v_search_hash,
        floor(extract(epoch from v_search_observed_at))::bigint::text,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );
  if v_request.status = 'confirmed' then
    if v_request.approved_by_pseudonym is distinct from v_actor
      or v_request.approval_confirmation_hash is distinct from
        v_approval_hash
      or v_request.approval_search_evidence_hash is distinct from
        v_search_hash
      or v_request.approval_search_observed_at is distinct from
        v_search_observed_at
      or v_request.approval_justification is distinct from
        v_justification
    then
      raise exception 'unmapped release retry conflicts with approval'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_unmapped_released',
      'replayed', true,
      'request', jsonb_build_object(
        'key', v_request.request_key,
        'status', v_request.status,
        'released_count', v_request.released_count
      )
    );
  end if;
  if v_actor = v_request.requested_by_pseudonym then
    raise exception
      'unmapped release maker and checker require distinct Finance actors'
      using errcode = '42501';
  end if;
  if v_search_hash = v_request.request_search_evidence_hash
    or v_search_observed_at <= v_request.request_search_observed_at
  then
    raise exception
      'checker requires a distinct, newer exact Revolut search'
      using errcode = 'P0004';
  end if;

  for v_reference_json in
    select value
    from jsonb_array_elements(p_references) value
  loop
    v_reference := upper(btrim(v_reference_json #>> '{}'));
    select execution.*
    into v_execution
    from affiliate_private.affiliate_revolut_payout_executions execution
    where execution.manual_batch_id = v_batch.id
      and execution.payout_reference = v_reference
    for update;
    if not found
      or v_execution.state <> 'exported'
      or v_execution.reconciliation_status <> 'not_ready'
      or v_execution.provider_transaction_hash is not null
      or v_execution.submitted_by_pseudonym is not null
      or v_execution.submitted_at is not null
    then
      raise exception 'payout reference is no longer unmapped'
        using errcode = 'P0004';
    end if;
    select item.*
    into v_item
    from affiliate_private.affiliate_payout_items item
    where item.id = v_execution.payout_item_id
      and item.status = 'pending'
      and item.provider_transfer_hash is null
    for update;
    if not found then
      raise exception 'unmapped payout item is unavailable'
        using errcode = 'P0004';
    end if;

    insert into affiliate_private.affiliate_commission_entries (
      account_id,
      entry_kind,
      related_entry_id,
      currency,
      currency_exponent,
      amount_minor
    )
    select
      v_item.account_id,
      'payout_release',
      allocation.id,
      allocation.currency,
      allocation.currency_exponent,
      allocation.amount_minor
    from affiliate_private.affiliate_commission_entries allocation
    where allocation.id = v_item.allocation_entry_id
      and allocation.entry_kind = 'payout_allocation'
      and allocation.account_id = v_item.account_id
      and allocation.amount_minor = v_item.amount_minor
      and allocation.currency = v_item.currency
      and allocation.currency_exponent = v_cycle.currency_exponent
    returning * into v_entry;
    if not found then
      raise exception 'unmapped payout allocation is unavailable'
        using errcode = 'P0004';
    end if;

    insert into affiliate_private.affiliate_commission_postings (
      entry_id,
      ledger_account,
      direction,
      amount_minor,
      currency
    )
    values
      (
        v_entry.id,
        'partner_payout_clearing',
        'debit',
        v_entry.amount_minor,
        v_entry.currency
      ),
      (
        v_entry.id,
        'partner_commission_available',
        'credit',
        v_entry.amount_minor,
        v_entry.currency
      );

    update affiliate_private.affiliate_payout_items item
    set status = 'failed', updated_at = now()
    where item.id = v_item.id;
    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      state = 'cancelled',
      reconciliation_status = 'confirmed',
      job_status = 'exception',
      worker_id = null,
      lease_token_hash = null,
      leased_until = null,
      next_attempt_at = now() + interval '100 years',
      last_error_code = 'unmapped_transfer_released',
      updated_at = now()
    where execution.id = v_execution.id;

    v_hash := encode(
      extensions.digest(
        concat_ws(
          ':',
          'norva:partners:revolut-unmapped-release:v1',
          v_actor,
          v_batch.batch_key,
          v_execution.payout_reference,
          v_confirmation,
          v_justification
        ),
        'sha256'
      ),
      'hex'
    );
    insert into
      affiliate_private.affiliate_revolut_manual_unmapped_releases (
        manual_batch_id,
        request_id,
        execution_id,
        resolution_entry_id,
        released_by_pseudonym,
        confirmation_hash,
        justification
      )
    values (
      v_batch.id,
      v_request.id,
      v_execution.id,
      v_entry.id,
      v_actor,
      v_hash,
      v_justification
    );
    v_released_count := v_released_count + 1;
  end loop;

  select
    count(*) filter (
      where item.status = 'pending'
    )::integer,
    count(*) filter (
      where item.status = 'submitted'
    )::integer,
    count(*) filter (
      where item.status = 'submitted'
        and execution.submitted_by_pseudonym is not null
    )::integer
  into v_pending_count, v_submitted_count, v_confirmed_count
  from affiliate_private.affiliate_revolut_payout_executions execution
  join affiliate_private.affiliate_payout_items item
    on item.id = execution.payout_item_id
  where execution.manual_batch_id = v_batch.id;

  if v_pending_count = 0 and v_submitted_count = 0 then
    update affiliate_private.affiliate_revolut_manual_batches batch
    set status = 'cancelled', updated_at = now()
    where batch.id = v_batch.id;
    update affiliate_private.affiliate_payout_cycles cycle
    set status = 'failed', updated_at = now()
    where cycle.id = v_cycle.id
      and cycle.status in ('approved', 'submitted');
  elsif v_pending_count = 0
    and v_submitted_count = v_confirmed_count
  then
    select encode(
      extensions.digest(
        string_agg(
          execution.payout_reference
            || ':'
            || case
              when exists (
                select 1
                from affiliate_private.affiliate_commission_entries release
                where release.entry_kind = 'payout_release'
                  and release.related_entry_id =
                    item.allocation_entry_id
              ) then 'RELEASED'
              else 'ENTERED'
            end,
          ','
          order by execution.payout_reference
        ),
        'sha256'
      ),
      'hex'
    )
    into v_submission_hash
    from affiliate_private.affiliate_revolut_payout_executions execution
    join affiliate_private.affiliate_payout_items item
      on item.id = execution.payout_item_id
    where execution.manual_batch_id = v_batch.id
      and (
        execution.submitted_by_pseudonym is not null
        or exists (
          select 1
          from affiliate_private.affiliate_commission_entries release
          where release.entry_kind = 'payout_release'
            and release.related_entry_id = item.allocation_entry_id
        )
      );
    if v_submission_hash is null then
      raise exception 'manual submission evidence is incomplete'
        using errcode = 'P0004';
    end if;
    update affiliate_private.affiliate_revolut_manual_batches batch
    set
      status = 'submitted',
      submission_hash = v_submission_hash,
      submitted_by_pseudonym = v_actor,
      submitted_at = now(),
      updated_at = now()
    where batch.id = v_batch.id;
    update affiliate_private.affiliate_payout_cycles cycle
    set
      status = 'submitted',
      submitted_at = coalesce(cycle.submitted_at, now()),
      updated_at = now()
    where cycle.id = v_cycle.id
      and cycle.status in ('approved', 'submitted');
  else
    update affiliate_private.affiliate_revolut_manual_batches batch
    set status = 'partially_submitted', updated_at = now()
    where batch.id = v_batch.id;
  end if;

  update affiliate_private.affiliate_revolut_manual_unmapped_requests
    request
  set
    status = 'confirmed',
    approved_by_pseudonym = v_actor,
    approval_search_evidence_hash = v_search_hash,
    approval_search_observed_at = v_search_observed_at,
    approval_confirmation_hash = v_approval_hash,
    approval_justification = v_justification,
    released_count = v_released_count,
    approved_at = now()
  where request.id = v_request.id
    and request.status = 'pending'
  returning * into v_request;
  if not found then
    raise exception 'unmapped release changed during approval'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_batch.batch_key,
    'revolut_manual_unmapped_released',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'released_count', v_released_count,
      'request_key', v_request.request_key,
      'reference_set_hash', v_reference_set_hash,
      'request_search_evidence_hash',
        v_request.request_search_evidence_hash,
      'approval_search_evidence_hash', v_search_hash,
      'pending_count', v_pending_count,
      'submitted_count', v_submitted_count,
      'currency', v_batch.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_manual_unmapped_released',
    'replayed', false,
    'request_key', v_request.request_key,
    'released_count', v_released_count,
    'pending_count', v_pending_count,
    'submitted_count', v_submitted_count
  );
end;
$$;

create or replace function
public.admin_partners_revolut_manual_batch_release_unmapped(
  p_batch_key text,
  p_references jsonb,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(
      p_batch_key,
      p_references,
      p_provider_search_evidence_hash,
      p_provider_search_observed_at,
      p_confirmation,
      p_justification
    );
$$;

revoke all on function
  affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(
    text, jsonb, text, timestamptz, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_manual_batch_release_unmapped(
    text, jsonb, text, timestamptz, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_manual_batch_release_unmapped(
    text, jsonb, text, timestamptz, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_manual_batch_release_unmapped(
    text, jsonb, text, timestamptz, text, text
  )
to authenticated;

comment on table
  affiliate_private.affiliate_revolut_manual_unmapped_releases is
  'Append-only exact subset releases for never-entered transfers in a partially submitted Revolut Basic batch.';

-- A stale or contradicted maker request must have a terminal path. Rejection
-- deliberately does not accept a provider-search proof: it releases no money
-- and only removes the request's operational freeze after an independent
-- Finance checker records an explicit, audited decision.
create or replace function
affiliate_private.admin_partners_revolut_manual_control_reject(
  p_control_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_control_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_confirmation_hash text;
  v_batch_id uuid;
  v_batch_key text;
  v_control_type text;
  v_status text;
  v_requested_by text;
  v_existing_actor text;
  v_existing_confirmation_hash text;
  v_existing_justification text;
  v_resolved_at timestamptz;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual control rejection requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^(rmc|ruq)_[0-9a-f]{24}$'
    or v_confirmation <> 'REJECT-CONTROL:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual control rejection'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  if left(v_key, 4) = 'rmc_' then
    v_control_type := 'batch_cancellation';
    select cancellation.manual_batch_id, batch.batch_key
    into v_batch_id, v_batch_key
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    join affiliate_private.affiliate_revolut_manual_batches batch
      on batch.id = cancellation.manual_batch_id
    where cancellation.cancellation_key = v_key;
  else
    v_control_type := 'unmapped_release';
    select request.manual_batch_id, batch.batch_key
    into v_batch_id, v_batch_key
    from affiliate_private.affiliate_revolut_manual_unmapped_requests
      request
    join affiliate_private.affiliate_revolut_manual_batches batch
      on batch.id = request.manual_batch_id
    where request.request_key = v_key;
  end if;
  if v_batch_id is null then
    raise exception 'manual control is unavailable'
      using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-manual-batch:' || v_batch_key,
      0
    )
  );

  if v_control_type = 'batch_cancellation' then
    select
      batch.batch_key,
      cancellation.status,
      cancellation.requested_by_pseudonym,
      cancellation.approved_by_pseudonym,
      cancellation.approval_confirmation_hash,
      cancellation.approval_justification,
      cancellation.approved_at
    into
      v_batch_key,
      v_status,
      v_requested_by,
      v_existing_actor,
      v_existing_confirmation_hash,
      v_existing_justification,
      v_resolved_at
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    join affiliate_private.affiliate_revolut_manual_batches batch
      on batch.id = cancellation.manual_batch_id
    where cancellation.cancellation_key = v_key
    for update of cancellation, batch;
  else
    select
      batch.batch_key,
      request.status,
      request.requested_by_pseudonym,
      request.approved_by_pseudonym,
      request.approval_confirmation_hash,
      request.approval_justification,
      request.approved_at
    into
      v_batch_key,
      v_status,
      v_requested_by,
      v_existing_actor,
      v_existing_confirmation_hash,
      v_existing_justification,
      v_resolved_at
    from affiliate_private.affiliate_revolut_manual_unmapped_requests
      request
    join affiliate_private.affiliate_revolut_manual_batches batch
      on batch.id = request.manual_batch_id
    where request.request_key = v_key
    for update of request, batch;
  end if;
  if v_status is null then
    raise exception 'manual control is unavailable'
      using errcode = 'P0002';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  if v_actor = v_requested_by then
    raise exception
      'maker and rejection checker require distinct Finance actors'
      using errcode = '42501';
  end if;
  v_confirmation_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-manual-control-reject:v1',
        v_actor,
        v_key,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  if v_status = 'rejected' then
    if v_existing_actor is distinct from v_actor
      or v_existing_confirmation_hash is distinct from
        v_confirmation_hash
      or v_existing_justification is distinct from v_justification
    then
      raise exception 'manual control already has another rejection'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_manual_control_rejected',
      'replayed', true,
      'control', jsonb_build_object(
        'key', v_key,
        'type', v_control_type,
        'status', 'rejected',
        'batch_key', v_batch_key,
        'resolved_at', v_resolved_at
      )
    );
  end if;
  if v_status <> 'pending' then
    raise exception 'manual control is already terminal'
      using errcode = 'P0003';
  end if;

  if v_control_type = 'batch_cancellation' then
    update affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    set
      status = 'rejected',
      approved_by_pseudonym = v_actor,
      approval_confirmation_hash = v_confirmation_hash,
      approval_justification = v_justification,
      approved_at = now()
    where cancellation.cancellation_key = v_key
      and cancellation.status = 'pending'
    returning cancellation.approved_at into v_resolved_at;
  else
    update affiliate_private.affiliate_revolut_manual_unmapped_requests
      request
    set
      status = 'rejected',
      approved_by_pseudonym = v_actor,
      approval_confirmation_hash = v_confirmation_hash,
      approval_justification = v_justification,
      approved_at = now()
    where request.request_key = v_key
      and request.status = 'pending'
    returning request.approved_at into v_resolved_at;
  end if;
  if v_resolved_at is null then
    raise exception 'manual control changed during rejection'
      using errcode = 'P0004';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_batch_key,
    'revolut_manual_control_rejected',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'control_key', v_key,
      'control_type', v_control_type,
      'status', 'rejected',
      'resolved_at', v_resolved_at
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_manual_control_rejected',
    'replayed', false,
    'control', jsonb_build_object(
      'key', v_key,
      'type', v_control_type,
      'status', 'rejected',
      'batch_key', v_batch_key,
      'resolved_at', v_resolved_at
    )
  );
end;
$$;

create or replace function
public.admin_partners_revolut_manual_control_reject(
  p_control_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_control_reject(
      p_control_key,
      p_confirmation,
      p_justification
    );
$$;

revoke all on function
  affiliate_private.admin_partners_revolut_manual_control_reject(
    text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_manual_control_reject(
    text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_manual_control_reject(text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_manual_control_reject(text, text, text)
to authenticated;

-- ---------------------------------------------------------------------------
-- Late COMPLETED after a payout release: account-wide hold and recovery
-- ---------------------------------------------------------------------------

create or replace function
affiliate_private.admin_partners_revolut_late_completion_review(
  p_observation_key text,
  p_conclusion text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_observation_key, '')));
  v_conclusion text := lower(btrim(coalesce(p_conclusion, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_hash text;
  v_observation
    affiliate_private.affiliate_revolut_late_completion_observations%rowtype;
  v_review
    affiliate_private.affiliate_revolut_late_completion_reviews%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'late completion review requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rlc_[0-9a-f]{24}$'
    or v_conclusion not in ('eligible', 'quarantine')
    or v_confirmation <> 'REVIEW-LATE:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid late completion review'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  select observation.*
  into v_observation
  from
    affiliate_private.affiliate_revolut_late_completion_observations
      observation
  where observation.observation_key = v_key
  for update;
  if not found then
    raise exception 'late completion observation is unavailable'
      using errcode = 'P0002';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  v_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-late-review:v1',
        v_actor,
        v_observation.source_evidence_hash,
        v_conclusion,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );
  select review.*
  into v_review
  from affiliate_private.affiliate_revolut_late_completion_reviews review
  where review.observation_id = v_observation.id;
  if found then
    if v_review.conclusion is distinct from v_conclusion
      or v_review.review_actor_pseudonym is distinct from v_actor
      or v_review.confirmation_hash is distinct from v_hash
      or v_review.justification is distinct from v_justification
    then
      raise exception 'late completion already has another review'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_late_completion_reviewed',
      'replayed', true,
      'review', jsonb_build_object(
        'key', v_review.review_key,
        'conclusion', v_review.conclusion
      )
    );
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_late_completion_decisions
      decision
    where decision.observation_id = v_observation.id
  ) then
    raise exception 'late completion is already decided'
      using errcode = 'P0003';
  end if;

  insert into affiliate_private.affiliate_revolut_late_completion_reviews (
    observation_id,
    execution_id,
    conclusion,
    review_actor_pseudonym,
    confirmation_hash,
    justification
  )
  values (
    v_observation.id,
    v_observation.execution_id,
    v_conclusion,
    v_actor,
    v_hash,
    v_justification
  )
  returning * into v_review;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_observation.observation_key,
    'revolut_late_completion_reviewed',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'review_key', v_review.review_key,
      'conclusion', v_review.conclusion,
      'amount_minor', v_observation.amount_minor,
      'currency', v_observation.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_late_completion_reviewed',
    'replayed', false,
    'review', jsonb_build_object(
      'key', v_review.review_key,
      'conclusion', v_review.conclusion
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_late_completion_decide(
  p_review_key text,
  p_decision text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_review_key, '')));
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_hash text;
  v_review
    affiliate_private.affiliate_revolut_late_completion_reviews%rowtype;
  v_observation
    affiliate_private.affiliate_revolut_late_completion_observations%rowtype;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_release affiliate_private.affiliate_commission_entries%rowtype;
  v_recovery affiliate_private.affiliate_commission_entries%rowtype;
  v_decision_row
    affiliate_private.affiliate_revolut_late_completion_decisions%rowtype;
  v_release_checker text;
  v_release_checker_count integer := 0;
  v_release_maker text;
  v_release_maker_count integer := 0;
  v_available_balance bigint := 0;
  v_available_debit bigint := 0;
  v_recovery_due bigint := 0;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'late completion decision requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rlv_[0-9a-f]{24}$'
    or v_decision not in ('confirmed', 'quarantined')
    or v_confirmation <> (case v_decision
      when 'confirmed' then 'CONFIRM-LATE:' || v_key
      else 'QUARANTINE-LATE:' || v_key
    end)
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid late completion decision'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  select review.*
  into v_review
  from affiliate_private.affiliate_revolut_late_completion_reviews review
  where review.review_key = v_key
  for update;
  if not found then
    raise exception 'late completion review is unavailable'
      using errcode = 'P0002';
  end if;
  if v_actor = v_review.review_actor_pseudonym then
    raise exception 'late review and decision require distinct actors'
      using errcode = '42501';
  end if;

  select observation.*
  into strict v_observation
  from
    affiliate_private.affiliate_revolut_late_completion_observations
      observation
  where observation.id = v_review.observation_id;
  select execution.*
  into strict v_execution
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.id = v_observation.execution_id
  for update;
  select item.*
  into strict v_item
  from affiliate_private.affiliate_payout_items item
  where item.id = v_execution.payout_item_id
  for update;
  select release.*
  into strict v_release
  from affiliate_private.affiliate_commission_entries release
  where release.id = v_observation.release_entry_id
    and release.entry_kind in ('payout_release', 'payout_settlement')
    and release.related_entry_id = v_item.allocation_entry_id
    and release.account_id = v_item.account_id
    and release.amount_minor = v_observation.amount_minor
    and release.currency = v_observation.currency
  for update;

  select count(distinct checker.checker)::integer, min(checker.checker)
  into v_release_checker_count, v_release_checker
  from (
    select cancellation.approved_by_pseudonym as checker
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    where cancellation.manual_batch_id = v_execution.manual_batch_id
      and cancellation.status = 'confirmed'
      and v_release.entry_kind = 'payout_release'
    union all
    select request.approved_by_pseudonym
    from affiliate_private.affiliate_revolut_manual_unmapped_releases
      unmapped
    join affiliate_private.affiliate_revolut_manual_unmapped_requests
      request
      on request.id = unmapped.request_id
      and request.status = 'confirmed'
    where unmapped.execution_id = v_execution.id
      and unmapped.resolution_entry_id = v_release.id
      and v_release.entry_kind = 'payout_release'
    union all
    select decision.decision_actor_pseudonym
    from affiliate_private.affiliate_revolut_return_decisions decision
    where decision.execution_id = v_execution.id
      and decision.resolution_entry_id = v_release.id
      and decision.decision = 'confirmed'
      and v_release.entry_kind = 'payout_release'
    union all
    select decision.decision_actor_pseudonym
    from affiliate_private.affiliate_revolut_manual_decisions decision
    where decision.execution_id = v_execution.id
      and decision.settlement_entry_id = v_release.id
      and decision.decision = 'confirmed'
      and v_release.entry_kind = 'payout_settlement'
    union all
    select decision.decision_actor_pseudonym
    from
      affiliate_private
        .affiliate_revolut_reconciliation_incident_decisions decision
    where decision.target_execution_id = v_execution.id
      and decision.resolution_entry_id = v_release.id
      and decision.action in (
        'settle_exact',
        'remap_exact_and_settle'
      )
      and v_release.entry_kind = 'payout_settlement'
  ) checker
  where checker.checker is not null;
  if v_release_checker_count <> 1 then
    raise exception 'payout release checker evidence is incomplete'
      using errcode = 'P0004';
  end if;
  if v_actor = v_release_checker then
    raise exception
      'release checker and late decision require distinct actors'
      using errcode = '42501';
  end if;
  select count(distinct maker.maker)::integer, min(maker.maker)
  into v_release_maker_count, v_release_maker
  from (
    select cancellation.requested_by_pseudonym as maker
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    where cancellation.manual_batch_id = v_execution.manual_batch_id
      and cancellation.status = 'confirmed'
      and v_release.entry_kind = 'payout_release'
    union all
    select request.requested_by_pseudonym
    from affiliate_private.affiliate_revolut_manual_unmapped_releases
      unmapped
    join affiliate_private.affiliate_revolut_manual_unmapped_requests
      request
      on request.id = unmapped.request_id
      and request.status = 'confirmed'
    where unmapped.execution_id = v_execution.id
      and unmapped.resolution_entry_id = v_release.id
      and v_release.entry_kind = 'payout_release'
    union all
    select review.review_actor_pseudonym
    from affiliate_private.affiliate_revolut_return_decisions decision
    join affiliate_private.affiliate_revolut_return_reviews review
      on review.id = decision.review_id
    where decision.execution_id = v_execution.id
      and decision.resolution_entry_id = v_release.id
      and decision.decision = 'confirmed'
      and v_release.entry_kind = 'payout_release'
    union all
    select review.review_actor_pseudonym
    from affiliate_private.affiliate_revolut_manual_decisions decision
    join affiliate_private.affiliate_revolut_manual_reviews review
      on review.id = decision.review_id
    where decision.execution_id = v_execution.id
      and decision.settlement_entry_id = v_release.id
      and decision.decision = 'confirmed'
      and v_release.entry_kind = 'payout_settlement'
    union all
    select review.review_actor_pseudonym
    from
      affiliate_private
        .affiliate_revolut_reconciliation_incident_decisions decision
    join
      affiliate_private
        .affiliate_revolut_reconciliation_incident_reviews review
      on review.id = decision.review_id
    where decision.target_execution_id = v_execution.id
      and decision.resolution_entry_id = v_release.id
      and decision.action in (
        'settle_exact',
        'remap_exact_and_settle'
      )
      and v_release.entry_kind = 'payout_settlement'
  ) maker
  where maker.maker is not null;
  if v_release_maker_count <> 1 then
    raise exception 'payout release maker evidence is incomplete'
      using errcode = 'P0004';
  end if;
  if v_actor = v_release_maker then
    raise exception
      'release maker and late decision require distinct actors'
      using errcode = '42501';
  end if;
  if v_execution.submitted_by_pseudonym is not null
    and v_actor = v_execution.submitted_by_pseudonym
  then
    raise exception
      'transfer submitter and late decision require distinct actors'
      using errcode = '42501';
  end if;
  if v_execution.manual_batch_id is not null
    and exists (
      select 1
      from affiliate_private.affiliate_revolut_manual_batches batch
      where batch.id = v_execution.manual_batch_id
        and batch.submitted_by_pseudonym = v_actor
    )
  then
    raise exception
      'batch submitter and late decision require distinct actors'
      using errcode = '42501';
  end if;

  v_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:revolut-late-decision:v1',
        v_actor,
        v_observation.source_evidence_hash,
        v_release.entry_key,
        v_review.confirmation_hash,
        v_decision,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );
  select decision.*
  into v_decision_row
  from affiliate_private.affiliate_revolut_late_completion_decisions
    decision
  where decision.observation_id = v_observation.id;
  if found then
    if v_decision_row.review_id is distinct from v_review.id
      or v_decision_row.decision is distinct from v_decision
      or v_decision_row.decision_actor_pseudonym is distinct from v_actor
      or v_decision_row.confirmation_hash is distinct from v_hash
      or v_decision_row.justification is distinct from v_justification
    then
      raise exception 'late completion already has another decision'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_late_completion_decided',
      'replayed', true,
      'decision', jsonb_build_object(
        'key', v_decision_row.decision_key,
        'status', v_decision_row.decision,
        'available_debit_minor',
          v_decision_row.available_debit_minor,
        'recovery_due_minor', v_decision_row.recovery_due_minor
      )
    );
  end if;

  if v_decision = 'confirmed' then
    if v_review.conclusion <> 'eligible' then
      raise exception 'confirmed late completion requires eligible review'
        using errcode = 'P0004';
    end if;
    perform affiliate_private.partners_balance_lock(
      v_item.account_id,
      v_observation.currency
    );
    select coalesce(sum(
      case
        when posting.direction = 'credit' then posting.amount_minor
        else -posting.amount_minor
      end
    ), 0)::bigint
    into v_available_balance
    from affiliate_private.affiliate_commission_postings posting
    join affiliate_private.affiliate_commission_entries entry
      on entry.id = posting.entry_id
    where entry.account_id = v_item.account_id
      and posting.currency = v_observation.currency
      and posting.ledger_account = 'partner_commission_available';
    v_available_debit := least(
      v_observation.amount_minor,
      greatest(v_available_balance, 0)
    );
    v_recovery_due :=
      v_observation.amount_minor - v_available_debit;

    insert into affiliate_private.affiliate_commission_entries (
      account_id,
      entry_kind,
      related_entry_id,
      currency,
      currency_exponent,
      amount_minor
    )
    values (
      v_item.account_id,
      case v_release.entry_kind
        when 'payout_release' then 'payout_late_settlement'
        else 'payout_duplicate_settlement'
      end,
      v_release.id,
      v_release.currency,
      v_release.currency_exponent,
      v_release.amount_minor
    )
    returning * into v_recovery;
    if v_available_debit > 0 then
      insert into affiliate_private.affiliate_commission_postings (
        entry_id,
        ledger_account,
        direction,
        amount_minor,
        currency
      )
      values (
        v_recovery.id,
        'partner_commission_available',
        'debit',
        v_available_debit,
        v_recovery.currency
      );
    end if;
    if v_recovery_due > 0 then
      insert into affiliate_private.affiliate_commission_postings (
        entry_id,
        ledger_account,
        direction,
        amount_minor,
        currency
      )
      values (
        v_recovery.id,
        'partner_recovery_due',
        'debit',
        v_recovery_due,
        v_recovery.currency
      );
    end if;
    insert into affiliate_private.affiliate_commission_postings (
      entry_id,
      ledger_account,
      direction,
      amount_minor,
      currency
    )
    values (
      v_recovery.id,
      'partner_cash_settled',
      'credit',
      v_recovery.amount_minor,
      v_recovery.currency
    );
  elsif v_review.conclusion <> 'quarantine' then
    raise exception 'quarantined decision requires quarantine review'
      using errcode = 'P0004';
  end if;

  insert into
    affiliate_private.affiliate_revolut_late_completion_decisions (
      observation_id,
      review_id,
      execution_id,
      decision,
      decision_actor_pseudonym,
      confirmation_hash,
      justification,
      recovery_entry_id,
      available_debit_minor,
      recovery_due_minor
    )
  values (
    v_observation.id,
    v_review.id,
    v_execution.id,
    v_decision,
    v_actor,
    v_hash,
    v_justification,
    v_recovery.id,
    v_available_debit,
    v_recovery_due
  )
  returning * into v_decision_row;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_execution.execution_key,
    case v_decision
      when 'confirmed' then case v_release.entry_kind
        when 'payout_release' then 'revolut_late_completion_confirmed'
        else 'revolut_duplicate_completion_confirmed'
      end
      else 'revolut_late_completion_quarantined'
    end,
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'decision_key', v_decision_row.decision_key,
      'decision', v_decision,
      'basis_entry_kind', v_release.entry_kind,
      'reference', v_execution.payout_reference,
      'amount_minor', v_observation.amount_minor,
      'currency', v_observation.currency,
      'available_debit_minor', v_available_debit,
      'recovery_due_minor', v_recovery_due,
      'payout_hold_scope', case
        when v_decision = 'quarantined' then 'account'
        else 'profile_reverification'
      end
    )
  );

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_late_completion_decided',
    'replayed', false,
    'decision', jsonb_build_object(
      'key', v_decision_row.decision_key,
      'status', v_decision_row.decision,
      'available_debit_minor', v_available_debit,
      'recovery_due_minor', v_recovery_due
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_late_completion_queue(
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_total bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'late completion queue requires AAL2'
      using errcode = '42501';
  end if;
  if v_status not in (
    'all',
    'pending',
    'reviewed',
    'confirmed',
    'quarantined'
  ) then
    raise exception 'invalid late completion queue status'
      using errcode = '22023';
  end if;

  select count(*)
  into v_total
  from
    affiliate_private.affiliate_revolut_late_completion_observations
      observation
  left join
    affiliate_private.affiliate_revolut_late_completion_reviews review
    on review.observation_id = observation.id
  left join
    affiliate_private.affiliate_revolut_late_completion_decisions decision
    on decision.observation_id = observation.id
  where v_status = 'all'
    or case
      when decision.decision is not null then decision.decision
      when review.id is not null then 'reviewed'
      else 'pending'
    end = v_status;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'observation_key', rows.observation_key,
        'execution_key', rows.execution_key,
        'reference', rows.payout_reference,
        'adapter', rows.adapter,
        'destination_masked', rows.destination_masked,
        'amount_minor', rows.amount_minor,
        'currency', rows.currency,
        'affected_currency', rows.currency,
        'observed_at', rows.observed_at,
        'status', rows.effective_status,
        'review_key', rows.review_key,
        'review_conclusion', rows.review_conclusion,
        'available_debit_minor', rows.available_debit_minor,
        'recovery_due_minor', rows.recovery_due_minor,
        'payout_hold_scope', case
          when rows.effective_status = 'confirmed'
            then 'profile_reverification'
          else 'account'
        end
      )
      order by rows.observed_at desc, rows.observation_key
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select
      observation.*,
      execution.execution_key,
      execution.payout_reference,
      execution.adapter,
      execution.destination_masked,
      review.review_key,
      review.conclusion as review_conclusion,
      decision.available_debit_minor,
      decision.recovery_due_minor,
      case
        when decision.decision is not null then decision.decision
        when review.id is not null then 'reviewed'
        else 'pending'
      end as effective_status
    from
      affiliate_private.affiliate_revolut_late_completion_observations
        observation
    join affiliate_private.affiliate_revolut_payout_executions execution
      on execution.id = observation.execution_id
    left join
      affiliate_private.affiliate_revolut_late_completion_reviews review
      on review.observation_id = observation.id
    left join
      affiliate_private.affiliate_revolut_late_completion_decisions decision
      on decision.observation_id = observation.id
    where v_status = 'all'
      or case
        when decision.decision is not null then decision.decision
        when review.id is not null then 'reviewed'
        else 'pending'
      end = v_status
    order by observation.observed_at desc, observation.observation_key
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

create or replace function
public.admin_partners_revolut_late_completion_review(
  p_observation_key text,
  p_conclusion text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_late_completion_review(
      p_observation_key,
      p_conclusion,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_late_completion_decide(
  p_review_key text,
  p_decision text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_late_completion_decide(
      p_review_key,
      p_decision,
      p_confirmation,
      p_justification
    );
$$;

create or replace function
public.admin_partners_revolut_late_completion_queue(
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default 'all'
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_late_completion_queue(
      p_limit,
      p_offset,
      p_status
    );
$$;

revoke all on function
  affiliate_private.admin_partners_revolut_late_completion_review(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_late_completion_review(
    text, text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_late_completion_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_late_completion_decide(
    text, text, text, text
  )
to authenticated;
revoke all on function
  affiliate_private.admin_partners_revolut_late_completion_queue(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_late_completion_queue(
    integer, integer, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_late_completion_review(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_late_completion_review(
    text, text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_late_completion_decide(
    text, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_late_completion_decide(
    text, text, text, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_late_completion_queue(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_late_completion_queue(
    integer, integer, text
  )
to authenticated;

comment on table
  affiliate_private.affiliate_revolut_late_completion_observations is
  'Exact COMPLETED evidence received after a payout_release; it freezes every payout rail for the affected account without disabling commissions or referral links.';

-- Internal helpers and trigger routines are owner-only. PostgreSQL grants
-- PUBLIC execution on newly created routines unless it is revoked explicitly.
revoke all on function
  affiliate_private.revolut_manual_batch_manifest_hash(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.record_revolut_late_completion_observation(
    uuid, text, uuid, text, timestamptz
  )
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.refresh_revolut_payout_aggregate(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_manual_cancellation_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_revolut_unmapped_request_transition()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_payout_profile_binding_and_hold()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.admin_partners_currency_set(text, integer, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_currency_set(text, integer, text, text)
to authenticated;

create or replace function
affiliate_private.admin_partners_revolut_manual_controls_queue(
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_total bigint;
  v_items jsonb;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual control queue requires AAL2'
      using errcode = '42501';
  end if;
  if v_status not in ('all', 'pending', 'confirmed', 'rejected') then
    raise exception 'invalid manual control queue status'
      using errcode = '22023';
  end if;

  with controls as (
    select
      cancellation.cancellation_key as control_key,
      'batch_cancellation'::text as control_type,
      cancellation.status,
      batch.batch_key,
      cancellation.reference_set_hash,
      cancellation.request_search_observed_at,
      cancellation.approval_search_observed_at,
      cancellation.requested_at,
      cancellation.approved_at,
      batch.exported_at + interval '7 days' as eligible_at,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'reference', execution.payout_reference,
              'amount_minor', execution.amount_minor,
              'currency', execution.currency,
              'currency_exponent', execution.currency_exponent
            )
            order by execution.payout_reference
          )
          from affiliate_private.affiliate_revolut_payout_executions
            execution
          where execution.manual_batch_id = batch.id
        ),
        '[]'::jsonb
      ) as references_snapshot
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    join affiliate_private.affiliate_revolut_manual_batches batch
      on batch.id = cancellation.manual_batch_id
    union all
    select
      request.request_key,
      'unmapped_release'::text,
      request.status,
      batch.batch_key,
      request.reference_set_hash,
      request.request_search_observed_at,
      request.approval_search_observed_at,
      request.requested_at,
      request.approved_at,
      batch.exported_at + interval '7 days',
      request.references_snapshot
    from affiliate_private.affiliate_revolut_manual_unmapped_requests
      request
    join affiliate_private.affiliate_revolut_manual_batches batch
      on batch.id = request.manual_batch_id
  )
  select count(*)
  into v_total
  from controls
  where v_status = 'all' or controls.status = v_status;

  with controls as (
    select
      cancellation.cancellation_key as control_key,
      'batch_cancellation'::text as control_type,
      cancellation.status,
      batch.batch_key,
      cancellation.reference_set_hash,
      cancellation.request_search_observed_at,
      cancellation.approval_search_observed_at,
      cancellation.requested_at,
      cancellation.approved_at,
      batch.exported_at + interval '7 days' as eligible_at,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'reference', execution.payout_reference,
              'amount_minor', execution.amount_minor,
              'currency', execution.currency,
              'currency_exponent', execution.currency_exponent
            )
            order by execution.payout_reference
          )
          from affiliate_private.affiliate_revolut_payout_executions
            execution
          where execution.manual_batch_id = batch.id
        ),
        '[]'::jsonb
      ) as references_snapshot
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    join affiliate_private.affiliate_revolut_manual_batches batch
      on batch.id = cancellation.manual_batch_id
    union all
    select
      request.request_key,
      'unmapped_release'::text,
      request.status,
      batch.batch_key,
      request.reference_set_hash,
      request.request_search_observed_at,
      request.approval_search_observed_at,
      request.requested_at,
      request.approved_at,
      batch.exported_at + interval '7 days',
      request.references_snapshot
    from affiliate_private.affiliate_revolut_manual_unmapped_requests
      request
    join affiliate_private.affiliate_revolut_manual_batches batch
      on batch.id = request.manual_batch_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', rows.control_key,
        'type', rows.control_type,
        'status', rows.status,
        'batch_key', rows.batch_key,
        'reference_set_hash', rows.reference_set_hash,
        'references', rows.references_snapshot,
        'maker_search_observed_at', rows.request_search_observed_at,
        'checker_search_observed_at', rows.approval_search_observed_at,
        'requested_at', rows.requested_at,
        'approved_at', rows.approved_at,
        'resolved_at', rows.approved_at,
        'resolution', case
          when rows.status = 'confirmed' then 'approved'
          when rows.status = 'rejected' then 'rejected'
          else null
        end,
        'eligible_at', rows.eligible_at
      )
      order by rows.requested_at desc, rows.control_key
    ),
    '[]'::jsonb
  )
  into v_items
  from (
    select *
    from controls
    where v_status = 'all' or controls.status = v_status
    order by requested_at desc, control_key
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object(
    'schema_version', 1,
    'total', v_total,
    'items', v_items
  );
end;
$$;

create or replace function
public.admin_partners_revolut_manual_controls_queue(
  p_limit integer default 50,
  p_offset integer default 0,
  p_status text default 'all'
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select
    affiliate_private.admin_partners_revolut_manual_controls_queue(
      p_limit,
      p_offset,
      p_status
    );
$$;

revoke all on function
  affiliate_private.admin_partners_revolut_manual_controls_queue(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_manual_controls_queue(
    integer, integer, text
  )
to authenticated;
revoke all on function
  public.admin_partners_revolut_manual_controls_queue(
    integer, integer, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_partners_revolut_manual_controls_queue(
    integer, integer, text
  )
to authenticated;

-- ---------------------------------------------------------------------------
-- P0 close-out: statement-first Basic, financial fences, discrepancy controls
-- ---------------------------------------------------------------------------

-- Finance confirms only the Norva references actually entered in Revolut.
-- Provider transaction identity remains NULL until the normalized statement is
-- ingested; it is never frozen from a manually copied dashboard value.
create or replace function
affiliate_private.admin_partners_revolut_manual_batch_mark_submitted(
  p_batch_key text,
  p_transfers jsonb,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_batch_key, '')));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_batch affiliate_private.affiliate_revolut_manual_batches%rowtype;
  v_cycle affiliate_private.affiliate_payout_cycles%rowtype;
  v_transfer jsonb;
  v_reference text;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_input_count integer;
  v_entered_count integer;
  v_matched_count integer;
  v_released_count integer;
  v_resolved_count integer;
  v_applied_count integer := 0;
  v_replayed_count integer := 0;
  v_submission_hash text;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'manual payout submission requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rmb_[0-9a-f]{24}$'
    or jsonb_typeof(p_transfers) <> 'array'
    or jsonb_array_length(p_transfers) not between 1 and 5000
    or v_confirmation <> 'SUBMIT:' || v_key
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid manual payout submission'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:revolut-manual-batch:' || v_key,
      0
    )
  );
  select batch.*
  into v_batch
  from affiliate_private.affiliate_revolut_manual_batches batch
  where batch.batch_key = v_key
  for update;
  if not found then
    raise exception 'manual payout batch is unavailable'
      using errcode = 'P0002';
  end if;
  if v_batch.status not in (
    'exported',
    'partially_submitted',
    'submitted',
    'partially_reconciled',
    'settled',
    'exception'
  ) then
    raise exception 'manual payout batch must be exported first'
      using errcode = 'P0004';
  end if;
  if exists (
    select 1
    from affiliate_private.affiliate_revolut_manual_cancellations
      cancellation
    where cancellation.manual_batch_id = v_batch.id
      and cancellation.status = 'pending'
  )
    or exists (
      select 1
      from affiliate_private.affiliate_revolut_manual_unmapped_requests
        request
      where request.manual_batch_id = v_batch.id
        and request.status = 'pending'
    )
  then
    raise exception 'manual payout batch Finance review is pending'
      using errcode = 'P0003';
  end if;

  v_input_count := jsonb_array_length(p_transfers);
  for v_transfer in
    select value
    from jsonb_array_elements(p_transfers) value
  loop
    if jsonb_typeof(v_transfer) <> 'object'
      or (
        select count(*)
        from jsonb_object_keys(v_transfer)
      ) <> 1
      or not (v_transfer ? 'reference')
    then
      raise exception
        'manual transfer record must contain only reference'
        using errcode = '22023';
    end if;
    v_reference := upper(btrim(coalesce(v_transfer ->> 'reference', '')));
    if v_reference !~ '^NORVA-[A-F0-9]{12}$' then
      raise exception 'invalid manual payout reference'
        using errcode = '22023';
    end if;
  end loop;
  if (
    select count(distinct upper(btrim(value ->> 'reference')))
    from jsonb_array_elements(p_transfers) value
  ) <> v_input_count then
    raise exception 'manual payout references must be unique'
      using errcode = '22023';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  for v_transfer in
    select value
    from jsonb_array_elements(p_transfers) value
  loop
    v_reference := upper(btrim(coalesce(v_transfer ->> 'reference', '')));
    select execution.*
    into v_execution
    from affiliate_private.affiliate_revolut_payout_executions execution
    where execution.manual_batch_id = v_batch.id
      and execution.payout_reference = v_reference
    for update;
    if not found or v_execution.adapter <> 'revolut_manual' then
      raise exception 'manual transfer does not match the exported batch'
        using errcode = 'P0004';
    end if;

    select item.*
    into v_item
    from affiliate_private.affiliate_payout_items item
    where item.id = v_execution.payout_item_id
    for update;
    if not found then
      raise exception 'manual payout item is unavailable'
        using errcode = 'P0002';
    end if;
    select account.*
    into v_account
    from affiliate_private.affiliate_accounts account
    where account.id = v_item.account_id
    for update;
    if not found or v_account.status <> 'active' then
      raise exception 'Partner account must remain active'
        using errcode = '55000';
    end if;
    perform affiliate_private.partners_balance_lock(
      v_account.id,
      v_execution.currency
    );

    if v_execution.submitted_by_pseudonym is not null then
      if v_item.status not in ('submitted', 'settled', 'failed') then
        raise exception 'manual transfer acknowledgement is inconsistent'
          using errcode = 'P0004';
      end if;
      v_replayed_count := v_replayed_count + 1;
      continue;
    end if;

    if v_execution.state not in ('exported', 'paid', 'exception')
      or v_item.status not in ('pending', 'submitted')
      or exists (
        select 1
        from affiliate_private.affiliate_commission_entries release
        where release.entry_kind = 'payout_release'
          and release.related_entry_id = v_item.allocation_entry_id
      )
      or not exists (
        select 1
        from affiliate_private.affiliate_revolut_beneficiary_bindings
          binding
        join affiliate_private.affiliate_payout_profiles profile
          on profile.id = v_item.payout_profile_id
        where binding.id = v_execution.beneficiary_binding_id
          and binding.binding_version =
            v_execution.beneficiary_binding_version
          and binding.status = 'active'
          and profile.status = 'active'
          and profile.revolut_binding_id = binding.id
          and profile.revolut_binding_version =
            binding.binding_version
      )
    then
      raise exception 'manual transfer cannot be acknowledged'
        using errcode = 'P0004';
    end if;

    update affiliate_private.affiliate_revolut_payout_executions execution
    set
      state = case
        when execution.state = 'exported' then 'submitted'
        else execution.state
      end,
      reconciliation_status = case
        when execution.state = 'exported' then 'pending'
        else execution.reconciliation_status
      end,
      job_status = case
        when execution.state = 'exported' then 'observing'
        else execution.job_status
      end,
      submitted_by_pseudonym = v_actor,
      submitted_at = coalesce(execution.submitted_at, now()),
      updated_at = now()
    where execution.id = v_execution.id
      and execution.submitted_by_pseudonym is null;
    if not found then
      raise exception 'manual transfer acknowledgement changed'
        using errcode = 'P0004';
    end if;

    update affiliate_private.affiliate_payout_items item
    set status = 'submitted', updated_at = now()
    where item.id = v_item.id
      and item.status in ('pending', 'submitted');
    if not found then
      raise exception 'payout item changed during manual submission'
        using errcode = 'P0004';
    end if;
    v_applied_count := v_applied_count + 1;
  end loop;

  select count(*)::integer
  into v_entered_count
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id
    and execution.submitted_by_pseudonym is not null;
  select count(*)::integer
  into v_matched_count
  from affiliate_private.affiliate_revolut_payout_executions execution
  where execution.manual_batch_id = v_batch.id
    and execution.provider_transaction_hash is not null;
  select count(*)::integer
  into v_released_count
  from affiliate_private.affiliate_revolut_payout_executions execution
  join affiliate_private.affiliate_payout_items item
    on item.id = execution.payout_item_id
  where execution.manual_batch_id = v_batch.id
    and exists (
      select 1
      from affiliate_private.affiliate_commission_entries release
      where release.entry_kind = 'payout_release'
        and release.related_entry_id = item.allocation_entry_id
    );

  select count(*)::integer
  into v_resolved_count
  from affiliate_private.affiliate_revolut_payout_executions execution
  join affiliate_private.affiliate_payout_items item
    on item.id = execution.payout_item_id
  where execution.manual_batch_id = v_batch.id
    and (
      execution.submitted_by_pseudonym is not null
      or exists (
        select 1
        from affiliate_private.affiliate_commission_entries release
        where release.entry_kind = 'payout_release'
          and release.related_entry_id = item.allocation_entry_id
      )
    );

  if v_resolved_count > v_batch.item_count then
    raise exception 'manual payout acknowledgement count is inconsistent'
      using errcode = 'P0004';
  end if;
  if v_resolved_count < v_batch.item_count then
    if v_batch.submission_hash is not null
      or v_batch.status not in ('exported', 'partially_submitted')
    then
      raise exception 'manual payout acknowledgement is incomplete'
        using errcode = 'P0005';
    end if;
    update affiliate_private.affiliate_revolut_manual_batches batch
    set status = 'partially_submitted', updated_at = now()
    where batch.id = v_batch.id
    returning * into v_batch;

    insert into affiliate_private.affiliate_events (
      aggregate_type,
      aggregate_key,
      action,
      actor_type,
      actor_pseudonym,
      justification,
      after_state
    )
    values (
      'payout',
      v_batch.batch_key,
      'revolut_manual_batch_entry_progressed',
      'admin',
      v_actor,
      v_justification,
      jsonb_build_object(
        'entered_count', v_entered_count,
        'statement_matched_count', v_matched_count,
        'released_count', v_released_count,
        'resolved_count', v_resolved_count,
        'remaining_count', v_batch.item_count - v_resolved_count,
        'item_count', v_batch.item_count,
        'currency', v_batch.currency
      )
    );

    return jsonb_build_object(
      'schema_version', 2,
      'action', 'revolut_manual_batch_submission_progressed',
      'replayed', v_applied_count = 0,
      'batch', jsonb_build_object(
        'key', v_batch.batch_key,
        'status', v_batch.status,
        'entered_count', v_entered_count,
        'statement_matched_count', v_matched_count,
        'released_count', v_released_count,
        'resolved_count', v_resolved_count,
        'remaining_count', v_batch.item_count - v_resolved_count,
        'completed', false
      )
    );
  end if;

  select encode(
    extensions.digest(
      string_agg(
        execution.payout_reference
          || ':'
          || case
            when exists (
              select 1
              from affiliate_private.affiliate_commission_entries release
              where release.entry_kind = 'payout_release'
                and release.related_entry_id = item.allocation_entry_id
            ) then 'RELEASED'
            else 'ENTERED'
          end,
        ','
        order by execution.payout_reference
      ),
      'sha256'
    ),
    'hex'
  )
  into v_submission_hash
  from affiliate_private.affiliate_revolut_payout_executions execution
  join affiliate_private.affiliate_payout_items item
    on item.id = execution.payout_item_id
  where execution.manual_batch_id = v_batch.id;
  if v_submission_hash is null then
    raise exception 'manual payout acknowledgement hash is unavailable'
      using errcode = 'P0004';
  end if;

  if v_batch.submission_hash is not null then
    if v_batch.submission_hash <> v_submission_hash then
      raise exception
        'manual payout acknowledgement replay conflicts with evidence'
        using errcode = 'P0005';
    end if;
    return jsonb_build_object(
      'schema_version', 2,
      'action', 'revolut_manual_batch_submitted',
      'replayed', true,
      'batch', jsonb_build_object(
        'key', v_batch.batch_key,
        'status', v_batch.status,
        'entered_count', v_entered_count,
        'statement_matched_count', v_matched_count,
        'released_count', v_released_count,
        'resolved_count', v_resolved_count,
        'remaining_count', 0,
        'completed', true
      )
    );
  end if;

  select cycle.*
  into v_cycle
  from affiliate_private.affiliate_payout_cycles cycle
  where cycle.id = v_batch.cycle_id
  for update;
  if not found or v_cycle.status not in ('approved', 'submitted') then
    raise exception 'payout cycle changed during manual submission'
      using errcode = 'P0004';
  end if;
  update affiliate_private.affiliate_payout_cycles cycle
  set
    status = 'submitted',
    submitted_at = coalesce(cycle.submitted_at, now()),
    updated_at = now()
  where cycle.id = v_cycle.id
    and cycle.status in ('approved', 'submitted');

  update affiliate_private.affiliate_revolut_manual_batches batch
  set
    status = 'submitted',
    submission_hash = v_submission_hash,
    submitted_by_pseudonym = v_actor,
    submitted_at = coalesce(batch.submitted_at, now()),
    updated_at = now()
  where batch.id = v_batch.id
  returning * into v_batch;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_batch.batch_key,
    'revolut_manual_batch_entered',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'entered_count', v_entered_count,
      'statement_matched_count', v_matched_count,
      'released_count', v_released_count,
      'resolved_count', v_resolved_count,
      'item_count', v_batch.item_count,
      'currency', v_batch.currency
    )
  );

  return jsonb_build_object(
    'schema_version', 2,
    'action', 'revolut_manual_batch_submitted',
    'replayed', v_applied_count = 0,
    'batch', jsonb_build_object(
      'key', v_batch.batch_key,
      'status', v_batch.status,
      'entered_count', v_entered_count,
      'statement_matched_count', v_matched_count,
      'released_count', v_released_count,
      'resolved_count', v_resolved_count,
      'remaining_count', 0,
      'completed', true
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_revolut_reconciliation_incident_review(
  p_incident_key text,
  p_action text,
  p_target_reference text,
  p_provider_search_evidence_hash text,
  p_provider_search_observed_at timestamptz,
  p_confirmation text,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := lower(btrim(coalesce(p_incident_key, '')));
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_target_reference text :=
    upper(btrim(coalesce(p_target_reference, '')));
  v_search_hash text := lower(
    btrim(coalesce(p_provider_search_evidence_hash, ''))
  );
  v_search_at timestamptz :=
    date_trunc('second', p_provider_search_observed_at);
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_justification text := btrim(coalesce(p_justification, ''));
  v_actor text;
  v_hash text;
  v_cycle integer;
  v_target_token text;
  v_target_execution_id uuid;
  v_target_amount_minor bigint;
  v_target_currency text;
  v_target_currency_exponent integer;
  v_incident
    affiliate_private.affiliate_revolut_reconciliation_incidents%rowtype;
  v_row affiliate_private.affiliate_revolut_statement_rows%rowtype;
  v_execution
    affiliate_private.affiliate_revolut_payout_executions%rowtype;
  v_item affiliate_private.affiliate_payout_items%rowtype;
  v_review
    affiliate_private
      .affiliate_revolut_reconciliation_incident_reviews%rowtype;
begin
  perform affiliate_private.partners_require_capability('finance');
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'reconciliation incident review requires AAL2'
      using errcode = '42501';
  end if;
  if v_key !~ '^rri_[0-9a-f]{24}$'
    or v_action not in (
      'settle_exact',
      'remap_exact_and_settle',
      'release_after_return',
      'quarantine'
    )
    or v_search_hash !~ '^[0-9a-f]{64}$'
    or p_provider_search_observed_at is null
    or length(v_justification) not between 12 and 1000
  then
    raise exception 'invalid reconciliation incident review'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'norva:partners:payout-approval-configuration',
      0
    )
  );
  select incident.*
  into v_incident
  from affiliate_private.affiliate_revolut_reconciliation_incidents
    incident
  where incident.incident_key = v_key
  for update;
  if not found then
    raise exception 'reconciliation incident is unavailable'
      using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from
      affiliate_private
        .affiliate_revolut_reconciliation_incident_decisions decision
    where decision.incident_id = v_incident.id
      and decision.action <> 'quarantine'
  ) then
    raise exception 'reconciliation incident is already resolved'
      using errcode = 'P0003';
  end if;

  select row.*
  into v_row
  from affiliate_private.affiliate_revolut_statement_rows row
  where row.id = v_incident.statement_row_id;
  if not found
    or v_row.statement_row_hash <> v_incident.source_evidence_hash
  then
    raise exception 'reconciliation source evidence is unavailable'
      using errcode = 'P0004';
  end if;

  if v_action = 'quarantine' then
    if v_target_reference <> '' then
      raise exception 'quarantine does not accept a target reference'
        using errcode = '22023';
    end if;
    v_target_token := 'NONE';
  else
    if v_action = 'settle_exact' then
      select execution.*
      into v_execution
      from affiliate_private.affiliate_revolut_payout_executions execution
      where execution.id = v_incident.source_execution_id;
      if not found or v_target_reference <> v_execution.payout_reference then
        raise exception 'settle_exact requires the incident execution'
          using errcode = 'P0004';
      end if;
    else
      select execution.*
      into v_execution
      from affiliate_private.affiliate_revolut_payout_executions execution
      where execution.payout_reference = v_target_reference;
      if not found then
        raise exception 'target payout reference is unavailable'
          using errcode = 'P0002';
      end if;
    end if;
    if v_execution.adapter <> 'revolut_manual'
      or v_execution.manual_batch_id is null
    then
      raise exception 'incident target must be a Revolut Basic execution'
        using errcode = 'P0004';
    end if;
    select item.*
    into v_item
    from affiliate_private.affiliate_payout_items item
    where item.id = v_execution.payout_item_id;
    if not found
      or v_item.allocation_entry_id is null
      or v_item.status not in ('pending', 'submitted')
      or exists (
        select 1
        from affiliate_private.affiliate_commission_entries resolution
        where resolution.related_entry_id = v_item.allocation_entry_id
          and resolution.entry_kind in (
            'payout_settlement',
            'payout_release'
          )
      )
      or exists (
        select 1
        from
          affiliate_private
            .affiliate_revolut_reconciliation_incident_decisions decision
        where decision.target_execution_id = v_execution.id
          and decision.action <> 'quarantine'
      )
    then
      raise exception 'target payout allocation is not unresolved'
        using errcode = 'P0004';
    end if;

    if v_action in ('settle_exact', 'remap_exact_and_settle')
      and (
        v_row.provider_state <> 'COMPLETED'
        or v_row.amount_minor <> v_execution.amount_minor
        or v_row.currency <> v_execution.currency
      )
    then
      raise exception
        'exact settlement forbids partial or cross-currency adjustment'
        using errcode = 'P0004';
    end if;
    if v_action = 'settle_exact'
      and v_execution.provider_transaction_hash is distinct from
        v_row.provider_transaction_hash
    then
      raise exception
        'settle_exact requires the unchanged statement identity'
        using errcode = 'P0004';
    end if;
    if v_action = 'remap_exact_and_settle'
      and v_execution.provider_transaction_hash is not distinct from
        v_row.provider_transaction_hash
    then
      raise exception 'remap requires an absent or superseded identity'
        using errcode = 'P0004';
    end if;
    if v_action = 'release_after_return'
      and not exists (
        select 1
        from affiliate_private.affiliate_revolut_return_observations
          return_observation
        join affiliate_private.affiliate_revolut_statement_rows return_row
          on return_row.id = return_observation.statement_row_id
        where return_observation.execution_id = v_execution.id
          and return_observation.provider_state in (
            'FAILED',
            'CANCELLED',
            'REVERTED'
          )
          and return_observation.amount_minor = v_execution.amount_minor
          and return_observation.currency = v_execution.currency
          and return_row.execution_id = v_execution.id
          and return_row.provider_state =
            return_observation.provider_state
          and return_row.amount_minor = v_execution.amount_minor
          and return_row.currency = v_execution.currency
          and return_row.payout_reference = v_execution.payout_reference
          and return_row.provider_transaction_hash =
            v_incident.source_provider_transaction_hash
          and return_observation.observed_at + interval '7 days' <= now()
      )
    then
      raise exception
        'release_after_return requires exact terminal return evidence and cooldown'
        using errcode = 'P0004';
    end if;
    v_target_token := v_execution.payout_reference;
    v_target_execution_id := v_execution.id;
    v_target_amount_minor := v_execution.amount_minor;
    v_target_currency := v_execution.currency;
    v_target_currency_exponent := v_execution.currency_exponent;
  end if;

  if v_confirmation <>
      concat_ws(
        ':',
        'REVIEW-RECON',
        v_key,
        upper(v_action),
        v_target_token,
        left(v_incident.source_provider_transaction_hash, 12),
        v_incident.source_amount_minor::text,
        v_incident.source_currency,
        floor(extract(epoch from v_search_at))::bigint::text
      )
  then
    raise exception 'invalid typed reconciliation review confirmation'
      using errcode = '22023';
  end if;

  v_actor := affiliate_private.partners_admin_actor_pseudonym();
  v_hash := encode(
    extensions.digest(
      concat_ws(
        ':',
        'norva:partners:reconciliation-incident-review:v1',
        v_actor,
        v_incident.source_evidence_hash,
        v_action,
        v_target_token,
        v_search_hash,
        v_search_at::text,
        v_confirmation,
        v_justification
      ),
      'sha256'
    ),
    'hex'
  );

  select review.*
  into v_review
  from
    affiliate_private
      .affiliate_revolut_reconciliation_incident_reviews review
  where review.incident_id = v_incident.id
    and not exists (
      select 1
      from
        affiliate_private
          .affiliate_revolut_reconciliation_incident_decisions decision
      where decision.review_id = review.id
    )
  order by review.review_cycle desc
  limit 1;
  if found then
    if v_review.proposed_action is distinct from v_action
      or v_review.target_execution_id is distinct from
        v_target_execution_id
      or v_review.provider_search_evidence_hash is distinct from
        v_search_hash
      or v_review.provider_search_observed_at is distinct from v_search_at
      or v_review.review_actor_pseudonym is distinct from v_actor
      or v_review.confirmation_hash is distinct from v_hash
      or v_review.justification is distinct from v_justification
    then
      raise exception 'incident already has another pending review'
        using errcode = 'P0003';
    end if;
    return jsonb_build_object(
      'schema_version', 1,
      'action', 'revolut_reconciliation_incident_reviewed',
      'replayed', true,
      'review', jsonb_build_object(
        'key', v_review.review_key,
        'incident_key', v_key,
        'proposed_action', v_review.proposed_action,
        'target_reference', v_review.target_reference
      )
    );
  end if;
  if v_search_at < now() - interval '2 minutes'
    or v_search_at > now() + interval '30 seconds'
  then
    raise exception 'review requires a fresh Revolut search'
      using errcode = 'P0004';
  end if;

  select coalesce(max(review.review_cycle), 0) + 1
  into v_cycle
  from
    affiliate_private
      .affiliate_revolut_reconciliation_incident_reviews review
  where review.incident_id = v_incident.id;

  insert into
    affiliate_private.affiliate_revolut_reconciliation_incident_reviews (
      incident_id,
      review_cycle,
      proposed_action,
      target_execution_id,
      target_reference,
      target_amount_minor,
      target_currency,
      target_currency_exponent,
      provider_search_evidence_hash,
      provider_search_observed_at,
      review_actor_pseudonym,
      confirmation_hash,
      justification
    )
  values (
    v_incident.id,
    v_cycle,
    v_action,
    v_target_execution_id,
    nullif(v_target_token, 'NONE'),
    v_target_amount_minor,
    v_target_currency,
    v_target_currency_exponent,
    v_search_hash,
    v_search_at,
    v_actor,
    v_hash,
    v_justification
  )
  returning * into v_review;

  if v_target_execution_id is not null then
    update affiliate_private.affiliate_payout_profiles profile
    set
      status = 'verification_required',
      revolut_binding_id = null,
      revolut_binding_version = null,
      updated_at = now()
    where profile.account_id = v_item.account_id
      and profile.status <> 'disabled';
  end if;

  insert into affiliate_private.affiliate_events (
    aggregate_type,
    aggregate_key,
    action,
    actor_type,
    actor_pseudonym,
    justification,
    after_state
  )
  values (
    'payout',
    v_incident.incident_key,
    'revolut_reconciliation_incident_reviewed',
    'admin',
    v_actor,
    v_justification,
    jsonb_build_object(
      'review_key', v_review.review_key,
      'review_cycle', v_review.review_cycle,
      'proposed_action', v_review.proposed_action,
      'target_reference', v_review.target_reference,
      'source_reference', v_incident.source_reference,
      'source_amount_minor', v_incident.source_amount_minor,
      'source_currency', v_incident.source_currency
    )
  );
  return jsonb_build_object(
    'schema_version', 1,
    'action', 'revolut_reconciliation_incident_reviewed',
    'replayed', false,
    'review', jsonb_build_object(
      'key', v_review.review_key,
      'incident_key', v_key,
      'review_cycle', v_review.review_cycle,
      'proposed_action', v_review.proposed_action,
      'target_reference', v_review.target_reference
    )
  );
end;
$$;

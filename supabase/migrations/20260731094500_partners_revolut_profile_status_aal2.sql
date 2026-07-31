-- Keep the beneficiary/profile read model behind the same explicit AAL2
-- boundary as every Finance mutation. The Finance capability check remains
-- required as a separate authorization factor.

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
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'payout profile status requires AAL2'
      using errcode = '42501';
  end if;
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
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'revolut return queue requires AAL2'
      using errcode = '42501';
  end if;
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

revoke all on function
  affiliate_private.admin_partners_revolut_profile_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_revolut_profile_status(uuid)
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
  affiliate_private.capture_revolut_reconciliation_incident()
from public, anon, authenticated, service_role;
revoke all on function
  affiliate_private.guard_commission_entry_open_account()
from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

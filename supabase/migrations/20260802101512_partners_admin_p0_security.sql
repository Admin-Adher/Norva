-- Norva Partners: shared operator reads and AAL2 mutation boundaries.
--
-- Support, Risk and Finance operators share the sanitized overview and
-- configuration contracts. Capability delegation and programme lifecycle
-- changes require an AAL2 session. Existing payout triggers already protect
-- new live cycles and live approvals; the extra trigger below closes the
-- remaining DRY -> LIVE promotion gap without restricting dry-run work.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Shared, sanitized operator reads.
-- ---------------------------------------------------------------------------

create or replace function affiliate_private.admin_partners_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_account_statuses jsonb;
  v_verification_statuses jsonb;
  v_link_statuses jsonb;
begin
  if not (
    affiliate_private.partners_has_capability('support')
    or affiliate_private.partners_has_capability('risk')
    or affiliate_private.partners_has_capability('finance')
  ) then
    raise exception 'Partners Admin capability is required'
      using errcode = '42501';
  end if;

  select coalesce(
    jsonb_object_agg(statuses.status, statuses.total),
    '{}'::jsonb
  )
  into v_account_statuses
  from (
    select account.status, count(*) as total
    from affiliate_private.affiliate_accounts account
    group by account.status
    order by account.status
  ) statuses;

  select coalesce(
    jsonb_object_agg(statuses.verification_status, statuses.total),
    '{}'::jsonb
  )
  into v_verification_statuses
  from (
    select account.verification_status, count(*) as total
    from affiliate_private.affiliate_accounts account
    where account.status <> 'closed'
    group by account.verification_status
    order by account.verification_status
  ) statuses;

  select coalesce(
    jsonb_object_agg(statuses.status, statuses.total),
    '{}'::jsonb
  )
  into v_link_statuses
  from (
    select link.status, count(*) as total
    from affiliate_private.affiliate_links link
    group by link.status
    order by link.status
  ) statuses;

  return jsonb_build_object(
    'schema_version', 1,
    'accounts_total', (
      select count(*) from affiliate_private.affiliate_accounts
    ),
    'accounts_open', (
      select count(*)
      from affiliate_private.affiliate_accounts account
      where account.status <> 'closed'
    ),
    'account_statuses', v_account_statuses,
    'verification_statuses', v_verification_statuses,
    'link_statuses', v_link_statuses,
    'readiness', jsonb_build_object(
      'member_accounts', true,
      'member_links', true,
      'audit_history', true,
      'financial_ledger', true,
      'fraud_workbench', true,
      'payout_operations',
        affiliate_private.partners_payout_operations_ready(),
      'reason', affiliate_private.partners_payout_operations_reason()
    ),
    'generated_at', now()
  );
end;
$$;

create or replace function affiliate_private.admin_partners_configuration()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_programs jsonb;
  v_policies jsonb;
  v_release_flags jsonb;
  v_release_gates jsonb;
begin
  if not (
    affiliate_private.partners_has_capability('support')
    or affiliate_private.partners_has_capability('risk')
    or affiliate_private.partners_has_capability('finance')
  ) then
    raise exception 'Partners Admin capability is required'
      using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'version_key', p.version_key,
        'status', p.status,
        'commission_rate_bps', p.commission_rate_bps,
        'attribution_window_days', p.attribution_window_days,
        'maturation_days', p.maturation_days,
        'terms_version', p.terms_version,
        'disclosure_version', p.disclosure_version,
        'effective_from', p.effective_from,
        'effective_until', p.effective_until
      )
      order by p.created_at desc
    ),
    '[]'::jsonb
  )
  into v_programs
  from affiliate_private.affiliate_program_versions p;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'program_version_key', p.version_key,
        'country_code', cp.country_code,
        'subdivision_code', cp.subdivision_code,
        'individual_available', cp.individual_available,
        'minimum_age', cp.minimum_age,
        'payout_currencies', cp.payout_currencies,
        'kyc_attempt_policy', case
          when ap.country_policy_id is null then null
          else jsonb_build_object(
            'status', ap.status,
            'max_attempts', ap.max_attempts,
            'window_seconds', ap.window_seconds,
            'cooldown_seconds', ap.cooldown_seconds
          )
        end
      )
      order by p.version_key, cp.country_code, cp.subdivision_code
    ),
    '[]'::jsonb
  )
  into v_policies
  from affiliate_private.affiliate_country_policies cp
  join affiliate_private.affiliate_program_versions p
    on p.id = cp.program_version_id
  left join affiliate_private.affiliate_kyc_attempt_policies ap
    on ap.country_policy_id = cp.id;

  with managed_flags(flag_key, position) as (
    values
      ('partners_enabled'::text, 1),
      ('partners_invite_only'::text, 2),
      ('partners_shadow_mode'::text, 3),
      ('partners_payouts_live'::text, 4),
      ('partners_tv_relay_enabled'::text, 5),
      ('partners_revolut_api_enabled'::text, 6)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', managed.flag_key,
        'enabled', coalesce(flag.enabled, false)
      )
      order by managed.position
    ),
    '[]'::jsonb
  )
  into v_release_flags
  from managed_flags managed
  left join public.admin_feature_flags flag
    on flag.key = managed.flag_key;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', gate.gate_key,
        'satisfied', gate.satisfied,
        'updated_at', gate.updated_at
      )
      order by gate.gate_key
    ),
    '[]'::jsonb
  )
  into v_release_gates
  from affiliate_private.affiliate_release_gates gate;

  return jsonb_build_object(
    'schema_version', 1,
    'programs', v_programs,
    'policies', v_policies,
    'release_flags', v_release_flags,
    'release_gates', v_release_gates,
    'configuration_counts', jsonb_build_object(
      'active_country_mappings', (
        select count(*)
        from affiliate_private.affiliate_country_code_mappings
        where status = 'active'
      ),
      'active_currencies', (
        select count(*)
        from affiliate_private.affiliate_currency_metadata
        where status = 'active'
      ),
      'active_payout_providers', (
        select count(*)
        from affiliate_private.affiliate_payout_provider_configs
        where status = 'active'
      ),
      'active_allowlist_entries', (
        select count(*)
        from affiliate_private.affiliate_pilot_allowlist
        where status = 'active'
          and (expires_at is null or expires_at > now())
      )
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- AAL2 boundary for capability and programme mutations.
-- ---------------------------------------------------------------------------

create or replace function affiliate_private.partners_require_aal2(
  p_operation text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception '% requires AAL2', p_operation
      using errcode = '42501';
  end if;
end;
$$;

alter function affiliate_private.admin_partners_capability_set(
  uuid, text, boolean, text
) rename to admin_partners_capability_set_pre_aal2_20260802;

create function affiliate_private.admin_partners_capability_set(
  p_user_id uuid,
  p_capability text,
  p_enabled boolean,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not affiliate_private.partners_can_manage_capabilities() then
    raise exception 'Partners capability manager role is required'
      using errcode = '42501';
  end if;
  perform affiliate_private.partners_require_aal2(
    'Partners capability mutation'
  );
  return affiliate_private.admin_partners_capability_set_pre_aal2_20260802(
    p_user_id,
    p_capability,
    p_enabled,
    p_justification
  );
end;
$$;

alter function affiliate_private.admin_partners_program_create(
  text, jsonb, text, text, timestamptz, text
) rename to admin_partners_program_create_pre_aal2_20260802;

create function affiliate_private.admin_partners_program_create(
  p_version_key text,
  p_payout_thresholds jsonb,
  p_terms_version text,
  p_disclosure_version text,
  p_effective_from timestamptz,
  p_justification text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners program mutation'
  );
  return affiliate_private.admin_partners_program_create_pre_aal2_20260802(
    p_version_key,
    p_payout_thresholds,
    p_terms_version,
    p_disclosure_version,
    p_effective_from,
    p_justification
  );
end;
$$;

alter function affiliate_private.admin_partners_program_activate(
  text, text, text
) rename to admin_partners_program_activate_pre_aal2_20260802;

create function affiliate_private.admin_partners_program_activate(
  p_version_key text,
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
  perform affiliate_private.partners_require_capability('support');
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners program mutation'
  );
  return affiliate_private.admin_partners_program_activate_pre_aal2_20260802(
    p_version_key,
    p_confirmation,
    p_justification
  );
end;
$$;

-- Recreate the public SQL shims after renaming the private implementations so
-- their dependency always resolves to the AAL2-checked entry point.
create or replace function public.admin_partners_capability_set(
  p_user_id uuid,
  p_capability text,
  p_enabled boolean,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_capability_set(
    p_user_id,
    p_capability,
    p_enabled,
    p_justification
  );
$$;

create or replace function public.admin_partners_program_create(
  p_version_key text,
  p_payout_thresholds jsonb,
  p_terms_version text,
  p_disclosure_version text,
  p_effective_from timestamptz,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_program_create(
    p_version_key,
    p_payout_thresholds,
    p_terms_version,
    p_disclosure_version,
    p_effective_from,
    p_justification
  );
$$;

create or replace function public.admin_partners_program_activate(
  p_version_key text,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_program_activate(
    p_version_key,
    p_confirmation,
    p_justification
  );
$$;

-- ---------------------------------------------------------------------------
-- Payout AAL2 audit: preserve dry-run workflows and close DRY -> LIVE.
-- ---------------------------------------------------------------------------

create or replace function
affiliate_private.guard_partners_payout_live_promotion_aal2()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.live_execution is false
    and new.live_execution is true
    and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
  then
    raise exception 'live payout cycle promotion requires AAL2'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists affiliate_payout_cycles_live_promotion_aal2
  on affiliate_private.affiliate_payout_cycles;
create trigger affiliate_payout_cycles_live_promotion_aal2
before update of live_execution
on affiliate_private.affiliate_payout_cycles
for each row
when (old.live_execution is false and new.live_execution is true)
execute function
  affiliate_private.guard_partners_payout_live_promotion_aal2();

-- ---------------------------------------------------------------------------
-- Explicit privilege matrix. Private version-pinned implementations and guard
-- helpers remain owner-only; API callers retain the historical public surface.
-- ---------------------------------------------------------------------------

revoke all on function
  affiliate_private.partners_require_aal2(text),
  affiliate_private.guard_partners_payout_live_promotion_aal2(),
  affiliate_private.admin_partners_capability_set_pre_aal2_20260802(
    uuid, text, boolean, text
  ),
  affiliate_private.admin_partners_program_create_pre_aal2_20260802(
    text, jsonb, text, text, timestamptz, text
  ),
  affiliate_private.admin_partners_program_activate_pre_aal2_20260802(
    text, text, text
  )
from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.admin_partners_overview(),
  affiliate_private.admin_partners_configuration(),
  affiliate_private.admin_partners_capability_set(
    uuid, text, boolean, text
  ),
  affiliate_private.admin_partners_program_create(
    text, jsonb, text, text, timestamptz, text
  ),
  affiliate_private.admin_partners_program_activate(text, text, text),
  public.admin_partners_capability_set(uuid, text, boolean, text),
  public.admin_partners_program_create(
    text, jsonb, text, text, timestamptz, text
  ),
  public.admin_partners_program_activate(text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  affiliate_private.admin_partners_overview(),
  affiliate_private.admin_partners_configuration(),
  affiliate_private.admin_partners_capability_set(
    uuid, text, boolean, text
  ),
  affiliate_private.admin_partners_program_create(
    text, jsonb, text, text, timestamptz, text
  ),
  affiliate_private.admin_partners_program_activate(text, text, text),
  public.admin_partners_capability_set(uuid, text, boolean, text),
  public.admin_partners_program_create(
    text, jsonb, text, text, timestamptz, text
  ),
  public.admin_partners_program_activate(text, text, text)
to authenticated;

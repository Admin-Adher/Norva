-- Norva Partners: require AAL2 for every sensitive Admin mutation.
--
-- The previous security migration protected capability and programme changes
-- and only the LIVE payout boundaries. This migration makes the RPC contract
-- uniform: payout-cycle creation and approval also require AAL2 for dry runs.
-- The existing payout implementation, including its live maker-checker rule,
-- remains version-pinned and is only reachable through the guarded wrapper.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Reassert the capability and programme boundaries on the current signatures.
-- There is no separate programme-update RPC: draft creation and activation are
-- the complete programme mutation surface exposed by the current schema.
-- ---------------------------------------------------------------------------

create or replace function affiliate_private.admin_partners_capability_set(
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

create or replace function affiliate_private.admin_partners_program_create(
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

create or replace function affiliate_private.admin_partners_program_activate(
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

-- ---------------------------------------------------------------------------
-- Version-pin the existing payout implementations and put AAL2 in front of
-- every create/approve call. The delegated functions retain validation,
-- advisory locks, idempotency, release gates and live maker-checker controls.
-- ---------------------------------------------------------------------------

alter function affiliate_private.admin_partners_payout_cycle_create(
  date, date, text, boolean, text, text
) rename to admin_partners_payout_cycle_create_pre_aal2_20260802;

create function affiliate_private.admin_partners_payout_cycle_create(
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_live_execution boolean,
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
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners payout cycle creation'
  );
  return
    affiliate_private.admin_partners_payout_cycle_create_pre_aal2_20260802(
      p_period_start,
      p_period_end,
      p_currency,
      p_live_execution,
      p_confirmation,
      p_justification
    );
end;
$$;

alter function affiliate_private.admin_partners_payout_cycle_approve(
  text, text, text
) rename to admin_partners_payout_cycle_approve_pre_aal2_20260802;

create function affiliate_private.admin_partners_payout_cycle_approve(
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
begin
  perform affiliate_private.partners_require_capability('finance');
  perform affiliate_private.partners_require_aal2(
    'Partners payout cycle approval'
  );
  return
    affiliate_private.admin_partners_payout_cycle_approve_pre_aal2_20260802(
      p_cycle_key,
      p_confirmation,
      p_justification
    );
end;
$$;

-- Renaming keeps the old function OIDs. Recreate every public shim so its
-- dependency resolves to the new AAL2-checked private entry point.
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

create or replace function public.admin_partners_payout_cycle_create(
  p_period_start date,
  p_period_end date,
  p_currency text,
  p_live_execution boolean,
  p_confirmation text,
  p_justification text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_payout_cycle_create(
    p_period_start,
    p_period_end,
    p_currency,
    p_live_execution,
    p_confirmation,
    p_justification
  );
$$;

create or replace function public.admin_partners_payout_cycle_approve(
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
  select affiliate_private.admin_partners_payout_cycle_approve(
    p_cycle_key,
    p_confirmation,
    p_justification
  );
$$;

-- ---------------------------------------------------------------------------
-- Explicit privilege matrix: version-pinned implementations stay owner-only;
-- the historical authenticated RPC signatures remain unchanged.
-- ---------------------------------------------------------------------------

revoke all on function
  affiliate_private.admin_partners_payout_cycle_create_pre_aal2_20260802(
    date, date, text, boolean, text, text
  ),
  affiliate_private.admin_partners_payout_cycle_approve_pre_aal2_20260802(
    text, text, text
  )
from public, anon, authenticated, service_role;

revoke all on function
  affiliate_private.admin_partners_capability_set(
    uuid, text, boolean, text
  ),
  affiliate_private.admin_partners_program_create(
    text, jsonb, text, text, timestamptz, text
  ),
  affiliate_private.admin_partners_program_activate(text, text, text),
  affiliate_private.admin_partners_payout_cycle_create(
    date, date, text, boolean, text, text
  ),
  affiliate_private.admin_partners_payout_cycle_approve(text, text, text),
  public.admin_partners_capability_set(uuid, text, boolean, text),
  public.admin_partners_program_create(
    text, jsonb, text, text, timestamptz, text
  ),
  public.admin_partners_program_activate(text, text, text),
  public.admin_partners_payout_cycle_create(
    date, date, text, boolean, text, text
  ),
  public.admin_partners_payout_cycle_approve(text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  affiliate_private.admin_partners_capability_set(
    uuid, text, boolean, text
  ),
  affiliate_private.admin_partners_program_create(
    text, jsonb, text, text, timestamptz, text
  ),
  affiliate_private.admin_partners_program_activate(text, text, text),
  affiliate_private.admin_partners_payout_cycle_create(
    date, date, text, boolean, text, text
  ),
  affiliate_private.admin_partners_payout_cycle_approve(text, text, text),
  public.admin_partners_capability_set(uuid, text, boolean, text),
  public.admin_partners_program_create(
    text, jsonb, text, text, timestamptz, text
  ),
  public.admin_partners_program_activate(text, text, text),
  public.admin_partners_payout_cycle_create(
    date, date, text, boolean, text, text
  ),
  public.admin_partners_payout_cycle_approve(text, text, text)
to authenticated;

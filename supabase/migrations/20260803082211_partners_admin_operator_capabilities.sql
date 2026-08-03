-- Norva Partners: make the Finance maker-checker operable from the audited
-- Admin surface without weakening the server-managed Admin boundary.
--
-- Capability managers can inspect the small set of current Admin operators
-- and delegate Support/Risk/Finance to a selected account. Enabling a
-- capability is restricted to a confirmed Admin; Finance additionally
-- requires a verified TOTP factor. Revocation deliberately remains possible
-- after an account is demoted or loses its factor so stale grants can always
-- be removed.

alter default privileges in schema affiliate_private
  revoke execute on functions from public;

-- JWT claims remain a necessary fail-closed boundary, but they are not a live
-- revocation source. Every Partners capability gate also re-reads the Auth row
-- so a ban, deletion, demotion or server-managed flag removal takes effect on
-- the next database statement even while an older access token is still valid.
create or replace function affiliate_private.partners_actor_is_live_admin(
  p_required_app_flag text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    auth.uid() is not null
    and coalesce(
      auth.jwt() -> 'app_metadata' ->> 'role' = 'admin',
      false
    )
    and exists (
      select 1
      from auth.users users
      where users.id = auth.uid()
        and users.deleted_at is null
        and (
          users.banned_until is null
          or users.banned_until < now()
        )
        and users.email_confirmed_at is not null
        and coalesce(users.raw_app_meta_data ->> 'role', '') = 'admin'
        and (
          p_required_app_flag is null
          or (
            p_required_app_flag in (
              'partners_capability_admin',
              'partners_release_manager'
            )
            and coalesce(
              users.raw_app_meta_data -> p_required_app_flag = 'true'::jsonb,
              false
            )
          )
        )
    );
$$;

create or replace function affiliate_private.partners_has_capability(
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    lower(btrim(coalesce(p_capability, ''))) in (
      'support',
      'risk',
      'finance'
    )
    and affiliate_private.partners_actor_is_live_admin(null)
    and exists (
      select 1
      from affiliate_private.affiliate_admin_capabilities capability
      where capability.user_id = auth.uid()
        and capability.capability = lower(btrim(p_capability))
        and capability.enabled
    )
    and (
      lower(btrim(p_capability)) <> 'finance'
      or exists (
        select 1
        from auth.mfa_factors factor
        where factor.user_id = auth.uid()
          and factor.factor_type = 'totp'
          and factor.status = 'verified'
      )
    );
$$;

create or replace function affiliate_private.partners_can_manage_capabilities()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    affiliate_private.partners_actor_is_live_admin(
      'partners_capability_admin'
    )
    and coalesce(
      (
        auth.jwt()
        -> 'app_metadata'
        -> 'partners_capability_admin'
      ) = 'true'::jsonb,
      false
    );
$$;

create or replace function affiliate_private.partners_is_release_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    affiliate_private.partners_actor_is_live_admin(
      'partners_release_manager'
    )
    and coalesce(
      (
        auth.jwt()
        -> 'app_metadata'
        -> 'partners_release_manager'
      ) = 'true'::jsonb,
      false
    );
$$;

-- An AAL2 JWT can outlive the verified factor that produced it. Sensitive
-- Partners mutations therefore require both the token assurance claim and a
-- currently verified TOTP factor in Auth.
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
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'
    or not exists (
      select 1
      from auth.mfa_factors factor
      where factor.user_id = auth.uid()
        and factor.factor_type = 'totp'
        and factor.status = 'verified'
    )
  then
    raise exception '% requires AAL2', p_operation
      using errcode = '42501';
  end if;
end;
$$;

create or replace function affiliate_private.partners_admin_operator_key(
  p_user_id uuid
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select 'op_' || encode(
    extensions.digest(
      'norva-partners-capability-operator:v1:' || p_user_id::text,
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function
affiliate_private.admin_partners_capability_operators()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_operators jsonb;
begin
  if not affiliate_private.partners_can_manage_capabilities() then
    raise exception 'Partners capability manager role is required'
      using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'operator_key', subject.operator_key,
        'email', subject.email,
        'is_admin', subject.is_admin,
        'account_active', subject.account_active,
        'email_confirmed', subject.email_confirmed,
        'totp_verified', subject.totp_verified,
        'capabilities', jsonb_build_object(
          'support', subject.support,
          'risk', subject.risk,
          'finance', subject.finance
        )
      )
      order by subject.is_admin desc, lower(subject.email), subject.user_id
    ),
    '[]'::jsonb
  )
  into v_operators
  from (
    select
      users.id as user_id,
      affiliate_private.partners_admin_operator_key(users.id)
        as operator_key,
      coalesce(nullif(users.email::text, ''), 'Compte sans e-mail') as email,
      coalesce(users.raw_app_meta_data ->> 'role', 'user') = 'admin'
        as is_admin,
      users.deleted_at is null
        and (users.banned_until is null or users.banned_until < now())
        as account_active,
      users.email_confirmed_at is not null as email_confirmed,
      exists (
        select 1
        from auth.mfa_factors factor
        where factor.user_id = users.id
          and factor.factor_type = 'totp'
          and factor.status = 'verified'
      ) as totp_verified,
      coalesce(bool_or(
        capability.capability = 'support' and capability.enabled
      ), false) as support,
      coalesce(bool_or(
        capability.capability = 'risk' and capability.enabled
      ), false) as risk,
      coalesce(bool_or(
        capability.capability = 'finance' and capability.enabled
      ), false) as finance
    from auth.users users
    left join affiliate_private.affiliate_admin_capabilities capability
      on capability.user_id = users.id
    where coalesce(users.raw_app_meta_data ->> 'role', 'user') = 'admin'
      or exists (
        select 1
        from affiliate_private.affiliate_admin_capabilities stale
        where stale.user_id = users.id
          and stale.enabled
      )
    group by users.id, users.email, users.raw_app_meta_data,
      users.email_confirmed_at, users.deleted_at, users.banned_until
  ) subject;

  return jsonb_build_object(
    'schema_version', 1,
    'operators', v_operators,
    'requirements', jsonb_build_object(
      'confirmed_admin', true,
      'active_admin', true,
      'finance_totp', true,
      'maker_checker_distinct_operators', 2
    )
  );
end;
$$;

create or replace function
affiliate_private.admin_partners_capability_set_by_operator_key(
  p_operator_key text,
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
declare
  v_operator_key text := lower(btrim(coalesce(p_operator_key, '')));
  v_user_id uuid;
begin
  if not affiliate_private.partners_can_manage_capabilities() then
    raise exception 'Partners capability manager role is required'
      using errcode = '42501';
  end if;
  perform affiliate_private.partners_require_aal2(
    'Partners capability mutation'
  );
  if v_operator_key !~ '^op_[0-9a-f]{64}$' then
    raise exception 'invalid capability operator key'
      using errcode = '22023';
  end if;

  select users.id
  into v_user_id
  from auth.users users
  where affiliate_private.partners_admin_operator_key(users.id)
      = v_operator_key
    and (
      coalesce(users.raw_app_meta_data ->> 'role', 'user') = 'admin'
      or exists (
        select 1
        from affiliate_private.affiliate_admin_capabilities stale
        where stale.user_id = users.id
          and stale.enabled
      )
    )
  limit 1;
  if v_user_id is null then
    raise exception 'capability operator is unavailable'
      using errcode = 'P0002';
  end if;

  return affiliate_private.admin_partners_capability_set(
    v_user_id,
    p_capability,
    p_enabled,
    p_justification
  );
end;
$$;

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
declare
  v_capability text := lower(btrim(coalesce(p_capability, '')));
begin
  if not affiliate_private.partners_can_manage_capabilities() then
    raise exception 'Partners capability manager role is required'
      using errcode = '42501';
  end if;
  perform affiliate_private.partners_require_aal2(
    'Partners capability mutation'
  );

  -- Hold the live manager row through the mutation so a concurrent ban,
  -- demotion or flag revocation cannot interleave after the authorization gate.
  perform 1
  from auth.users actor
  where actor.id = auth.uid()
    and actor.deleted_at is null
    and (actor.banned_until is null or actor.banned_until < now())
    and actor.email_confirmed_at is not null
    and coalesce(actor.raw_app_meta_data ->> 'role', '') = 'admin'
    and coalesce(
      actor.raw_app_meta_data -> 'partners_capability_admin' = 'true'::jsonb,
      false
    )
  for share;
  if not found then
    raise exception 'Partners capability manager role is required'
      using errcode = '42501';
  end if;

  if coalesce(p_enabled, false) then
    perform 1
    from auth.users users
    where users.id = p_user_id
      and users.deleted_at is null
      and (
        users.banned_until is null
        or users.banned_until < now()
      )
      and users.email_confirmed_at is not null
      and coalesce(users.raw_app_meta_data ->> 'role', '') = 'admin'
    for share;
    if not found then
      raise exception 'capability subject must be an active confirmed Admin'
        using errcode = '42501';
    end if;

    if v_capability = 'finance' then
      perform 1
      from auth.mfa_factors factor
      where factor.user_id = p_user_id
        and factor.factor_type = 'totp'
        and factor.status = 'verified'
      for share;
      if not found then
        raise exception 'Finance capability subject requires verified TOTP'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return affiliate_private.admin_partners_capability_set_pre_aal2_20260802(
    p_user_id,
    p_capability,
    p_enabled,
    p_justification
  );
end;
$$;

create or replace function public.admin_partners_capability_operators()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_capability_operators();
$$;

create or replace function public.admin_partners_capability_set_by_operator_key(
  p_operator_key text,
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
  select affiliate_private.admin_partners_capability_set_by_operator_key(
    p_operator_key,
    p_capability,
    p_enabled,
    p_justification
  );
$$;

revoke all on function
  affiliate_private.partners_actor_is_live_admin(text),
  affiliate_private.partners_admin_operator_key(uuid),
  affiliate_private.admin_partners_capability_operators(),
  affiliate_private.admin_partners_capability_set_by_operator_key(
    text, text, boolean, text
  ),
  public.admin_partners_capability_operators(),
  public.admin_partners_capability_set_by_operator_key(
    text, text, boolean, text
  )
from public, anon, authenticated, service_role;

grant execute on function
  affiliate_private.admin_partners_capability_operators(),
  affiliate_private.admin_partners_capability_set_by_operator_key(
    text, text, boolean, text
  ),
  public.admin_partners_capability_operators(),
  public.admin_partners_capability_set_by_operator_key(
    text, text, boolean, text
  )
to authenticated;

comment on function public.admin_partners_capability_operators() is
  'Capability-manager-only list of confirmed Admin readiness and delegated Partners capabilities. Never returns MFA secrets.';

comment on function public.admin_partners_capability_set_by_operator_key(
  text, text, boolean, text
) is
  'AAL2 capability mutation resolved from a domain-separated opaque operator key; Auth user ids never cross the Admin UI boundary.';

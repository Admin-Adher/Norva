begin;

-- A user who has not joined yet has no affiliate account row. In PL/pgSQL,
-- comparing the empty row's member_status with 'active' yields NULL. The Edge
-- contract intentionally accepts booleans only, so make the non-member state
-- explicit and fail closed instead of serializing JSON null.
create or replace function
affiliate_private.partners_service_bootstrap_v2(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_confirmed boolean := false;
  v_account affiliate_private.affiliate_accounts%rowtype;
  v_program affiliate_private.affiliate_program_versions%rowtype;
  v_link affiliate_private.affiliate_links%rowtype;
  v_partners_enabled boolean := false;
  v_invite_only boolean := true;
  v_cash_pilot_allowlist_only boolean := true;
  v_earnings_enabled boolean := false;
  v_credits_enabled boolean := false;
  v_payouts_live boolean := false;
  v_blocked boolean := false;
  v_cash_readiness jsonb;
begin
  if p_user_id is null then
    raise exception 'user id is required' using errcode = '22023';
  end if;
  select cloud_user.email_confirmed_at is not null
  into v_confirmed
  from auth.users cloud_user
  where cloud_user.id = p_user_id;
  if not found then
    raise exception 'Cloud user is unavailable' using errcode = 'P0002';
  end if;

  select
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_invite_only'
    ), true),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_cash_pilot_allowlist_only'
    ), true),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_earnings_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_credit_redemptions_enabled'
    ), false),
    coalesce(bool_or(flag.enabled) filter (
      where flag.key = 'partners_payouts_live'
    ), false)
  into
    v_partners_enabled,
    v_invite_only,
    v_cash_pilot_allowlist_only,
    v_earnings_enabled,
    v_credits_enabled,
    v_payouts_live
  from public.admin_feature_flags flag
  where flag.key in (
    'partners_enabled',
    'partners_invite_only',
    'partners_cash_pilot_allowlist_only',
    'partners_earnings_enabled',
    'partners_credit_redemptions_enabled',
    'partners_payouts_live'
  );

  select account.*
  into v_account
  from affiliate_private.affiliate_accounts account
  where account.user_id = p_user_id
    and account.status <> 'closed'
  order by account.created_at desc
  limit 1;
  if found then
    v_blocked := v_account.member_status in ('held', 'suspended', 'closed');
    if v_account.member_program_version_id is not null then
      select program.*
      into v_program
      from affiliate_private.affiliate_program_versions program
      where program.id = v_account.member_program_version_id;
    end if;
    select link.*
    into v_link
    from affiliate_private.affiliate_links link
    where link.account_id = v_account.id
      and link.status = 'active'
    order by link.created_at desc
    limit 1;
  else
    select program.*
    into v_program
    from affiliate_private.affiliate_program_versions program
    where program.status = 'active'
      and program.account_type = 'individual'
      and program.commission_rate_bps = 2000
      and program.attribution_window_days = 30
      and program.maturation_days = 45
      and program.effective_from <= now()
      and (
        program.effective_until is null
        or program.effective_until > now()
      )
    order by program.effective_from desc
    limit 1;
  end if;
  v_cash_readiness := affiliate_private.partners_cash_readiness(v_account.id);

  return jsonb_build_object(
    'schema_version', 2,
    'flags', jsonb_build_object(
      'partners_enabled', v_partners_enabled,
      'partners_invite_only', v_invite_only,
      'partners_cash_pilot_allowlist_only', v_cash_pilot_allowlist_only,
      'partners_earnings_enabled', v_earnings_enabled,
      'partners_credit_redemptions_enabled', v_credits_enabled,
      'partners_payouts_live', v_payouts_live
    ),
    'eligibility', jsonb_build_object(
      'visible', v_partners_enabled or v_account.id is not null,
      'eligible',
        v_partners_enabled
        and v_confirmed
        and not v_blocked
        and v_program.id is not null,
      'reason', case
        when not v_confirmed then 'email_unconfirmed'
        when v_blocked then 'account_blocked'
        when not v_partners_enabled then 'disabled'
        when v_program.id is null then 'program_unavailable'
        else 'available'
      end
    ),
    'membership', jsonb_build_object(
      'exists', v_account.id is not null,
      'status', coalesce(v_account.member_status, 'not_joined'),
      'joined_at', v_account.member_joined_at,
      'verification_status', v_account.verification_status
    ),
    'program', case
      when v_program.id is null then null
      else jsonb_build_object(
        'commission_rate_bps', v_program.commission_rate_bps,
        'attribution_window_days', v_program.attribution_window_days,
        'maturation_days', v_program.maturation_days,
        'terms_version', v_program.terms_version,
        'disclosure_version', v_program.disclosure_version
      )
    end,
    'link', case
      when v_link.id is null then null
      else jsonb_build_object(
        'status', v_link.status,
        'share_url', 'https://norva.tv/r/' || v_link.public_code,
        'created_at', v_link.created_at
      )
    end,
    'credit_readiness', jsonb_build_object(
      'ready', coalesce(
        v_account.member_status = 'active'
        and v_credits_enabled,
        false
      ),
      'reason', case
        when v_account.member_status is distinct from 'active'
          then 'membership_required'
        when not v_credits_enabled then 'credits_disabled'
        else null
      end
    ),
    'cash_readiness', v_cash_readiness
  );
end;
$$;

comment on function
affiliate_private.partners_service_bootstrap_v2(uuid) is
  'Returns the fail-closed Partners v2 bootstrap; non-member readiness is an explicit JSON boolean false.';

commit;

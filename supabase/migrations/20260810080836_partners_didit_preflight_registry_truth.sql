-- Keep the read-only guided checklist and the write-side certification gate on
-- the same approval-registry truth. The previous preflight only inspected the
-- historical gate boolean, so an expired, stale or unbound Privacy approval
-- could be presented as ready and then be rejected by the protected write.

create or replace function
affiliate_private.admin_partners_kyc_certification_preflight()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_privacy_approved boolean := false;
  v_coverage_open boolean := false;
  v_partners_membership_closed boolean := false;
  v_cash_payouts_closed boolean := false;
  v_tv_relay_closed boolean := false;
  v_revolut_api_closed boolean := false;
  v_aal2 boolean := false;
  v_fresh_aal2 boolean := false;
  v_iat_text text := coalesce(auth.jwt() ->> 'iat', '');
  v_issued_at timestamptz;
begin
  perform affiliate_private.partners_require_didit_certification_observer(
    'Didit certification preflight'
  );

  v_privacy_approved :=
    affiliate_private.partners_release_gate_approval_is_current(
      'privacy_approved',
      'preproduction'
    );
  v_coverage_open :=
    not affiliate_private.partners_release_gate_approval_is_current(
      'individual_verification_coverage_confirmed'
    );

  select coalesce((
    select not flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_enabled'
  ), false) into v_partners_membership_closed;
  select coalesce((
    select not flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_payouts_live'
  ), false) into v_cash_payouts_closed;
  select coalesce((
    select not flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_tv_relay_enabled'
  ), false) into v_tv_relay_closed;
  select coalesce((
    select not flag.enabled
    from public.admin_feature_flags flag
    where flag.key = 'partners_revolut_api_enabled'
  ), false) into v_revolut_api_closed;

  v_aal2 := auth.jwt() ->> 'aal' = 'aal2';
  if v_aal2 and v_iat_text ~ '^[0-9]{10}(?:\.[0-9]{1,6})?$' then
    begin
      v_issued_at := to_timestamp(v_iat_text::double precision);
      v_fresh_aal2 := v_issued_at >= now() - interval '10 minutes'
        and v_issued_at <= now() + interval '1 minute';
    exception when others then
      v_fresh_aal2 := false;
    end;
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'action', 'kyc_certification_preflight',
    'ready',
      v_privacy_approved
      and v_coverage_open
      and v_partners_membership_closed
      and v_cash_payouts_closed
      and v_tv_relay_closed
      and v_revolut_api_closed
      and v_fresh_aal2,
    'requirements', jsonb_build_object(
      'privacy_approved', v_privacy_approved,
      'coverage_open', v_coverage_open,
      'partners_membership_closed', v_partners_membership_closed,
      'cash_payouts_closed', v_cash_payouts_closed,
      'tv_relay_closed', v_tv_relay_closed,
      'revolut_api_closed', v_revolut_api_closed,
      'aal2', v_aal2,
      'fresh_aal2', v_fresh_aal2
    )
  );
end;
$$;

create or replace function public.admin_partners_kyc_certification_preflight()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select affiliate_private.admin_partners_kyc_certification_preflight();
$$;

revoke all on function
  affiliate_private.admin_partners_kyc_certification_preflight()
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.admin_partners_kyc_certification_preflight()
  to authenticated;

revoke all on function public.admin_partners_kyc_certification_preflight()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_partners_kyc_certification_preflight()
  to authenticated;

comment on function public.admin_partners_kyc_certification_preflight() is
  'Returns the same approval-registry and fail-closed readiness truth enforced by the protected live Didit certification write.';

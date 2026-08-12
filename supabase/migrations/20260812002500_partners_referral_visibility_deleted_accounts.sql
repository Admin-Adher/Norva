-- Deleted referred accounts remain pseudonymised in the immutable affiliate
-- audit trail, but they must not remain visible or counted in a member-facing
-- referral directory. Preserve the original display-number sequence so a
-- deletion never renumbers referrals that the member has already seen.

do $partners_referral_visibility_deleted_accounts$
declare
  v_oid regprocedure;
  v_definition text;
  v_rewritten text;
  v_expected text;
  v_replacement text;
  v_occurrences integer;
begin
  v_oid := to_regprocedure(
    'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
  );
  if v_oid is null then
    raise exception 'Partners referral visibility projection is unavailable'
      using errcode = '55000';
  end if;

  v_definition := replace(
    pg_get_functiondef(v_oid),
    chr(13) || chr(10),
    chr(10)
  );
  v_rewritten := v_definition;

  v_expected := E'where attribution.referrer_account_id = v_account_id;';
  v_replacement := E'where attribution.referrer_account_id = v_account_id\n    and attribution.referred_user_id is not null;';
  v_occurrences := (
    length(v_rewritten) - length(replace(v_rewritten, v_expected, ''))
  ) / length(v_expected);
  if v_occurrences <> 1 then
    raise exception 'Partners referral visible-total contract drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  v_expected := E'with numbered as materialized (\n    select row_number() over (';
  v_replacement := E'with numbered as materialized (\n    select\n      attribution.referred_user_id,\n      row_number() over (';
  v_occurrences := (
    length(v_rewritten) - length(replace(v_rewritten, v_expected, ''))
  ) / length(v_expected);
  if v_occurrences <> 1 then
    raise exception 'Partners referral continuation numbering contract drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  v_expected := E'where v_cursor_number is null\n      or numbered.referral_number < v_cursor_number';
  v_replacement := E'where numbered.referred_user_id is not null\n      and (\n        v_cursor_number is null\n        or numbered.referral_number < v_cursor_number\n      )';
  v_occurrences := (
    length(v_rewritten) - length(replace(v_rewritten, v_expected, ''))
  ) / length(v_expected);
  if v_occurrences <> 2 then
    raise exception 'Partners referral visible-page contract drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  execute v_rewritten;
end;
$partners_referral_visibility_deleted_accounts$;

alter function affiliate_private.partners_service_referral_visibility(
  uuid, integer, text
) owner to supabase_admin;
revoke all on function
  affiliate_private.partners_service_referral_visibility(uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_referral_visibility(uuid, integer, text)
  to service_role;

do $partners_referral_visibility_deleted_accounts_verify$
declare
  v_oid regprocedure;
  v_definition text;
begin
  v_oid := to_regprocedure(
    'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
  );
  select pg_get_functiondef(v_oid)
  into v_definition;

  if pg_get_userbyid((select proowner from pg_proc where oid = v_oid))
      <> 'supabase_admin'
    or not exists (
      select 1
      from pg_proc routine
      where routine.oid = v_oid
        and routine.prosecdef
        and routine.provolatile = 's'::"char"
        and 'search_path=""' = any(
          coalesce(routine.proconfig, '{}'::text[])
        )
    )
    or has_function_privilege(
      'anon',
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'affiliate_private.partners_service_referral_visibility(uuid,integer,text)',
      'EXECUTE'
    )
    or v_definition not like
      '%and attribution.referred_user_id is not null;%'
    or v_definition not like
      '%where numbered.referred_user_id is not null%'
  then
    raise exception 'Partners deleted-account visibility contract is invalid'
      using errcode = '55000';
  end if;
end;
$partners_referral_visibility_deleted_accounts_verify$;

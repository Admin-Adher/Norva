-- Norva Partners: display positions are a property of the current member-facing
-- directory, not an identifier for the immutable attribution audit trail.
-- Deleted accounts remain pseudonymised in affiliate_attributions, but are
-- excluded before row_number() so visible referrals are labelled #1, #2, ...
-- without gaps left by deleted accounts or operational canaries.

do $partners_referral_visible_numbering$
declare
  v_oid regprocedure;
  v_definition text;
  v_rewritten text;
  v_expected text;
  v_replacement text;
  v_occurrences integer;
  v_original_owner oid;
begin
  v_oid := to_regprocedure(
    'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
  );
  if v_oid is null then
    raise exception 'Partners referral visibility projection is unavailable'
      using errcode = '55000';
  end if;

  select proowner
  into v_original_owner
  from pg_proc
  where oid = v_oid;

  v_definition := replace(
    pg_get_functiondef(v_oid),
    chr(13) || chr(10),
    chr(10)
  );
  v_rewritten := v_definition;

  -- The total already excludes deleted accounts. The two numbered CTEs must
  -- apply the same predicate before assigning their visible display position.
  v_expected := E'where attribution.referrer_account_id = v_account_id\n  ),';
  v_replacement := E'where attribution.referrer_account_id = v_account_id\n      and attribution.referred_user_id is not null\n  ),';
  v_occurrences := (
    length(v_rewritten) - length(replace(v_rewritten, v_expected, ''))
  ) / length(v_expected);
  if v_occurrences <> 2 then
    raise exception 'Partners referral numbering source contract drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  -- The earlier privacy migration filtered candidates after row_number().
  -- Remove that now-redundant late filter from both page calculations.
  v_expected := E'where numbered.referred_user_id is not null\n      and (\n        v_cursor_number is null\n        or numbered.referral_number < v_cursor_number\n      )';
  v_replacement := E'where (\n      v_cursor_number is null\n      or numbered.referral_number < v_cursor_number\n    )';
  v_occurrences := (
    length(v_rewritten) - length(replace(v_rewritten, v_expected, ''))
  ) / length(v_expected);
  if v_occurrences <> 2 then
    raise exception 'Partners referral numbering page contract drifted'
      using errcode = '55000';
  end if;
  v_rewritten := replace(v_rewritten, v_expected, v_replacement);

  execute v_rewritten;

  if (select proowner from pg_proc where oid = v_oid)
      <> v_original_owner then
    raise exception 'Partners referral visibility owner changed during rewrite'
      using errcode = '55000';
  end if;
end;
$partners_referral_visible_numbering$;

-- CREATE OR REPLACE must preserve the pre-existing owner. Avoid a cross-role
-- transfer so both blank and partially applied database replays stay portable.
revoke all on function
  affiliate_private.partners_service_referral_visibility(uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function
  affiliate_private.partners_service_referral_visibility(uuid, integer, text)
  to service_role;

do $partners_referral_visible_numbering_verify$
declare
  v_oid regprocedure;
  v_definition text;
begin
  v_oid := to_regprocedure(
    'affiliate_private.partners_service_referral_visibility(uuid,integer,text)'
  );
  select lower(pg_get_functiondef(v_oid))
  into v_definition;

  if not exists (
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
    or regexp_count(
      v_definition,
      'and attribution\.referred_user_id is not null'
    ) <> 3
    or position(
      'where numbered.referred_user_id is not null' in v_definition
    ) > 0
  then
    raise exception 'Partners visible referral numbering contract is invalid'
      using errcode = '55000';
  end if;
end;
$partners_referral_visible_numbering_verify$;

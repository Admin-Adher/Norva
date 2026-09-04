-- Add inclusive source-count ranges without changing either RPC signature.
-- Legacy bucket filters remain compatible. No client records are modified.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
-- Admin Clients: exhaustive source-count and signup-location filters.
--
-- `p_country` remains the billing/storefront signal. `p_signup_country` is the
-- coarse Cloudflare edge country captured at signup. They deliberately remain
-- separate in the RPC contract and UI.


create or replace function public.admin_users_page(
  p_limit integer default 25,
  p_offset integer default 0,
  p_search text default null,
  p_sort text default 'created_desc',
  p_tag_id uuid default null,
  p_billing_status text default null,
  p_country text default null,
  p_source_bucket text default null,
  p_signup_country text default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_lim int := greatest(1, least(100, coalesce(p_limit, 25)));
  v_off int := greatest(0, coalesce(p_offset, 0));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_bs text := nullif(btrim(coalesce(p_billing_status, '')), '');
  v_cc text := nullif(upper(btrim(coalesce(p_country, ''))), '');
  v_source_bucket text := nullif(lower(btrim(coalesce(p_source_bucket, ''))), '');
  v_signup_cc text := nullif(upper(btrim(coalesce(p_signup_country, ''))), '');
  v_source_min integer;
  v_source_max integer;
  v_uuid uuid := null;
  v_total bigint;
  v_rows jsonb;
  v_alltags jsonb;
  v_countries jsonb;
  v_signup_countries jsonb;
  v_signup_country_missing bigint;
  v_source_buckets jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_source_bucket like 'range:%' then
    if v_source_bucket !~ '^range:[0-9]{0,6}:[0-9]{0,6}$' or v_source_bucket = 'range::' then
      raise exception 'invalid source count range' using errcode = '22023';
    end if;
    v_source_min := nullif(split_part(v_source_bucket, ':', 2), '')::integer;
    v_source_max := nullif(split_part(v_source_bucket, ':', 3), '')::integer;
    if v_source_min > v_source_max then
      raise exception 'invalid source count range' using errcode = '22023';
    end if;
  elsif v_source_bucket is not null and v_source_bucket not in ('0', '1', '2_3', '4_plus') then
    raise exception 'invalid source count filter' using errcode = '22023';
  end if;
  if v_signup_cc is not null and v_signup_cc <> '??' and v_signup_cc !~ '^[A-Z]{2}$' then
    raise exception 'invalid signup country filter' using errcode = '22023';
  end if;
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;

  select count(*) into v_total
  from auth.users u
  left join public.cloud_entitlement_projection pr on pr.user_id = u.id
  left join public.cloud_signup_attribution sa on sa.user_id = u.id
  left join lateral (
    select count(*)::int as n from public.cloud_sources s where s.user_id = u.id
  ) src on true
  where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
    and (p_tag_id is null or exists (
      select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id
    ))
    and (v_bs is null
      or (v_bs = 'trialing' and pr.status = 'trialing')
      or (v_bs = 'active' and pr.status = 'active')
      or (v_bs = 'past_due' and pr.status in ('past_due', 'grace'))
      or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
      or (v_bs = 'expired' and pr.status = 'expired')
      or (v_bs = 'free' and (pr.status is null or pr.status not in (
        'trialing','active','past_due','grace','cancelled_at_period_end','expired'
      ))))
    and (v_bs is null or v_bs = 'free' or u.id not in (
      select user_id from public.admin_internal_accounts
    ))
    and (v_cc is null or (v_cc = '??' and pr.country_code is null) or pr.country_code = v_cc)
    and (v_signup_cc is null
      or (v_signup_cc = '??' and sa.country_code is null)
      or sa.country_code = v_signup_cc)
    and (v_source_bucket is null
      or (v_source_bucket = '0' and src.n = 0)
      or (v_source_bucket = '1' and src.n = 1)
      or (v_source_bucket = '2_3' and src.n between 2 and 3)
      or (v_source_bucket = '4_plus' and src.n >= 4)
      or (v_source_bucket like 'range:%'
        and (v_source_min is null or src.n >= v_source_min)
        and (v_source_max is null or src.n <= v_source_max)));

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id as user_id,
           u.email::text as email,
           u.created_at,
           u.last_sign_in_at,
           (u.email_confirmed_at is not null) as email_confirmed,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           coalesce(u.raw_app_meta_data ->> 'role', 'user') as role,
           (u.id in (select user_id from public.admin_enrichment_accounts)) as is_driver,
           (u.id in (select user_id from public.admin_internal_accounts)) as is_internal,
           pr.status as billing_status,
           pr.plan_code as plan_code,
           pr.country_code as country_code,
           pr.country_source as country_source,
           src.n as sources_count,
           (select coalesce(jsonb_agg(
              jsonb_build_object('id', tg.id, 'label', tg.label, 'color', tg.color)
              order by tg.label
            ), '[]'::jsonb)
            from public.admin_client_tags ctg
            join public.admin_tags tg on tg.id = ctg.tag_id
            where ctg.user_id = u.id) as tags
    from auth.users u
    left join public.cloud_entitlement_projection pr on pr.user_id = u.id
    left join public.cloud_signup_attribution sa on sa.user_id = u.id
    left join lateral (
      select count(*)::int as n from public.cloud_sources s where s.user_id = u.id
    ) src on true
    where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
      and (p_tag_id is null or exists (
        select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id
      ))
      and (v_bs is null
        or (v_bs = 'trialing' and pr.status = 'trialing')
        or (v_bs = 'active' and pr.status = 'active')
        or (v_bs = 'past_due' and pr.status in ('past_due', 'grace'))
        or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
        or (v_bs = 'expired' and pr.status = 'expired')
        or (v_bs = 'free' and (pr.status is null or pr.status not in (
          'trialing','active','past_due','grace','cancelled_at_period_end','expired'
        ))))
      and (v_bs is null or v_bs = 'free' or u.id not in (
        select user_id from public.admin_internal_accounts
      ))
      and (v_cc is null or (v_cc = '??' and pr.country_code is null) or pr.country_code = v_cc)
      and (v_signup_cc is null
        or (v_signup_cc = '??' and sa.country_code is null)
        or sa.country_code = v_signup_cc)
      and (v_source_bucket is null
        or (v_source_bucket = '0' and src.n = 0)
        or (v_source_bucket = '1' and src.n = 1)
        or (v_source_bucket = '2_3' and src.n between 2 and 3)
        or (v_source_bucket = '4_plus' and src.n >= 4)
      or (v_source_bucket like 'range:%'
        and (v_source_min is null or src.n >= v_source_min)
        and (v_source_max is null or src.n <= v_source_max)))
    order by
      (case when p_sort = 'active_desc' then u.last_sign_in_at end) desc nulls last,
      (case when p_sort = 'email_asc' then u.email end) asc,
      (case when p_sort = 'created_asc' then u.created_at end) asc,
      u.created_at desc
    limit v_lim offset v_off
  ) t;

  select coalesce(jsonb_agg(
    jsonb_build_object('id', id, 'label', label, 'color', color) order by label
  ), '[]'::jsonb) into v_alltags
  from public.admin_tags;

  select coalesce(jsonb_agg(
    jsonb_build_object('country_code', cc, 'n', n) order by n desc, cc
  ), '[]'::jsonb) into v_countries
  from (
    select pr.country_code as cc, count(*)::int as n
    from public.cloud_entitlement_projection pr
    where pr.country_code is not null
    group by 1
  ) t;

  select coalesce(jsonb_agg(
    jsonb_build_object('country_code', cc, 'n', n) order by n desc, cc
  ), '[]'::jsonb) into v_signup_countries
  from (
    select sa.country_code as cc, count(*)::int as n
    from public.cloud_signup_attribution sa
    where sa.country_code is not null
    group by 1
  ) t;

  select count(*) into v_signup_country_missing
  from auth.users u
  left join public.cloud_signup_attribution sa on sa.user_id = u.id
  where sa.country_code is null;

  select jsonb_build_object(
    '0', count(*) filter (where src.n = 0),
    '1', count(*) filter (where src.n = 1),
    '2_3', count(*) filter (where src.n between 2 and 3),
    '4_plus', count(*) filter (where src.n >= 4)
  ) into v_source_buckets
  from auth.users u
  left join lateral (
    select count(*)::int as n from public.cloud_sources s where s.user_id = u.id
  ) src on true;

  return jsonb_build_object(
    'total', v_total,
    'limit', v_lim,
    'offset', v_off,
    'rows', v_rows,
    'all_tags', v_alltags,
    'countries', v_countries,
    'signup_countries', v_signup_countries,
    'signup_country_missing', v_signup_country_missing,
    'source_buckets', v_source_buckets
  );
end;
$function$;

revoke all on function public.admin_users_page(
  integer, integer, text, text, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.admin_users_page(
  integer, integer, text, text, uuid, text, text, text, text
) to authenticated, service_role;


create or replace function public.admin_users_export(
  p_search text default null,
  p_tag_id uuid default null,
  p_billing_status text default null,
  p_limit integer default 10000,
  p_country text default null,
  p_source_bucket text default null,
  p_signup_country text default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_lim int := greatest(1, least(10000, coalesce(p_limit, 10000)));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_bs text := nullif(btrim(coalesce(p_billing_status, '')), '');
  v_cc text := nullif(upper(btrim(coalesce(p_country, ''))), '');
  v_source_bucket text := nullif(lower(btrim(coalesce(p_source_bucket, ''))), '');
  v_signup_cc text := nullif(upper(btrim(coalesce(p_signup_country, ''))), '');
  v_source_min integer;
  v_source_max integer;
  v_uuid uuid := null;
  v_rows jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_source_bucket like 'range:%' then
    if v_source_bucket !~ '^range:[0-9]{0,6}:[0-9]{0,6}$' or v_source_bucket = 'range::' then
      raise exception 'invalid source count range' using errcode = '22023';
    end if;
    v_source_min := nullif(split_part(v_source_bucket, ':', 2), '')::integer;
    v_source_max := nullif(split_part(v_source_bucket, ':', 3), '')::integer;
    if v_source_min > v_source_max then
      raise exception 'invalid source count range' using errcode = '22023';
    end if;
  elsif v_source_bucket is not null and v_source_bucket not in ('0', '1', '2_3', '4_plus') then
    raise exception 'invalid source count filter' using errcode = '22023';
  end if;
  if v_signup_cc is not null and v_signup_cc <> '??' and v_signup_cc !~ '^[A-Z]{2}$' then
    raise exception 'invalid signup country filter' using errcode = '22023';
  end if;
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id as user_id,
           u.email::text as email,
           coalesce(u.raw_app_meta_data ->> 'role', 'user') as role,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           (u.email_confirmed_at is not null) as email_confirmed,
           u.created_at,
           u.last_sign_in_at,
           pr.status as billing_status,
           pr.plan_code as plan_code,
           pr.country_code as country_code,
           pr.country_source as country_source,
           c.period as billing_period,
           c.amount_cents as amount_cents,
           src.n as sources_count,
           (select coalesce(string_agg(tg.label, '|' order by tg.label), '')
            from public.admin_client_tags ctg
            join public.admin_tags tg on tg.id = ctg.tag_id
            where ctg.user_id = u.id) as tags
    from auth.users u
    left join public.cloud_entitlement_projection pr on pr.user_id = u.id
    left join public.cloud_stancer_customers c on c.user_id = u.id
    left join public.cloud_signup_attribution sa on sa.user_id = u.id
    left join lateral (
      select count(*)::int as n from public.cloud_sources s where s.user_id = u.id
    ) src on true
    where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
      and (p_tag_id is null or exists (
        select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id
      ))
      and (v_bs is null
        or (v_bs = 'trialing' and pr.status = 'trialing')
        or (v_bs = 'active' and pr.status = 'active')
        or (v_bs = 'past_due' and pr.status in ('past_due', 'grace'))
        or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
        or (v_bs = 'expired' and pr.status = 'expired')
        or (v_bs = 'free' and (pr.status is null or pr.status not in (
          'trialing','active','past_due','grace','cancelled_at_period_end','expired'
        ))))
      and (v_bs is null or v_bs = 'free' or u.id not in (select user_id from public.admin_internal_accounts))
      and (v_cc is null or (v_cc = '??' and pr.country_code is null) or pr.country_code = v_cc)
      and (v_signup_cc is null
        or (v_signup_cc = '??' and sa.country_code is null)
        or sa.country_code = v_signup_cc)
      and (v_source_bucket is null
        or (v_source_bucket = '0' and src.n = 0)
        or (v_source_bucket = '1' and src.n = 1)
        or (v_source_bucket = '2_3' and src.n between 2 and 3)
        or (v_source_bucket = '4_plus' and src.n >= 4)
      or (v_source_bucket like 'range:%'
        and (v_source_min is null or src.n >= v_source_min)
        and (v_source_max is null or src.n <= v_source_max)))
    order by u.created_at desc
    limit v_lim
  ) t;
  return v_rows;
end;
$function$;

revoke all on function public.admin_users_export(
  text, uuid, text, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.admin_users_export(
  text, uuid, text, integer, text, text, text
) to authenticated, service_role;

comment on function public.admin_users_page(
  integer, integer, text, text, uuid, text, text, text, text
) is 'Admin CRM page. Billing country, signup country and source-count filters are independent and exhaustive.';

comment on function public.admin_users_export(
  text, uuid, text, integer, text, text, text
) is 'Admin CRM CSV export with the same billing-country, signup-country and source-count filters as the paginated list.';

notify pgrst, 'reload schema';
commit;

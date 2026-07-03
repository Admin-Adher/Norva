-- Admin CRM P0 lot (ADMIN-CRM-AUDIT.md Part D) — the CRM finally sees the business.
--
--  1) admin_finance()            — live finance aggregates: MRR/ARR by plan/period/rail, status
--                                  counts, cash collected 30d, upcoming charges, funnel 30d,
--                                  cancel reasons & saves, 50 most recent payments.
--  2) admin_user_billing(uuid)   — the fiche's "Subscription & payments" panel: projection +
--                                  mapping + payment history + email stamps + cancel feedback.
--  3) admin_users_page/export    — +billing_status/plan_code columns and a p_billing_status
--                                  filter (the daily working views: past_due list, trials list).
--  4) admin_client_crm           — timeline now carries the client's REAL life events: checkout,
--                                  card validated, charges, plan changes, cancellations (+reason),
--                                  accepted save offers, trial start.
--  5) refresh_admin_dashboard    — overview gains billing counters (for the Cockpit "Revenus"
--                                  group + billing ops-alerts) and watch-based activity counters;
--                                  crons: 'billing'/'lifecycle' kinds + 'continu' window (the two
--                                  revenue-critical jobs were classified 'autre / —').

-- ── 1) admin_finance ────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_finance()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  with paying as (
    select p.user_id, p.status, p.provider, coalesce(p.plan_code, 'plus') as plan_code,
           c.period, c.amount_cents,
           case when c.amount_cents is null then null
                when c.period = 'annual' then round(c.amount_cents / 12.0)
                else c.amount_cents end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_stancer_customers c on c.user_id = p.user_id
    where p.status in ('active', 'past_due', 'grace', 'cancelled_at_period_end')
  ), trialers as (
    select p.user_id, coalesce(p.plan_code, 'plus') as plan_code, p.provider, p.trial_ends_at,
           c.period, c.amount_cents,
           case when c.amount_cents is null then null
                when c.period = 'annual' then round(c.amount_cents / 12.0)
                else c.amount_cents end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_stancer_customers c on c.user_id = p.user_id
    where p.status = 'trialing'
  )
  select jsonb_build_object(
    'refreshed_at', now(),
    'users_total', (select count(*) from auth.users),
    'mrr_cents', (select coalesce(sum(mrr_cents), 0) from paying),
    'arr_cents', (select coalesce(sum(mrr_cents), 0) * 12 from paying),
    'mrr_trial_cents', (select coalesce(sum(mrr_cents), 0) from trialers),
    'mrr_unknown_n', (select count(*) from paying where mrr_cents is null),
    'counts', jsonb_build_object(
      'trialing', (select count(*) from trialers),
      'active', (select count(*) from paying where status = 'active'),
      'past_due', (select count(*) from paying where status in ('past_due', 'grace')),
      'cancel_pending', (select count(*) from paying where status = 'cancelled_at_period_end'),
      'expired', (select count(*) from cloud_entitlement_projection where status = 'expired')
    ),
    'by_plan', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last), '[]'::jsonb) from (
      select plan_code, coalesce(period, '—') as period, coalesce(provider, '—') as provider,
             count(*)::int as n, coalesce(sum(mrr_cents), 0)::bigint as mrr_cents
      from paying group by 1, 2, 3
    ) t),
    'dunning', (select coalesce(jsonb_agg(row_to_json(t) order by t.stage), '[]'::jsonb) from (
      select coalesce(dunning_stage, 0) as stage, count(*)::int as n
      from cloud_entitlement_projection where status in ('past_due', 'grace') group by 1
    ) t),
    'collected_30d_cents', (select coalesce(sum(amount), 0) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'),
    'collected_30d_n', (select count(*) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'),
    'upcoming', jsonb_build_object(
      'trial_charges_48h_n', (select count(*) from trialers where trial_ends_at < now() + interval '48 hours'),
      'trial_charges_48h_cents', (select coalesce(sum(amount_cents), 0) from trialers where trial_ends_at < now() + interval '48 hours'),
      'renewals_7d_n', (select count(*) from cloud_entitlement_projection p2
        join cloud_stancer_customers c2 on c2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days'),
      'renewals_7d_cents', (select coalesce(sum(c2.amount_cents), 0) from cloud_entitlement_projection p2
        join cloud_stancer_customers c2 on c2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days')
    ),
    'funnel_30d', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select stage, sum(users)::int as users from public.norva_funnel_daily
      where day > (now() - interval '30 days')::date group by stage
    ) t),
    'conversions_7d', (select count(distinct user_id) from cloud_stancer_payments
      where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'),
    'cancel_reasons', (select coalesce(jsonb_agg(row_to_json(t) order by t.n desc), '[]'::jsonb) from (
      select reason, count(*)::int as n from cloud_cancel_feedback where action = 'cancelled' group by 1
    ) t),
    'cancels_total', (select count(*) from cloud_cancel_feedback where action = 'cancelled'),
    'saves_total', (select count(*) from cloud_cancel_feedback where action = 'saved'),
    'discounts_pending', (select count(*) from cloud_stancer_customers where discount_next_pct is not null),
    'recent_payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select sp.pi_id, sp.user_id, u.email::text as email, sp.kind, sp.amount, sp.currency,
             sp.status, coalesce(sp.updated_at, sp.created_at) as at
      from cloud_stancer_payments sp left join auth.users u on u.id = sp.user_id
      order by coalesce(sp.updated_at, sp.created_at) desc limit 50
    ) t)
  ) into v;
  return v;
end; $$;
revoke all on function public.admin_finance() from public, anon;
grant execute on function public.admin_finance() to authenticated;

-- ── 2) admin_user_billing ───────────────────────────────────────────────────────────────────────
create or replace function public.admin_user_billing(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'projection', (select to_jsonb(t) from (
      select status, provider, plan_code, trial_ends_at, trial_consumed_at, current_period_end,
             dunning_stage, dunning_last_at, last_event_at,
             welcome_email_at, trial_reminder_email_at, winback_email_at
      from cloud_entitlement_projection where user_id = p_user_id
    ) t),
    'mapping', (select to_jsonb(t) from (
      select plan, period, amount_cents, card_last4, card_exp, discount_next_pct, save_offer_used_at
      from cloud_stancer_customers where user_id = p_user_id
    ) t),
    'payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select pi_id, kind, amount, currency, status, created_at, updated_at
      from cloud_stancer_payments where user_id = p_user_id
      order by coalesce(updated_at, created_at) desc limit 100
    ) t),
    'cancel_feedback', (select coalesce(jsonb_agg(row_to_json(t) order by t.created_at desc), '[]'::jsonb) from (
      select reason, action, offer, status_at, created_at
      from cloud_cancel_feedback where user_id = p_user_id
    ) t)
  );
end; $$;
revoke all on function public.admin_user_billing(uuid) from public, anon;
grant execute on function public.admin_user_billing(uuid) to authenticated;

-- ── 3a) admin_users_page: +billing columns + p_billing_status filter ────────────────────────────
drop function if exists public.admin_users_page(int, int, text, text, uuid);
create or replace function public.admin_users_page(
  p_limit  int  default 25,
  p_offset int  default 0,
  p_search text default null,
  p_sort   text default 'created_desc',
  p_tag_id uuid default null,
  p_billing_status text default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_lim    int    := greatest(1, least(100, coalesce(p_limit, 25)));
  v_off    int    := greatest(0, coalesce(p_offset, 0));
  v_search text   := nullif(btrim(coalesce(p_search, '')), '');
  v_bs     text   := nullif(btrim(coalesce(p_billing_status, '')), '');
  v_uuid   uuid   := null;
  v_total  bigint;
  v_rows   jsonb;
  v_alltags jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;

  select count(*) into v_total
  from auth.users u
  left join public.cloud_entitlement_projection pr on pr.user_id = u.id
  where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
    and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id))
    and (v_bs is null
      or (v_bs = 'trialing'       and pr.status = 'trialing')
      or (v_bs = 'active'         and pr.status = 'active')
      or (v_bs = 'past_due'       and pr.status in ('past_due', 'grace'))
      or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
      or (v_bs = 'expired'        and pr.status = 'expired')
      or (v_bs = 'free'           and (pr.status is null or pr.status not in ('trialing','active','past_due','grace','cancelled_at_period_end','expired'))));

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           u.created_at,
           u.last_sign_in_at,
           (u.email_confirmed_at is not null)                as email_confirmed,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.id in (select user_id from public.admin_enrichment_accounts)) as is_driver,
           pr.status                                         as billing_status,
           pr.plan_code                                      as plan_code,
           (select count(*) from public.cloud_sources s where s.user_id = u.id) as sources_count,
           (select coalesce(jsonb_agg(jsonb_build_object('id',tg.id,'label',tg.label,'color',tg.color) order by tg.label), '[]'::jsonb)
              from public.admin_client_tags ctg join public.admin_tags tg on tg.id = ctg.tag_id where ctg.user_id = u.id) as tags
    from auth.users u
    left join public.cloud_entitlement_projection pr on pr.user_id = u.id
    where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
      and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id))
      and (v_bs is null
        or (v_bs = 'trialing'       and pr.status = 'trialing')
        or (v_bs = 'active'         and pr.status = 'active')
        or (v_bs = 'past_due'       and pr.status in ('past_due', 'grace'))
        or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
        or (v_bs = 'expired'        and pr.status = 'expired')
        or (v_bs = 'free'           and (pr.status is null or pr.status not in ('trialing','active','past_due','grace','cancelled_at_period_end','expired'))))
    order by
      (case when p_sort = 'active_desc' then u.last_sign_in_at end) desc nulls last,
      (case when p_sort = 'email_asc'   then u.email           end) asc,
      (case when p_sort = 'created_asc' then u.created_at      end) asc,
      u.created_at desc
    limit v_lim offset v_off
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'color',color) order by label), '[]'::jsonb)
    into v_alltags from public.admin_tags;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'rows', v_rows, 'all_tags', v_alltags);
end;
$$;
revoke all on function public.admin_users_page(int, int, text, text, uuid, text) from public, anon;
grant execute on function public.admin_users_page(int, int, text, text, uuid, text) to authenticated;

-- ── 3b) admin_users_export: +billing columns + same filter ──────────────────────────────────────
drop function if exists public.admin_users_export(text, uuid, int);
create or replace function public.admin_users_export(
  p_search text default null,
  p_tag_id uuid default null,
  p_billing_status text default null,
  p_limit  int  default 10000
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_lim    int  := greatest(1, least(10000, coalesce(p_limit, 10000)));
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_bs     text := nullif(btrim(coalesce(p_billing_status, '')), '');
  v_uuid   uuid := null;
  v_rows   jsonb;
begin
  if not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_search ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := v_search::uuid;
  end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select u.id                                              as user_id,
           u.email::text                                     as email,
           coalesce(u.raw_app_meta_data ->> 'role', 'user')  as role,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           (u.email_confirmed_at is not null)                as email_confirmed,
           u.created_at,
           u.last_sign_in_at,
           pr.status                                         as billing_status,
           pr.plan_code                                      as plan_code,
           c.period                                          as billing_period,
           c.amount_cents                                    as amount_cents,
           (select count(*) from public.cloud_sources s where s.user_id = u.id) as sources_count,
           (select coalesce(string_agg(tg.label, '|' order by tg.label), '')
              from public.admin_client_tags ctg join public.admin_tags tg on tg.id = ctg.tag_id
              where ctg.user_id = u.id) as tags
    from auth.users u
    left join public.cloud_entitlement_projection pr on pr.user_id = u.id
    left join public.cloud_stancer_customers c on c.user_id = u.id
    where (v_search is null or u.email ilike '%' || v_search || '%' or u.id = v_uuid)
      and (p_tag_id is null or exists (select 1 from public.admin_client_tags ct where ct.user_id = u.id and ct.tag_id = p_tag_id))
      and (v_bs is null
        or (v_bs = 'trialing'       and pr.status = 'trialing')
        or (v_bs = 'active'         and pr.status = 'active')
        or (v_bs = 'past_due'       and pr.status in ('past_due', 'grace'))
        or (v_bs = 'cancel_pending' and pr.status = 'cancelled_at_period_end')
        or (v_bs = 'expired'        and pr.status = 'expired')
        or (v_bs = 'free'           and (pr.status is null or pr.status not in ('trialing','active','past_due','grace','cancelled_at_period_end','expired'))))
    order by u.created_at desc
    limit v_lim
  ) t;
  return v_rows;
end;
$$;
revoke all on function public.admin_users_export(text, uuid, text, int) from public, anon;
grant execute on function public.admin_users_export(text, uuid, text, int) to authenticated;

-- ── 4) admin_client_crm: the timeline carries the client's REAL life events ─────────────────────
create or replace function public.admin_client_crm(p_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_tags jsonb; v_all jsonb; v_notes jsonb; v_timeline jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'label',t.label,'color',t.color) order by t.label), '[]'::jsonb)
    into v_tags from public.admin_client_tags ct join public.admin_tags t on t.id=ct.tag_id where ct.user_id=p_user_id;

  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'label',t.label,'color',t.color) order by t.label), '[]'::jsonb)
    into v_all from public.admin_tags t;

  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'author_email',n.author_email,'created_at',n.created_at) order by n.created_at desc), '[]'::jsonb)
    into v_notes from public.admin_notes n where n.user_id=p_user_id;

  select coalesce(jsonb_agg(row_to_json(e) order by e.at desc), '[]'::jsonb) into v_timeline from (
    select 'signup' as kind, 'Compte créé' as summary, u.created_at as at, '{}'::jsonb as meta
      from auth.users u where u.id=p_user_id
    union all
    select 'provider_added', 'Provider ajouté : '||coalesce(s.display_name, left(s.id::text,8)), s.created_at,
           jsonb_build_object('source_id', s.id)
      from cloud_sources s where s.user_id=p_user_id
    union all
    select 'sync', 'Dernier sync : '||coalesce(s.display_name, left(s.id::text,8)), s.last_synced_at,
           jsonb_build_object('source_id', s.id)
      from cloud_sources s where s.user_id=p_user_id and s.last_synced_at is not null
    union all
    -- Billing life events, read straight from the payment journal (no extra writes needed).
    select 'billing',
           case
             when sp.kind = 'trial_setup' and sp.status in ('authorized','captured','to_capture') then 'Carte validée — essai configuré'
             when sp.kind = 'trial_setup'  then 'Checkout essai ouvert ('||sp.status||')'
             when sp.kind = 'first_charge' and sp.status = 'captured' then 'Premier prélèvement — '||to_char(sp.amount/100.0,'FM990.00')||' $'
             when sp.kind = 'renewal'      and sp.status = 'captured' then 'Renouvellement — '||to_char(sp.amount/100.0,'FM990.00')||' $'
             when sp.kind = 'card_update'  then 'Moyen de paiement mis à jour ('||sp.status||')'
             when sp.kind = 'plan_change'  then 'Changement de plan ('||sp.status||')'
             when sp.kind = 'resubscribe'  then 'Réabonnement ('||sp.status||')'
             else sp.kind||' — '||sp.status
           end,
           coalesce(sp.updated_at, sp.created_at),
           jsonb_build_object('pi_id', sp.pi_id, 'amount', sp.amount, 'status', sp.status)
      from cloud_stancer_payments sp where sp.user_id=p_user_id
    union all
    select 'trial_started', 'Essai 7 jours démarré', p2.trial_consumed_at, '{}'::jsonb
      from cloud_entitlement_projection p2 where p2.user_id=p_user_id and p2.trial_consumed_at is not null
    union all
    select case when cf.action='saved' then 'saved' else 'cancelled' end,
           case when cf.action='saved' then 'Contre-offre acceptée ('||coalesce(cf.offer,'—')||') — raison : '||cf.reason
                else 'Annulation — raison : '||cf.reason end,
           cf.created_at, jsonb_build_object('status_at', cf.status_at)
      from cloud_cancel_feedback cf where cf.user_id=p_user_id
    union all
    select ev.kind, ev.summary, ev.created_at, ev.meta from public.admin_events ev where ev.user_id=p_user_id
    order by at desc nulls last
    limit 60
  ) e;

  return jsonb_build_object('tags', v_tags, 'all_tags', v_all, 'notes', v_notes, 'timeline', v_timeline);
end; $$;

-- ── 5) refresh_admin_dashboard: billing + watching counters, cron reclassification ──────────────
-- Verbatim re-emission of 20260703150000 with: overview += users_watching_*, billing_* block;
-- cron window += 'continu' (schedules with no hour range, e.g. '23 * * * *', '*/15 * * * *');
-- cron kind += 'billing' / 'lifecycle' (they classified as 'autre' — invisible as revenue jobs).
create or replace function public.refresh_admin_dashboard()
returns timestamptz language plpgsql security definer set search_path = public, cron as $$
declare ov jsonb; src jsonb; cov jsonb; crn jsonb;
begin
  set local statement_timeout to '180s';
  set local work_mem to '64MB';

  with tc as (
    select v.source_id, t2.item_type, count(*)::bigint as n
    from cloud_titles t2
    join cloud_title_variants v on v.id = t2.default_variant_id
    where t2.variant_count > 0 and t2.item_type in ('movie','series')
    group by 1, 2
  ), vc as (
    select source_id, count(*)::bigint as n from cloud_title_variants group by 1
  ), mc as (
    select source_id, count(*)::bigint as n,
           count(*) filter (where item_type in ('movie','series'))::bigint as n_ms
    from cloud_media_items group by 1
  ), tt as (
    select item_type, count(*)::bigint as n
    from cloud_titles where variant_count > 0 and item_type in ('movie','series')
    group by 1
  ), src_rows as (
    select s.id as source_id, s.user_id as user_id, u.email::text as owner_email,
           coalesce(s.display_name, left(s.id::text, 8)) as display_name,
           s.sync_status, s.sync_error, s.catalog_version, s.created_at, s.last_synced_at,
           coalesce(mc.n, 0)  as media_items,
           coalesce(vc.n, 0)  as variants,
           coalesce(tcm.n, 0) as movie_titles,
           coalesce(tcs.n, 0) as series_titles,
           (coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0) as incomplete,
           pi.id as identity_id, pi.display_name::text as identity_name,
           (s.user_id in (select user_id from public.admin_enrichment_accounts)) as is_driver
    from cloud_sources s
    left join auth.users u on u.id = s.user_id
    left join mc on mc.source_id = s.id
    left join vc on vc.source_id = s.id
    left join tc tcm on tcm.source_id = s.id and tcm.item_type = 'movie'
    left join tc tcs on tcs.source_id = s.id and tcs.item_type = 'series'
    left join catalog_provider_identities cpi on cpi.provider_key = (select cpi2.provider_key from catalog_provider_identities cpi2 where cpi2.display_name = s.display_name and cpi2.status = 'active' limit 1)
    left join provider_identities pi on pi.id = cpi.identity_id
    where s.user_id in (select user_id from public.admin_enrichment_accounts)
       or s.sync_status = 'sync_error' or s.sync_error is not null
       or (exists (select 1 from cloud_media_items m where m.source_id = s.id and m.item_type in ('movie','series'))
           and not exists (select 1 from cloud_title_variants v2 where v2.source_id = s.id))
    order by (s.user_id in (select user_id from public.admin_enrichment_accounts)) desc, s.created_at
    limit 300
  )
  select
    jsonb_build_object(
      'users_total',(select count(*) from auth.users),
      'users_active_7d',(select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
      'users_active_24h',(select count(*) from auth.users where last_sign_in_at > now() - interval '24 hours'),
      'users_active_30d',(select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
      'users_new_7d',(select count(*) from auth.users where created_at > now() - interval '7 days'),
      'users_new_30d',(select count(*) from auth.users where created_at > now() - interval '30 days'),
      'users_watching_24h',(select count(distinct user_id) from cloud_watch_history where updated_at > now() - interval '24 hours'),
      'users_watching_7d',(select count(distinct user_id) from cloud_watch_history where updated_at > now() - interval '7 days'),
      'sources_total',(select count(*) from cloud_sources),
      'sources_error',(select count(*) from cloud_sources where sync_status = 'sync_error' or sync_error is not null),
      'sources_incomplete',(select count(*) from cloud_sources s
          left join mc on mc.source_id = s.id
          left join vc on vc.source_id = s.id
          where coalesce(mc.n_ms, 0) > 0 and coalesce(vc.n, 0) = 0),
      'titles_movie',(select coalesce((select n from tt where item_type = 'movie'), 0)),
      'titles_series',(select coalesce((select n from tt where item_type = 'series'), 0)),
      'identities_active',(select count(*) from provider_identities where status = 'active'),
      'gensubs_ready',(select count(*) from catalog_generated_subtitles where status = 'ready'),
      'gensubs_processing',(select count(*) from catalog_generated_subtitles where status = 'processing'),
      'gensubs_failed',(select count(*) from catalog_generated_subtitles where status = 'failed'),
      'tmdb_year_backlog',(select count(*) from cloud_titles where release_year is null and provider_tmdb_id is not null),
      'tmdb_unmatched',(select count(*) from cloud_titles where match_status = 'unmatched'),
      'tmdb_unverified',(select count(*) from cloud_titles where match_status in ('provider_unverified','weak') and provider_tmdb_id is not null and provider_tmdb_id <> '0'),
      'cron_active',(select count(*) from cron.job where active),
      'cron_paused',(select count(*) from cron.job where not active),
      'cron_fails_24h',(select count(*) from cron.job_run_details where status = 'failed' and start_time > now() - interval '24 hours'),
      'billing_mrr_cents',(select coalesce(sum(case when c.period = 'annual' then round(c.amount_cents / 12.0) else c.amount_cents end), 0)
          from cloud_entitlement_projection p join cloud_stancer_customers c on c.user_id = p.user_id
          where p.status in ('active','past_due','grace','cancelled_at_period_end')),
      'billing_trialing',(select count(*) from cloud_entitlement_projection where status = 'trialing'),
      'billing_active',(select count(*) from cloud_entitlement_projection where status = 'active'),
      'billing_past_due',(select count(*) from cloud_entitlement_projection where status in ('past_due','grace')),
      'billing_cancel_pending',(select count(*) from cloud_entitlement_projection where status = 'cancelled_at_period_end'),
      'billing_collected_30d_cents',(select coalesce(sum(amount), 0) from cloud_stancer_payments
          where status = 'captured' and kind in ('first_charge','renewal') and updated_at > now() - interval '30 days'),
      'billing_conversions_7d',(select count(distinct user_id) from cloud_stancer_payments
          where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'),
      'billing_cron_fails_24h',(select count(*) from cron.job_run_details d join cron.job j on j.jobid = d.jobid
          where j.jobname in ('norva-stancer-billing','norva-lifecycle') and d.status = 'failed' and d.start_time > now() - interval '24 hours')
    ),
    (select coalesce(jsonb_agg(row_to_json(sr) order by sr.is_driver desc, sr.created_at), '[]'::jsonb) from src_rows sr)
  into ov, src;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into cov from (
    select u.email::text as owner_email, coalesce(s.display_name, left(s.id::text, 8)) as panel, ct.item_type,
           count(*) as total,
           count(*) filter (where ct.audio_languages <> '{}') as resolved,
           round(100.0 * count(*) filter (where ct.audio_languages <> '{}') / nullif(count(*), 0), 1) as resolved_pct,
           count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}') as never_probed,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') as probed_24h,
           count(*) filter (where ct.audio_probed_at > now() - interval '24 hours' and ct.audio_languages <> '{}') as resolved_24h,
           case when count(*) filter (where ct.audio_probed_at > now() - interval '24 hours') > 0
                then ceil(count(*) filter (where ct.audio_probed_at is null and ct.audio_languages = '{}')::numeric / count(*) filter (where ct.audio_probed_at > now() - interval '24 hours'))
                else null end as eta_days,
           count(*) filter (where ct.subtitle_probed_at is not null) as subtitle_probed,
           count(*) filter (where jsonb_typeof(ct.subtitle_tracks) = 'array' and jsonb_array_length(ct.subtitle_tracks) > 0) as subtitle_found
    from cloud_titles ct join cloud_title_variants v on v.id = ct.default_variant_id join cloud_sources s on s.id = v.source_id
    left join auth.users u on u.id = s.user_id
    where ct.variant_count > 0
      and ct.user_id in (select user_id from public.admin_enrichment_accounts)
    group by u.email, s.display_name, s.id, ct.item_type
    order by u.email, ct.item_type, count(*) desc
  ) t;

  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into crn from (
    select j.jobid, j.jobname, j.schedule, j.active,
           case when j.schedule ~ '6-23' then 'jour'
                when j.schedule ~ '0-5' then 'nuit'
                when j.schedule ~ '^\S+ \* \* \* \*$' then 'continu'
                else '—' end as window,
           case when j.jobname ~ 'stancer|billing' then 'billing'
                when j.jobname ~ 'lifecycle' then 'lifecycle'
                when j.jobname ~ 'whisper' then 'whisper'
                when j.jobname ~ 'reaper|prewarm|prune|series-info|dashboard|vac|history|alert' then 'maintenance'
                when j.jobname ~ 'auto-refresh|resume-stuck' then 'sync'
                when j.jobname ~ 'series' then 'séries'
                when j.jobname ~ 'subtitle|pregen' then 'sous-titres'
                when j.jobname ~ 'audio|langs' then 'audio films'
                when j.jobname ~ 'enrich|origlang|revalidate|backfill-years|search-match|tmdb' then 'tmdb'
                when j.jobname ~ 'notify|digest' then 'notif'
                else 'autre' end as kind,
           lr.start_time as last_run, lr.status as last_status,
           coalesce((select count(*) from cron.job_run_details d where d.jobid = j.jobid and d.status = 'failed' and d.start_time > now() - interval '24 hours'), 0) as fails_24h
    from cron.job j
    left join lateral (select d.start_time, d.status from cron.job_run_details d where d.jobid = j.jobid order by d.start_time desc limit 1) lr on true
    order by (case when j.jobname ~ 'stancer|billing|lifecycle' then 0 when j.schedule ~ '6-23' then 1 when j.schedule ~ '0-5' then 2 else 3 end), j.jobname
  ) t;

  insert into public.admin_dashboard_cache (id, overview, sources, coverage, cron, refreshed_at)
       values (1, ov, src, cov, crn, now())
  on conflict (id) do update set overview = excluded.overview, sources = excluded.sources, coverage = excluded.coverage, cron = excluded.cron, refreshed_at = excluded.refreshed_at;
  return now();
end; $$;

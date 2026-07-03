-- Internal/VIP accounts + Support tickets (admin CRM P1 lot, on owner request 2026-07-03).
--
-- A) INTERNAL ACCOUNTS. Every account existing today belongs to the owner (or family:
--    hernandez.jeremy@outlook.fr) and was used for Stancer development tests — their billing rows
--    pollute the finance metrics. `admin_internal_accounts` registers them; admin_finance, the
--    snapshot billing counters and norva_funnel_daily all EXCLUDE registered accounts. Backfilled
--    with all current users; a fiche action (admin_internal_toggle) manages future ones. Internal
--    accounts are also granted permanent VIP full access (system/active/family, period end 2099) —
--    EXCEPT accounts currently on the stancer rail (live end-to-end tests must keep running).
--
-- B) SUPPORT TICKETS. cloud_support_tickets + cloud_support_messages (RLS on, no policies — the
--    norva-support edge function and admin RPCs are the only doors). Admin RPCs power the CRM
--    Support page + the fiche panel; counters ride the snapshot for the sidebar badge + ops-alerts.

-- ── A1) registry + backfill ─────────────────────────────────────────────────────────────────────
create table if not exists public.admin_internal_accounts (
  user_id    uuid primary key,
  note       text,
  created_at timestamptz not null default now()
);
alter table public.admin_internal_accounts enable row level security;

insert into public.admin_internal_accounts (user_id, note)
select id, 'backfill 2026-07-03 — compte interne (owner/famille), tests Stancer'
from auth.users
on conflict (user_id) do nothing;

-- ── A2) permanent VIP access for internal accounts (stancer test rails left untouched) ──────────
update public.cloud_entitlement_projection p
set status = 'active', plan_code = 'family', provider = 'system',
    current_period_end = '2099-01-01T00:00:00Z', trial_ends_at = null, last_event_at = now()
where p.user_id in (select user_id from public.admin_internal_accounts)
  and coalesce(p.provider, '') <> 'stancer';

insert into public.cloud_entitlement_projection (user_id, status, provider, plan_code, current_period_end, last_event_at)
select a.user_id, 'active', 'system', 'family', '2099-01-01T00:00:00Z', now()
from public.admin_internal_accounts a
where not exists (select 1 from public.cloud_entitlement_projection p where p.user_id = a.user_id);

-- ── A3) fiche toggle ────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_internal_toggle(p_user_id uuid, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_on then
    insert into admin_internal_accounts (user_id, note) values (p_user_id, 'marqué depuis la fiche')
    on conflict (user_id) do nothing;
  else
    delete from admin_internal_accounts where user_id = p_user_id;
  end if;
  insert into admin_events (user_id, kind, summary, actor)
  values (p_user_id, 'admin_action',
          case when p_on then 'Compte marqué INTERNE (exclu des stats finance)' else 'Compte retiré des comptes internes' end,
          null);
  return jsonb_build_object('internal', p_on);
end; $$;

revoke all on function public.admin_internal_toggle(uuid, boolean) from public, anon;
grant execute on function public.admin_internal_toggle(uuid, boolean) to authenticated;

-- ── A4) funnel view excludes internal accounts ──────────────────────────────────────────────────
create or replace view public.norva_funnel_daily as
select day, stage, count(distinct user_id)::int as users
from (
  select created_at::date as day, 'signup' as stage, user_id
    from public.cloud_entitlement_projection
  union all
  select first_at::date, 'source_added', user_id
    from (select user_id, min(created_at) as first_at from public.cloud_sources group by user_id) s
  union all
  select first_at::date, 'first_play', user_id
    from (select user_id, min(created_at) as first_at from public.cloud_watch_history group by user_id) w
  union all
  select created_at::date, 'checkout_open', user_id
    from public.cloud_stancer_payments where kind in ('trial_setup', 'resubscribe')
  union all
  select trial_consumed_at::date, 'trial_start', user_id
    from public.cloud_entitlement_projection where trial_consumed_at is not null
  union all
  select updated_at::date, 'trial_convert', user_id
    from public.cloud_stancer_payments where kind = 'first_charge' and status = 'captured'
  union all
  select updated_at::date, 'renewal', user_id
    from public.cloud_stancer_payments where kind = 'renewal' and status = 'captured'
  union all
  select created_at::date, 'cancel', user_id
    from public.cloud_cancel_feedback where action = 'cancelled'
  union all
  select created_at::date, 'save', user_id
    from public.cloud_cancel_feedback where action = 'saved'
  union all
  select updated_at::date, 'winback_return', user_id
    from public.cloud_stancer_payments
    where kind = 'resubscribe' and status in ('captured', 'authorized', 'to_capture')
) stages
where user_id not in (select user_id from public.admin_internal_accounts)
group by day, stage;
revoke all on public.norva_funnel_daily from anon, authenticated;

-- ── B1) support tables ──────────────────────────────────────────────────────────────────────────
create table if not exists public.cloud_support_tickets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  subject         text not null,
  status          text not null default 'open' check (status in ('open', 'pending', 'closed')),
  priority        text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  channel         text not null default 'in_app',
  last_from       text not null default 'user' check (last_from in ('user', 'admin')),
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists cloud_support_tickets_status_idx on public.cloud_support_tickets (status, last_message_at desc);
create index if not exists cloud_support_tickets_user_idx on public.cloud_support_tickets (user_id, last_message_at desc);
alter table public.cloud_support_tickets enable row level security;

create table if not exists public.cloud_support_messages (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.cloud_support_tickets(id) on delete cascade,
  from_admin   boolean not null default false,
  author_email text,
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists cloud_support_messages_ticket_idx on public.cloud_support_messages (ticket_id, created_at);
alter table public.cloud_support_messages enable row level security;

-- ── B2) admin support RPCs ──────────────────────────────────────────────────────────────────────
create or replace function public.admin_support_counts()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'open',         (select count(*) from cloud_support_tickets where status <> 'closed'),
    'needs_reply',  (select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user'),
    'stale_24h',    (select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user' and last_message_at < now() - interval '24 hours')
  ) where public.is_admin();
$$;
revoke all on function public.admin_support_counts() from public, anon;
grant execute on function public.admin_support_counts() to authenticated;

create or replace function public.admin_support_list(
  p_status  text default null,   -- 'needs_reply' | 'open' | 'pending' | 'closed' | null (all)
  p_user_id uuid default null,
  p_limit   int  default 50,
  p_offset  int  default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_rows jsonb; v_total bigint;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select count(*) into v_total from cloud_support_tickets t
   where (p_user_id is null or t.user_id = p_user_id)
     and (p_status is null
       or (p_status = 'needs_reply' and t.status <> 'closed' and t.last_from = 'user')
       or (p_status in ('open', 'pending', 'closed') and t.status = p_status));
  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) into v_rows from (
    select t.id, t.user_id, u.email::text as email, t.subject, t.status, t.priority, t.last_from,
           t.last_message_at, t.created_at,
           (select count(*) from cloud_support_messages m where m.ticket_id = t.id) as msg_count,
           (select left(m.body, 140) from cloud_support_messages m where m.ticket_id = t.id order by m.created_at desc limit 1) as last_body
    from cloud_support_tickets t
    left join auth.users u on u.id = t.user_id
    where (p_user_id is null or t.user_id = p_user_id)
      and (p_status is null
        or (p_status = 'needs_reply' and t.status <> 'closed' and t.last_from = 'user')
        or (p_status in ('open', 'pending', 'closed') and t.status = p_status))
    order by (t.status <> 'closed' and t.last_from = 'user') desc, t.last_message_at desc
    limit greatest(1, least(200, coalesce(p_limit, 50))) offset greatest(0, coalesce(p_offset, 0))
  ) x;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end; $$;
revoke all on function public.admin_support_list(text, uuid, int, int) from public, anon;
grant execute on function public.admin_support_list(text, uuid, int, int) to authenticated;

create or replace function public.admin_support_ticket(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'ticket', (select to_jsonb(x) from (
      select t.id, t.user_id, u.email::text as email, t.subject, t.status, t.priority, t.channel,
             t.last_from, t.last_message_at, t.created_at
      from cloud_support_tickets t left join auth.users u on u.id = t.user_id where t.id = p_id
    ) x),
    'messages', (select coalesce(jsonb_agg(row_to_json(m) order by m.created_at), '[]'::jsonb) from (
      select id, from_admin, author_email, body, created_at
      from cloud_support_messages where ticket_id = p_id
    ) m)
  );
end; $$;
revoke all on function public.admin_support_ticket(uuid) from public, anon;
grant execute on function public.admin_support_ticket(uuid) to authenticated;

create or replace function public.admin_support_set_status(p_id uuid, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_user uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_status not in ('open', 'pending', 'closed') then raise exception 'bad status'; end if;
  update cloud_support_tickets set status = p_status, updated_at = now() where id = p_id
  returning user_id into v_user;
  if v_user is null then raise exception 'ticket not found' using errcode = 'P0002'; end if;
  insert into admin_events (user_id, kind, summary, actor)
  values (v_user, 'admin_action', 'Ticket support → ' || p_status, null);
  return jsonb_build_object('status', p_status);
end; $$;
revoke all on function public.admin_support_set_status(uuid, text) from public, anon;
grant execute on function public.admin_support_set_status(uuid, text) to authenticated;

-- ── C) finance & snapshot exclude internal accounts; snapshot gains support counters ─────────────
-- admin_finance: verbatim 20260703240000 with `not internal` filters on every aggregate.
create or replace function public.admin_finance()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;

  with internal as (
    select user_id from public.admin_internal_accounts
  ), paying as (
    select p.user_id, p.status, p.provider, coalesce(p.plan_code, 'plus') as plan_code,
           c.period, c.amount_cents,
           case when c.amount_cents is null then null
                when c.period = 'annual' then round(c.amount_cents / 12.0)
                else c.amount_cents end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_stancer_customers c on c.user_id = p.user_id
    where p.status in ('active', 'past_due', 'grace', 'cancelled_at_period_end')
      and p.user_id not in (select user_id from internal)
  ), trialers as (
    select p.user_id, coalesce(p.plan_code, 'plus') as plan_code, p.provider, p.trial_ends_at,
           c.period, c.amount_cents,
           case when c.amount_cents is null then null
                when c.period = 'annual' then round(c.amount_cents / 12.0)
                else c.amount_cents end as mrr_cents
    from cloud_entitlement_projection p
    left join cloud_stancer_customers c on c.user_id = p.user_id
    where p.status = 'trialing'
      and p.user_id not in (select user_id from internal)
  )
  select jsonb_build_object(
    'refreshed_at', now(),
    'users_total', (select count(*) from auth.users where id not in (select user_id from internal)),
    'internal_excluded', (select count(*) from internal),
    'mrr_cents', (select coalesce(sum(mrr_cents), 0) from paying),
    'arr_cents', (select coalesce(sum(mrr_cents), 0) * 12 from paying),
    'mrr_trial_cents', (select coalesce(sum(mrr_cents), 0) from trialers),
    'mrr_unknown_n', (select count(*) from paying where mrr_cents is null),
    'counts', jsonb_build_object(
      'trialing', (select count(*) from trialers),
      'active', (select count(*) from paying where status = 'active'),
      'past_due', (select count(*) from paying where status in ('past_due', 'grace')),
      'cancel_pending', (select count(*) from paying where status = 'cancelled_at_period_end'),
      'expired', (select count(*) from cloud_entitlement_projection
                   where status = 'expired' and user_id not in (select user_id from internal))
    ),
    'by_plan', (select coalesce(jsonb_agg(row_to_json(t) order by t.mrr_cents desc nulls last), '[]'::jsonb) from (
      select plan_code, coalesce(period, '—') as period, coalesce(provider, '—') as provider,
             count(*)::int as n, coalesce(sum(mrr_cents), 0)::bigint as mrr_cents
      from paying group by 1, 2, 3
    ) t),
    'dunning', (select coalesce(jsonb_agg(row_to_json(t) order by t.stage), '[]'::jsonb) from (
      select coalesce(dunning_stage, 0) as stage, count(*)::int as n
      from cloud_entitlement_projection
      where status in ('past_due', 'grace') and user_id not in (select user_id from internal)
      group by 1
    ) t),
    'collected_30d_cents', (select coalesce(sum(amount), 0) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
        and user_id not in (select user_id from internal)),
    'collected_30d_n', (select count(*) from cloud_stancer_payments
      where status = 'captured' and kind in ('first_charge', 'renewal') and updated_at > now() - interval '30 days'
        and user_id not in (select user_id from internal)),
    'upcoming', jsonb_build_object(
      'trial_charges_48h_n', (select count(*) from trialers where trial_ends_at < now() + interval '48 hours'),
      'trial_charges_48h_cents', (select coalesce(sum(amount_cents), 0) from trialers where trial_ends_at < now() + interval '48 hours'),
      'renewals_7d_n', (select count(*) from cloud_entitlement_projection p2
        join cloud_stancer_customers c2 on c2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days'
          and p2.user_id not in (select user_id from internal)),
      'renewals_7d_cents', (select coalesce(sum(c2.amount_cents), 0) from cloud_entitlement_projection p2
        join cloud_stancer_customers c2 on c2.user_id = p2.user_id
        where p2.status = 'active' and p2.current_period_end < now() + interval '7 days'
          and p2.user_id not in (select user_id from internal))
    ),
    'funnel_30d', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select stage, sum(users)::int as users from public.norva_funnel_daily
      where day > (now() - interval '30 days')::date group by stage
    ) t),
    'conversions_7d', (select count(distinct user_id) from cloud_stancer_payments
      where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'
        and user_id not in (select user_id from internal)),
    'cancel_reasons', (select coalesce(jsonb_agg(row_to_json(t) order by t.n desc), '[]'::jsonb) from (
      select reason, count(*)::int as n from cloud_cancel_feedback
      where action = 'cancelled' and user_id not in (select user_id from internal) group by 1
    ) t),
    'cancels_total', (select count(*) from cloud_cancel_feedback
      where action = 'cancelled' and user_id not in (select user_id from internal)),
    'saves_total', (select count(*) from cloud_cancel_feedback
      where action = 'saved' and user_id not in (select user_id from internal)),
    'discounts_pending', (select count(*) from cloud_stancer_customers
      where discount_next_pct is not null and user_id not in (select user_id from internal)),
    'recent_payments', (select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) from (
      select sp.pi_id, sp.user_id, u.email::text as email, sp.kind, sp.amount, sp.currency,
             sp.status, coalesce(sp.updated_at, sp.created_at) as at
      from cloud_stancer_payments sp left join auth.users u on u.id = sp.user_id
      where sp.user_id not in (select user_id from internal)
      order by coalesce(sp.updated_at, sp.created_at) desc limit 50
    ) t)
  ) into v;
  return v;
end; $$;

-- admin_users_page: +is_internal flag (same signature as 20260703240000, rows gain one field).
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
           (u.id in (select user_id from public.admin_internal_accounts)) as is_internal,
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

-- admin_user_billing: +is_internal (fiche badge/toggle state).
create or replace function public.admin_user_billing(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object(
    'is_internal', (p_user_id in (select user_id from admin_internal_accounts)),
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

-- refresh_admin_dashboard: billing_* counters exclude internal accounts + support counters ride in.
-- Only the overview jsonb changes vs 20260703240000 — src/cov/crn blocks are byte-identical.
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
          where p.status in ('active','past_due','grace','cancelled_at_period_end')
            and p.user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_trialing',(select count(*) from cloud_entitlement_projection
          where status = 'trialing' and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_active',(select count(*) from cloud_entitlement_projection
          where status = 'active' and provider <> 'system'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_past_due',(select count(*) from cloud_entitlement_projection
          where status in ('past_due','grace') and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_cancel_pending',(select count(*) from cloud_entitlement_projection
          where status = 'cancelled_at_period_end' and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_collected_30d_cents',(select coalesce(sum(amount), 0) from cloud_stancer_payments
          where status = 'captured' and kind in ('first_charge','renewal') and updated_at > now() - interval '30 days'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_conversions_7d',(select count(distinct user_id) from cloud_stancer_payments
          where kind = 'first_charge' and status = 'captured' and updated_at > now() - interval '7 days'
            and user_id not in (select user_id from public.admin_internal_accounts)),
      'billing_cron_fails_24h',(select count(*) from cron.job_run_details d join cron.job j on j.jobid = d.jobid
          where j.jobname in ('norva-stancer-billing','norva-lifecycle') and d.status = 'failed' and d.start_time > now() - interval '24 hours'),
      'support_open',(select count(*) from cloud_support_tickets where status <> 'closed'),
      'support_needs_reply',(select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user'),
      'support_stale_24h',(select count(*) from cloud_support_tickets where status <> 'closed' and last_from = 'user' and last_message_at < now() - interval '24 hours')
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

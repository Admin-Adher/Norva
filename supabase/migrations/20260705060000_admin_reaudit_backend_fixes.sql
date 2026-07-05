-- Admin CRM re-audit (2026-07-05) — backend correctness/perf fixes (Lot B).
-- Findings #5, #6, #16, #29. (#26 fixed client-side in _renderCron; #27/#28 folded into the
-- admin_finance rewrite of the next migration alongside #14.)
--
-- IMPORTANT: every CREATE OR REPLACE below re-applies grants. CREATE OR REPLACE resets a function's
-- ACL to the PostgREST default (EXECUTE to PUBLIC → anon+authenticated) — the exact drift closed in
-- 20260705050000. These admin RPCs must stay authenticated+service_role only (is_admin()-gated).

-- ── #29 (perf): cover the admin_client_tags.tag_id FK (bulk/segment ops filter by tag_id) ──
create index if not exists idx_admin_client_tags_tag on public.admin_client_tags (tag_id);

-- ── #5 (bug): audit-feed keyset pagination must break created_at ties, or bulk-inserted events
-- (admin_tag_bulk writes one row per client with an identical now()) get skipped at a batch
-- boundary and "Charger plus" can vanish. Move to a composite (created_at, id) cursor.
-- admin_events.id is uuid; the frontend now carries the last row's id as p_before_id.
-- Drop the old 3-arg overload first so the new 4-arg is the single resolution target — named-arg
-- calls that omit the defaulted p_kind/p_before_id still resolve cleanly (old client stays working).
drop function if exists public.admin_audit_feed(integer, text, timestamptz);
create or replace function public.admin_audit_feed(
  p_limit integer default 60,
  p_kind text default null,
  p_before timestamptz default null,
  p_before_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_rows jsonb;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows from (
    select e.id, e.kind, e.summary, e.actor, e.created_at, e.user_id,
           u.email::text as client_email
    from public.admin_events e
    left join auth.users u on u.id = e.user_id
    where (p_kind is null or e.kind = p_kind)
      and (p_before is null
           or e.created_at < p_before
           or (e.created_at = p_before and p_before_id is not null and e.id < p_before_id))
    order by e.created_at desc, e.id desc
    limit greatest(1, least(200, coalesce(p_limit, 60)))
  ) t;
  return v_rows;
end; $function$;
-- NB: revoke anon/authenticated explicitly, not just PUBLIC — Supabase's ALTER DEFAULT PRIVILEGES
-- grants EXECUTE to anon+authenticated on newly-CREATEd functions, and a DROP+CREATE (unlike
-- CREATE OR REPLACE, which preserves the ACL) re-triggers it. `revoke from public` alone is a no-op
-- against those explicit grants (root cause of the 20260705050000 drift).
revoke all on function public.admin_audit_feed(integer, text, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.admin_audit_feed(integer, text, timestamptz, uuid) to authenticated, service_role;

-- ── #16 (audit accountability): admin_internal_toggle & admin_support_set_status wrote a null
-- actor, so a privileged VIP/exclude toggle (or ticket status change) was unattributable in the
-- journal. Stamp the acting admin's email like every sibling mutation does. ──
create or replace function public.admin_internal_toggle(p_user_id uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
          nullif(auth.jwt() ->> 'email', ''));
  return jsonb_build_object('internal', p_on);
end; $function$;
revoke all on function public.admin_internal_toggle(uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_internal_toggle(uuid, boolean) to authenticated, service_role;

create or replace function public.admin_support_set_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_user uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_status not in ('open', 'pending', 'closed') then raise exception 'bad status'; end if;
  update cloud_support_tickets set status = p_status, updated_at = now() where id = p_id
  returning user_id into v_user;
  if v_user is null then raise exception 'ticket not found' using errcode = 'P0002'; end if;
  insert into admin_events (user_id, kind, summary, actor)
  values (v_user, 'admin_action', 'Ticket support → ' || p_status, nullif(auth.jwt() ->> 'email', ''));
  return jsonb_build_object('status', p_status);
end; $function$;
revoke all on function public.admin_support_set_status(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_support_set_status(uuid, text) to authenticated, service_role;

-- ── #6 (UX consistency): the Finance status cards count paying subscribers EXCLUDING internal
-- accounts, but clicking one filtered the Clients list WITHOUT that exclusion, so the card number
-- never matched the list total. Exclude internal accounts from admin_users_page whenever a specific
-- billing status is selected (not for 'free' / no filter, where internal accounts stay findable).
-- Full body reproduced from live with the single AND added to both the count and rows queries. ──
create or replace function public.admin_users_page(
  p_limit integer default 25,
  p_offset integer default 0,
  p_search text default null,
  p_sort text default 'created_desc',
  p_tag_id uuid default null,
  p_billing_status text default null)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
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
      or (v_bs = 'free'           and (pr.status is null or pr.status not in ('trialing','active','past_due','grace','cancelled_at_period_end','expired'))))
    and (v_bs is null or v_bs = 'free' or u.id not in (select user_id from public.admin_internal_accounts));

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
      and (v_bs is null or v_bs = 'free' or u.id not in (select user_id from public.admin_internal_accounts))
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
$function$;
revoke all on function public.admin_users_page(integer, integer, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_users_page(integer, integer, text, text, uuid, text) to authenticated, service_role;

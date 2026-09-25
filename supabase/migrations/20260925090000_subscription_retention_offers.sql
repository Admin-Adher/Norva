-- Personal offers after voluntary cancellation. Prices are server-owned;
-- accepting before expiry preserves the existing term and never charges now.
begin;
create table public.cloud_retention_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into public.cloud_retention_policy default values;
create table public.cloud_retention_offers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cancellation_event text not null,
  access_until timestamptz not null,
  available_at timestamptz not null,
  expires_at timestamptz not null,
  plan text not null check (plan in ('plus','family')),
  period text not null check (period in ('monthly','annual')),
  base_amount_cents integer not null check (base_amount_cents between 100 and 99999),
  amount_cents integer not null check (amount_cents > 0 and amount_cents < base_amount_cents),
  discount_pct integer not null check (discount_pct in (10,20)),
  cycles integer not null check (cycles in (1,3)),
  state text not null default 'offered' check (state in ('offered','accepted','declined')),
  accepted_at timestamptz,
  declined_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,cancellation_event),
  check ((period='monthly' and discount_pct=20 and cycles=3)
      or (period='annual' and discount_pct=10 and cycles=1)),
  check ((state='accepted') = (accepted_at is not null)),
  check (expires_at > access_until and available_at < access_until)
);
create index on public.cloud_retention_offers(user_id,accepted_at desc);
alter table public.cloud_retention_policy enable row level security;
alter table public.cloud_retention_offers enable row level security;
revoke all on public.cloud_retention_policy, public.cloud_retention_offers from public,anon,authenticated;
grant select on public.cloud_retention_policy to service_role;
grant select,insert,update,delete on public.cloud_retention_offers to service_role;
alter table public.cloud_revolut_orders add column retention_offer_id uuid
  references public.cloud_retention_offers(id) on delete set null;

-- Restoring a trial is a lifecycle transition. A missing historic paywall event
-- must not make the analytics trigger reject an otherwise valid resumption.
do $funnel$
declare definition text; revised text;
begin
  definition:=pg_get_functiondef('public.norva_entitlement_activation_funnel_event()'::regprocedure);
  revised:=replace(definition,
    '  v_activation_key := ''entitlement_activated:''',
    '  if v_previous.id is null then return new; end if;
  v_activation_key := ''entitlement_activated:''');
  if revised=definition then raise exception 'retention trial analytics contract missing'; end if;
  execute revised;
end;
$funnel$;

create function public.norva_retention_offer_eligible(p_offer uuid,p_user uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select exists (
    select 1 from public.cloud_retention_offers o
    join public.cloud_entitlement_projection e on e.user_id=o.user_id
    join public.cloud_revolut_customers c on c.user_id=o.user_id
    join public.billing_prices b on b.plan=o.plan and b.period=o.period
    where o.id=p_offer and o.user_id=p_user and o.state='offered'
      and (select enabled from public.cloud_retention_policy where singleton)
      and now() between o.available_at and o.expires_at
      and not public.norva_is_internal_account(p_user)
      and e.provider='revolut' and e.status in ('cancelled_at_period_end','expired')
      and e.current_period_end=o.access_until
      and c.plan=o.plan and c.period=o.period and c.amount_cents=o.base_amount_cents
      and c.payment_method_id is not null and c.pending_plan is null
      and c.discount_next_pct is null and coalesce(c.promo_cycles_left,0)=0
      and b.amount_cents=o.base_amount_cents
      and not (b.promo_amount_cents is not null and (b.promo_ends_at is null or b.promo_ends_at>now()))
      and not exists(select 1 from public.cloud_retention_offers used
        where used.user_id=p_user and used.accepted_at>now()-interval '12 months')
      and o.cancellation_event=(select x.provider_event_id from public.cloud_entitlement_events x
        where x.user_id=p_user and x.provider='revolut' and x.event_type='CANCELLATION_CONFIRMED'
        order by x.created_at desc limit 1)
  );
$$;

create function public.norva_retention_offer(p_user uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e public.cloud_entitlement_projection%rowtype;
  c public.cloud_revolut_customers%rowtype; b public.billing_prices%rowtype;
  o public.cloud_retention_offers%rowtype; ev record; reason text;
begin
  if not coalesce((select enabled from public.cloud_retention_policy where singleton),false)
    or public.norva_is_internal_account(p_user) then return null; end if;
  select * into e from public.cloud_entitlement_projection where user_id=p_user;
  if not found or e.provider<>'revolut' or e.status not in ('cancelled_at_period_end','expired')
    or e.current_period_end is null or now()<e.current_period_end-interval '3 days'
    or now()>e.current_period_end+interval '7 days' then return null; end if;
  select provider_event_id,created_at into ev from public.cloud_entitlement_events
    where user_id=p_user and provider='revolut' and event_type='CANCELLATION_CONFIRMED'
    order by created_at desc limit 1;
  if not found then return null; end if;
  select f.reason into reason from public.cloud_cancel_feedback f where f.user_id=p_user
    and f.action='cancelled' and f.created_at>=ev.created_at-interval '1 minute'
    order by f.created_at desc limit 1;
  if reason='technical' then return jsonb_build_object('support',true); end if;
  if exists(select 1 from public.cloud_retention_offers where user_id=p_user
    and accepted_at>now()-interval '12 months') then return null; end if;
  select * into c from public.cloud_revolut_customers where user_id=p_user;
  if not found or c.plan not in ('plus','family') or c.period not in ('monthly','annual')
    or c.payment_method_id is null or c.pending_plan is not null or c.discount_next_pct is not null
    or coalesce(c.promo_cycles_left,0)>0 then return null; end if;
  select * into b from public.billing_prices where plan=c.plan and period=c.period;
  if not found or b.amount_cents<>c.amount_cents
    or (b.promo_amount_cents is not null and (b.promo_ends_at is null or b.promo_ends_at>now())) then return null; end if;
  insert into public.cloud_retention_offers(user_id,cancellation_event,access_until,available_at,expires_at,
    plan,period,base_amount_cents,amount_cents,discount_pct,cycles)
  values(p_user,ev.provider_event_id,e.current_period_end,e.current_period_end-interval '3 days',
    e.current_period_end+interval '7 days',c.plan,c.period,c.amount_cents,
    round(c.amount_cents*case when c.period='monthly' then .8 else .9 end),
    case when c.period='monthly' then 20 else 10 end,case when c.period='monthly' then 3 else 1 end)
  on conflict(user_id,cancellation_event) do nothing;
  select * into o from public.cloud_retention_offers where user_id=p_user and cancellation_event=ev.provider_event_id;
  if not public.norva_retention_offer_eligible(o.id,p_user) then return null; end if;
  return jsonb_build_object('id',o.id,'plan',o.plan,'period',o.period,'currency','USD',
    'amount_cents',o.amount_cents,'base_amount_cents',o.base_amount_cents,'discount_pct',o.discount_pct,
    'cycles',o.cycles,'access_until',o.access_until,'expires_at',o.expires_at,
    'charge_mode',case when e.current_period_end>now() then 'next_cycle' else 'immediate' end);
end;
$$;

create function public.norva_retention_action(p_user uuid,p_offer uuid,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.cloud_retention_offers%rowtype; e public.cloud_entitlement_projection%rowtype; resumed record;
begin
  if p_action not in ('accept','decline','checkout') then raise exception 'invalid_retention_action'; end if;
  perform pg_advisory_xact_lock(hashtextextended('norva:revolut:money:'||p_user::text,0));
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,20260721));
  select * into e from public.cloud_entitlement_projection where user_id=p_user for update;
  perform 1 from public.cloud_revolut_customers where user_id=p_user for update;
  perform 1 from public.billing_prices b join public.cloud_revolut_customers c
    on b.plan=c.plan and b.period=c.period where c.user_id=p_user for share of b;
  select * into o from public.cloud_retention_offers where id=p_offer and user_id=p_user for update;
  if not found then raise exception 'retention_offer_unavailable'; end if;
  if o.state='accepted' and p_action='accept' then
    return jsonb_build_object('ok',true,'already_applied',true,'status',e.status); end if;
  if p_action='decline' then
    update public.cloud_retention_offers set state='declined',declined_at=clock_timestamp()
      where id=p_offer and state='offered';
    return jsonb_build_object('ok',true);
  end if;
  if not public.norva_retention_offer_eligible(p_offer,p_user) then raise exception 'retention_offer_unavailable'; end if;
  if p_action='checkout' then
    if e.status<>'expired' then raise exception 'retention_subscription_not_expired'; end if;
    return public.norva_retention_offer(p_user);
  end if;
  if e.current_period_end<=clock_timestamp() then raise exception 'retention_checkout_required'; end if;
  if exists(select 1 from public.cloud_revolut_billing_attempts where user_id=p_user
    and applied_at is null) then raise exception 'retention_billing_inflight'; end if;
  update public.cloud_revolut_customers set amount_cents=o.amount_cents,
    base_amount_cents=o.base_amount_cents,promo_cycles_left=o.cycles,updated_at=clock_timestamp() where user_id=p_user;
  select * into resumed from public.norva_apply_revolut_account_action(p_user,'resume',
    'retention:'||p_offer::text,clock_timestamp());
  update public.cloud_retention_offers set state='accepted',accepted_at=clock_timestamp() where id=p_offer;
  return jsonb_build_object('ok',true,'status',resumed.status,'access_until',resumed.access_until);
end;
$$;

-- Only a successfully reconciled, captured resubscription consumes an offer.
-- Failed or abandoned checkout attempts do not burn the twelve-month allowance.
create function public.norva_retention_order_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.cloud_retention_offers%rowtype;
begin
  if tg_op='UPDATE' and new.retention_offer_id is distinct from old.retention_offer_id then
    raise exception 'retention_order_binding_immutable';
  end if;
  if new.retention_offer_id is null then return new; end if;
  select * into o from public.cloud_retention_offers where id=new.retention_offer_id for update;
  if not found or o.user_id<>new.user_id or new.kind<>'resubscribe'
    or new.plan<>o.plan or new.period<>o.period or new.requested_amount_cents<>o.amount_cents
    or new.base_amount_cents is distinct from o.base_amount_cents
    or new.promo_cycles is distinct from o.cycles then raise exception 'retention_order_mismatch'; end if;
  if tg_op='INSERT' and not public.norva_retention_offer_eligible(o.id,new.user_id) then
    raise exception 'retention_offer_unavailable'; end if;
  if new.finalization_result->>'result'='resubscribed' and new.finalized_at is not null then
    update public.cloud_retention_offers set state='accepted',accepted_at=coalesce(accepted_at,clock_timestamp())
      where id=o.id;
  end if;
  return new;
end;
$$;
create trigger retention_order_guard before insert or update on public.cloud_revolut_orders
  for each row execute function public.norva_retention_order_guard();

revoke all on function public.norva_retention_offer_eligible(uuid,uuid),public.norva_retention_offer(uuid),
  public.norva_retention_action(uuid,uuid,text),public.norva_retention_order_guard() from public,anon,authenticated;
grant execute on function public.norva_retention_offer_eligible(uuid,uuid),public.norva_retention_offer(uuid),
  public.norva_retention_action(uuid,uuid,text) to service_role;

create function public.norva_retention_delivery_allowed(p_user uuid,p_reference text)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare offer_id uuid; stage text; o public.cloud_retention_offers%rowtype;
begin
  if coalesce(p_reference,'') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:(pre|post)$' then return false; end if;
  offer_id:=split_part(p_reference,':',1)::uuid; stage:=split_part(p_reference,':',2);
  if not public.norva_marketing_email_allowed(p_user)
    or not public.norva_retention_offer_eligible(offer_id,p_user) then return false; end if;
  select * into o from public.cloud_retention_offers where id=offer_id;
  if stage='pre' then return now()<o.access_until; end if;
  return now()>=o.access_until+interval '3 days';
end;
$$;

-- Keep the existing recipient, consent, deduplication and transport gates.
-- Extend the deployed predicates in place, including Postal's final send gate;
-- abort the migration if the known contract is missing rather than replacing
-- a newer production function with an older copied definition.
alter table public.cloud_branded_email_outbox drop constraint cloud_branded_email_marker_check;
alter table public.cloud_branded_email_outbox add constraint cloud_branded_email_marker_check
  check(marker_kind is null or marker_kind in ('welcome','dunning','winback','abandoned','billing_event','retention'));
do $patch$
declare f record; definition text; revised text; changed integer:=0;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='norva_enqueue_lifecycle_email'
  loop
    definition:=pg_get_functiondef(f.oid);
    revised:=replace(definition,
      'or v_marker not in (''welcome'', ''dunning'', ''winback'', ''abandoned'', ''billing_event'')',
      'or (v_marker = ''retention'' and (v_flow <> ''retention_offer'' or not p_marketing or not public.norva_retention_delivery_allowed(p_user_id,p_marker_reference)))
       or v_marker not in (''welcome'', ''dunning'', ''winback'', ''abandoned'', ''billing_event'', ''retention'')');
    if revised=definition then raise exception 'retention enqueue extension contract missing'; end if;
    execute revised;
  end loop;
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','norva_postal_full') and p.prorettype='boolean'::regtype
      and (p.proname like 'authorize_branded_email_delivery%' or p.proname='branded_allowed')
      and p.prosrc like '%elsif o.marker_kind = ''winback'' then%'
  loop
    definition:=pg_get_functiondef(f.oid);
    revised:=replace(definition,'elsif o.marker_kind = ''winback'' then',
      'elsif o.marker_kind = ''retention'' then
         v_allowed := public.norva_retention_delivery_allowed(o.user_id,o.marker_reference);
       elsif o.marker_kind = ''winback'' then');
    execute revised; changed:=changed+1;
  end loop;
  if changed<2 then raise exception 'retention delivery gate extension contract missing'; end if;
end;
$patch$;

create function public.norva_retention_candidates()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e record; offer jsonb; offers jsonb:='[]'::jsonb; stage text; reference text;
begin
  if not coalesce((select enabled from public.cloud_retention_policy where singleton),false) then return offers; end if;
  for e in select user_id,current_period_end from public.cloud_entitlement_projection
    where provider='revolut' and status in ('cancelled_at_period_end','expired')
      and current_period_end between now()-interval '7 days' and now()+interval '3 days'
    order by current_period_end,user_id limit 1000
  loop
    offer:=public.norva_retention_offer(e.user_id);
    if offer is null or not offer ? 'id' then continue; end if;
    stage:=case when now()<e.current_period_end then 'pre' else 'post' end;
    reference:=(offer->>'id')||':'||stage;
    if public.norva_retention_delivery_allowed(e.user_id,reference)
      and not exists(select 1 from public.cloud_branded_email_outbox where
        dedupe_key='lifecycle:retention:'||reference) then
      offers:=offers||jsonb_build_array(offer||jsonb_build_object('user_id',e.user_id,'stage',stage,'reference',reference));
    end if;
  end loop;
  return offers;
end;
$$;
revoke all on function public.norva_retention_delivery_allowed(uuid,text),public.norva_retention_candidates()
  from public,anon,authenticated;
grant execute on function public.norva_retention_delivery_allowed(uuid,text),public.norva_retention_candidates()
  to service_role;
commit;

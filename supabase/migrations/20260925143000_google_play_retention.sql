-- Google Play retention is a separate rail. Activation is deliberate, after store QA.
begin;
create table public.cloud_play_retention_policy (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  communications_enabled boolean not null default false
);
insert into public.cloud_play_retention_policy default values;
create table public.cloud_play_retention_offers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cancellation_event text not null,
  product_id text not null check(product_id in ('norva_plus:monthly','norva_plus:annual','norva_family:monthly','norva_family:annual')),
  offer_id text not null check(offer_id in ('retention-monthly-20','retention-annual-10')),
  access_until timestamptz not null,
  available_at timestamptz not null,
  expires_at timestamptz not null,
  state text not null default 'offered' check(state in ('offered','accepted','declined')),
  claimed_at timestamptz,
  claim_id uuid,
  accepted_at timestamptz,
  purchase_event text unique,
  original_transaction_id text,
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,cancellation_event),
  check((state='accepted')=(accepted_at is not null)),
  check(available_at=access_until-interval '3 days' and expires_at=access_until+interval '7 days'),
  check((product_id like '%:monthly' and offer_id='retention-monthly-20') or
        (product_id like '%:annual' and offer_id='retention-annual-10'))
);
create index on public.cloud_play_retention_offers(user_id,accepted_at desc);
create index on public.cloud_play_retention_offers(original_transaction_id,accepted_at desc);
create table public.cloud_play_retention_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  push_opt_in boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
create table public.cloud_play_retention_deliveries (
  offer_id uuid not null references public.cloud_play_retention_offers(id) on delete cascade,
  stage text not null check(stage in ('pre','post')),
  channel text not null check(channel in ('email','push')),
  token text,
  dispatched_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key(offer_id,stage)
);
alter table public.cloud_play_retention_policy enable row level security;
alter table public.cloud_play_retention_offers enable row level security;
alter table public.cloud_play_retention_preferences enable row level security;
alter table public.cloud_play_retention_deliveries enable row level security;
revoke all on public.cloud_play_retention_policy,public.cloud_play_retention_offers,
  public.cloud_play_retention_preferences,public.cloud_play_retention_deliveries from public,anon,authenticated;
grant all on public.cloud_play_retention_policy,public.cloud_play_retention_offers,
  public.cloud_play_retention_preferences,public.cloud_play_retention_deliveries to service_role;

create function public.norva_play_retention_eligible(p_offer uuid,p_user uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists (
  select 1 from public.cloud_play_retention_offers o
  join public.cloud_entitlement_projection e on e.user_id=o.user_id
  join public.cloud_entitlement_events ev on ev.user_id=o.user_id and ev.provider_event_id=o.cancellation_event and ev.provider='revenuecat'
  where o.id=p_offer and o.user_id=p_user and o.state='offered'
    and (select enabled from public.cloud_play_retention_policy where singleton)
    and not public.norva_is_internal_account(p_user)
    and now() between o.available_at and o.expires_at
    and e.provider='google_play' and e.status in ('cancelled_at_period_end','expired')
    and e.current_period_end=o.access_until and e.billing_product_id=o.product_id
    and ev.event_type='CANCELLATION' and ev.payload->>'store'='PLAY_STORE'
    and ev.payload->>'cancel_reason'='UNSUBSCRIBE'
    and coalesce(ev.payload->>'environment','')='PRODUCTION'
    and ev.payload->>'period_type' in ('NORMAL','TRIAL')
    and coalesce(ev.payload->>'offer_code','') not like 'retention-%'
    and not exists(select 1 from public.cloud_entitlement_events x where x.user_id=p_user and x.provider='revenuecat'
      and x.event_type in ('PRODUCT_CHANGE','CANCELLATION','UNCANCELLATION','BILLING_ISSUE','TRANSFER')
      and x.created_at>ev.created_at and x.provider_event_id<>o.cancellation_event)
    and not exists(select 1 from public.cloud_retention_offers w where w.user_id=p_user and w.accepted_at>now()-interval '12 months')
    and not exists(select 1 from public.cloud_revolut_orders w where w.user_id=p_user and w.retention_offer_id is not null and w.finalized_at is null)
    and not exists(select 1 from public.cloud_play_retention_offers used where used.accepted_at>now()-interval '12 months'
      and (used.user_id=p_user or used.original_transaction_id=ev.payload->>'original_transaction_id'))
 );
$$;

create function public.norva_play_retention_offer(p_user uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare e public.cloud_entitlement_projection%rowtype; ev public.cloud_entitlement_events%rowtype;
 o public.cloud_play_retention_offers%rowtype; cadence text;
begin
 if not coalesce((select enabled from public.cloud_play_retention_policy where singleton),false)
   or public.norva_is_internal_account(p_user) then return null; end if;
 select * into e from public.cloud_entitlement_projection where user_id=p_user;
 if not found or e.provider<>'google_play' or e.status not in ('cancelled_at_period_end','expired')
   or e.current_period_end is null or now() not between e.current_period_end-interval '3 days' and e.current_period_end+interval '7 days'
   or e.billing_product_id not in ('norva_plus:monthly','norva_plus:annual','norva_family:monthly','norva_family:annual') then return null; end if;
 select * into ev from public.cloud_entitlement_events where user_id=p_user and provider='revenuecat' and event_type='CANCELLATION'
   order by created_at desc limit 1;
 if not found or ev.payload->>'store'<>'PLAY_STORE' or ev.payload->>'cancel_reason'<>'UNSUBSCRIBE' then return null; end if;
 if exists(select 1 from public.cloud_cancel_feedback f where f.user_id=p_user and f.reason='technical'
   and f.created_at>=ev.created_at-interval '1 minute') then return jsonb_build_object('support',true); end if;
 cadence:=split_part(e.billing_product_id,':',2);
 insert into public.cloud_play_retention_offers(user_id,cancellation_event,product_id,offer_id,access_until,available_at,expires_at)
 values(p_user,ev.provider_event_id,e.billing_product_id,case when cadence='monthly' then 'retention-monthly-20' else 'retention-annual-10' end,
   e.current_period_end,e.current_period_end-interval '3 days',e.current_period_end+interval '7 days') on conflict(user_id,cancellation_event) do nothing;
 select * into o from public.cloud_play_retention_offers where user_id=p_user and cancellation_event=ev.provider_event_id;
 if not public.norva_play_retention_eligible(o.id,p_user) then return null; end if;
 return jsonb_build_object('id',o.id,'productId',o.product_id,'offerId',o.offer_id,'period',cadence,
   'discountPct',case when cadence='monthly' then 20 else 10 end,'cycles',case when cadence='monthly' then 3 else 1 end,
   'accessUntil',o.access_until,'expiresAt',o.expires_at,'preserveAccess',o.access_until>now());
end;
$$;

create function public.norva_play_retention_action(p_user uuid,p_offer uuid,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.cloud_play_retention_offers%rowtype; quote jsonb;
begin
 -- Shared locks with Revolut: two rails cannot claim a personal offer concurrently.
 perform pg_advisory_xact_lock(hashtextextended('norva:revolut:money:'||p_user::text,0));
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,20260721));
 select * into o from public.cloud_play_retention_offers where id=p_offer and user_id=p_user for update;
 if not found then return null; end if;
 if p_action='decline' then
   update public.cloud_play_retention_offers set state='declined' where id=p_offer and state='offered';
   return jsonb_build_object('ok',true);
 end if;
 if p_action<>'claim' then raise exception 'invalid_play_retention_action'; end if;
 if not public.norva_play_retention_eligible(p_offer,p_user) then return null; end if;
 -- Repeated taps/devices cannot open a second payment sheet while the first is open.
 if o.claimed_at>now()-interval '10 minutes' then return jsonb_build_object('pending',true); end if;
 update public.cloud_play_retention_offers set claimed_at=clock_timestamp(),claim_id=gen_random_uuid() where id=p_offer returning * into o;
 quote:=public.norva_play_retention_offer(p_user);
 return quote||jsonb_build_object('claimId',o.claim_id);
end;
$$;

-- Only the authenticated, verified RevenueCat webhook writes these events.
-- Client callbacks never consume an offer or grant entitlement. Renewals and
-- duplicate/reordered deliveries cannot reset the twelve-month clock.
create function public.norva_play_retention_purchase() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.cloud_play_retention_offers%rowtype; bought timestamptz;
begin
 if new.provider is distinct from 'revenuecat' or new.processed_at is null or new.event_type not in ('INITIAL_PURCHASE','RENEWAL')
   or new.payload->>'store' is distinct from 'PLAY_STORE' or new.payload->>'environment' is distinct from 'PRODUCTION'
   or coalesce(new.payload->>'offer_code','') not in ('retention-monthly-20','retention-annual-10')
   or new.payload#>>'{_norva,projection_applied}' is distinct from 'true'
   or coalesce(new.payload->>'original_transaction_id','')='' then return new; end if;
 if coalesce(new.payload->>'purchased_at_ms','') !~ '^[0-9]{10,16}$' then return new; end if;
 bought:=to_timestamp((new.payload->>'purchased_at_ms')::numeric/1000);
 perform pg_advisory_xact_lock(hashtextextended('norva:revolut:money:'||new.user_id::text,0));
 select * into o from public.cloud_play_retention_offers where user_id=new.user_id and state='offered'
   and product_id=new.payload->>'product_id' and offer_id=new.payload->>'offer_code'
   and claimed_at is not null and bought>=claimed_at-interval '5 minutes'
   and bought<=expires_at+interval '1 day' order by claimed_at desc limit 1 for update;
 if not found then return new; end if;
 update public.cloud_play_retention_offers set state='accepted',accepted_at=bought,
   purchase_event=new.provider_event_id,original_transaction_id=new.payload->>'original_transaction_id' where id=o.id;
 return new;
end;
$$;
create trigger norva_play_retention_purchase after insert on public.cloud_entitlement_events
for each row execute function public.norva_play_retention_purchase();

-- Extend both web offer creation and its final guard with the mobile ledger.
alter function public.norva_retention_offer_eligible(uuid,uuid) rename to norva_retention_offer_eligible_web;
create function public.norva_retention_offer_eligible(p_offer uuid,p_user uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select public.norva_retention_offer_eligible_web(p_offer,p_user)
 and not exists(select 1 from public.cloud_play_retention_offers m where m.user_id=p_user
   and (m.accepted_at>now()-interval '12 months' or (m.state='offered' and m.claimed_at>now()-interval '24 hours')));
$$;
-- PL/pgSQL function bodies resolve the new name at execution; no old guard may
-- be directly invoked by an API role.
revoke all on function public.norva_retention_offer_eligible_web(uuid,uuid) from public,anon,authenticated,service_role;

do $permissions$
declare f record;
begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'norva_play_retention_%'
 loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature); end loop;
end;
$permissions$;
revoke all on function public.norva_retention_offer_eligible(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_retention_offer_eligible(uuid,uuid) to service_role;
commit;

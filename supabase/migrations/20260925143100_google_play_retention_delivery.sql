begin;
alter table public.cloud_play_retention_deliveries add column id uuid not null default gen_random_uuid() unique;

create function public.norva_play_retention_delivery_allowed(p_user uuid,p_reference text)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
 select exists(select 1 from public.cloud_play_retention_deliveries d
 join public.cloud_play_retention_offers o on o.id=d.offer_id
 where d.id::text=p_reference and o.user_id=p_user
   and (select communications_enabled from public.cloud_play_retention_policy where singleton)
   and public.norva_play_retention_eligible(o.id,p_user)
   and ((d.stage='pre' and now()<o.access_until) or (d.stage='post' and now()>=o.access_until+interval '3 days'))
   and ((d.channel='email' and public.norva_marketing_email_allowed(p_user)) or
        (d.channel='push' and exists(select 1 from public.cloud_play_retention_preferences p where p.user_id=p_user and p.push_opt_in)
         and exists(select 1 from public.cloud_push_tokens t where t.token=d.token and t.user_id=p_user and t.platform='android'
           and t.permission_state='granted' and t.last_seen_at>now()-interval '45 days'))));
$$;

create function public.norva_play_retention_deliveries(p_push_configured boolean default false)
returns setof jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare u record; o public.cloud_play_retention_offers%rowtype; q jsonb; s text; tok text; ch text; d public.cloud_play_retention_deliveries%rowtype;
begin
 if not coalesce((select enabled and communications_enabled from public.cloud_play_retention_policy where singleton),false) then return; end if;
 for u in select user_id from public.cloud_entitlement_projection where provider='google_play'
   and status in ('cancelled_at_period_end','expired') and now() between current_period_end-interval '3 days' and current_period_end+interval '7 days' limit 200
 loop
   q:=public.norva_play_retention_offer(u.user_id);
   if q is null or not q ? 'id' then continue; end if;
   select * into o from public.cloud_play_retention_offers where id=(q->>'id')::uuid;
   s:=case when now()<o.access_until then 'pre' when now()>=o.access_until+interval '3 days' then 'post' else null end;
   if s is null then continue; end if;
   tok:=null;
   if p_push_configured and exists(select 1 from public.cloud_play_retention_preferences p where p.user_id=u.user_id and p.push_opt_in) then
     select t.token into tok from public.cloud_push_tokens t where t.user_id=u.user_id and t.platform='android'
       and t.permission_state='granted' and t.last_seen_at>now()-interval '45 days'
       -- Older apps do not understand this notification kind.
       and t.app_version ~ '^1\.3\.(2[4-9]|[3-9][0-9])$' order by t.last_seen_at desc limit 1;
   end if;
   ch:=case when tok is not null then 'push' when public.norva_marketing_email_allowed(u.user_id) then 'email' else null end;
   if ch is null then continue; end if;
   insert into public.cloud_play_retention_deliveries(offer_id,stage,channel,token) values(o.id,s,ch,tok)
      on conflict(offer_id,stage) do nothing;
   select * into d from public.cloud_play_retention_deliveries where offer_id=o.id and stage=s;
   if d.dispatched_at is null and public.norva_play_retention_delivery_allowed(u.user_id,d.id::text) then
     return next q||jsonb_build_object('user_id',u.user_id,'deliveryId',d.id,'stage',s,'channel',d.channel);
   end if;
 end loop;
end;
$$;

create function public.norva_play_retention_claim_push(p_delivery uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.cloud_play_retention_deliveries%rowtype; o public.cloud_play_retention_offers%rowtype;
begin
 select * into d from public.cloud_play_retention_deliveries where id=p_delivery for update;
 if not found or d.channel<>'push' or d.dispatched_at is not null then return null; end if;
 select * into o from public.cloud_play_retention_offers where id=d.offer_id;
 if not public.norva_play_retention_delivery_allowed(o.user_id,d.id::text) then return null; end if;
 -- At-most-once transport attempt: never turn an ambiguous FCM response into
 -- duplicate email/push. A single most recently active device is selected.
 update public.cloud_play_retention_deliveries set dispatched_at=clock_timestamp() where id=d.id;
 return jsonb_build_object('token',d.token,'user_id',o.user_id);
end;
$$;

alter table public.cloud_branded_email_outbox drop constraint cloud_branded_email_marker_check;
alter table public.cloud_branded_email_outbox add constraint cloud_branded_email_marker_check
 check(marker_kind is null or marker_kind in ('welcome','dunning','winback','abandoned','billing_event','retention','play_retention'));
do $patch$
declare f record; definition text; revised text; enqueues int:=0; deliveries int:=0;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='norva_enqueue_lifecycle_email'
 loop
   definition:=pg_get_functiondef(f.oid);
   revised:=replace(definition,
     'or v_marker not in (''welcome'', ''dunning'', ''winback'', ''abandoned'', ''billing_event'', ''retention'')',
     'or (v_marker = ''play_retention'' and (v_flow <> ''play_retention_offer'' or not p_marketing or not public.norva_play_retention_delivery_allowed(p_user_id,p_marker_reference)))
      or v_marker not in (''welcome'', ''dunning'', ''winback'', ''abandoned'', ''billing_event'', ''retention'', ''play_retention'')');
   if revised=definition then raise exception 'play retention enqueue contract missing'; end if;
   execute revised; enqueues:=enqueues+1;
 end loop;
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','norva_postal_full') and p.prorettype='boolean'::regtype
   and (p.proname like 'authorize_branded_email_delivery%' or p.proname='branded_allowed')
   and p.prosrc like '%elsif o.marker_kind = ''retention'' then%'
 loop
   definition:=pg_get_functiondef(f.oid);
   revised:=replace(definition,'elsif o.marker_kind = ''retention'' then',
     'elsif o.marker_kind = ''play_retention'' then
        v_allowed := public.norva_play_retention_delivery_allowed(o.user_id,o.marker_reference);
      elsif o.marker_kind = ''retention'' then');
   execute revised; deliveries:=deliveries+1;
 end loop;
 if enqueues<>1 or deliveries<>2 then raise exception 'play retention gate inventory changed'; end if;
end;
$patch$;
revoke all on function public.norva_play_retention_delivery_allowed(uuid,text),public.norva_play_retention_deliveries(boolean),public.norva_play_retention_claim_push(uuid) from public,anon,authenticated;
grant execute on function public.norva_play_retention_delivery_allowed(uuid,text),public.norva_play_retention_deliveries(boolean),public.norva_play_retention_claim_push(uuid) to service_role;
commit;

-- Run ONLY in a disposable, network-disabled clone of the production SCHEMA.
-- Every row below is synthetic and the transaction always rolls back.
begin;
set local session_replication_role=replica;
insert into billing_prices(plan,period,amount_cents) values('plus','monthly',499),('plus','annual',4199)
  on conflict(plan,period) do update set amount_cents=excluded.amount_cents,promo_amount_cents=null;
do $$declare u uuid;begin
  for n in 1..16 loop
    u:=('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    insert into auth.users(id,email,email_confirmed_at,created_at) values(u,'retention'||n||'@example.test',now(),now());
    insert into cloud_entitlement_projection(user_id,provider,plan_code,status,current_period_end,trial_ends_at,trial_consumed_at)
      values(u,'revolut','plus','cancelled_at_period_end',now()+interval '2 days',now()-interval '30 days',now()-interval '37 days');
    insert into cloud_revolut_customers(user_id,plan,period,amount_cents,payment_method_id,revolut_customer_id)
      values(u,'plus','monthly',499,'synthetic-card','synthetic-customer');
    insert into cloud_entitlement_events(user_id,provider,event_type,provider_event_id,created_at,processed_at,payload)
      values(u,'revolut','CANCELLATION_CONFIRMED','qa-cancel-'||n,now()-interval '1 day',now()-interval '1 day',jsonb_build_object('effective_at',now()+interval '2 days'));
    insert into cloud_marketing_email_preferences(user_id,marketing_email_opt_in,opted_in_at,opted_in_source)
      values(u,n<>12,case when n<>12 then now() end,case when n<>12 then 'account_settings' end);
  end loop;
end$$;
update cloud_revolut_customers set period='annual',amount_cents=4199 where user_id='00000000-0000-4000-8000-000000000002';
update cloud_entitlement_projection set current_period_end=now()+interval '4 days' where user_id='00000000-0000-4000-8000-000000000003';
update cloud_entitlement_projection set current_period_end=now()-interval '4 days',status='expired' where user_id='00000000-0000-4000-8000-000000000005';
insert into cloud_cancel_feedback(user_id,reason,action,created_at) values('00000000-0000-4000-8000-000000000006','technical','cancelled',now());
insert into admin_internal_accounts(user_id) values('00000000-0000-4000-8000-000000000007');
update cloud_entitlement_projection set provider='google_play' where user_id='00000000-0000-4000-8000-000000000008';
update cloud_revolut_customers set promo_cycles_left=2 where user_id='00000000-0000-4000-8000-000000000009';
set local session_replication_role=origin;

do $test$
declare u uuid:='00000000-0000-4000-8000-000000000001';o jsonb;annual jsonb;expired jsonb;
  original_end timestamptz; again jsonb; offer_id uuid; delivery uuid; rejected boolean; candidates jsonb;
begin
  if norva_retention_offer(u) is not null then raise exception 'disabled policy exposed offer';end if;
  update cloud_retention_policy set enabled=true;
  o:=norva_retention_offer(u);offer_id:=(o->>'id')::uuid;
  if o->>'amount_cents'<>'399' or o->>'cycles'<>'3' or o->>'charge_mode'<>'next_cycle' then raise exception 'monthly terms %',o;end if;
  if norva_retention_offer(u)->>'id'<>o->>'id' then raise exception 'duplicate offer';end if;
  annual:=norva_retention_offer('00000000-0000-4000-8000-000000000002');
  if annual->>'amount_cents'<>'3779' or annual->>'cycles'<>'1' then raise exception 'annual terms %',annual;end if;
  if norva_retention_offer('00000000-0000-4000-8000-000000000003') is null then raise exception 'post-cancellation offer missing before J-3';end if;
  if norva_retention_offer('00000000-0000-4000-8000-000000000006')->>'support'<>'true' then raise exception 'technical reason not routed to help';end if;
  foreach u in array array['00000000-0000-4000-8000-000000000007'::uuid,'00000000-0000-4000-8000-000000000008'::uuid,'00000000-0000-4000-8000-000000000009'::uuid] loop
    if norva_retention_offer(u) is not null then raise exception 'ineligible owner exposed: %',u;end if;
  end loop;
  u:='00000000-0000-4000-8000-000000000001';
  rejected:=false;
  begin perform norva_retention_action('00000000-0000-4000-8000-000000000004',offer_id,'accept');
    exception when others then rejected:=true;end;
  if not rejected then raise exception 'cross-owner acceptance';end if;
  if not norva_retention_delivery_allowed(u,offer_id::text||':pre') then raise exception 'consented pre reminder blocked';end if;
  if norva_retention_delivery_allowed(u,offer_id::text||':post') then raise exception 'post reminder too early';end if;
  again:=norva_retention_offer('00000000-0000-4000-8000-000000000012');
  if again is null then raise exception 'in-app offer unnecessarily requires email consent';end if;
  if norva_retention_delivery_allowed('00000000-0000-4000-8000-000000000012',(again->>'id')||':pre') then raise exception 'marketing sent without consent';end if;
  candidates:=norva_retention_candidates();
  if not exists(select 1 from jsonb_array_elements(candidates) x where x->>'id'=o->>'id') then raise exception 'pre candidate missing';end if;
  delivery:=(norva_enqueue_lifecycle_email(u,'retention_offer','lifecycle:retention:'||offer_id||':pre',
    'retention1@example.test','Norva <updates@norva.tv>','support@norva.tv','Synthetic offer','<p>Test</p>','Test',
    '[{"name":"app","value":"norva"},{"name":"category","value":"marketing"},{"name":"flow","value":"retention_offer"}]',
    '{"List-Unsubscribe":"<https://norva.tv/test-unsubscribe>","List-Unsubscribe-Post":"List-Unsubscribe=One-Click"}',
    true,'retention',offer_id::text||':pre',null)->>'id')::uuid;
  if not norva_postal_full.branded_allowed(delivery) then raise exception 'Postal blocked eligible offer';end if;
  if exists(select 1 from jsonb_array_elements(norva_retention_candidates()) x where x->>'id'=o->>'id') then raise exception 'queued offer selected twice';end if;
  select current_period_end into original_end from cloud_entitlement_projection where user_id=u;
  perform norva_retention_action(u,offer_id,'accept');
  if (select current_period_end from cloud_entitlement_projection where user_id=u)<>original_end then raise exception 'paid access moved';end if;
  if (select status from cloud_entitlement_projection where user_id=u)<>'active' then raise exception 'renewal not restored';end if;
  if (select amount_cents from cloud_revolut_customers where user_id=u)<>399
    or (select promo_cycles_left from cloud_revolut_customers where user_id=u)<>3 then raise exception 'promo mapping incorrect';end if;
  again:=norva_retention_action(u,offer_id,'accept');
  if again->>'already_applied'<>'true' then raise exception 'acceptance not idempotent';end if;
  if norva_postal_full.branded_allowed(delivery) then raise exception 'accepted offer still sent';end if;
  if exists(select 1 from cloud_revolut_orders) then raise exception 'accept-before-end opened payment';end if;
  update cloud_entitlement_projection set status='cancelled_at_period_end' where user_id=u;
  if norva_retention_offer(u) is not null then raise exception 'twelve-month cooldown ignored';end if;
  u:='00000000-0000-4000-8000-000000000004';o:=norva_retention_offer(u);
  perform norva_retention_action(u,(o->>'id')::uuid,'decline');
  if norva_retention_offer(u) is not null or norva_retention_delivery_allowed(u,(o->>'id')||':pre') then raise exception 'declined offer still displayed or sent';end if;
  expired:=norva_retention_offer('00000000-0000-4000-8000-000000000005');
  if expired->>'charge_mode'<>'immediate' then raise exception 'expired offer hides immediate debit';end if;
  rejected:=false;
  begin perform norva_retention_action('00000000-0000-4000-8000-000000000005',(expired->>'id')::uuid,'accept');
    exception when others then rejected:=true;end;
  if not rejected then raise exception 'expired offer reactivated free';end if;
  if not norva_retention_delivery_allowed('00000000-0000-4000-8000-000000000005',(expired->>'id')||':post') then raise exception 'post reminder missing';end if;
  raise notice 'RETENTION_BASIC_AND_DELIVERY_OK';
end;
$test$;

do $cooldown$
declare u uuid:='00000000-0000-4000-8000-000000000003';o jsonb;
begin
 o:=norva_retention_offer(u);
 if (o->>'access_until')::timestamptz<>now()+interval '4 days' then raise exception 'access shortened';end if;
 update cloud_retention_offers set state='accepted',accepted_at=now()-interval '11 months' where id=(o->>'id')::uuid;
 if norva_retention_offer_eligible((o->>'id')::uuid,u) then raise exception 'consumed quote reused';end if;
 if norva_retention_offer(u) is not null then raise exception 'cooldown bypass';end if;
 if has_function_privilege('authenticated','public.norva_dispatch_billing_confirmations()','execute') then raise exception 'public cron dispatch';end if;
 raise notice 'IMMEDIATE_OFFER_ACCESS_COOLDOWN_PERMISSIONS_OK';
end;
$cooldown$;
rollback;

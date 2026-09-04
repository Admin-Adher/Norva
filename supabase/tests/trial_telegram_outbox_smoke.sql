-- Execute inside an explicit transaction and ROLLBACK. pg_net wakes created by
-- fixture Auth/entitlement triggers are transactional and never reach Telegram.
do $$
declare u uuid:=gen_random_uuid(); u2 uuid:=gen_random_uuid(); n integer; c record; ok boolean;
begin
  insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values(u,'authenticated','authenticated','trial-routing-test@example.invalid','{}','{}',now(),now()),
        (u2,'authenticated','authenticated','trial-routing-test2@example.invalid','{}','{}',now(),now());
  insert into public.paywall_funnel_events(user_id,event_type,event_source,plan_code,dedupe_key)
  values(u,'paywall_exposed','client_rpc','plus','trial-routing-fixture:'||u::text);
  insert into public.cloud_entitlement_projection(user_id,provider,plan_code,status)
  values(u,'system','plus','unknown') on conflict(user_id) do update set trial_consumed_at=null,trial_ends_at=null;
  if exists(select 1 from public.cloud_trial_telegram_outbox where user_id=u) then raise exception 'unconfirmed trial emitted';end if;
  update public.cloud_entitlement_projection set status='trialing',provider='revolut',trial_consumed_at=now(),trial_ends_at=now()+interval '7 days',current_period_end=now()+interval '7 days',last_event_at=now() where user_id=u;
  select count(*) into n from public.cloud_trial_telegram_outbox where user_id=u;
  if n<>1 then raise exception 'confirmed web trial missing: %',n;end if;
  update public.cloud_entitlement_projection set last_verified_at=now() where user_id=u;
  update public.cloud_entitlement_projection set status='active' where user_id=u;
  update public.cloud_entitlement_projection set status='trialing',provider='google_play' where user_id=u;
  select count(*) into n from public.cloud_trial_telegram_outbox where user_id=u;
  if n<>1 then raise exception 'webhook replay duplicated';end if;
  insert into public.admin_internal_accounts(user_id) values(u2);
  insert into public.cloud_entitlement_projection(user_id,provider,plan_code,status,trial_consumed_at,trial_ends_at,last_event_at,current_period_end)
  values(u2,'system','plus','trialing',now(),now()+interval '7 days',now(),now()+interval '7 days')
  on conflict(user_id) do update set trial_consumed_at=now(),trial_ends_at=now()+interval '7 days';
  if exists(select 1 from public.cloud_trial_telegram_outbox where user_id=u2) then raise exception 'internal trial emitted';end if;
  -- Isolate claim from production work without touching existing queue rows.
  select * into c from public.cloud_trial_telegram_outbox where user_id=u;
  update public.cloud_trial_telegram_outbox set state='processing',lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',attempt_count=1 where id=c.id returning * into c;
  select public.finish_trial_telegram_delivery(c.id,gen_random_uuid(),42) into ok;
  if ok then raise exception 'incorrect lease accepted';end if;
  select public.finish_trial_telegram_delivery(c.id,c.lease_token,null,true,120,'telegram_http_429') into ok;
  if not ok then raise exception 'correct retry lease rejected';end if;
  if not exists(select 1 from public.cloud_trial_telegram_outbox where id=c.id and state='pending' and next_attempt_at>=now()+interval '120 seconds') then raise exception 'retry-after ignored';end if;
  if has_table_privilege('authenticated','public.cloud_trial_telegram_outbox','SELECT') then raise exception 'outbox exposed';end if;
  if has_function_privilege('authenticated','public.claim_trial_telegram_deliveries()','EXECUTE') then raise exception 'claim exposed';end if;
  raise notice 'TRIAL_TELEGRAM_SMOKE_OK: confirmation, replay, internal exclusion, lease CAS, retry-after, ACL';
end $$;

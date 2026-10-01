-- Web retention is available after cancellation. Google Play keeps its own
-- product/offer eligibility and its cross-channel twelve-month exclusion.
begin;
alter table public.cloud_retention_policy
  add column communications_enabled boolean not null default false,
  add column communications_enabled_at timestamptz,
  add constraint retention_communications_start_required
    check(not communications_enabled or communications_enabled_at is not null);
do $patch$
declare original text; revised text;
begin
  original := pg_get_functiondef('public.norva_retention_offer(uuid)'::regprocedure);
  revised := replace(original,
    'or e.current_period_end is null or now()<e.current_period_end-interval ''3 days''',
    'or e.current_period_end is null');
  if revised=original then raise exception 'retention availability contract changed'; end if;
  original:=revised;
  revised:=replace(revised,
    'values(p_user,ev.provider_event_id,e.current_period_end,e.current_period_end-interval ''3 days'',',
    'values(p_user,ev.provider_event_id,e.current_period_end,least(ev.created_at,e.current_period_end-interval ''1 microsecond''),');
  if revised=original then raise exception 'retention offer insert contract changed'; end if;
  original:=revised;
  revised:=replace(revised,'on conflict(user_id,cancellation_event) do nothing;',
    'on conflict(user_id,cancellation_event) do update
      set available_at=least(cloud_retention_offers.available_at,excluded.available_at)
      where cloud_retention_offers.state=''offered'';');
  if revised=original then raise exception 'retention offer conflict contract changed'; end if;
  execute revised;
  original:=pg_get_functiondef('public.norva_retention_delivery_allowed(uuid,text)'::regprocedure);
  revised:=replace(original,'if not public.norva_marketing_email_allowed(p_user)',
    'if not coalesce((select communications_enabled from public.cloud_retention_policy where singleton),false)
    or not public.norva_marketing_email_allowed(p_user)');
  if revised=original then raise exception 'retention communications guard changed'; end if;
  execute revised;
  original:=pg_get_functiondef('public.norva_retention_candidates()'::regprocedure);
  revised:=replace(original,
    'and current_period_end between now()-interval ''7 days'' and now()+interval ''3 days''',
    'and (current_period_end between now()-interval ''7 days'' and now()+interval ''3 days''
      or (current_period_end>now() and last_event_at >=
        (select communications_enabled_at from public.cloud_retention_policy where singleton)))');
  if revised=original then raise exception 'retention candidate timing contract changed'; end if;
  execute revised;
end;
$patch$;

-- Wake the durable billing-email producer after cancellation, with a minutely
-- retry independent of marketing/behavioral sweeps. The HTTP call starts only
-- after commit and cannot roll back a confirmed cancellation.
create or replace function public.norva_dispatch_billing_confirmations()
returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare request_id bigint;
begin
  if not exists(select 1 from public.cloud_lifecycle_billing_intents
    where next_attempt_at<=now() and (state='pending' or (state='processing' and lease_expires_at<=now())))
    then return null; end if;
  select net.http_post(
    url:='https://api.norva.tv/functions/v1/norva-lifecycle/cron/billing-events',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
      (select decrypted_secret from vault.decrypted_secrets where name='norva_cron_shared_secret')),
    body:='{}'::jsonb,timeout_milliseconds:=50000) into request_id;
  return request_id;
exception when others then
  -- The persisted intent remains available to the next cron retry.
  raise warning 'billing confirmation dispatch deferred';
  return null;
end;
$$;
revoke all on function public.norva_dispatch_billing_confirmations() from public,anon,authenticated;
grant execute on function public.norva_dispatch_billing_confirmations() to service_role;
do $cron$
begin
  if exists(select 1 from pg_namespace where nspname='cron') then
    perform cron.schedule('norva-billing-confirmations','* * * * *',
      'select public.norva_dispatch_billing_confirmations();');
  end if;
end;
$cron$;
notify pgrst,'reload schema';
commit;

begin;
-- Preserve the verified store in future cancellation receipts. Older intents
-- without a store use neutral account settings, never a Revolut checkout.
do $patch$
declare original text; revised text; f record; changed int:=0;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prosrc like '%if v_raw_type in (''CANCELLATION'',''SUBSCRIPTION_PAUSED'') then%'
 loop
   original:=pg_get_functiondef(f.oid);
   revised:=replace(original,
     'if v_raw_type in (''CANCELLATION'',''SUBSCRIPTION_PAUSED'') then
    v_payload := jsonb_strip_nulls(jsonb_build_object(',
     'if v_raw_type in (''CANCELLATION'',''SUBSCRIPTION_PAUSED'') then
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      ''store'', new.payload->>''store'',');
   if revised=original then raise exception 'cancellation store contract changed'; end if;
   execute revised; changed:=changed+1;
 end loop;
 if changed<>1 then raise exception 'cancellation producer inventory changed'; end if;
end;
$patch$;

-- A dedicated schedule can be enabled without activating web winback/dunning.
-- Policy stays OFF: deployment alone sends no promotion and opens no offer.
create or replace function public.norva_dispatch_play_retention()
returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare request_id bigint;
begin
  if not coalesce((select enabled and communications_enabled
    from public.cloud_play_retention_policy where singleton),false) then return null; end if;
  select net.http_post(
    url:='https://api.norva.tv/functions/v1/norva-lifecycle/cron/play-retention',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
      (select decrypted_secret from vault.decrypted_secrets where name='norva_cron_shared_secret')),
    body:='{}'::jsonb,timeout_milliseconds:=50000) into request_id;
  return request_id;
exception when others then
  raise warning 'Play retention dispatch deferred'; return null;
end;
$$;
revoke all on function public.norva_dispatch_play_retention() from public,anon,authenticated;
grant execute on function public.norva_dispatch_play_retention() to service_role;
do $cron$
begin
 if exists(select 1 from pg_namespace where nspname='cron') then
   perform cron.schedule('norva-play-retention','*/10 * * * *',
     'select public.norva_dispatch_play_retention();');
 end if;
end;
$cron$;
notify pgrst,'reload schema';
commit;

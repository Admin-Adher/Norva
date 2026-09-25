-- Disposable schema clone only; no network and no real customer rows.
begin;
set local session_replication_role=replica;
insert into auth.users(id,email,email_confirmed_at,created_at)
values('00000000-0000-4000-8000-000000000901','mobile-retention@example.test',now(),now());
insert into public.cloud_entitlement_projection(user_id,provider,plan_code,status,current_period_end)
values('00000000-0000-4000-8000-000000000901','revolut','plus','expired',now()-interval '4 days');
insert into public.cloud_marketing_email_preferences(user_id,marketing_email_opt_in,opted_in_at,opted_in_source)
values('00000000-0000-4000-8000-000000000901',true,now(),'account_settings');
update public.cloud_retention_policy set enabled=false;
set local session_replication_role=origin;

do $test$
declare u uuid:='00000000-0000-4000-8000-000000000901'; r jsonb; delivery uuid; test_provider text;
begin
  if not public.norva_legacy_winback_allowed(u) then raise exception 'legacy web regression'; end if;
  r:=public.norva_enqueue_lifecycle_email(u,'winback','lifecycle:winback:mobile-proof',
    'mobile-retention@example.test','Norva <updates@norva.tv>','support@norva.tv','Synthetic test',
    '<p>Synthetic test</p>','Synthetic test',
    '[{"name":"app","value":"norva"},{"name":"category","value":"marketing"},{"name":"flow","value":"winback"}]',
    '{"List-Unsubscribe":"<https://example.test/optout>","List-Unsubscribe-Post":"List-Unsubscribe=One-Click"}',
    true,'winback');
  select id into delivery from cloud_branded_email_outbox where dedupe_key='lifecycle:winback:mobile-proof';
  if delivery is null then raise exception 'synthetic message not queued'; end if;
  if not norva_postal_full.branded_allowed(delivery) then raise exception 'legacy web delivery rejected'; end if;
  foreach test_provider in array array['google_play','apple_app_store','revenuecat','system'] loop
    update cloud_entitlement_projection set provider=test_provider where user_id=u;
    if public.norva_legacy_winback_allowed(u) then raise exception 'store permitted: %',test_provider; end if;
    if norva_postal_full.branded_allowed(delivery) then raise exception 'queued mail crossed channel: %',test_provider; end if;
    begin
      perform public.norva_enqueue_lifecycle_email(u,'winback','lifecycle:winback:mobile-proof-new',
        'mobile-retention@example.test','Norva <updates@norva.tv>','support@norva.tv','Synthetic test',
        '<p>Synthetic test</p>','Synthetic test',
        '[{"name":"app","value":"norva"},{"name":"category","value":"marketing"},{"name":"flow","value":"winback"}]',
        '{"List-Unsubscribe":"<https://example.test/optout>","List-Unsubscribe-Post":"List-Unsubscribe=One-Click"}',true,'winback');
      raise exception 'store enqueue accepted';
    exception when raise_exception then
      if SQLERRM <> 'invalid_lifecycle_marker' then raise; end if;
    end;
  end loop;
  update cloud_entitlement_projection set provider='revolut' where user_id=u;
  update cloud_retention_policy set enabled=true;
  if public.norva_legacy_winback_allowed(u) or norva_postal_full.branded_allowed(delivery) then
    raise exception 'personal offer policy did not suppress queued generic follow-up'; end if;
  if has_function_privilege('authenticated','public.norva_legacy_winback_allowed(uuid)','execute') then
    raise exception 'eligibility helper exposed to client'; end if;
  raise notice 'MOBILE_RETENTION_CHANNEL_AND_QUEUED_MAIL_OK';
end;
$test$;
rollback;


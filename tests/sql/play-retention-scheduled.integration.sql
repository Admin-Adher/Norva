-- Disposable network-isolated schema clone only. Every synthetic row rolls back.
begin;
set local session_replication_role=replica;
insert into auth.users(id,email) values('00000000-0000-4000-8000-000000000904','scheduled@example.test');
insert into public.cloud_play_retention_offers(id,user_id,cancellation_event,product_id,offer_id,
 access_until,available_at,expires_at,claimed_at,claim_id)
values('00000000-0000-4000-8000-000000000905','00000000-0000-4000-8000-000000000904',
 'scheduled-cancel','norva_plus:monthly','retention-monthly-20',now()+interval '2 days',
 now()-interval '1 day',now()+interval '9 days',now(),'00000000-0000-4000-8000-000000000906');
set local session_replication_role=origin;
do $$
declare payload jsonb; accepted timestamptz;
begin
 payload:=jsonb_build_object('store','PLAY_STORE','environment','PRODUCTION',
 'product_id','norva_plus:monthly','original_transaction_id','GPA.scheduled',
 'purchased_at_ms',floor(extract(epoch from now())*1000),'_norva',jsonb_build_object(
 'projection_applied',true,'play_retention',jsonb_build_object('source','google_play_api',
 'environment','PRODUCTION','offerId','retention-monthly-20','claimId','wrong',
 'accessUntil',now()+interval '2 days')));
 insert into public.cloud_entitlement_events(user_id,provider,provider_event_id,event_type,payload,processed_at)
 values('00000000-0000-4000-8000-000000000904','revenuecat','scheduled-wrong-claim','INITIAL_PURCHASE',payload,now());
 if exists(select 1 from public.cloud_play_retention_offers where cancellation_event='scheduled-cancel' and accepted_at is not null)
 then raise exception 'Wrong claim consumed offer'; end if;
 payload:=jsonb_set(payload,'{_norva,play_retention,claimId}','"00000000-0000-4000-8000-000000000906"');
 insert into public.cloud_entitlement_events(user_id,provider,provider_event_id,event_type,payload,processed_at)
 values('00000000-0000-4000-8000-000000000904','revenuecat','scheduled-confirmed','INITIAL_PURCHASE',payload,now());
 select accepted_at into accepted from public.cloud_play_retention_offers where cancellation_event='scheduled-cancel';
 if accepted is null then raise exception 'Verified scheduled offer not confirmed'; end if;
 insert into public.cloud_entitlement_events(user_id,provider,provider_event_id,event_type,payload,processed_at)
 values('00000000-0000-4000-8000-000000000904','revenuecat','scheduled-duplicate','INITIAL_PURCHASE',payload,now());
 if (select accepted_at from public.cloud_play_retention_offers where cancellation_event='scheduled-cancel')<>accepted
 then raise exception 'Duplicate moved antiabuse boundary'; end if;
end;
$$;
rollback;

-- Run in a network-isolated schema clone only. Synthetic account and rollback.
begin;
set local session_replication_role=replica;
insert into auth.users(id,email,email_confirmed_at,created_at)
values('00000000-0000-4000-8000-000000000902','play-retention@example.test',now(),now());
insert into public.cloud_entitlement_projection(user_id,provider,plan_code,status,current_period_end,billing_product_id)
values('00000000-0000-4000-8000-000000000902','google_play','plus','cancelled_at_period_end',now()+interval '2 days','norva_plus:monthly');
insert into public.cloud_entitlement_events(user_id,provider,provider_event_id,event_type,payload,processed_at)
values('00000000-0000-4000-8000-000000000902','revenuecat','play-proof-cancel','CANCELLATION',
 '{"store":"PLAY_STORE","environment":"PRODUCTION","cancel_reason":"UNSUBSCRIBE","period_type":"NORMAL","original_transaction_id":"GPA.synthetic"}',now());
insert into public.cloud_marketing_email_preferences(user_id,marketing_email_opt_in,opted_in_at,opted_in_source)
values('00000000-0000-4000-8000-000000000902',true,now(),'account_settings');
set local session_replication_role=origin;
do $test$
declare u uuid:='00000000-0000-4000-8000-000000000902'; q jsonb; o uuid; claim jsonb; delivery jsonb; allowed boolean; used_at timestamptz;
begin
 if public.norva_play_retention_offer(u) is not null then raise exception 'policy off leaked offer'; end if;
 update public.cloud_play_retention_policy set enabled=true,communications_enabled=true;
 q:=public.norva_play_retention_offer(u); o:=(q->>'id')::uuid;
 if o is null or q->>'offerId'<>'retention-monthly-20' or (q->>'cycles')::int<>3 then raise exception 'approved offer missing'; end if;
 if public.norva_play_retention_eligible(o,'00000000-0000-4000-8000-000000000903') then raise exception 'owner isolation'; end if;
 select x into delivery from public.norva_play_retention_deliveries(false) x where x->>'user_id'=u::text;
 if delivery->>'channel'<>'email' then raise exception 'email consent channel'; end if;
 if not public.norva_play_retention_delivery_allowed(u,delivery->>'deliveryId') then raise exception 'valid delivery blocked'; end if;
 perform public.norva_play_retention_deliveries(true);
 if (select count(*) from public.cloud_play_retention_deliveries where offer_id=o)<>1 then raise exception 'duplicate stage'; end if;
 update public.cloud_marketing_email_preferences set marketing_email_opt_in=false where user_id=u;
 if public.norva_play_retention_delivery_allowed(u,delivery->>'deliveryId') then raise exception 'revoked email consent'; end if;
 update public.cloud_marketing_email_preferences set marketing_email_opt_in=true where user_id=u;
 update public.cloud_entitlement_projection set provider='revolut' where user_id=u;
 if public.norva_play_retention_offer(u) is not null or public.norva_play_retention_delivery_allowed(u,delivery->>'deliveryId') then raise exception 'cross rail'; end if;
 update public.cloud_entitlement_projection set provider='google_play' where user_id=u;
 claim:=public.norva_play_retention_action(u,o,'claim');
 if claim->>'claimId' is null then raise exception 'claim failed'; end if;
 if public.norva_play_retention_action(u,o,'claim')->>'pending'<>'true' then raise exception 'double tap'; end if;
 if exists(select 1 from public.cloud_play_retention_offers where id=o and accepted_at is not null) then raise exception 'claim consumed'; end if;
 -- A forged or unmapped client result is not an authority.
 insert into public.cloud_entitlement_events(user_id,provider,provider_event_id,event_type,payload,processed_at)
 values(u,'revenuecat','play-proof-purchase','INITIAL_PURCHASE',jsonb_build_object('store','PLAY_STORE','environment','PRODUCTION',
   'offer_code','retention-monthly-20','product_id','norva_plus:monthly','original_transaction_id','GPA.synthetic',
   'purchased_at_ms',floor(extract(epoch from now())*1000),'_norva',jsonb_build_object('projection_applied',true)),now());
 select accepted_at into used_at from public.cloud_play_retention_offers where id=o;
 if used_at is null or public.norva_play_retention_offer(u) is not null then raise exception 'verified consumption'; end if;
 if public.norva_play_retention_delivery_allowed(u,delivery->>'deliveryId') then raise exception 'accepted still contacted'; end if;
 insert into public.cloud_entitlement_events(user_id,provider,provider_event_id,event_type,payload,processed_at)
 select user_id,provider,'play-proof-renewal','RENEWAL',payload||jsonb_build_object('purchased_at_ms',floor(extract(epoch from now()+interval '30 days')*1000)),now()
 from public.cloud_entitlement_events where provider_event_id='play-proof-purchase';
 if (select accepted_at from public.cloud_play_retention_offers where id=o)<>used_at then raise exception 'renewal reset cooldown'; end if;
 if has_function_privilege('authenticated','public.norva_play_retention_action(uuid,uuid,text)','execute') then raise exception 'client write access'; end if;
 raise notice 'GOOGLE_PLAY_RETENTION_OWNER_CHANNEL_CONSENT_DEDUPE_CLAIM_PURCHASE_OK';
end;
$test$;
rollback;

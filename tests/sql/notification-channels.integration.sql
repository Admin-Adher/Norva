-- Networkless disposable database only. Synthetic timing is not device evidence.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('norva.test_is_admin','true',true);
create table public.admin_feature_flags(key text primary key,enabled boolean);
create table public.cloud_provider_access_rollout(singleton boolean,stage text);
insert into public.cloud_provider_access_rollout values(true,'20_percent');
insert into public.admin_feature_flags values('provider_access_notifications_v1_enabled',true),('provider_access_v1_enabled',true),
 ('provider_access_email_v1_enabled',true),('provider_access_push_v1_enabled',false),('provider_access_in_app_v1_enabled',true);
do $$declare rules jsonb;begin
 rules:=admin_marketing_system_automations();
 if jsonb_array_length(rules)<>8 or rules->6->'channel_states'->1->>'enabled'<>'false'
 or rules->1->'channels'<>jsonb_build_array('E-mail') then raise exception 'inventory reports phantom active push';end if;
end$$;
update public.admin_feature_flags set enabled=true where key='provider_access_push_v1_enabled';
do $$begin if admin_marketing_system_automations()->6->'channel_states'->1->>'enabled'<>'true'
 then raise exception 'inventory did not follow actual push flag';end if;end$$;

insert into auth.users(id,email,email_confirmed_at) values('10000000-0000-4000-8000-000000000021','operator@example.test',now());
insert into admin_internal_accounts values('10000000-0000-4000-8000-000000000021');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000021',true);
select admin_record_behavioral_import_readiness('synthetic-notification-proof',repeat('a',40),'fixture-only',repeat('c',64),true,true,true,true,true,'VERIFY IMPORT READINESS');
select admin_update_behavioral_lifecycle_runtime(false,'production','START PRODUCTION','Fixture production channel acceptance');
select admin_update_behavioral_lifecycle_journey('no_source','active',100,0,array['*'],'ACTIVATE no_source',14,1,3,2,21,9,'Fixture full channel coverage');
do $$begin if (norva_seed_behavioral_lifecycle_jobs(50)->>'inserted')::int<>0 then raise exception 'historical account backfill';end if;end$$;

insert into auth.users(id,email,email_confirmed_at) values('10000000-0000-4000-8000-000000000022','new-user@example.test',now());
-- Pick an actual IANA timezone in daytime; never stub the quiet-hours predicate.
select norva_record_lifecycle_timezone('10000000-0000-4000-8000-000000000022',
 (select name from pg_timezone_names where extract(hour from clock_timestamp() at time zone name)=12 order by name limit 1));
select norva_seed_behavioral_lifecycle_jobs(50);
update behavioral_lifecycle_outbox set scheduled_for=clock_timestamp()-interval '1 minute',
 next_attempt_at=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()+interval '3 days'
 where user_id='10000000-0000-4000-8000-000000000022';
do $$declare u uuid:='10000000-0000-4000-8000-000000000022';begin
 if (select count(*) from behavioral_lifecycle_outbox where user_id=u)<>3
 or exists(select 1 from behavioral_lifecycle_outbox where user_id=u and not norva_behavioral_delivery_eligible(id))
 then raise exception 'production channel eligibility missing';end if;
 if norva_materialize_behavioral_in_app(50)<>1 then raise exception 'in-app help not materialized';end if;
end$$;
-- Service push works without marketing opt-in; commercial push requires it.
update behavioral_lifecycle_outbox set is_marketing=true where channel='push';
do $$begin if exists(select 1 from behavioral_lifecycle_outbox where channel='push' and norva_behavioral_delivery_eligible(id))
 then raise exception 'OS permission mistaken for marketing consent';end if;end$$;
insert into cloud_marketing_email_preferences(user_id,marketing_email_opt_in,opted_in_at,opted_in_source)
 values('10000000-0000-4000-8000-000000000022',true,now(),'fixture-explicit');
do $$begin if exists(select 1 from behavioral_lifecycle_outbox where channel='push' and not norva_behavioral_delivery_eligible(id))
 then raise exception 'consented commercial push blocked';end if;end$$;
create temp table notification_claim as select * from norva_claim_behavioral_deliveries('push',10,120);
do $$declare c record;a jsonb;begin
 select * into strict c from notification_claim;
 a:=norva_authorize_behavioral_push(c.id,c.lease_token);
 if a->>'reason'<>'permission_unavailable' then raise exception 'missing device permission was ignored';end if;
end$$;
insert into cloud_push_tokens(token,user_id,permission_state,timezone,last_seen_at)
 select 'fixture-token-never-sent',user_id,'granted',timezone,clock_timestamp() from behavioral_lifecycle_user_state where user_id='10000000-0000-4000-8000-000000000022';
update behavioral_lifecycle_outbox set status='pending',next_attempt_at=clock_timestamp()-interval '1 second' where channel='push';
truncate notification_claim;
insert into notification_claim select * from norva_claim_behavioral_deliveries('push',10,120);
do $$declare c record;a jsonb;u uuid:='10000000-0000-4000-8000-000000000022';begin
 select * into strict c from notification_claim;
 a:=norva_authorize_behavioral_push(c.id,c.lease_token);
 if a->>'authorized'<>'true' or jsonb_array_length(a->'tokens')<>1 then raise exception 'valid push not authorized';end if;
 if norva_marketing_email_contact_allowed(u) then raise exception 'concurrent marketing email ignored push reservation';end if;
 if norva_behavioral_frequency_allowed_at(u,'email','no_source')<clock_timestamp()+interval '23 hours'
 then raise exception 'email duplicated recent push guidance';end if;
 if norva_behavioral_frequency_allowed_at(u,'in_app','no_source')>clock_timestamp()+interval '1 second'
 then raise exception 'immediate in-app help incorrectly capped';end if;
 perform norva_complete_behavioral_push(c.id,c.lease_token,1,0,0,false,null);
end$$;
update behavioral_lifecycle_outbox set provider_accepted_at=clock_timestamp()-interval '2 days',transport_started_at=clock_timestamp()-interval '2 days' where channel='push';
do $$begin if not norva_marketing_email_contact_allowed('10000000-0000-4000-8000-000000000022') then raise exception 'contact cap failed to release';end if;end$$;
insert into cloud_branded_email_outbox(id,delivery_key,user_id,flow,request_from,is_marketing,state,sent_at)
values('40000000-0000-4000-8000-000000000021','notification-fixture-cap','10000000-0000-4000-8000-000000000022','winback','fixture',true,'sent',now()-interval '3 days');
do $$begin if norva_marketing_email_contact_allowed('10000000-0000-4000-8000-000000000022') then raise exception 'weekly commercial cap did not combine email and push';end if;end$$;
update behavioral_lifecycle_outbox set status='email_queued',updated_at=clock_timestamp() where channel='email';
do $$begin if norva_behavioral_frequency_allowed_at('10000000-0000-4000-8000-000000000022','push','no_source')<clock_timestamp()+interval '23 hours'
 then raise exception 'push duplicated queued email guidance';end if;end$$;
update cloud_marketing_email_preferences set unsubscribed_at=now();
do $$begin if exists(select 1 from behavioral_lifecycle_outbox where channel='push' and norva_behavioral_delivery_eligible(id))
 then raise exception 'revoked marketing preference ignored';end if;
 if has_function_privilege('authenticated','public.norva_marketing_contact_allowed(uuid,uuid)','EXECUTE')
 then raise exception 'service policy exposed to browser';end if;
end$$;
select admin_record_behavioral_import_readiness('synthetic-later-failure',repeat('b',40),'fixture-only',repeat('d',64),true,false,true,true,true,'RECORD IMPORT FAILURE');
do $$begin if exists(select 1 from behavioral_lifecycle_outbox where norva_behavioral_delivery_eligible(id)) then raise exception 'later readiness failure ignored';end if;end$$;
rollback;
select 'NOTIFICATION_CHANNELS_PROOF_OK';

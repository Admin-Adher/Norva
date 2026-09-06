-- Disposable database only: behavioral bootstrap + engine + timezone migration.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role','service_role',true);
do $test$
declare
 u uuid := '50000000-0000-0000-0000-000000000001';
 o uuid;
begin
 update public.behavioral_lifecycle_runtime set emergency_stop=false,audience_mode='internal_test';
 update public.behavioral_lifecycle_journeys set status='active',rollout_percent=100,
 activated_at=clock_timestamp()-interval '5 days' where journey_key='no_source';
 insert into auth.users(id,email,created_at) values(u,'timezone@example.test',clock_timestamp()-interval '4 days');
 insert into public.admin_internal_accounts values(u);
 if public.norva_behavioral_timezone_verified(u) then raise exception 'default UTC trusted'; end if;
 perform public.norva_register_push_token(u,'synthetic-token','android','granted',null,'en','1.3.17');
 if public.norva_behavioral_timezone_verified(u) then raise exception 'missing timezone trusted'; end if;
 perform public.norva_seed_behavioral_lifecycle_jobs(100);
 if exists(select 1 from public.behavioral_lifecycle_outbox where user_id=u and channel<>'in_app') then raise exception 'unknown timezone queued external message'; end if;
 if not exists(select 1 from public.behavioral_lifecycle_outbox where user_id=u and channel='in_app') then raise exception 'unknown timezone blocked in-app help'; end if;
 perform public.norva_register_push_token(u,'synthetic-token','android','granted','Asia/Kolkata','en','1.3.17');
 if not public.norva_behavioral_timezone_verified(u) then raise exception 'explicit timezone untrusted'; end if;
 perform public.norva_register_push_token(u,'synthetic-token','android','granted','invalid-zone','en','1.3.17');
 if (select timezone from public.behavioral_lifecycle_user_state where user_id=u)<>'Asia/Kolkata' then raise exception 'invalid metadata replaced good timezone'; end if;
 if public.norva_behavioral_next_allowed_at('2026-09-05 19:00Z','Asia/Kolkata',21::smallint,9::smallint) <> '2026-09-06 03:30Z'::timestamptz then raise exception 'India quiet hours broken'; end if;
 if public.norva_behavioral_next_allowed_at('2026-09-05 19:00Z','Asia/Dhaka',21::smallint,9::smallint) <> '2026-09-06 03:00Z'::timestamptz then raise exception 'Bangladesh quiet hours broken'; end if;
 perform public.norva_seed_behavioral_lifecycle_jobs(100);
 select id into o from public.behavioral_lifecycle_outbox where user_id=u and channel='email' limit 1;
 if o is null then raise exception 'verified timezone did not release email scheduling'; end if;
 update public.behavioral_lifecycle_outbox set experiment_arm='treatment',scheduled_for=clock_timestamp()-interval '1 minute',expires_at=clock_timestamp()+interval '1 day' where id=o;
 if not public.norva_behavioral_delivery_eligible(o) then raise exception 'verified email not eligible'; end if;
 update public.behavioral_lifecycle_user_state set timezone_observed_at=clock_timestamp()-interval '46 days' where user_id=u;
 if public.norva_behavioral_delivery_eligible(o) then raise exception 'stale timezone allowed delivery'; end if;
 perform public.norva_register_push_token(u,'synthetic-token','android','granted','UTC','en','1.3.17');
 if not public.norva_behavioral_timezone_verified(u) then raise exception 'explicit real UTC rejected'; end if;
 delete from public.cloud_push_tokens where user_id=u;
 update public.behavioral_lifecycle_user_state set timezone='UTC',timezone_source='unknown',timezone_observed_at=null where user_id=u;
 if not (public.norva_record_lifecycle_timezone(u,'Asia/Dhaka')->>'ok')::boolean then raise exception 'no-push context refused'; end if;
 if not public.norva_behavioral_timezone_verified(u) or (select timezone from public.behavioral_lifecycle_user_state where user_id=u)<>'Asia/Dhaka' then raise exception 'no-push timezone not observed'; end if;
 if (public.norva_record_lifecycle_timezone(u,'invalid-zone')->>'ok')::boolean then raise exception 'invalid context accepted'; end if;
 if (select timezone from public.behavioral_lifecycle_user_state where user_id=u)<>'Asia/Dhaka' then raise exception 'invalid context overwrote valid timezone'; end if;
 if exists(select 1 from public.cloud_push_tokens where user_id=u) then raise exception 'context fabricated a push token'; end if;
 if has_function_privilege('authenticated','public.norva_record_lifecycle_timezone(uuid,text)','EXECUTE')
   or has_function_privilege('anon','public.norva_record_lifecycle_timezone(uuid,text)','EXECUTE') then raise exception 'browser can choose another context owner'; end if;
 perform set_config('request.jwt.claim.role','authenticated',true);
 begin
   perform public.norva_record_lifecycle_timezone(u,'Europe/Paris');
   raise exception 'role check missing';
 exception when insufficient_privilege then null;
 end;
 perform set_config('request.jwt.claim.role','service_role',true);
end;
$test$;
rollback;
select 'LIFECYCLE_TIMEZONE_RUNTIME_PROOF_OK';

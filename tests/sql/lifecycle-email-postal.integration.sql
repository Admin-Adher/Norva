-- Synthetic accounts only, actual lifecycle/Postal predicates, no network.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role','service_role',true);

do $test$
declare
 u uuid := '60000000-0000-0000-0000-000000000001';
 u3 uuid := '60000000-0000-0000-0000-000000000003';
 o public.behavioral_lifecycle_outbox%rowtype;
 e public.cloud_branded_email_outbox%rowtype;
 token uuid := gen_random_uuid();
 reply jsonb;
 permission text;
 allowed boolean;
 n integer;
 cap_index integer;
 h smallint := extract(hour from clock_timestamp() at time zone 'UTC')::smallint;
 -- Pick a real IANA fixed-offset zone whose local clock is noon. Do not
 -- weaken the production quiet-hour configuration just to make a test pass.
 zone text := case when 12-h=0 then 'UTC' else
   'Etc/GMT'||case when 12-h>0 then '-' else '+' end||abs(12-h)::text end;
 quiet_offset integer := ((22-h+12)%24)-12;
 quiet_zone text := case when quiet_offset=0 then 'UTC' else
   'Etc/GMT'||case when quiet_offset>0 then '-' else '+' end||abs(quiet_offset)::text end;
begin
 if (select delay_minutes from public.behavioral_lifecycle_steps where journey_key='no_source' and channel='email')<>1440
   or (select count(*) from public.behavioral_lifecycle_steps where journey_key='no_source' and channel='email')<>1
   or exists(select 1 from public.behavioral_lifecycle_outbox) then raise exception 'dormant migration manufactured work'; end if;
 if has_function_privilege('anon','norva_postal_full.behavioral_email_not_before(uuid,timestamptz)','execute')
   or has_function_privilege('authenticated','norva_postal_full.behavioral_email_not_before(uuid,timestamptz)','execute')
   or has_function_privilege('service_role','norva_postal_full.behavioral_email_not_before(uuid,timestamptz)','execute')
   or has_function_privilege('norva_postal_full_worker','norva_postal_full.behavioral_email_not_before(uuid,timestamptz)','execute')
   then raise exception 'private helper exposed'; end if;

 update public.behavioral_lifecycle_runtime set emergency_stop=false,audience_mode='internal_test';
 update public.behavioral_lifecycle_journeys set status='active',rollout_percent=100,holdout_percent=0,
   activated_at=clock_timestamp()-interval '7 days' where journey_key='no_source';
 insert into auth.users(id,email,created_at) values
   (u,'fallback@example.test',clock_timestamp()-interval '25 hours'),
   (u3,'day-three@example.test',clock_timestamp()-interval '73 hours');
 insert into public.admin_internal_accounts values(u),(u3);
 perform public.norva_record_lifecycle_timezone(u,zone);
 perform public.norva_record_lifecycle_timezone(u3,zone);
 perform public.norva_seed_behavioral_lifecycle_jobs(100);
 select count(*) into n from public.behavioral_lifecycle_outbox;
 perform public.norva_seed_behavioral_lifecycle_jobs(100);
 if (select count(*) from public.behavioral_lifecycle_outbox)<>n then raise exception 'seed duplicated a step'; end if;
 select * into strict o from public.behavioral_lifecycle_outbox where user_id=u and channel='email';
 if not public.norva_behavioral_delivery_eligible(o.id) then raise exception 'no-push +24h email not eligible'; end if;
 if norva_postal_full.behavioral_email_not_before(o.id,o.triggered_at+interval '23 hours')<>o.triggered_at+interval '24 hours'
   or norva_postal_full.behavioral_email_not_before(gen_random_uuid(),clock_timestamp())<>'infinity'::timestamptz then raise exception 'earliest-send boundary failed'; end if;

 perform public.norva_register_push_token(u,'synthetic-fallback-token','android','granted',zone,'en','1.3.17');
 if norva_postal_full.behavioral_email_not_before(o.id,clock_timestamp())<>o.triggered_at+interval '3 days' then raise exception 'fresh push did not keep J3'; end if;
 update public.behavioral_lifecycle_outbox set status='processing',lease_token=token,lease_expires_at=clock_timestamp()+interval '5 minutes' where id=o.id;
 reply:=public.norva_authorize_behavioral_email_enqueue(o.id,token);
 if reply->>'reason'<>'deferred' or exists(select 1 from public.cloud_branded_email_outbox) then raise exception 'render authorization did not defer'; end if;
 if (select next_attempt_at from public.behavioral_lifecycle_outbox where id=o.id)<o.triggered_at+interval '3 days'
   or (select last_error_family from public.behavioral_lifecycle_outbox where id=o.id) is not null then raise exception 'cadence classified as quiet-hours error'; end if;

 update public.cloud_push_tokens set last_seen_at=clock_timestamp()-interval '46 days' where user_id=u;
 if norva_postal_full.behavioral_email_not_before(o.id,clock_timestamp())>clock_timestamp()+interval '1 second' then raise exception 'stale token delayed fallback'; end if;
 update public.cloud_push_tokens set permission_state='denied',last_seen_at=clock_timestamp() where user_id=u;
 if norva_postal_full.behavioral_email_not_before(o.id,clock_timestamp())>clock_timestamp()+interval '1 second' then raise exception 'denied token delayed fallback'; end if;
 update public.behavioral_lifecycle_outbox set status='processing',lease_token=token,lease_expires_at=clock_timestamp()+interval '5 minutes' where id=o.id;
 reply:=public.norva_authorize_behavioral_email_enqueue(o.id,token);
 if reply->>'authorized'<>'true' then raise exception 'no usable push cannot render'; end if;
 -- Granting push during rendering is caught again by the enqueue function.
 update public.cloud_push_tokens set permission_state='granted' where user_id=u;
 reply:=public.norva_enqueue_behavioral_email(o.id,token,'fallback@example.test','Norva <support@norva.tv>',null,
   o.title,'<p>Controlled fixture</p>',o.body,'[{"name":"flow","value":"behavioral_no_source"}]','{}');
 if reply->>'reason'<>'deferred' or exists(select 1 from public.cloud_branded_email_outbox) then raise exception 'enqueue race bypassed cadence'; end if;
 update public.cloud_push_tokens set permission_state='denied' where user_id=u;
 update public.behavioral_lifecycle_outbox set status='processing',lease_token=token,lease_expires_at=clock_timestamp()+interval '5 minutes' where id=o.id;
 reply:=public.norva_enqueue_behavioral_email(o.id,token,'fallback@example.test','Norva <support@norva.tv>',null,
   o.title,'<p>Controlled fixture</p>',o.body,'[{"name":"flow","value":"behavioral_no_source"}]','{}');
 if reply->>'queued'<>'true' then raise exception 'fallback did not enqueue'; end if;
 select * into strict e from public.cloud_branded_email_outbox where id=(reply->>'id')::uuid;
 reply:=public.norva_enqueue_behavioral_email(o.id,token,'fallback@example.test','Norva <support@norva.tv>',null,
   o.title,'<p>Controlled fixture</p>',o.body,'[]','{}');
 if reply->>'reason'<>'claim_missing' or (select count(*) from public.cloud_branded_email_outbox)<>1 then raise exception 'lease replay duplicated email'; end if;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'allow' then raise exception 'actual Postal refused +24h'; end if;
 update public.cloud_push_tokens set permission_state='granted',last_seen_at=clock_timestamp() where user_id=u;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'defer' then raise exception 'actual Postal missed push-after-enqueue'; end if;
 update norva_postal_full.policy set enabled=true,test_only=false;
 permission:=norva_postal_full.authorize('postal_60000000-0000-4000-8000-000000000001',e.delivery_key,e.recipient_email,false,e.flow);
 if permission<>'defer' or (select count(*) from norva_postal_full.receipts)<>1
   then raise exception 'worker authorization missed cadence: %, receipts %',permission,(select count(*) from norva_postal_full.receipts); end if;

 -- Existing (non-Postal) branded boundary retains the same guard too.
 update public.cloud_branded_email_outbox set state='processing',lease_token=token,lease_expires_at=clock_timestamp()+interval '5 minutes' where id=e.id;
 allowed:=public.authorize_branded_email_delivery(e.id,e.delivery_key,token);
 if allowed
   or (select state from public.cloud_branded_email_outbox where id=e.id)<>'pending' then raise exception 'legacy boundary missed cadence'; end if;

 -- Unknown timezone, global stop, holdout and suppression still block SMTP.
 update public.behavioral_lifecycle_user_state set timezone_source='unknown' where user_id=u;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'cancel' then raise exception 'unknown timezone sent'; end if;
 update public.behavioral_lifecycle_user_state set timezone_source='device' where user_id=u;
 update public.behavioral_lifecycle_runtime set emergency_stop=true;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'cancel' then raise exception 'stop ignored'; end if;
 update public.behavioral_lifecycle_runtime set emergency_stop=false;
 update public.behavioral_lifecycle_outbox set experiment_arm='holdout' where id=o.id;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'cancel' then raise exception 'holdout sent'; end if;
 update public.behavioral_lifecycle_outbox set experiment_arm='treatment' where id=o.id;
 insert into public.cloud_email_suppressions values(e.recipient_email,true);
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'cancel' then raise exception 'suppression ignored'; end if;
 delete from public.cloud_email_suppressions;
 update public.behavioral_lifecycle_user_state set first_source_attempt_at=clock_timestamp() where user_id=u;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'cancel' then raise exception 'first attempt did not stop queued email'; end if;

 -- At J3 a fresh push does not prevent the single final help email.
 perform public.norva_register_push_token(u3,'synthetic-day-three-token','android','granted',zone,'en','1.3.17');
 select * into strict o from public.behavioral_lifecycle_outbox where user_id=u3 and channel='email';
 update public.behavioral_lifecycle_outbox set status='processing',lease_token=token,lease_expires_at=clock_timestamp()+interval '5 minutes' where id=o.id;
 reply:=public.norva_enqueue_behavioral_email(o.id,token,'day-three@example.test','Norva <support@norva.tv>',null,
   o.title,'<p>Controlled fixture</p>',o.body,'[{"name":"flow","value":"behavioral_no_source"}]','{}');
 if reply->>'queued'<>'true' then raise exception 'fresh push blocked J3 email'; end if;
 select * into strict e from public.cloud_branded_email_outbox where id=(reply->>'id')::uuid;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'allow' then raise exception 'Postal blocked J3'; end if;
 -- A genuine spool binding keeps a deferred email claimable beyond the old
 -- Resend window. An HTTP 425 alone is not enough to receive this exception.
 update public.cloud_branded_email_outbox set state='processing',lease_token=token,
   lease_expires_at=clock_timestamp()+interval '5 minutes',attempt_count=12,
   transport_started_at=clock_timestamp()-interval '30 hours' where id=e.id;
 if norva_postal_full.behavioral_pending_window(e.id,clock_timestamp()) then raise exception 'unbound 425 got extended window'; end if;
 permission:=norva_postal_full.authorize('postal_60000000-0000-4000-8000-000000000003',e.delivery_key,e.recipient_email,false,e.flow);
 if permission<>'allow' or not norva_postal_full.behavioral_pending_window(e.id,clock_timestamp()) then raise exception 'genuine pending binding missing'; end if;
 if norva_postal_full.defer_behavioral_pending(e.id,e.delivery_key,token,425,'{"name":"postal_pending","provider":"resend"}')
   then raise exception 'wrong provider got waiting exemption'; end if;
 permission:=public.fail_postal_branded_email_delivery(e.id,e.delivery_key,token,425,'pending',
   '{"name":"postal_pending","provider":"postal"}',true,15,12,true);
 if permission<>'retry_scheduled' or (select state from public.cloud_branded_email_outbox where id=e.id)<>'pending'
   or (select attempt_count from public.cloud_branded_email_outbox where id=e.id)<>11
   or (select transport_started_at from public.cloud_branded_email_outbox where id=e.id)>clock_timestamp()-interval '29 hours'
   then raise exception 'known pending consumed failure budget or reset idempotency'; end if;
 update public.cloud_branded_email_outbox set next_attempt_at=clock_timestamp()-interval '1 second' where id=e.id;
 select c.lease_token into token from public.claim_postal_branded_email_deliveries(4,90,12) c where c.id=e.id;
 if token is null then raise exception 'claim still expired the known Postal wait at 23h'; end if;
 allowed:=public.authorize_branded_email_delivery(e.id,e.delivery_key,token);
 if not allowed then raise exception 'J3 claimed email failed final public authorization'; end if;
 update norva_postal_full.receipts set state='uncertain' where delivery_key=e.delivery_key;
 if norva_postal_full.behavioral_pending_window(e.id,clock_timestamp()) then raise exception 'unknown SMTP result escaped quarantine'; end if;
 update norva_postal_full.receipts set state='pending' where delivery_key=e.delivery_key;
 if norva_postal_full.behavioral_pending_window(e.id,clock_timestamp()+interval '3 days') then raise exception 'extended window is unbounded'; end if;
 update public.behavioral_lifecycle_user_state set timezone=quiet_zone where user_id=u3;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'defer' then raise exception 'quiet hours bypassed'; end if;
 update public.behavioral_lifecycle_user_state set timezone=zone where user_id=u3;
 update public.behavioral_lifecycle_outbox set is_marketing=true where id=o.id;
 update public.cloud_branded_email_outbox set is_marketing=true where id=e.id;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'cancel' then raise exception 'marketing consent bypassed'; end if;
 update public.behavioral_lifecycle_outbox set is_marketing=false where id=o.id;
 update public.cloud_branded_email_outbox set is_marketing=false where id=e.id;
 -- Synthetic accepted history exercises the real weekly cap, without
 -- substituting a test-only frequency/eligibility function.
 for cap_index in 1..2 loop
   insert into public.behavioral_lifecycle_outbox
   select (jsonb_populate_record(null::public.behavioral_lifecycle_outbox,
     to_jsonb(o)||jsonb_build_object('id',gen_random_uuid(),'dedupe_key','cadence-cap-fixture-'||cap_index,
       'status','provider_accepted','provider_accepted_at',clock_timestamp()-make_interval(hours=>cap_index),
       'accepted_count',1,'email_outbox_id',null,'lease_token',null,'lease_expires_at',null))).*;
 end loop;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'defer' then raise exception 'weekly frequency cap bypassed'; end if;
 delete from public.behavioral_lifecycle_outbox where user_id=u3 and dedupe_key in ('cadence-cap-fixture-1','cadence-cap-fixture-2');
 update public.behavioral_lifecycle_outbox set expires_at=clock_timestamp()-interval '1 second' where id=o.id;
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'cancel' then raise exception 'absolute journey expiry bypassed'; end if;
 update public.behavioral_lifecycle_outbox set expires_at=o.expires_at where id=o.id;
 -- Exercise the real source-table trigger, not a production synthetic event.
 insert into public.cloud_sources(user_id,source_type,sync_status) values(u3,'m3u','ready');
 if norva_postal_full.eligibility(e.delivery_key,e.recipient_email,false,e.flow)<>'cancel' then raise exception 'real source trigger failed to cancel'; end if;
 if (select count(*) from public.cloud_branded_email_outbox)<>2 then raise exception 'extra reminders created'; end if;
end;
$test$;
rollback;
select 'CONDITIONAL_EMAIL_POSTAL_RUNTIME_PROOF_OK';

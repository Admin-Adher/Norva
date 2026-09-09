\set ON_ERROR_STOP on
begin;
create temporary table notice_renders(flow text,html text,body text);
create function pg_temp.check_notice(p_ok boolean,p_label text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'NOTICE ASSERTION: %',p_label;end if;end $$;
insert into auth.users(id,email,email_confirmed_at) values
 ('10000000-0000-4000-8000-000000000011','gateway@example.test',now()),
 ('10000000-0000-4000-8000-000000000012','relay@example.test',now()),
 ('10000000-0000-4000-8000-000000000013','unaffected@example.test',now());
select pg_temp.check_notice(not has_schema_privilege('authenticated','norva_notices','USAGE'),'private schema exposed');
select pg_temp.check_notice(not has_function_privilege('anon','public.norva_observe_customer_incident(text,boolean)','EXECUTE'),'incident RPC public');
select pg_temp.check_notice(not has_function_privilege('service_role','norva_notices.password_verification_attempt(jsonb)','EXECUTE'),'server password proof forgeable');
select pg_temp.check_notice((public.norva_observe_customer_incident('gateway',true)->>'enabled')::boolean=false,'disabled circuit sent');
update norva_notices.runtime set security_enabled=true,incidents_enabled=true,prices_enabled=true;

-- Failed logins alone cannot contact anyone; success must be confirmed by Auth.
set local role supabase_auth_admin;
select norva_notices.password_verification_attempt('{"user_id":"10000000-0000-4000-8000-000000000011","valid":false}') from generate_series(1,5);
reset role;
select pg_temp.check_notice(not exists(select 1 from public.cloud_branded_email_outbox),'failed-only email flood');
set local role supabase_auth_admin;
select norva_notices.password_verification_attempt('{"user_id":"10000000-0000-4000-8000-000000000011","valid":true}');
reset role;
select pg_temp.check_notice(not exists(select 1 from public.cloud_branded_email_outbox),'password accepted mistaken for login');
set local role supabase_auth_admin;
insert into auth.audit_log_entries(id,payload,created_at) values(gen_random_uuid(),'{"actor_id":"10000000-0000-4000-8000-000000000011","action":"login"}',now());
reset role;
select pg_temp.check_notice((select count(*)=1 from public.cloud_branded_email_outbox where flow='security_suspicious_login'),'confirmed login notice missing');
insert into notice_renders select flow,request_html,request_text from public.cloud_branded_email_outbox where flow='security_suspicious_login';
set local role supabase_auth_admin;
select norva_notices.password_verification_attempt('{"user_id":"10000000-0000-4000-8000-000000000011","valid":false}') from generate_series(1,5);
select norva_notices.password_verification_attempt('{"user_id":"10000000-0000-4000-8000-000000000011","valid":true}');
insert into auth.audit_log_entries(id,payload,created_at) values(gen_random_uuid(),'{"actor_id":"10000000-0000-4000-8000-000000000011","action":"login"}',now());
insert into auth.audit_log_entries(id,payload,created_at) values(gen_random_uuid(),'{"actor_id":"10000000-0000-4000-8000-000000000011","action":"token_revoked"}',now());
reset role;
select pg_temp.check_notice((select count(*)=1 from public.cloud_branded_email_outbox),'cooldown or token-revocation guard failed');

insert into public.cloud_gateway_sessions values('10000000-0000-4000-8000-000000000011',now());
insert into public.cloud_playback_sessions values('10000000-0000-4000-8000-000000000012',now(),'relay');
insert into public.cloud_gateway_sessions values('10000000-0000-4000-8000-000000000013',now()-interval '1 day');
set local role service_role;
select public.norva_observe_customer_incident('gateway',true);
select public.norva_observe_customer_incident('gateway',true);
reset role;
select pg_temp.check_notice(not exists(select 1 from norva_notices.incidents),'rapid repeated calls created incident');
update norva_notices.incident_observations set last_observed_at=now()-interval '15 minutes',failing_since=now()-interval '15 minutes' where service='gateway';
set local role service_role;
select public.norva_observe_customer_incident('gateway',true);
reset role;
select pg_temp.check_notice((select count(*)=1 from public.cloud_branded_email_outbox where flow='service_incident'),'incident recipient count');
insert into notice_renders select flow,request_html,request_text from public.cloud_branded_email_outbox where flow='service_incident';
select pg_temp.check_notice((select bool_and(user_id='10000000-0000-4000-8000-000000000011') from public.cloud_branded_email_outbox where flow='service_incident'),'unaffected customer notified');
-- A recovery cannot arrive before the outage was delivered.
update public.cloud_branded_email_outbox set state='sent',sent_at=now(),recipient_email=null,request_reply_to=null,request_subject=null,request_html=null,request_text=null where flow='service_incident';
update norva_notices.incident_observations set last_observed_at=now()-interval '15 minutes' where service='gateway';
select public.norva_observe_customer_incident('gateway',false);
select pg_temp.check_notice(not exists(select 1 from public.cloud_branded_email_outbox where flow='service_recovered'),'one healthy probe falsely recovered');
update norva_notices.incident_observations set last_observed_at=now()-interval '15 minutes',healthy_since=now()-interval '15 minutes' where service='gateway';
select public.norva_observe_customer_incident('gateway',false);
select pg_temp.check_notice((select count(*)=1 from public.cloud_branded_email_outbox where flow='service_recovered'),'recovery missing');
insert into notice_renders select flow,request_html,request_text from public.cloud_branded_email_outbox where flow='service_recovered';
select public.norva_observe_customer_incident('relay',true);
update norva_notices.incident_observations set last_observed_at=now()-interval '15 minutes',failing_since=now()-interval '15 minutes' where service='relay';
select public.norva_observe_customer_incident('relay',true);
update norva_notices.incident_observations set last_observed_at=now()-interval '15 minutes' where service='relay';
select public.norva_observe_customer_incident('relay',false);
update norva_notices.incident_observations set last_observed_at=now()-interval '15 minutes',healthy_since=now()-interval '15 minutes' where service='relay';
select public.norva_observe_customer_incident('relay',false);
select pg_temp.check_notice((select count(*)=1 from public.cloud_branded_email_outbox where flow='service_incident' and state='canceled'),'stale unsent incident not canceled');
select pg_temp.check_notice((select count(*)=1 from public.cloud_branded_email_outbox where flow='service_recovered'),'recovery without delivered initial notice');

insert into public.cloud_entitlement_projection values('10000000-0000-4000-8000-000000000013','revolut','active',now()+interval '30 days');
insert into public.cloud_revolut_customers(user_id,plan,period,amount_cents,base_amount_cents,promo_cycles_left)
 values('10000000-0000-4000-8000-000000000013','plus','monthly',299,499,1);
update public.cloud_revolut_customers set amount_cents=499,base_amount_cents=null,promo_cycles_left=null;
select pg_temp.check_notice((select count(*)=1 from norva_notices.price_events where reason='promotion_completed'),'promo ending price notice missing');
select pg_temp.check_notice((select request_text like '%USD 2.99%' and request_text like '%USD 4.99%' and request_text like '%per month%' from public.cloud_branded_email_outbox where flow='billing_price_change'),'price/currency/period not exact');
insert into notice_renders select flow,request_html,request_text from public.cloud_branded_email_outbox where flow='billing_price_change';
update public.cloud_revolut_customers set amount_cents=499;
select pg_temp.check_notice((select count(*)=1 from norva_notices.price_events),'noop price update duplicated');
update public.cloud_revolut_customers set pending_plan='family',pending_period='monthly',pending_amount_cents=899,pending_effective_at=now()+interval '30 days',pending_order_id='real-user-checkout';
select pg_temp.check_notice((select count(*)=1 from norva_notices.price_events),'plan-change confirmation duplicated');
update public.cloud_revolut_customers set plan='family',amount_cents=899,pending_order_id=null,pending_plan=null,pending_amount_cents=null;
select pg_temp.check_notice((select count(*)=1 from norva_notices.price_events),'plan application duplicated');
select set_config('norva.test_is_admin','true',true);
select pg_temp.check_notice(jsonb_array_length(public.admin_marketing_system_automations())=4,'inventory not extended');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000013',true);
do $$begin
 begin perform public.norva_observe_customer_incident('gateway',false);raise exception 'user observation accepted';
 exception when insufficient_privilege then null;end;
end $$;
select json_build_object('rendered_notices',jsonb_agg(to_jsonb(notice_renders))) from notice_renders;
rollback;
select 'CUSTOMER_NOTICES_SQL_PROOF_OK';

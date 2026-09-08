-- Disposable database only. No outbound network or customer mutations.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('norva.test_is_admin','true',true);
insert into auth.users(id,email) values('10000000-0000-4000-8000-000000000011','security@example.test');
insert into auth.identities values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000011');
update auth.users set email_confirmed_at=now();
insert into auth.mfa_factors values('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000011','unverified');
do $$begin if exists(select 1 from captured_security_email) then raise exception 'unverified factor or signup emitted notice';end if;end$$;
update auth.mfa_factors set status='verified';
update auth.mfa_factors set status='verified';
delete from auth.mfa_factors;
insert into auth.identities values('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000011');
delete from auth.identities where id='20000000-0000-4000-8000-000000000002';
update auth.users set phone='+10000000001',phone_confirmed_at=now();
update auth.users set phone=phone;
do $$begin
 if (select count(*) from captured_security_email)<>5 then raise exception 'expected five security events';end if;
 if (select count(distinct flow) from captured_security_email)<>5 then raise exception 'security types duplicated or missing';end if;
 if exists(select 1 from captured_security_email where recipient<>'security@example.test') then raise exception 'wrong security recipient';end if;
 if has_function_privilege('authenticated','public.norva_enqueue_account_security_notice(uuid,text,text)','EXECUTE')
 or has_function_privilege('anon','public.norva_pending_renewal_email_quotes(integer)','EXECUTE') then raise exception 'privileged API exposed';end if;
end$$;
insert into auth.mfa_factors values('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000011','verified');
delete from auth.users;
do $$begin if (select count(*) from captured_security_email)<>6 then raise exception 'account deletion emitted misleading security notices';end if;end$$;

insert into auth.users(id,email,email_confirmed_at) values('10000000-0000-4000-8000-000000000012','renewal@example.test',now());
insert into cloud_revolut_customers(user_id,amount_cents,discount_next_pct) values('10000000-0000-4000-8000-000000000012',999,20);
insert into fixture_renewals values('10000000-0000-4000-8000-000000000012',now()+interval '3 days','fixture-cycle');
do $$begin if (select amount_cents from norva_pending_renewal_email_quotes())<>799 then raise exception 'discount quote incorrect';end if;end$$;
update cloud_revolut_customers set amount_cents=50,discount_next_pct=99;
do $$begin if (select amount_cents from norva_pending_renewal_email_quotes())<>50 then raise exception 'billing floor incorrect';end if;end$$;
update cloud_revolut_customers set pending_effective_at=now()+interval '1 day';
do $$begin if (select amount_cents from norva_pending_renewal_email_quotes()) is not null then raise exception 'pending quote invented';end if;end$$;
do $$begin
 if not norva_marketing_email_contact_allowed('10000000-0000-4000-8000-000000000012') then raise exception 'empty marketing history blocked';end if;
end$$;
insert into cloud_branded_email_outbox(id,delivery_key,user_id,flow,request_from,is_marketing,state,sent_at)
values('40000000-0000-4000-8000-000000000001','fixture-cap-1','10000000-0000-4000-8000-000000000012','winback','test',true,'sent',now()-interval '1 hour');
do $$begin if norva_marketing_email_contact_allowed('10000000-0000-4000-8000-000000000012') then raise exception '24 hour commercial cap ignored';end if;end$$;
update cloud_branded_email_outbox set sent_at=now()-interval '2 days';
do $$begin if not norva_marketing_email_contact_allowed('10000000-0000-4000-8000-000000000012') then raise exception 'commercial cap failed to release';end if;end$$;
insert into cloud_branded_email_outbox(id,delivery_key,user_id,flow,request_from,is_marketing,state,sent_at)
values('40000000-0000-4000-8000-000000000002','fixture-cap-2','10000000-0000-4000-8000-000000000012','checkout_abandoned','test',true,'sent',now()-interval '3 days');
do $$begin if norva_marketing_email_contact_allowed('10000000-0000-4000-8000-000000000012') then raise exception 'shared weekly commercial cap ignored';end if;end$$;

do $$begin
 begin
  perform admin_update_behavioral_lifecycle_runtime(false,'production','START PRODUCTION','Fixture production acceptance');
  raise exception 'production accepted without readiness';
 exception when sqlstate '55000' then null;end;
end$$;
-- Exercise real audience and delivery predicates; evidence itself is synthetic.
-- The readiness gate is append-only, so use the same documented admin recorder as production.
insert into admin_internal_accounts(user_id) values('10000000-0000-4000-8000-000000000012');
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000012',true);
select admin_record_behavioral_import_readiness('synthetic-email-proof',repeat('a',40),'1.3.19+32',repeat('c',64),
 true,true,true,true,true,'VERIFY IMPORT READINESS');
update behavioral_lifecycle_steps set enabled=false;
select admin_update_behavioral_lifecycle_runtime(false,'production','START PRODUCTION','Fixture production acceptance');
select admin_update_behavioral_lifecycle_journey('no_source','active',100,0,array['*'],'ACTIVATE no_source',14,0,0,2,21,9,'Fixture email production rollout');
do $$begin
 if (select holdout_percent from behavioral_lifecycle_journeys where journey_key='no_source')<>0 then raise exception 'holdout not disabled for production';end if;
 if not exists(select 1 from behavioral_lifecycle_admin_audit where action='runtime_started_production') then raise exception 'missing activation audit';end if;
end$$;
insert into auth.users(id,email,email_confirmed_at) values('10000000-0000-4000-8000-000000000013','france@example.test',now());
update behavioral_lifecycle_user_state set country_code='FR' where user_id='10000000-0000-4000-8000-000000000013';
select norva_record_lifecycle_timezone('10000000-0000-4000-8000-000000000013','Europe/Paris');
do $$begin
 if not norva_behavioral_journey_relevant('10000000-0000-4000-8000-000000000013','no_source') then raise exception 'production excludes non-pilot country';end if;
 if norva_behavioral_journey_relevant('10000000-0000-4000-8000-000000000012','no_source') then raise exception 'production includes internal account';end if;
end$$;
select admin_record_behavioral_import_readiness('synthetic-email-failure',repeat('b',40),'1.3.19+32',repeat('d',64),
 true,false,true,true,true,'RECORD IMPORT FAILURE');
do $$begin
 if norva_behavioral_journey_relevant('10000000-0000-4000-8000-000000000013','no_source') then raise exception 'production ignored subsequent failure';end if;
end$$;
rollback;
select 'EMAIL_COVERAGE_PROOF_OK';

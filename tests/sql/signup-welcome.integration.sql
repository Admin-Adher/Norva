-- Run only in the isolated disposable database after the bootstrap, the real
-- complete_branded_email_delivery function, and the new migration. No sends.
\set ON_ERROR_STOP on
begin;
do $test$
declare
 v_user uuid := '10000000-0000-0000-0000-000000000001';
 v_old uuid := '10000000-0000-0000-0000-000000000002';
 v_internal uuid := '10000000-0000-0000-0000-000000000003';
 v_unconfirmed uuid := '10000000-0000-0000-0000-000000000004';
 v_id uuid := '20000000-0000-0000-0000-000000000001';
 v_lease uuid := '30000000-0000-0000-0000-000000000001';
 v_count integer;
begin
 insert into auth.users values
  (v_user,'new@example.test',clock_timestamp(),clock_timestamp()),
  (v_old,'old@example.test',clock_timestamp()-interval '30 days',clock_timestamp()-interval '30 days'),
  (v_internal,'internal@example.test',clock_timestamp(),clock_timestamp()),
  (v_unconfirmed,'unconfirmed@example.test',clock_timestamp(),null);
 insert into public.admin_internal_accounts values(v_internal);
 select count(*) into v_count from public.norva_pending_signup_welcomes(100);
 if v_count <> 0 then raise exception 'disabled runtime selected users'; end if;
 update public.lifecycle_signup_welcome_runtime set enabled=true;
 select count(*) into v_count from public.norva_pending_signup_welcomes(100);
 if v_count <> 1 then raise exception 'expected exactly one confirmed free signup, got %',v_count; end if;
 if not public.norva_signup_welcome_eligible(v_user) then raise exception 'free signup ineligible'; end if;
 if exists(select 1 from public.cloud_entitlement_projection) then raise exception 'fabricated entitlement'; end if;
 perform public.norva_pending_signup_welcomes(100);
 if (select count(*) from public.lifecycle_signup_welcomes) <> 1 then raise exception 'duplicate marker'; end if;
 insert into public.cloud_branded_email_outbox(id,user_id,delivery_key,state,lease_token,marker_kind)
 values(v_id,v_user,'lifecycle:welcome:'||v_user,'processing',v_lease,'welcome');
 if exists(select 1 from public.norva_pending_signup_welcomes(100)) then raise exception 'queued welcome selected again'; end if;
 if public.authorize_branded_email_delivery_pre_behavioral(v_id,'wrong-key',v_lease) then raise exception 'bad lease accepted'; end if;
 if not public.authorize_branded_email_delivery_pre_behavioral(v_id,'lifecycle:welcome:'||v_user,v_lease) then raise exception 'free welcome rejected before send'; end if;
 if not public.complete_branded_email_delivery(v_id,'lifecycle:welcome:'||v_user,v_lease,'synthetic-provider-id',200,'{}') then raise exception 'ack failed'; end if;
 if not exists(select 1 from public.lifecycle_signup_welcomes where user_id=v_user and sent_at is not null) then raise exception 'independent marker missing'; end if;
 if public.norva_signup_welcome_eligible(v_user) then raise exception 'sent welcome still eligible'; end if;
 if exists(select 1 from public.cloud_entitlement_projection) then raise exception 'ack fabricated entitlement'; end if;
 if public.complete_branded_email_delivery(v_id,'lifecycle:welcome:'||v_user,v_lease,'synthetic-provider-id',200,'{}') then raise exception 'duplicate ack accepted'; end if;
 if has_function_privilege('authenticated','public.norva_pending_signup_welcomes(integer)','execute') then raise exception 'public candidate access'; end if;
 if has_table_privilege('service_role','public.lifecycle_signup_welcome_runtime','update') then raise exception 'service can enable runtime'; end if;
end;
$test$;
do $revocation$
declare
 u uuid := '10000000-0000-0000-0000-000000000011';
 o uuid := '20000000-0000-0000-0000-000000000011';
 l uuid := '30000000-0000-0000-0000-000000000011';
begin
 insert into auth.users values(u,'revoked@example.test',clock_timestamp(),clock_timestamp());
 perform public.norva_pending_signup_welcomes(100);
 insert into public.cloud_branded_email_outbox(id,user_id,delivery_key,state,lease_token,marker_kind,request_html)
 values(o,u,'revoke-proof','processing',l,'welcome','synthetic body');
 update auth.users set email_confirmed_at=null where id=u;
 if public.authorize_branded_email_delivery_pre_behavioral(o,'revoke-proof',l) then raise exception 'revoked confirmation allowed'; end if;
 if not exists(select 1 from public.cloud_branded_email_outbox where id=o and state='canceled' and request_html is null) then raise exception 'revoked delivery not scrubbed'; end if;
 update auth.users set email_confirmed_at=clock_timestamp() where id=u;
 update public.cloud_branded_email_outbox set state='processing',lease_token=l where id=o;
 update public.lifecycle_signup_welcome_runtime set enabled=false;
 if public.authorize_branded_email_delivery_pre_behavioral(o,'revoke-proof',l) then raise exception 'disabled welcome authorized'; end if;
 if exists(select 1 from public.norva_pending_signup_welcomes(100)) then raise exception 'disabled cohort leaked'; end if;
end;
$revocation$;
rollback;
select 'SIGNUP_WELCOME_RUNTIME_PROOF_OK';

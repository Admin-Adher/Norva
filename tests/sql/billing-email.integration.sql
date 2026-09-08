-- Synthetic database only. Real candidate, enqueue, authorization and ack functions.
begin;
do $test$
declare u uuid;v_id uuid;v_again uuid;v_key text;v_cycle text;v_lease uuid:=gen_random_uuid();r record;
begin
 for n in 1..9 loop
  u:=('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  insert into auth.users values(u,'user'||n||'@example.test',now(),now());
  insert into cloud_entitlement_projection(user_id,provider,status,current_period_end,dunning_stage)
   values(u,'revolut','active',now()+interval '2 days',0);
  insert into cloud_revolut_customers values(u,'monthly',399,'synthetic-payment','synthetic-customer');
 end loop;
 insert into admin_internal_accounts values('00000000-0000-4000-8000-000000000002');
 update cloud_entitlement_projection set provider='google_play' where user_id='00000000-0000-4000-8000-000000000003';
 update cloud_entitlement_projection set status='cancelled_at_period_end' where user_id='00000000-0000-4000-8000-000000000004';
 update cloud_entitlement_projection set current_period_end=now()+interval '5 days' where user_id in ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006');
 update cloud_revolut_customers set period='annual' where user_id='00000000-0000-4000-8000-000000000006';
 update auth.users set email_confirmed_at=null where id='00000000-0000-4000-8000-000000000007';
 update cloud_entitlement_projection set status='past_due',current_period_end=now()-interval '2 days',dunning_stage=null where user_id='00000000-0000-4000-8000-000000000008';
 update cloud_entitlement_projection set status='past_due',current_period_end=null,trial_ends_at=null where user_id='00000000-0000-4000-8000-000000000009';
 if (select count(*) from norva_pending_renewal_emails(100))<>2 then raise exception 'wrong renewal cohort';end if;
 if (select count(*) from norva_pending_dunning_emails(100))<>1 then raise exception 'null-stage dunning lost or unsafe cohort';end if;

 select * into r from norva_pending_renewal_emails(100) where user_id='00000000-0000-4000-8000-000000000001';
 v_key:='lifecycle:renewal:'||r.user_id||':'||r.cycle_key;
 for n in 1..2 loop
  v_again:=(norva_enqueue_lifecycle_email(r.user_id,'renewal_upcoming',v_key,'user1@example.test','Norva <updates@norva.tv>','support@norva.tv','Renewal','<p>Synthetic</p>','Synthetic',
   '[{"name":"app","value":"norva"},{"name":"category","value":"transactional"},{"name":"flow","value":"renewal_upcoming"}]','{}',false,'billing_event',r.cycle_key,null)->>'id')::uuid;
  if n=1 then v_id:=v_again;elsif v_again<>v_id then raise exception 'duplicate renewal';end if;
 end loop;
 if (select count(*) from norva_pending_renewal_emails(100))<>1 then raise exception 'queued renewal selected again';end if;
 if not norva_postal_full.branded_allowed(v_id) then raise exception 'valid renewal blocked';end if;
 update cloud_entitlement_projection set status='cancelled_at_period_end' where user_id=r.user_id;
 if norva_postal_full.branded_allowed(v_id) then raise exception 'canceled renewal reached SMTP';end if;
 update cloud_branded_email_outbox set state='processing',lease_token=v_lease where id=v_id;
 if authorize_branded_email_delivery_pre_behavioral(v_id,(select delivery_key from cloud_branded_email_outbox where id=v_id),v_lease) then raise exception 'canceled renewal reached Edge';end if;
 if not exists(select 1 from cloud_branded_email_outbox where id=v_id and state='canceled' and request_html is null) then raise exception 'cancel did not scrub payload';end if;
 update cloud_entitlement_projection set status='active',current_period_end=now()+interval '32 days' where user_id=r.user_id;
 if norva_billing_notice_allowed(v_id) then raise exception 'old cycle allowed';end if;

 select * into r from norva_pending_dunning_emails(100);
 if r.stage<>1 then raise exception 'null stage did not start at one';end if;
 v_cycle:=r.cycle_key;
 v_key:='lifecycle:dunning:'||r.user_id||':'||r.cycle_key||':1';
 v_id:=(norva_enqueue_lifecycle_email(r.user_id,'payment_failed',v_key,'user8@example.test','Norva <updates@norva.tv>','support@norva.tv','Payment','<p>Synthetic</p>','Synthetic',
  '[{"name":"app","value":"norva"},{"name":"category","value":"transactional"},{"name":"flow","value":"payment_failed"}]','{}',false,'dunning',r.cycle_key,1::smallint)->>'id')::uuid;
 if not norva_postal_full.branded_allowed(v_id) then raise exception 'valid dunning rejected';end if;
 update cloud_entitlement_projection set dunning_last_at=now() where user_id=r.user_id;
 if norva_postal_full.branded_allowed(v_id) then raise exception '24 hour throttle bypassed';end if;
 update cloud_entitlement_projection set dunning_last_at=null,current_period_end=now()-interval '1 day' where user_id=r.user_id;
 if norva_postal_full.branded_allowed(v_id) then raise exception 'stale-cycle dunning reached SMTP';end if;
 update cloud_branded_email_outbox set state='processing',lease_token=v_lease where id=v_id;
 if not complete_postal_branded_email_delivery(v_id,(select delivery_key from cloud_branded_email_outbox where id=v_id),v_lease,'synthetic-receipt',200,'{}') then raise exception 'historical ack failed';end if;
 if not exists(select 1 from cloud_entitlement_projection where user_id=r.user_id and dunning_stage is null and dunning_last_at is null) then raise exception 'historical ack advanced new cycle';end if;
 select * into r from norva_pending_dunning_emails(100);
 if r.cycle_key=v_cycle then raise exception 'different billing cycle shares dedupe';end if;
 v_id:=(norva_enqueue_lifecycle_email(r.user_id,'payment_failed','lifecycle:dunning:'||r.user_id||':'||r.cycle_key||':1','user8@example.test','Norva <updates@norva.tv>','support@norva.tv','Payment','<p>Synthetic</p>','Synthetic',
  '[{"name":"app","value":"norva"},{"name":"category","value":"transactional"},{"name":"flow","value":"payment_failed"}]','{}',false,'dunning',r.cycle_key,1::smallint)->>'id')::uuid;
 update cloud_branded_email_outbox set state='processing',lease_token=v_lease where id=v_id;
 if not complete_postal_branded_email_delivery(v_id,(select delivery_key from cloud_branded_email_outbox where id=v_id),v_lease,'synthetic-new-receipt',200,'{}') then raise exception 'new-cycle ack failed';end if;
 if not exists(select 1 from cloud_entitlement_projection where user_id=r.user_id and dunning_stage=1 and dunning_last_at is not null) then raise exception 'new-cycle ack lost';end if;
 if exists(select 1 from norva_pending_dunning_emails(100)) then raise exception 'immediate second-stage enqueue';end if;
 if has_function_privilege('authenticated','norva_pending_dunning_emails(integer)','execute') or has_function_privilege('authenticated','norva_pending_renewal_emails(integer)','execute') then raise exception 'public billing candidates';end if;
end $test$;
rollback;
select 'BILLING_EMAIL_PROOF_OK';

\i /proof/fixture.sql
create table public.full_proof_checks(name text primary key);
create function public.check_full(ok boolean,n text) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'FAIL:%',n;end if;insert into public.full_proof_checks values(n);raise notice 'PASS:%',n;end $$;
select public.check_full(not (select enabled from norva_postal_full.policy),'starts_disabled');
select public.check_full(not has_schema_privilege('anon','norva_postal_full','usage'),'no_anon_schema');
select public.check_full(not has_table_privilege('norva_postal_full_worker','norva_postal_full.receipts','update'),'no_worker_direct_table_write');
select public.check_full(not has_function_privilege('service_role','norva_postal_full.record_verified_complaint(text,text)','execute'),'no_unverified_complaint_route');
update norva_postal_full.policy set enabled=true,test_recipients=array['test@example.test'];
select public.check_full(not norva_postal_full.preflight('norva-auth-test','outsider@example.test',true,'signup'),'test_scope_rejects_customer');
select public.check_full(norva_postal_full.preflight('norva-auth-test','test@example.test',true,'signup'),'auth_allowed_in_test_scope');
select public.check_full(norva_postal_full.authorize('postal_10000000-0000-4000-8000-000000000001','norva-auth-test','test@example.test',true,'signup')='allow','auth_registered');
select public.check_full(not norva_postal_full.receipt_is_sent('postal_10000000-0000-4000-8000-000000000001','norva-auth-test'),'queue_acceptance_not_sent');
do $$begin begin perform norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000001','sent',1,false);raise exception 'FAIL:insecure';exception when raise_exception then if sqlerrm='FAIL:insecure' then raise;end if;end;end$$;
select public.check_full(norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000001','sent',1,true),'secure_receipt');
select public.check_full(not norva_postal_full.receipt_is_sent('postal_10000000-0000-4000-8000-000000000001','wrong-key'),'receipt_key_binding');
select public.check_full(norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000001','sent',1,true),'receipt_duplicate_idempotent');
select public.check_full(not norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000001','failed',1,true),'sent_is_monotonic');

-- Exact production CAS/completion procedures, synthetic rows only.
insert into public.cloud_support_email_outbox(delivery_key,state,recipient_email,request_html,lease_token) values('support-proof','processing','test@example.test','sensitive fixture','10000000-0000-4000-8000-000000000001');
select public.check_full(norva_postal_full.authorize('postal_10000000-0000-4000-8000-000000000002','support-proof','test@example.test',false,'support')='allow','support_live_source_binding');
select public.check_full(not public.complete_postal_support_email_delivery('support-proof','10000000-0000-4000-8000-000000000001','postal_10000000-0000-4000-8000-000000000002',200,'{}'),'support_waits_smtp');
select norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000002','sent',2,true);
select public.check_full(not public.complete_postal_support_email_delivery('support-proof','10000000-0000-4000-8000-000000000009','postal_10000000-0000-4000-8000-000000000002',200,'{}'),'support_lease_cas');
select public.check_full(public.complete_postal_support_email_delivery('support-proof','10000000-0000-4000-8000-000000000001','postal_10000000-0000-4000-8000-000000000002',200,'{}'),'support_complete');
select public.check_full((select state='sent' and request_html is null and recipient_email is null and postal_delivery_id is not null and resend_email_id is null from public.cloud_support_email_outbox),'support_scrubbed_distinct_receipt');

insert into public.cloud_account_deletion_email_outbox(delivery_key,state,recipient_email,request_html,lease_token) values('delete-proof','processing','test@example.test','fixture','10000000-0000-4000-8000-000000000001');
select public.check_full(not norva_postal_full.preflight('delete-proof','test@example.test',false,'deletion'),'deletion_requires_confirmed_deletion');
update public.cloud_account_deletion_email_outbox set deletion_confirmed_at=now();
select norva_postal_full.authorize('postal_10000000-0000-4000-8000-000000000003','delete-proof','test@example.test',false,'deletion');
select norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000003','sent',3,true);
select public.check_full(public.complete_postal_account_deletion_email_delivery('delete-proof','10000000-0000-4000-8000-000000000001','postal_10000000-0000-4000-8000-000000000003',200,'{}'),'deletion_complete_without_auth_user');
insert into public.cloud_billing_receipt_outbox(delivery_key,recipient_email,request_html,lease_token) values('billing-proof','test@example.test','fixture','10000000-0000-4000-8000-000000000001');
select norva_postal_full.authorize('postal_10000000-0000-4000-8000-000000000004','billing-proof','test@example.test',false,'billing');
select norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000004','sent',4,true);
select public.check_full(public.complete_postal_billing_receipt_delivery('billing-proof','10000000-0000-4000-8000-000000000001','postal_10000000-0000-4000-8000-000000000004',200,'{}'),'billing_complete');
select public.check_full((select request_html is null and recipient_email is null and postal_delivery_id is not null and resend_email_id is null from public.cloud_billing_receipt_outbox),'billing_scrubbed');

insert into public.cloud_branded_email_outbox(id,delivery_key,mail_provider,state,recipient_email,request_html,lease_token,is_marketing) values('20000000-0000-4000-8000-000000000001','branded-proof','postal','processing','test@example.test','fixture','10000000-0000-4000-8000-000000000001',false);
select public.check_full(norva_postal_full.authorize('postal_10000000-0000-4000-8000-000000000005','branded-proof','test@example.test',false,'security')='allow','branded_fresh_authorization');
update public.cloud_branded_email_outbox set is_marketing=true;update public.proof_controls set marketing=false;
select public.check_full(norva_postal_full.authorize('postal_10000000-0000-4000-8000-000000000005','branded-proof','test@example.test',false,'security')='cancel','marketing_consent_revocation_stops_send');
update public.proof_controls set marketing=true;
select norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000005','sent',5,true);
select public.check_full(public.complete_postal_branded_email_delivery('20000000-0000-4000-8000-000000000001','branded-proof','10000000-0000-4000-8000-000000000001','postal_10000000-0000-4000-8000-000000000005',200,'{}'),'branded_complete');
select public.check_full((select resend_email_id is null and postal_delivery_id is not null and request_html is null from public.cloud_branded_email_outbox),'branded_keeps_provider_separation');

insert into public.cloud_import_notifications(id,delivery_key,status,recipient_email,request_from,request_reply_to,request_subject,request_html,request_text,request_tags,prepared_at,lease_token)
values('20000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002','processing','test@example.test','fixture','fixture','fixture','fixture','fixture','[]',now(),'10000000-0000-4000-8000-000000000001');
select public.check_full(norva_postal_full.authorize('postal_10000000-0000-4000-8000-000000000006','norva-import-40000000-0000-4000-8000-000000000002','test@example.test',false,'import')='allow','import_prefixed_key_binding');
select public.check_full(not public.complete_postal_import_notification_delivery('40000000-0000-4000-8000-000000000002',array['20000000-0000-4000-8000-000000000002'::uuid],'10000000-0000-4000-8000-000000000001','test@example.test',200,'postal_10000000-0000-4000-8000-000000000006','{}'),'import_waits_smtp');
select norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000006','sent',6,true);
select public.check_full(public.complete_postal_import_notification_delivery('40000000-0000-4000-8000-000000000002',array['20000000-0000-4000-8000-000000000002'::uuid],'10000000-0000-4000-8000-000000000001','test@example.test',200,'postal_10000000-0000-4000-8000-000000000006','{}'),'import_complete');
select public.check_full((select status='sent' and resend_email_id is null and postal_delivery_id is not null and request_html is null from public.cloud_import_notifications),'import_scrubbed_distinct_receipt');
insert into public.catalog_generated_subtitle_notifications(id,status) values('20000000-0000-4000-8000-000000000003','queued');
insert into public.catalog_subtitle_email_deliveries(id,notification_id,delivery_key,status,recipient_email,request_from,request_reply_to,request_subject,request_html,request_text,request_tags,lease_token,lease_expires_at)
values('20000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000003','subtitle-proof','processing','test@example.test','fixture','fixture','fixture','fixture','fixture','[]','10000000-0000-4000-8000-000000000001',now()+interval '10 minutes');
select public.check_full(norva_postal_full.authorize('postal_10000000-0000-4000-8000-000000000007','subtitle-proof','test@example.test',false,'subtitle')='allow','subtitle_binding');
select public.check_full(not public.complete_postal_subtitle_email_delivery('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001',200,'postal_10000000-0000-4000-8000-000000000007','{}'),'subtitle_waits_smtp');
select norva_postal_full.receipt('postal_10000000-0000-4000-8000-000000000007','sent',7,true);
select public.check_full(public.complete_postal_subtitle_email_delivery('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001',200,'postal_10000000-0000-4000-8000-000000000007','{}'),'subtitle_complete');
select public.check_full((select status='sent' and resend_email_id is null and postal_delivery_id is not null and request_html is null from public.catalog_subtitle_email_deliveries),'subtitle_scrubbed_distinct_receipt');
select public.check_full(not norva_postal_full.preflight('norva-ops-test','test@example.test',false,'ops'),'ops_unconfigured_refused');
update norva_postal_full.policy set ops_recipients=array['test@example.test'];
select public.check_full(norva_postal_full.preflight('norva-ops-test','test@example.test',false,'ops'),'ops_explicit_recipient_only');
select public.check_full(norva_postal_full.feedback('postal_10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',repeat('a',64),1,'MessageBounced',now())='applied','bounce_persisted');
select public.check_full(norva_postal_full.feedback('postal_10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',repeat('a',64),1,'MessageBounced',now())='duplicate','bounce_dedup');
select public.check_full(not norva_postal_full.preflight('norva-auth-new','test@example.test',true,'signup'),'bounce_blocks_subsequent_sends');
select public.check_full(norva_postal_full.record_verified_complaint('postal_10000000-0000-4000-8000-000000000001',repeat('b',64)),'operator_complaint');
select norva_postal_full.feedback('postal_10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',repeat('c',64),1,'MessageSent',now());
select public.check_full((select active and complaint_seen_at is not null from public.cloud_email_suppressions),'sent_does_not_clear_complaint');
update norva_postal_full.policy set enabled=false;

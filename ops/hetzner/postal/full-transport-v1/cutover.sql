-- Explicit full-production cutover only, not part of the disabled installer.
begin;
set local lock_timeout='1500ms';set local statement_timeout='10s';
select pg_advisory_xact_lock(1788683001);
do $$begin
 if current_user<>'supabase_admin' or current_setting('norva.postal_cutover',true)is distinct from 'authorized-full-replacement' then raise exception 'explicit_cutover_required';end if;
 if not exists(select 1 from public.cloud_branded_email_outbox where dedupe_key='postal-full-real-queue-proof-20260906-1' and state='sent' and postal_delivery_id is not null and resend_email_id is null and request_html is null)then raise exception 'real_proof_missing';end if;
 if exists(select 1 from public.cloud_branded_email_outbox where mail_provider='resend' and state in ('pending','processing'))
  or exists(select 1 from public.cloud_support_email_outbox where state in ('pending','processing'))
  or exists(select 1 from public.cloud_account_deletion_email_outbox where state in ('pending','processing'))
  or exists(select 1 from public.cloud_billing_receipt_outbox where sent_at is null and exhausted_at is null)
  or exists(select 1 from public.cloud_import_notifications where status in ('pending','processing'))
  or exists(select 1 from public.catalog_subtitle_email_deliveries where status in ('pending','processing')) then raise exception 'pending_legacy_mail_requires_reconciliation';end if;
 if exists(select 1 from norva_postal_full.receipts where state in ('pending','uncertain'))then raise exception 'incomplete_full_receipts';end if;
end$$;
alter table public.cloud_branded_email_outbox alter column mail_provider set default 'postal';
update norva_postal_full.policy set enabled=true,test_only=false;
-- No historical row is moved, reactivated, deleted or enqueued by this change.
commit;

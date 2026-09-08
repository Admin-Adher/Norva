-- Restore notification triggers only. Initial credential creation and
-- unconfirmed signup retries must never produce a password-change warning.
set lock_timeout='3s';
set statement_timeout='30s';
drop trigger if exists norva_password_changed_trg on auth.users;
create trigger norva_password_changed_trg
 after update of encrypted_password on auth.users for each row
 when (old.encrypted_password is distinct from new.encrypted_password
   and nullif(old.encrypted_password,'') is not null
   and nullif(new.encrypted_password,'') is not null
   and old.email_confirmed_at is not null and new.email_confirmed_at is not null)
 execute function public.norva_notify_password_changed();

drop trigger if exists norva_email_changed_trg on auth.users;
create trigger norva_email_changed_trg
 after update of email on auth.users for each row
 when (lower(old.email) is distinct from lower(new.email)
   and nullif(btrim(old.email),'') is not null and nullif(btrim(new.email),'') is not null
   and old.email_confirmed_at is not null and new.email_confirmed_at is not null)
 execute function public.norva_notify_email_changed();

-- Aggregate-only health endpoint for the existing restricted private worker.
-- The independent Telegram monitor never receives recipient identities/content.
create or replace function norva_postal_full.delivery_health()
returns jsonb language sql stable security definer set search_path='pg_catalog'
as $$
select jsonb_build_object(
 'auth_failures_24h',(select count(*) from norva_postal_full.receipts
   where auth and state in ('failed','uncertain') and created_at>now()-interval '24 hours'),
 'auth_expired_24h',(select count(*) from norva_postal_full.receipts
   where auth and state='canceled' and created_at>now()-interval '24 hours'),
 'import_dead_letters_72h',(select count(distinct delivery_key) from public.cloud_import_notifications
   where status='dead_letter' and created_at>now()-interval '72 hours'),
 'import_overdue',(select count(distinct delivery_key) from public.cloud_import_notifications
   where status in ('pending','processing') and created_at<now()-interval '15 minutes'),
 'branded_dead_letters_72h',(select count(*) from public.cloud_branded_email_outbox
   where state='dead_letter' and created_at>now()-interval '72 hours'),
 'branded_overdue',(select count(*) from public.cloud_branded_email_outbox
   where state in ('pending','processing') and next_attempt_at<now()-interval '15 minutes'
     and flow not like 'behavioral_%'),
 'support_overdue',(select count(*) from public.cloud_support_email_outbox
   where state in ('ready','processing') and next_attempt_at<now()-interval '15 minutes'),
 'billing_receipts_overdue',(select count(*) from public.cloud_billing_receipt_outbox
   where sent_at is null and exhausted_at is null and next_attempt_at<now()-interval '90 minutes')
);
$$;
revoke all on function norva_postal_full.delivery_health() from public,anon,authenticated;
grant execute on function norva_postal_full.delivery_health() to norva_postal_full_worker;

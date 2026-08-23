\set ON_ERROR_STOP on
begin;
set local "request.jwt.claim.role" = 'service_role';

-- A deterministic fixture is inserted before the deletion fence.  The test
-- drives two bounded batches and asserts that no retry can double a rollup.
insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  'd0000000-0000-0000-0000-000000000085','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','analytics-delete-085@invalid.test','not-used',clock_timestamp(),
  '{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp()
) on conflict (id) do nothing;
insert into public.paywall_funnel_events(
  id,user_id,event_type,event_source,experiment_key,experiment_variant,
  placement,surface,plan_code,dedupe_key,occurred_at
) values
  ('d1000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000085',
   'paywall_exposed','client_rpc','delete_test','control','subscribe','web','plus',
   'account-delete-analytics-085-1','2026-08-23T10:00:00Z'),
  ('d1000000-0000-0000-0000-000000000002','d0000000-0000-0000-0000-000000000085',
   'checkout_started','client_rpc','delete_test','control','subscribe','web','plus',
   'account-delete-analytics-085-2','2026-08-23T10:01:00Z')
on conflict (id) do nothing;

select public.norva_begin_account_deletion_workflow(
  'd0000000-0000-0000-0000-000000000085'
);
update public.cloud_provider_transport_stop_actions
set state='completed',completed_at=clock_timestamp(),
    transport_stop_receipt_hash=repeat('a',64)
where user_id='d0000000-0000-0000-0000-000000000085';
update public.cloud_provider_account_delete_preparations
set state='ready',phase='ready',ready_at=clock_timestamp(),lease_owner=null,lease_until=null
where user_id='d0000000-0000-0000-0000-000000000085';
select public.norva_purge_account_deletion_paywall_batch(
  'd0000000-0000-0000-0000-000000000085',0,1
);
select public.norva_purge_account_deletion_paywall_batch(
  'd0000000-0000-0000-0000-000000000085',2,1
);
do $assert$
begin
  if exists (select 1 from public.paywall_funnel_events where user_id='d0000000-0000-0000-0000-000000000085')
     or (select coalesce(sum(event_count),0) from public.account_deletion_paywall_daily_rollups
         where experiment_key='delete_test') <> 2
     or (select count(*) from pg_constraint where conname in (
       'paywall_funnel_events_user_id_fkey','paywall_experiment_assignments_user_id_fkey'
     ) and confdeltype <> 'r') <> 0 then
    raise exception 'account deletion analytics contract failed';
  end if;
end
$assert$;
rollback;

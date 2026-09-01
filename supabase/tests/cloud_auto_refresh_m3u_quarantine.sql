\set ON_ERROR_STOP on

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
create extension if not exists pgtap with schema extensions;
grant usage on schema extensions to service_role;
select extensions.plan(13);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '98a00000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'auto-refresh-m3u-quarantine-98a@invalid.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version, auto_refresh_next_at, auto_refresh_state
) values (
  '98a00000-0000-4000-8000-000000000101',
  '98a00000-0000-4000-8000-000000000001', 'm3u', 'Quarantined M3U',
  'cipher-quarantined', '{"playlistHost":"quarantine-98a.invalid"}'::jsonb,
  'error', 1, now() - interval '1 hour', '{}'::jsonb
);

create temp table auto_refresh_98a_claims as
select result.*
from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-98a', 1, 720) result;

select extensions.is(
  (select source_id from auto_refresh_98a_claims),
  '98a00000-0000-4000-8000-000000000101'::uuid,
  'the due M3U source receives one fenced fair-refresh claim'
);

select extensions.is(
  public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a',
    (select lease_sequence from auto_refresh_98a_claims),
    'action_required', now(), 409, 'm3u_quarantined'
  ) ->> 'outcome',
  'action_required',
  'the exact M3U quarantine settlement is accepted'
);

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a-stale',
    999999,
    'success', now(), null, null
  )$$,
  'PT409',
  'cloud auto refresh lease is stale',
  'a stale fair-refresh worker receives the application conflict contract'
);

select extensions.ok(
  (select auto_refresh_lease_owner is null and auto_refresh_lease_expires_at is null
   from public.cloud_sources
   where id = '98a00000-0000-4000-8000-000000000101'),
  'settling M3U quarantine releases the fair-refresh lease immediately'
);

select extensions.is(
  (select auto_refresh_state ->> 'actionRequiredReason'
   from public.cloud_sources
   where id = '98a00000-0000-4000-8000-000000000101'),
  'TOGGLE_SOURCE',
  'M3U quarantine exposes the exact recovery action'
);

select extensions.ok(
  (select (auto_refresh_state ->> 'suspended')::boolean
   from public.cloud_sources
   where id = '98a00000-0000-4000-8000-000000000101'),
  'the already-bounded fourth M3U failure suspends automatic pressure'
);

update public.cloud_sources
set auto_refresh_state = '{}'::jsonb,
    auto_refresh_next_at = now() - interval '1 second'
where id = '98a00000-0000-4000-8000-000000000101';

create temp table auto_refresh_98a_invalid_claims as
select result.*
from public.norva_claim_cloud_auto_refresh_sources('auto-refresh-98a-invalid', 1, 720) result;

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a-invalid',
    (select lease_sequence from auto_refresh_98a_invalid_claims),
    'action_required', now(), 409, 'auth'
  )$$,
  '22023',
  'invalid cloud auto refresh settlement',
  'HTTP 409 cannot be relabelled as an authentication action'
);

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a-invalid',
    (select lease_sequence from auto_refresh_98a_invalid_claims),
    'action_required', now(), 503, 'm3u_quarantined'
  )$$,
  '22023',
  'invalid cloud auto refresh settlement',
  'M3U quarantine cannot be paired with a different HTTP status'
);

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a-invalid',
    (select lease_sequence from auto_refresh_98a_invalid_claims),
    'action_required', now(), 409, 'unknown'
  )$$,
  '22023',
  'invalid cloud auto refresh settlement',
  'all other HTTP 409 action kinds remain fail closed'
);

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a-invalid',
    (select lease_sequence from auto_refresh_98a_invalid_claims),
    null, now(), null, null
  )$$,
  '22023',
  'invalid cloud auto refresh settlement',
  'a NULL outcome is rejected before terminal settlement'
);

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a-invalid',
    (select lease_sequence from auto_refresh_98a_invalid_claims),
    'action_required', now(), null, null
  )$$,
  '22023',
  'invalid cloud auto refresh settlement',
  'an action without status or kind is rejected'
);

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a-invalid',
    (select lease_sequence from auto_refresh_98a_invalid_claims),
    'action_required', now(), null, 'm3u_quarantined'
  )$$,
  '22023',
  'invalid cloud auto refresh settlement',
  'M3U quarantine without its HTTP status is rejected'
);

select extensions.throws_ok(
  $$select public.norva_settle_cloud_auto_refresh_source(
    '98a00000-0000-4000-8000-000000000101',
    '98a00000-0000-4000-8000-000000000001',
    'auto-refresh-98a-invalid',
    (select lease_sequence from auto_refresh_98a_invalid_claims),
    'action_required', now(), 409, null
  )$$,
  '22023',
  'invalid cloud auto refresh settlement',
  'HTTP 409 without the exact quarantine kind is rejected'
);

select * from extensions.finish();
rollback;

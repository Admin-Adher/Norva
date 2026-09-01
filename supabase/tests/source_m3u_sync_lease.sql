begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';
create extension if not exists pgtap with schema extensions;

select extensions.plan(54);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '98400000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'm3u-lease-984@invalid.test', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version, enabled, last_synced_at
) values (
  '98400000-0000-4000-8000-000000000101',
  '98400000-0000-4000-8000-000000000001',
  'm3u', 'M3U lease smoke', 'cipher-m3u',
  '{"syncProgress":{"status":"queued","stage":"queued","updatedAt":"1970-01-01T00:00:00Z"}}'::jsonb,
  'syncing', 1, true, now()
);

select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.norva_claim_source_m3u_sync_lease(uuid,uuid,uuid,integer)',
    'EXECUTE'
  ),
  'authenticated users cannot claim the service-owned M3U lease'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.norva_claim_source_m3u_sync_lease(uuid,uuid,uuid,integer)',
    'EXECUTE'
  ),
  'service role can claim the M3U lease through the RPC only'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000201', 300
  )->>'claimed')::boolean,
  true,
  'the first worker wins the atomic lease'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000202', 300
  )->>'reason'),
  'leased',
  'a concurrent worker is rejected before provider I/O'
);

select extensions.is(
  public.norva_renew_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000202', 300
  ),
  false,
  'a non-owner cannot heartbeat the lease'
);

select extensions.is(
  public.norva_renew_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000201', 300
  ),
  true,
  'the exact owner can heartbeat the lease'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000202',
    'cancelled', null
  )->>'reason',
  'lease_lost',
  'a non-owner cannot settle or release another worker lease'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000201',
    'transient_error', 'HTTP_503'
  )->>'state',
  'retry_wait',
  'a transient failure enters durable backoff'
);

select extensions.is(
  public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000202', 300
  )->>'reason',
  'backoff',
  'the watchdog cannot bypass retry backoff'
);

update public.cloud_source_m3u_sync_leases
set next_attempt_at = clock_timestamp() - interval '1 second'
where source_id = '98400000-0000-4000-8000-000000000101';

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000202', 300
  )->>'attemptCount')::integer,
  2,
  'the next eligible provider attempt advances the bounded budget'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000202',
    'permanent_error', 'HTTP_401'
  )->>'state',
  'quarantined',
  'a permanent provider/configuration failure is quarantined immediately'
);

select extensions.is(
  public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000203', 300
  )->>'reason',
  'quarantined',
  'minute cron ticks never resurrect a quarantined import'
);

update public.cloud_sources
set enabled = false
where id = '98400000-0000-4000-8000-000000000101';
update public.cloud_sources
set enabled = true
where id = '98400000-0000-4000-8000-000000000101';

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000203', 300
  )->>'attemptCount')::integer,
  1,
  'an explicit disable/re-enable resets quarantine and the attempt budget'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000203',
    'success', null
  )->>'state',
  'idle',
  'success releases ownership and clears prior failures'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000205', 300
  )->>'claimed')::boolean,
  true,
  'a fresh worker owns the provider lane before a credential transition'
);

-- The production affinity trigger correctly permits ciphertext changes only
-- inside the credential-transition state machine. This pgTAP transaction
-- temporarily isolates the downstream M3U reset trigger so its own deferred
-- reset semantics can be exercised without forging a credential transition.
alter table public.cloud_sources disable trigger trg_cloud_sources_provider_account_affinity;
update public.cloud_sources
set config_ciphertext = 'cipher-m3u-rotated-while-running'
where id = '98400000-0000-4000-8000-000000000101';
alter table public.cloud_sources enable trigger trg_cloud_sources_provider_account_affinity;

select extensions.is(
  (select reset_after_release
   from public.cloud_source_m3u_sync_leases
   where source_id = '98400000-0000-4000-8000-000000000101'),
  true,
  'a credential transition defers reset while the old provider lease is live'
);

select extensions.is(
  public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000206', 300
  )->>'reason',
  'leased',
  'a credential transition cannot open a second provider transport'
);

select extensions.is(
  public.norva_renew_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000205', 300
  ),
  false,
  'the superseded owner cannot extend a reset-pending lease'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000205',
    'transient_error', 'HTTP_503'
  )->>'state',
  'idle',
  'settling the old owner consumes the deferred credential reset'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000206', 300
  )->>'attemptCount')::integer,
  1,
  'the first post-credential-reset claim starts a fresh attempt budget'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000206',
    'success', null
  )->>'state',
  'idle',
  'the post-credential-reset worker releases normally'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000207', 300
  )->>'claimed')::boolean,
  true,
  'a fresh worker owns the provider lane before disable and re-enable'
);

update public.cloud_sources
set enabled = false
where id = '98400000-0000-4000-8000-000000000101';
update public.cloud_sources
set enabled = true
where id = '98400000-0000-4000-8000-000000000101';

select extensions.is(
  public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000208', 300
  )->>'reason',
  'leased',
  'disable and re-enable cannot open a second provider transport'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000207',
    'cancelled', null
  )->>'state',
  'idle',
  'the old owner consumes the deferred re-enable reset on settlement'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000208', 300
  )->>'attemptCount')::integer,
  1,
  'the first post-re-enable claim starts a fresh attempt budget'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000208',
    'success', null
  )->>'state',
  'idle',
  'the post-re-enable worker releases normally'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000209', 300
  )->>'claimed')::boolean,
  true,
  'a live owner is available for the deferred-reset expiry path'
);

alter table public.cloud_sources disable trigger trg_cloud_sources_provider_account_affinity;
update public.cloud_sources
set config_ciphertext = 'cipher-m3u-expiry-reset'
where id = '98400000-0000-4000-8000-000000000101';
alter table public.cloud_sources enable trigger trg_cloud_sources_provider_account_affinity;
update public.cloud_source_m3u_sync_leases
set lease_until = clock_timestamp() - interval '1 second'
where source_id = '98400000-0000-4000-8000-000000000101';

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000210', 300
  )->>'attemptCount')::integer,
  1,
  'an expired reset-pending lease is consumed before the next claim'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000210',
    'success', null
  )->>'state',
  'idle',
  'the post-expiry worker releases normally'
);

select extensions.ok(
  not has_function_privilege(
    'authenticated',
    'public.norva_claim_source_m3u_diagnostic_lease(uuid,uuid,uuid,integer)',
    'EXECUTE'
  ),
  'authenticated users cannot claim the service-owned M3U diagnostic lease'
);

select extensions.ok(
  has_function_privilege(
    'service_role',
    'public.norva_claim_source_m3u_diagnostic_lease(uuid,uuid,uuid,integer)',
    'EXECUTE'
  ),
  'service role can claim the non-counting diagnostic lease'
);

select extensions.is(
  (public.norva_claim_source_m3u_diagnostic_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000211', 60
  )->>'attemptCount')::integer,
  0,
  'a diagnostic lease enters only from a clean zero-budget idle row'
);

select extensions.is(
  public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000212', 300
  )->>'reason',
  'leased',
  'a diagnostic owner excludes a catalogue import from provider I/O'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000211',
    'cancelled', null
  )->>'state',
  'idle',
  'a diagnostic settlement returns to idle without consuming a retry'
);

select extensions.is(
  (public.norva_claim_source_m3u_diagnostic_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000215', 60
  )->>'claimed')::boolean,
  true,
  'a diagnostic owner can enter before a credential transition'
);

alter table public.cloud_sources disable trigger trg_cloud_sources_provider_account_affinity;
update public.cloud_sources
set config_ciphertext = 'cipher-m3u-diagnostic-expiry-reset'
where id = '98400000-0000-4000-8000-000000000101';
alter table public.cloud_sources enable trigger trg_cloud_sources_provider_account_affinity;

select extensions.is(
  (select reset_after_release
   from public.cloud_source_m3u_sync_leases
   where source_id = '98400000-0000-4000-8000-000000000101'),
  true,
  'a live diagnostic owner also receives the deferred reset marker'
);

update public.cloud_source_m3u_sync_leases
set lease_until = clock_timestamp() - interval '1 second'
where source_id = '98400000-0000-4000-8000-000000000101';

select extensions.is(
  (public.norva_claim_source_m3u_diagnostic_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000216', 60
  )->>'claimed')::boolean,
  true,
  'diagnostic claim consumes an expired deferred reset instead of staying leased'
);

select extensions.is(
  (select attempt_count
   from public.cloud_source_m3u_sync_leases
   where source_id = '98400000-0000-4000-8000-000000000101'),
  0,
  'post-reset diagnostic ownership keeps the durable import budget at zero'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000216',
    'cancelled', null
  )->>'state',
  'idle',
  'the post-reset diagnostic owner releases normally'
);

-- A raw-only fair refresh can quarantine a catalogue that is still healthy
-- and ready. TOGGLE_SOURCE must reset both durable control planes without
-- manufacturing a full-sync cursor or moving the source back to syncing.
insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version, enabled, last_synced_at
) values (
  '98400000-0000-4000-8000-000000000102',
  '98400000-0000-4000-8000-000000000001',
  'm3u', 'Ready quarantined M3U', 'cipher-m3u-ready',
  '{"syncProgress":{"status":"complete","stage":"complete","updatedAt":"2026-09-01T00:00:00Z"},"readySentinel":"preserve"}'::jsonb,
  'ready', 7, false, now()
);

select set_config('request.jwt.claim.role', 'service_role', true);
update public.cloud_sources
set auto_refresh_next_at = clock_timestamp() + interval '30 days',
    auto_refresh_state = jsonb_build_object(
      'attempts', 0,
      'lastOutcome', 'action_required',
      'actionRequired', true,
      'actionRequiredReason', 'TOGGLE_SOURCE',
      'terminalHttpStatus', 409,
      'terminalErrorKind', 'm3u_quarantined',
      'terminalFailureCount', 1,
      'suspended', true
    ),
    auto_refresh_lease_owner = 'raw-only-ready-984',
    auto_refresh_lease_sequence = 7,
    auto_refresh_lease_expires_at = clock_timestamp() + interval '5 minutes'
where id = '98400000-0000-4000-8000-000000000102';
select set_config('request.jwt.claim.role', '', true);

insert into public.cloud_source_m3u_sync_leases (
  source_id, user_id, state, attempt_count, next_attempt_at,
  last_error_kind, last_error_at, updated_at
) values (
  '98400000-0000-4000-8000-000000000102',
  '98400000-0000-4000-8000-000000000001',
  'quarantined', 4, '-infinity'::timestamptz,
  'HTTP_401', now(), now()
);

select set_config('request.jwt.claim.role', 'service_role', true);
update public.cloud_sources
set enabled = true
where id = '98400000-0000-4000-8000-000000000102';
select set_config('request.jwt.claim.role', '', true);

select extensions.is(
  (select sync_status from public.cloud_sources
   where id = '98400000-0000-4000-8000-000000000102'),
  'ready',
  're-enabling a ready quarantined M3U preserves ready status'
);

select extensions.is(
  (select config_hint->>'readySentinel' from public.cloud_sources
   where id = '98400000-0000-4000-8000-000000000102'),
  'preserve',
  'ready recovery preserves the existing catalogue progress payload'
);

select extensions.ok(
  (select coalesce(auto_refresh_state->>'suspended', 'false') = 'false'
      and auto_refresh_state->>'actionRequired' is null
      and auto_refresh_state->>'lastOutcome' = 'source_reenabled'
   from public.cloud_sources
   where id = '98400000-0000-4000-8000-000000000102'),
  'ready recovery clears the fair-refresh TOGGLE_SOURCE suspension'
);

select extensions.ok(
  (select auto_refresh_lease_owner is null
      and auto_refresh_lease_expires_at is null
      and auto_refresh_lease_sequence = 8
   from public.cloud_sources
   where id = '98400000-0000-4000-8000-000000000102'),
  'ready recovery fences and clears the old fair-refresh lease'
);

select extensions.ok(
  (select auto_refresh_next_at <= clock_timestamp()
   from public.cloud_sources
   where id = '98400000-0000-4000-8000-000000000102'),
  'ready recovery makes fair auto-refresh immediately due'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000102',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000217', 300
  )->>'attemptCount')::integer,
  1,
  'the first ready-source claim after TOGGLE_SOURCE starts at attempt one'
);

select extensions.is(
  (public.norva_claim_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000213', 300
  )->>'attemptCount')::integer,
  1,
  'a real import still starts the durable provider-attempt budget'
);

select extensions.is(
  public.norva_settle_source_m3u_sync_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000213',
    'transient_error', 'HTTP_503'
  )->>'state',
  'retry_wait',
  'a failed import retains its retry history before diagnostics'
);

select extensions.is(
  public.norva_claim_source_m3u_diagnostic_lease(
    '98400000-0000-4000-8000-000000000101',
    '98400000-0000-4000-8000-000000000001',
    '98400000-0000-4000-8000-000000000214', 60
  )->>'reason',
  'backoff',
  'a diagnostic cannot erase a real import retry/backoff budget'
);

select extensions.is(
  (select count(*)::integer
   from cron.job
   where jobname = 'norva-resume-stuck-sync'),
  1,
  'fresh install or repair leaves exactly one source-resume cron job'
);

select extensions.is(
  (select active
   from cron.job
   where jobname = 'norva-resume-stuck-sync'),
  true,
  'the unique source-resume cron job is active'
);

select extensions.is(
  (select schedule
   from cron.job
   where jobname = 'norva-resume-stuck-sync'),
  '* * * * *',
  'the unique source-resume cron job retains the minutely cadence'
);

select extensions.ok(
  (select command like '%source.source_type in (''xtream'', ''m3u'')%'
     and command like '%norva_cron_shared_secret%'
   from cron.job
   where jobname = 'norva-resume-stuck-sync'),
  'the cron command covers M3U and resolves the shared secret at execution time'
);

select extensions.ok(
  (select command like '%https://api.norva.tv/functions/v1/norva-source-sync/cron/resume-stuck%'
      and command not like '%oupsceccxsonaalhueff.supabase.co%'
   from cron.job
   where jobname = 'norva-resume-stuck-sync'),
  'the source-resume watchdog targets only the canonical self-hosted Edge ingress'
);

select extensions.is(
  (select count(*)::integer
   from vault.decrypted_secrets secret
   where secret.name = 'norva_cron_shared_secret'
     and nullif(secret.decrypted_secret, '') is not null),
  1,
  'the source-resume cron has exactly one non-empty shared secret'
);

select * from extensions.finish();
rollback;

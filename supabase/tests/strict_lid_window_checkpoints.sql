begin;

create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

select extensions.ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'public.catalog_file_audio_validation_jobs'::regclass),
  'the durable receipt journal has enabled and forced RLS'
);
select extensions.ok(
  not has_table_privilege('anon', 'public.catalog_file_audio_validation_jobs', 'SELECT')
  and not has_table_privilege('authenticated', 'public.catalog_file_audio_validation_jobs', 'SELECT')
  and has_table_privilege('service_role', 'public.catalog_file_audio_validation_jobs', 'SELECT'),
  'opaque receipts are readable only by service_role'
);
select extensions.ok(
  not has_function_privilege(
    'anon',
    'public.checkpoint_catalog_file_audio_validation_window(uuid,text,integer,integer,integer,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.reset_catalog_file_audio_validation_windows(uuid,text,integer,integer,integer,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.checkpoint_catalog_file_audio_validation_track(uuid,text,integer,jsonb)',
    'EXECUTE'
  ),
  'all window CAS transitions are service-role only'
);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '52000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'strict-lid-window-checkpoint@example.invalid',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_hint
) values (
  '52000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000001',
  'xtream',
  'Strict LID window checkpoint fixture',
  '{"serverHost":"strict-lid-window.invalid","username":"fixture"}'::jsonb
);

insert into public.provider_identities (id, display_name)
values (
  '52000000-0000-4000-8000-000000000003',
  'Strict LID window provider fixture'
);

insert into public.catalog_source_provider_identities (
  source_id, user_id, identity_id, provider_key
) values (
  '52000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000003',
  'strict-lid-window.invalid/fixture'
);

insert into public.cloud_titles (
  id, user_id, item_type, identity_key, identity_source, title
) values
  (
    '52000000-0000-4000-8000-000000000004',
    '52000000-0000-4000-8000-000000000001',
    'movie',
    'strict-lid-window-main',
    'normalized',
    'Strict LID window main fixture'
  ),
  (
    '52000000-0000-4000-8000-000000000005',
    '52000000-0000-4000-8000-000000000001',
    'movie',
    'strict-lid-window-restart',
    'normalized',
    'Strict LID window restart fixture'
  );

insert into public.cloud_title_variants (
  id, user_id, title_id, source_id, item_type, external_id, raw_title, codec_profile
) values
  (
    '52000000-0000-4000-8000-000000000006',
    '52000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000004',
    '52000000-0000-4000-8000-000000000002',
    'movie',
    'strict-lid-window-main',
    'Strict LID window main fixture',
    '{
      "metadataComplete":true,
      "probeSource":"gateway-inband",
      "probedAt":"2026-08-17T00:00:00Z",
      "container":"matroska",
      "durationSeconds":7200,
      "fileSizeBytes":1000000,
      "audioTracks":[
        {"index":1,"codec":"aac","channels":2,"default":true},
        {"index":2,"codec":"aac","channels":2,"default":false}
      ]
    }'::jsonb
  ),
  (
    '52000000-0000-4000-8000-000000000007',
    '52000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000005',
    '52000000-0000-4000-8000-000000000002',
    'movie',
    'strict-lid-window-restart',
    'Strict LID window restart fixture',
    '{
      "metadataComplete":true,
      "probeSource":"gateway-inband",
      "probedAt":"2026-08-17T00:00:00Z",
      "container":"matroska",
      "durationSeconds":7200,
      "fileSizeBytes":1000000,
      "audioTracks":[{"index":1,"codec":"aac","channels":2,"default":true}]
    }'::jsonb
  );

insert into public.catalog_file_tracks (
  server_host, item_type, external_id, audio_tracks
) values
  (
    '52000000-0000-4000-8000-000000000003',
    'movie',
    'strict-lid-window-main',
    '[
      {"index":1,"codec":"aac","channels":2,"default":true},
      {"index":2,"codec":"aac","channels":2,"default":false}
    ]'::jsonb
  ),
  (
    '52000000-0000-4000-8000-000000000003',
    'movie',
    'strict-lid-window-restart',
    '[{"index":1,"codec":"aac","channels":2,"default":true}]'::jsonb
  );

insert into public.catalog_file_audio_validation_jobs (
  id, requested_by, source_id, variant_id, identity_key, external_id,
  expected_audio_indices, profile_fingerprint, profile_snapshot, profile_probed_at,
  file_size_bytes, cached_audio_tracks
) values (
  '52000000-0000-4000-8000-000000000010',
  '52000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000006',
  '52000000-0000-4000-8000-000000000003',
  'strict-lid-window-main',
  array[1, 2],
  repeat('a', 64),
  '{
    "metadataComplete":true,
    "probeSource":"gatewayinband",
    "probedAt":"2026-08-17T00:00:00Z",
    "container":"matroska",
    "durationSeconds":7200,
    "fileSizeBytes":1000000,
    "audioTracks":[
      {"index":1,"codec":"aac","channels":2,"default":true},
      {"index":2,"codec":"aac","channels":2,"default":false}
    ]
  }'::jsonb,
  '2026-08-17T00:00:00Z',
  1000000,
  '[
    {"index":1,"codec":"aac","channels":2,"default":true},
    {"index":2,"codec":"aac","channels":2,"default":false}
  ]'::jsonb
);

select extensions.is(
  (public.claim_catalog_file_audio_validation_job(
    '52000000-0000-4000-8000-000000000010', 'window-owner-a', 300
  )->>'windowCount')::integer,
  6,
  'claim derives the six-window cursor from the exact duration'
);
select extensions.is(
  (select attempt_count from public.catalog_file_audio_validation_jobs
   where id = '52000000-0000-4000-8000-000000000010'),
  1,
  'the first owner claim spends exactly one bounded attempt'
);
select public.claim_catalog_file_audio_validation_job(
  '52000000-0000-4000-8000-000000000010', 'window-owner-a', 300
);
select extensions.is(
  (select attempt_count from public.catalog_file_audio_validation_jobs
   where id = '52000000-0000-4000-8000-000000000010'),
  1,
  'same-owner renewal does not double-spend the task attempt'
);
select extensions.is(
  public.claim_catalog_file_audio_validation_job(
    '52000000-0000-4000-8000-000000000010', 'window-owner-stale', 300
  ),
  null::jsonb,
  'a concurrent owner cannot steal a live job lease'
);
select extensions.throws_ok(
  $sql$
    select public.checkpoint_catalog_file_audio_validation_window(
      '52000000-0000-4000-8000-000000000010',
      'window-owner-a',
      1,
      2,
      6,
      1,
      'v1.aaaaaaaaaaaaaaa2.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
    )
  $sql$,
  '22023',
  'Invalid strict LID window checkpoint',
  'a missing ordinal cannot advance the append-only cursor'
);

create temporary table strict_lid_window_checkpoint_result as
select public.checkpoint_catalog_file_audio_validation_window(
  '52000000-0000-4000-8000-000000000010',
  'window-owner-a',
  1,
  1,
  6,
  1,
  'v1.aaaaaaaaaaaaaaa1.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
) as payload;

select extensions.is(
  (select payload->>'windowPosition' from strict_lid_window_checkpoint_result),
  '1',
  'the exact first receipt advances one position'
);
select extensions.ok(
  not ((select payload from strict_lid_window_checkpoint_result) ? 'receipt')
  and not ((select payload from strict_lid_window_checkpoint_result) ? 'windowToken'),
  'the checkpoint response never projects the opaque receipt'
);
select extensions.is(
  (public.claim_catalog_file_audio_validation_job(
    '52000000-0000-4000-8000-000000000010', 'window-owner-b', 300
  )->>'windowPosition')::integer,
  1,
  'a crash/retry resumes at the durable receipt position'
);
select extensions.throws_ok(
  $sql$
    select public.checkpoint_catalog_file_audio_validation_window(
      '52000000-0000-4000-8000-000000000010',
      'window-owner-b',
      1,
      2,
      6,
      1,
      'v1.aaaaaaaaaaaaaaa1.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
    )
  $sql$,
  '22023',
  'Invalid strict LID window checkpoint',
  'a duplicate receipt cannot advance the cursor'
);
select extensions.is(
  public.checkpoint_catalog_file_audio_validation_window(
    '52000000-0000-4000-8000-000000000010',
    'window-owner-a',
    1,
    2,
    6,
    1,
    'v1.aaaaaaaaaaaaaaa2.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
  ),
  null::jsonb,
  'a stale worker cannot checkpoint after ownership changes'
);
select public.checkpoint_catalog_file_audio_validation_window(
  '52000000-0000-4000-8000-000000000010',
  'window-owner-b',
  1,
  2,
  6,
  1,
  'v1.aaaaaaaaaaaaaaa2.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
);
select public.claim_catalog_file_audio_validation_job(
  '52000000-0000-4000-8000-000000000010', 'window-owner-c', 300
);
select public.checkpoint_catalog_file_audio_validation_window(
  '52000000-0000-4000-8000-000000000010',
  'window-owner-c', 1, 3, 6, 1,
  'v1.aaaaaaaaaaaaaaa3.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
);
select public.claim_catalog_file_audio_validation_job(
  '52000000-0000-4000-8000-000000000010', 'window-owner-d', 300
);
select public.checkpoint_catalog_file_audio_validation_window(
  '52000000-0000-4000-8000-000000000010',
  'window-owner-d', 1, 4, 6, 1,
  'v1.aaaaaaaaaaaaaaa4.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
);
select public.claim_catalog_file_audio_validation_job(
  '52000000-0000-4000-8000-000000000010', 'window-owner-e', 300
);
select public.checkpoint_catalog_file_audio_validation_window(
  '52000000-0000-4000-8000-000000000010',
  'window-owner-e', 1, 5, 6, 1,
  'v1.aaaaaaaaaaaaaaa5.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
);
select public.claim_catalog_file_audio_validation_job(
  '52000000-0000-4000-8000-000000000010', 'window-owner-f', 300
);
select public.checkpoint_catalog_file_audio_validation_window(
  '52000000-0000-4000-8000-000000000010',
  'window-owner-f', 1, 6, 6, 1,
  'v1.aaaaaaaaaaaaaaa6.AAAAAAAAAAAAAAAA.B.CCCCCCCCCCCCCCCCCCCCCC'
);

select extensions.ok(
  (select state = 'running'
          and strict_lid_window_position = 6
          and jsonb_array_length(strict_lid_window_tokens) = 6
   from public.catalog_file_audio_validation_jobs
   where id = '52000000-0000-4000-8000-000000000010'),
  'the sixth receipt retains exact ownership for zero-provider finalization'
);
select extensions.is(
  public.reset_catalog_file_audio_validation_windows(
    '52000000-0000-4000-8000-000000000010',
    'window-owner-stale', 1, 6, 6, 1
  ),
  false,
  'a stale worker cannot reset valid receipts'
);
select extensions.is(
  public.reset_catalog_file_audio_validation_windows(
    '52000000-0000-4000-8000-000000000010',
    'window-owner-f', 1, 6, 6, 1
  ),
  true,
  'the exact live owner can reset only a complete invalid receipt set'
);
select extensions.ok(
  (select strict_lid_window_position = 0
          and strict_lid_window_count = 0
          and strict_lid_window_protocol = 0
          and strict_lid_window_tokens = '[]'::jsonb
   from public.catalog_file_audio_validation_jobs
   where id = '52000000-0000-4000-8000-000000000010'),
  'authenticated reset clears all four window columns atomically'
);

insert into public.catalog_file_audio_validation_jobs (
  id, requested_by, source_id, variant_id, identity_key, external_id,
  expected_audio_indices, profile_fingerprint, profile_snapshot, profile_probed_at,
  file_size_bytes, cached_audio_tracks, state, lease_owner, lease_expires_at,
  queue_expires_at, strict_lid_window_position, strict_lid_window_count,
  strict_lid_window_tokens, strict_lid_window_protocol
) values (
  '52000000-0000-4000-8000-000000000011',
  '52000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000006',
  '52000000-0000-4000-8000-000000000003',
  'strict-lid-window-final-track',
  array[1, 2],
  repeat('b', 64),
  '{"durationSeconds":7200}'::jsonb,
  '2026-08-17T00:00:00Z',
  1000000,
  '[{"index":1},{"index":2}]'::jsonb,
  'running',
  'window-final-owner',
  clock_timestamp() + interval '5 minutes',
  null,
  6,
  6,
  jsonb_build_array(
    'v1.bbbbbbbbbbbbbbb1.BBBBBBBBBBBBBBBB.C.DDDDDDDDDDDDDDDDDDDDDD',
    'v1.bbbbbbbbbbbbbbb2.BBBBBBBBBBBBBBBB.C.DDDDDDDDDDDDDDDDDDDDDD',
    'v1.bbbbbbbbbbbbbbb3.BBBBBBBBBBBBBBBB.C.DDDDDDDDDDDDDDDDDDDDDD',
    'v1.bbbbbbbbbbbbbbb4.BBBBBBBBBBBBBBBB.C.DDDDDDDDDDDDDDDDDDDDDD',
    'v1.bbbbbbbbbbbbbbb5.BBBBBBBBBBBBBBBB.C.DDDDDDDDDDDDDDDDDDDDDD',
    'v1.bbbbbbbbbbbbbbb6.BBBBBBBBBBBBBBBB.C.DDDDDDDDDDDDDDDDDDDDDD'
  ),
  1
);

select extensions.is(
  public.checkpoint_catalog_file_audio_validation_track(
    '52000000-0000-4000-8000-000000000011',
    'window-final-owner',
    1,
    '{
      "index":1,
      "language":"fr",
      "method":"whisper-strict-consensus-v4",
      "sampleCount":4,
      "consensus":4,
      "rejectedSpeechSampleCount":0,
      "minSampleProbability":0.95,
      "minSampleWordCount":12,
      "minSampleUniqueWordCount":8
    }'::jsonb
  )->>'complete',
  'false',
  'a fully finalized track advances exactly one multi-track position'
);
select extensions.ok(
  (select state = 'queued'
          and next_track_position = 1
          and strict_lid_window_position = 0
          and strict_lid_window_tokens = '[]'::jsonb
   from public.catalog_file_audio_validation_jobs
   where id = '52000000-0000-4000-8000-000000000011'),
  'track advance resets receipts before the next track can be claimed'
);

insert into public.catalog_file_audio_validation_jobs (
  id, requested_by, source_id, variant_id, identity_key, external_id,
  expected_audio_indices, profile_fingerprint, profile_snapshot, profile_probed_at,
  file_size_bytes, cached_audio_tracks, attempt_count
) values (
  '52000000-0000-4000-8000-000000000012',
  '52000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000006',
  '52000000-0000-4000-8000-000000000003',
  'strict-lid-window-attempt-cap',
  array[1],
  repeat('c', 64),
  '{"durationSeconds":7200}'::jsonb,
  '2026-08-17T00:00:00Z',
  1000000,
  '[{"index":1}]'::jsonb,
  255
);
select public.claim_catalog_file_audio_validation_job(
  '52000000-0000-4000-8000-000000000012', 'window-attempt-256', 300
);
select extensions.is(
  (select attempt_count from public.catalog_file_audio_validation_jobs
   where id = '52000000-0000-4000-8000-000000000012'),
  256,
  'attempt 256 remains the final bounded executable claim'
);
update public.catalog_file_audio_validation_jobs
set state = 'queued',
    lease_owner = null,
    lease_expires_at = null,
    queue_expires_at = clock_timestamp() + interval '15 minutes'
where id = '52000000-0000-4000-8000-000000000012';
select extensions.is(
  public.claim_catalog_file_audio_validation_job(
    '52000000-0000-4000-8000-000000000012', 'window-attempt-257', 300
  ),
  null::jsonb,
  'attempt 257 is rejected instead of overflowing the bounded journal'
);
select extensions.ok(
  (select state = 'cancelled'
          and error_code = 'LANGUAGE_VALIDATION_ATTEMPT_LIMIT'
          and attempt_count = 256
   from public.catalog_file_audio_validation_jobs
   where id = '52000000-0000-4000-8000-000000000012'),
  'the rejected attempt terminalizes the old job without advancing receipts'
);

update public.catalog_file_audio_validation_jobs
set state = 'failed',
    lease_owner = null,
    lease_expires_at = null,
    queue_expires_at = null,
    error_code = 'TEST_CLEANUP'
where id in (
  '52000000-0000-4000-8000-000000000010',
  '52000000-0000-4000-8000-000000000011'
);

insert into public.catalog_file_audio_validation_jobs (
  id, requested_by, source_id, variant_id, identity_key, external_id,
  expected_audio_indices, profile_fingerprint, profile_snapshot, profile_probed_at,
  file_size_bytes, cached_audio_tracks, state, queue_expires_at, retry_at,
  error_code, attempt_count, cancelled_at
) values (
  '52000000-0000-4000-8000-000000000013',
  '52000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000007',
  '52000000-0000-4000-8000-000000000003',
  'strict-lid-window-restart',
  array[1],
  repeat('d', 64),
  '{"durationSeconds":7200}'::jsonb,
  '2026-08-17T00:00:00Z',
  1000000,
  '[{"index":1,"codec":"aac","channels":2,"default":true}]'::jsonb,
  'cancelled',
  null,
  clock_timestamp(),
  'LANGUAGE_VALIDATION_ATTEMPT_LIMIT',
  64,
  clock_timestamp()
);

create temporary table strict_lid_window_restart_result as
select public.start_catalog_file_audio_validation_job(
  '52000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000007',
  '52000000-0000-4000-8000-000000000003',
  'strict-lid-window-restart',
  array[1],
  repeat('e', 64),
  '2026-08-17T00:00:00Z'::timestamptz,
  1000000,
  '[{"index":1,"codec":"aac","channels":2,"default":true}]'::jsonb
) as payload;

select extensions.ok(
  (select payload->>'jobId' from strict_lid_window_restart_result)
    is distinct from '52000000-0000-4000-8000-000000000013',
  'a historical attempt-64 cancellation permits a fresh job under quota'
);
select extensions.is(
  (select count(*)::integer
   from public.catalog_file_audio_validation_jobs
   where external_id = 'strict-lid-window-restart'),
  2,
  'the terminal attempt-64 row is retained while the fresh job is queued'
);

select * from extensions.finish();
rollback;

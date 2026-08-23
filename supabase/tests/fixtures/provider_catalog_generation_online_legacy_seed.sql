-- Portable integration fixture. Apply to the lifecycle-foundation schema
-- before 20260823120000_provider_credential_transition_v1.sql.
begin;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '11111111-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'phase3-online@invalid.test', '', now(),
  '{}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.cloud_sources (
  id, user_id, source_type, display_name, config_ciphertext, config_hint,
  sync_status, catalog_version, enabled, last_synced_at
) values (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'xtream', 'Online migration legacy source', 'ciphertext-a', '{}'::jsonb,
  'ready', 1, true, now()
);

insert into public.provider_identities (id, display_name)
values (
  '88888888-8888-8888-8888-888888888888',
  'Online migration provider'
);

insert into public.catalog_source_provider_identities (
  source_id, user_id, identity_id, provider_key
) values (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  '88888888-8888-8888-8888-888888888888',
  'phase3-online-provider'
);

insert into public.cloud_media_items (
  id, user_id, source_id, item_type, external_id, title
) values
  (
    '30000000-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'series', 'series-1', 'Legacy Series'
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    'live', 'live-stream-1', 'Legacy Live'
  );

insert into public.cloud_titles (
  id, user_id, item_type, identity_key, identity_source, title
) values (
  '44444444-4444-4444-4444-444444444444',
  '11111111-1111-1111-1111-111111111111',
  'series', 'normalized:legacy-series', 'normalized', 'Legacy Series'
);

insert into public.cloud_title_variants (
  id, user_id, title_id, source_id, media_item_id,
  item_type, external_id, raw_title
) values (
  '55555555-5555-5555-5555-555555555555',
  '11111111-1111-1111-1111-111111111111',
  '44444444-4444-4444-4444-444444444444',
  '22222222-2222-2222-2222-222222222222',
  '30000000-0000-0000-0000-000000000001',
  'series', 'series-1', 'Legacy Series'
);

insert into public.cloud_live_logical_channels (
  id, user_id, source_id, logical_id, logical_key, title
) values (
  '66666666-6666-6666-6666-666666666666',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  'logical-1', 'legacy-live', 'Legacy Live'
);

insert into public.cloud_live_variants (
  id, user_id, source_id, logical_channel_id, logical_id,
  media_item_id, stream_id, external_id, title
) values (
  '77777777-7777-7777-7777-777777777777',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '66666666-6666-6666-6666-666666666666',
  'logical-1', '30000000-0000-0000-0000-000000000002',
  'stream-1', 'live-stream-1', 'Legacy Live'
);

insert into public.catalog_series_episode_memberships (
  user_id, source_id, provider_identity_id, parent_title_id,
  parent_variant_id, parent_item_type, parent_series_id, episode_id,
  container_extension, payload_fingerprint
) values (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '88888888-8888-8888-8888-888888888888',
  '44444444-4444-4444-4444-444444444444',
  '55555555-5555-5555-5555-555555555555',
  'series', 'series-1', 'episode-1', 'mkv',
  '0123456789abcdef0123456789abcdef'
);

insert into public.catalog_series_inventory_state (
  user_id, source_id, provider_identity_id, parent_title_id,
  parent_variant_id, parent_item_type, parent_series_id, episode_count
) values (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '88888888-8888-8888-8888-888888888888',
  '44444444-4444-4444-4444-444444444444',
  '55555555-5555-5555-5555-555555555555',
  'series', 'series-1', 1
);

commit;

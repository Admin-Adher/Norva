\set ON_ERROR_STOP on

insert into auth.users (
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  '95000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','online-rollout@invalid.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);

insert into public.cloud_sources (
  id,user_id,source_type,display_name,config_ciphertext,config_hint,
  sync_status,catalog_version,enabled,last_synced_at
) values (
  '95000000-0000-4000-8000-000000000101',
  '95000000-0000-4000-8000-000000000001',
  'xtream','Online legacy fixture','legacy-cipher',
  '{"serverHost":"legacy.example:8080","username":"legacy-user"}'::jsonb,
  'ready',1,true,now()
);

insert into public.provider_identities(id,display_name)
values ('95000000-0000-4000-8000-000000000201','Online provider');

insert into public.catalog_source_provider_identities(
  source_id,user_id,identity_id,provider_key
) values (
  '95000000-0000-4000-8000-000000000101',
  '95000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000201','online-provider'
);

insert into public.cloud_titles(
  id,user_id,item_type,identity_key,identity_source,title,metadata
) values (
  '95000000-0000-4000-8000-000000000301',
  '95000000-0000-4000-8000-000000000001',
  'series','normalized:online-series','normalized','Online series','{}'
);

insert into public.cloud_media_items(
  id,user_id,source_id,item_type,external_id,title,dedup_key,
  is_dedup_primary,metadata
)
select
  ('95000000-0000-4000-8000-' || lpad((400+n)::text,12,'0'))::uuid,
  '95000000-0000-4000-8000-000000000001'::uuid,
  '95000000-0000-4000-8000-000000000101'::uuid,
  'movie','legacy-movie-'||n,'Legacy movie '||n,'legacy-movie-'||n,true,'{}'::jsonb
from generate_series(1,3) n;

insert into public.cloud_title_variants(
  id,user_id,title_id,source_id,item_type,external_id,raw_title,metadata
) values (
  '95000000-0000-4000-8000-000000000501',
  '95000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000301',
  '95000000-0000-4000-8000-000000000101',
  'series','series-1','Online series','{}'
);

insert into public.cloud_live_logical_channels(
  id,user_id,source_id,logical_id,logical_key,title
)
select
  ('95000000-0000-4000-8000-' || lpad((600+n)::text,12,'0'))::uuid,
  '95000000-0000-4000-8000-000000000001'::uuid,
  '95000000-0000-4000-8000-000000000101'::uuid,
  'logical-'||n,'logical-key-'||n,'Logical channel '||n
from generate_series(1,2) n;

insert into public.cloud_live_variants(
  id,user_id,source_id,logical_channel_id,logical_id,stream_id,
  external_id,label,title,metadata
)
select
  ('95000000-0000-4000-8000-' || lpad((700+n)::text,12,'0'))::uuid,
  '95000000-0000-4000-8000-000000000001'::uuid,
  '95000000-0000-4000-8000-000000000101'::uuid,
  ('95000000-0000-4000-8000-' || lpad((600+n)::text,12,'0'))::uuid,
  'logical-'||n,'stream-'||n,'stream-'||n,'HD','Logical channel '||n,'{}'::jsonb
from generate_series(1,2) n;

insert into public.catalog_series_episode_memberships(
  user_id,source_id,provider_identity_id,parent_title_id,parent_variant_id,
  parent_item_type,parent_series_id,episode_id,container_extension,
  season_number,episode_number,payload_fingerprint
)
select
  '95000000-0000-4000-8000-000000000001'::uuid,
  '95000000-0000-4000-8000-000000000101'::uuid,
  '95000000-0000-4000-8000-000000000201'::uuid,
  '95000000-0000-4000-8000-000000000301'::uuid,
  '95000000-0000-4000-8000-000000000501'::uuid,
  'series','series-1','episode-'||n,'mp4',1,n,md5('episode-'||n)
from generate_series(1,2) n;

insert into public.catalog_series_inventory_state(
  user_id,source_id,provider_identity_id,parent_title_id,parent_variant_id,
  parent_item_type,parent_series_id,consecutive_failures,episode_count,last_details
) values (
  '95000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000101',
  '95000000-0000-4000-8000-000000000201',
  '95000000-0000-4000-8000-000000000301',
  '95000000-0000-4000-8000-000000000501',
  'series','series-1',0,2,'{}'
);

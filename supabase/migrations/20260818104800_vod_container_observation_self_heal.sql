-- Server-observed VOD container corrections.
--
-- Provider catalogues occasionally advertise an extension which does not match
-- the file bytes (for example, `mkv` for an ISO-BMFF/MP4 object). Keep the
-- correction outside the rebuildable per-user catalogue so a later sync, a new
-- account, or another account on the same provider cannot reintroduce the bad
-- route. Raw URLs, credentials and validators are never stored here; only
-- SHA-256 bindings emitted by the authenticated media gateway are retained.

create table if not exists public.catalog_file_container_observations (
  server_host             text not null,
  item_type               text not null check (item_type in ('movie', 'series')),
  external_id             text not null,
  declared_container      text not null,
  observed_container      text not null,
  evidence_kind           text not null,
  source_url_sha256       text not null check (source_url_sha256 ~ '^[0-9a-f]{64}$'),
  effective_url_sha256    text not null check (effective_url_sha256 ~ '^[0-9a-f]{64}$'),
  prefix_sha256           text not null check (prefix_sha256 ~ '^[0-9a-f]{64}$'),
  validator_kind          text not null check (validator_kind in ('etag', 'last-modified', 'none')),
  validator_sha256        text check (validator_sha256 is null or validator_sha256 ~ '^[0-9a-f]{64}$'),
  file_size_bytes         bigint check (file_size_bytes is null or file_size_bytes > 0),
  observation_count       integer not null default 1 check (observation_count > 0),
  first_observed_at       timestamptz not null default now(),
  last_observed_at        timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  primary key (server_host, item_type, external_id),
  check (declared_container <> observed_container)
);

alter table public.catalog_file_container_observations enable row level security;
revoke all on table public.catalog_file_container_observations from public, anon, authenticated;
grant all on table public.catalog_file_container_observations to service_role;

create index if not exists idx_catalog_file_container_observations_recent
  on public.catalog_file_container_observations (last_observed_at desc);

create or replace function public.record_catalog_file_container_observation(
  p_playback_session_id uuid,
  p_user_id uuid,
  p_source_id uuid,
  p_item_type text,
  p_external_id text,
  p_declared_container text,
  p_observed_container text,
  p_evidence jsonb,
  p_expected_media_item_id uuid default null,
  p_expected_media_item_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_host text;
  v_target_url_hash text;
  v_declared text;
  v_observed text;
  v_evidence_kind text;
  v_source_url_sha256 text;
  v_effective_url_sha256 text;
  v_prefix_sha256 text;
  v_validator_kind text;
  v_validator_sha256 text;
  v_file_size_bytes bigint;
  v_media_rows integer := 0;
  v_variant_rows integer := 0;
begin
  if p_item_type not in ('movie', 'series') or coalesce(btrim(p_external_id), '') = '' then
    raise exception 'invalid container observation identity' using errcode = '22023';
  end if;

  v_declared := lower(regexp_replace(coalesce(p_declared_container, ''), '[^a-z0-9]+', '', 'g'));
  v_observed := lower(regexp_replace(coalesce(p_observed_container, ''), '[^a-z0-9]+', '', 'g'));
  if v_declared = 'matroska' then v_declared := 'mkv'; end if;
  if v_observed = 'matroska' then v_observed := 'mkv'; end if;
  if v_declared not in ('mkv', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg', 'ts')
     or v_observed not in ('mkv', 'mp4', 'mov', 'avi', 'ogg', 'flv', 'mpg', 'mpeg', 'ts')
     or v_declared = v_observed then
    raise exception 'invalid container observation transition' using errcode = '22023';
  end if;

  if p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
     or (p_evidence - array[
       'kind', 'prefixSha256', 'sourceUrlSha256', 'effectiveUrlSha256',
       'validatorKind', 'validatorSha256', 'fileSizeBytes'
     ]::text[]) <> '{}'::jsonb then
    raise exception 'invalid container observation evidence shape' using errcode = '22023';
  end if;

  v_evidence_kind := p_evidence->>'kind';
  v_prefix_sha256 := lower(coalesce(p_evidence->>'prefixSha256', ''));
  v_source_url_sha256 := lower(coalesce(p_evidence->>'sourceUrlSha256', ''));
  v_effective_url_sha256 := lower(coalesce(p_evidence->>'effectiveUrlSha256', ''));
  v_validator_kind := coalesce(p_evidence->>'validatorKind', '');
  v_validator_sha256 := nullif(lower(coalesce(p_evidence->>'validatorSha256', '')), '');

  if v_prefix_sha256 !~ '^[0-9a-f]{64}$'
     or v_source_url_sha256 !~ '^[0-9a-f]{64}$'
     or v_effective_url_sha256 !~ '^[0-9a-f]{64}$'
     or v_validator_kind not in ('etag', 'last-modified', 'none')
     or (v_validator_kind = 'none' and v_validator_sha256 is not null)
     or (v_validator_kind <> 'none' and coalesce(v_validator_sha256, '') !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid container observation evidence binding' using errcode = '22023';
  end if;

  if (v_observed in ('mp4', 'mov') and v_evidence_kind <> 'iso-bmff-ftyp-v1')
     or (v_observed = 'mkv' and v_evidence_kind <> 'ebml-v1')
     or (v_observed = 'avi' and v_evidence_kind <> 'riff-avi-v1')
     or (v_observed = 'ogg' and v_evidence_kind <> 'ogg-v1')
     or (v_observed = 'flv' and v_evidence_kind <> 'flv-v1')
     or (v_observed in ('mpg', 'mpeg') and v_evidence_kind <> 'mpeg-ps-v1') then
    raise exception 'container observation evidence does not match detected container' using errcode = '22023';
  end if;

  if p_evidence->>'fileSizeBytes' is not null then
    if p_evidence->>'fileSizeBytes' !~ '^[1-9][0-9]{0,18}$' then
      raise exception 'invalid observed file size' using errcode = '22023';
    end if;
    v_file_size_bytes := (p_evidence->>'fileSizeBytes')::bigint;
  end if;

  select s.config_hint->>'serverHost'
    into v_host
  from public.cloud_sources s
  where s.id = p_source_id and s.user_id = p_user_id;
  if coalesce(v_host, '') = '' then
    raise exception 'container observation source is not owned' using errcode = '42501';
  end if;

  select ps.target_url_hash
    into v_target_url_hash
  from public.cloud_playback_sessions ps
  where ps.id = p_playback_session_id
    and ps.user_id = p_user_id
    and ps.source_id = p_source_id
    and ps.item_type = p_item_type
    and ps.item_id = p_external_id;
  if coalesce(v_target_url_hash, '') = '' or v_target_url_hash <> v_source_url_sha256 then
    raise exception 'container observation does not match playback target' using errcode = '42501';
  end if;

  insert into public.catalog_file_container_observations (
    server_host, item_type, external_id, declared_container, observed_container,
    evidence_kind, source_url_sha256, effective_url_sha256, prefix_sha256,
    validator_kind, validator_sha256, file_size_bytes
  ) values (
    v_host, p_item_type, p_external_id, v_declared, v_observed,
    v_evidence_kind, v_source_url_sha256, v_effective_url_sha256, v_prefix_sha256,
    v_validator_kind, v_validator_sha256, v_file_size_bytes
  )
  on conflict (server_host, item_type, external_id) do update set
    declared_container = excluded.declared_container,
    observed_container = excluded.observed_container,
    evidence_kind = excluded.evidence_kind,
    source_url_sha256 = excluded.source_url_sha256,
    effective_url_sha256 = excluded.effective_url_sha256,
    prefix_sha256 = excluded.prefix_sha256,
    validator_kind = excluded.validator_kind,
    validator_sha256 = excluded.validator_sha256,
    file_size_bytes = excluded.file_size_bytes,
    observation_count = public.catalog_file_container_observations.observation_count + 1,
    last_observed_at = now(),
    updated_at = now();

  update public.cloud_media_items m
     set playback_hint = jsonb_set(
       jsonb_set(coalesce(m.playback_hint, '{}'::jsonb) - 'codec_profile', '{container}', to_jsonb(v_observed), true),
       '{codecProfile}',
       jsonb_build_object('container', v_observed),
       true
     ),
         updated_at = now()
   where m.user_id = p_user_id
     and m.source_id = p_source_id
     and m.item_type = p_item_type
     and m.external_id = p_external_id
     and (p_expected_media_item_id is null or m.id = p_expected_media_item_id)
     and (p_expected_media_item_updated_at is null or m.updated_at = p_expected_media_item_updated_at);
  get diagnostics v_media_rows = row_count;

  update public.cloud_title_variants v
     set container_extension = v_observed,
         playback_hint = jsonb_set(coalesce(v.playback_hint, '{}'::jsonb), '{container}', to_jsonb(v_observed), true),
         codec_profile = jsonb_build_object('container', v_observed),
         updated_at = now()
   where v.user_id = p_user_id
     and v.source_id = p_source_id
     and v.item_type = p_item_type
     and v.external_id = p_external_id;
  get diagnostics v_variant_rows = row_count;

  update public.catalog_media_items m
     set playback_hint = jsonb_set(
       jsonb_set(coalesce(m.playback_hint, '{}'::jsonb) - 'codec_profile', '{container}', to_jsonb(v_observed), true),
       '{codecProfile}',
       jsonb_build_object('container', v_observed),
       true
     ),
         updated_at = now()
   where m.server_host = v_host
     and m.item_type = p_item_type
     and m.external_id = p_external_id;

  update public.catalog_title_variants v
     set container_extension = v_observed,
         playback_hint = jsonb_set(coalesce(v.playback_hint, '{}'::jsonb), '{container}', to_jsonb(v_observed), true),
         codec_profile = jsonb_build_object('container', v_observed),
         updated_at = now()
   where v.server_host = v_host
     and v.item_type = p_item_type
     and v.external_id = p_external_id;

  return jsonb_build_object(
    'ok', true,
    'serverHost', v_host,
    'itemType', p_item_type,
    'externalId', p_external_id,
    'declaredContainer', v_declared,
    'observedContainer', v_observed,
    'mediaRows', v_media_rows,
    'variantRows', v_variant_rows
  );
end;
$$;

revoke all on function public.record_catalog_file_container_observation(
  uuid, uuid, uuid, text, text, text, text, jsonb, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_catalog_file_container_observation(
  uuid, uuid, uuid, text, text, text, text, jsonb, uuid, timestamptz
) to service_role;

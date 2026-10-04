-- Human listening testimony is separate from provider tags and automatic LID.
-- The operator records only the owner's explicitly confirmed file and track.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create table public.catalog_owned_human_audio_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  variant_id uuid not null references public.cloud_title_variants(id) on delete cascade,
  title_id uuid not null references public.cloud_titles(id) on delete cascade,
  generation_id uuid not null,
  provider_identity_id uuid not null references public.provider_identities(id) on delete cascade,
  file_external_id text not null check(length(file_external_id) between 1 and 255),
  track_index integer not null check(track_index between 0 and 128),
  language text not null check(language ~ '^(?:[a-z]{2}|yue)$' and language not in ('un','xx','zz')),
  config_revision bigint not null,
  source_visibility_epoch bigint not null,
  user_visibility_epoch bigint not null,
  profile_snapshot jsonb not null check(jsonb_typeof(profile_snapshot)='object'),
  method text not null default 'owner-listening-v1' check(method='owner-listening-v1'),
  evidence_reference text not null check(evidence_reference ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'),
  confirmed_at timestamptz not null default clock_timestamp(),
  unique(user_id,variant_id,track_index,evidence_reference)
);
create index catalog_owned_human_audio_confirmations_file_idx
  on public.catalog_owned_human_audio_confirmations(user_id,source_id,variant_id,track_index,confirmed_at desc);
alter table public.catalog_owned_human_audio_confirmations enable row level security;
revoke all on public.catalog_owned_human_audio_confirmations from public,anon,authenticated,service_role;
grant select on public.catalog_owned_human_audio_confirmations to service_role;

-- No endpoint accepts a title/market/TMDB hint as testimony. A trusted operator
-- supplies exact coordinates and a private audit reference after owner consent.
-- Profiles may be incomplete for automatic LID while still naming the heard
-- audio track. Preserve the complete observed snapshot, including probe time.
-- Reads ignore only the probe timestamp; technical changes and reimports hide
-- the confirmation until reconfirmed against the new file/profile.
create function public.record_owned_movie_human_audio_confirmation(
  p_user_id uuid,p_source_id uuid,p_generation_id uuid,p_head_revision bigint,
  p_config_revision bigint,p_source_visibility_epoch bigint,p_user_visibility_epoch bigint,
  p_variant_id uuid,p_external_id text,p_identity_id uuid,p_profile_snapshot jsonb,
  p_track_index integer,p_language text,p_evidence_reference text
) returns uuid language plpgsql security definer set search_path='' as $function$
declare v_variant public.cloud_title_variants%rowtype;
  v_confirmation public.catalog_owned_human_audio_confirmations%rowtype;
  v_id uuid;
begin
  perform public.norva_credential_require_service_role();
  if p_track_index is null or p_track_index not between 0 and 128
    or p_language is null or not coalesce(p_language='yue' or public.norva_canonical_language_code(p_language)=p_language,false)
    or p_language !~ '^(?:[a-z]{2}|yue)$'
    or p_language in ('un','xx','zz')
    or p_evidence_reference is null or p_evidence_reference !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    or jsonb_typeof(p_profile_snapshot) is distinct from 'object'
    or octet_length(p_profile_snapshot::text)>65536 then
    raise exception 'Invalid owner audio confirmation' using errcode='22023';
  end if;
  perform 1 from public.cloud_source_catalog_heads h
    join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
    join public.cloud_sources s on s.id=h.source_id and s.user_id=h.user_id
    where h.source_id=p_source_id and h.user_id=p_user_id for share of h,l,s;
  perform 1 from public.cloud_user_catalog_visibility_epochs e
    where e.user_id=p_user_id for share;
  perform 1 from public.catalog_source_provider_identities i
    where i.user_id=p_user_id and i.source_id=p_source_id for share;
  perform public.norva_set_catalog_delete_proof(p_source_id,p_user_id,p_generation_id,p_head_revision,
    p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch);
  select v.* into v_variant from public.cloud_title_variants v
    join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id
      and s.source_type='xtream' and s.deleted_at is null and s.enabled
    join public.catalog_source_provider_identities i on i.user_id=v.user_id and i.source_id=v.source_id
      and i.identity_id=p_identity_id and i.verified_at is not null
    where v.id=p_variant_id and v.user_id=p_user_id and v.source_id=p_source_id
      and v.generation_id=p_generation_id and v.item_type='movie' and v.external_id=p_external_id
    for share of v;
  if not found or public.vod_language_profile_snapshot(v_variant.codec_profile) is distinct from p_profile_snapshot
    or coalesce(p_profile_snapshot->>'probedAt','')=''
    or coalesce(p_profile_snapshot->>'probeSource','') not in ('gatewayprobe','gatewayinband')
    or (select count(*) from jsonb_array_elements(coalesce(p_profile_snapshot->'audioTracks','[]'::jsonb)) t(value)
      where t.value->>'index'=p_track_index::text and coalesce(t.value->>'codec','')<>'')<>1 then
    raise exception 'Exact owner audio file or profile changed' using errcode='PT409';
  end if;
  -- Append-only evidence; replaying the same reference is idempotent only when
  -- all its fences and language agree. A correction requires a new reference.
  insert into public.catalog_owned_human_audio_confirmations
    (user_id,source_id,variant_id,title_id,generation_id,provider_identity_id,file_external_id,
      track_index,language,config_revision,source_visibility_epoch,user_visibility_epoch,
      profile_snapshot,evidence_reference)
  values(p_user_id,p_source_id,p_variant_id,v_variant.title_id,p_generation_id,p_identity_id,p_external_id,
    p_track_index,p_language,p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch,
    p_profile_snapshot,p_evidence_reference)
  on conflict(user_id,variant_id,track_index,evidence_reference) do nothing returning id into v_id;
  if v_id is not null then return v_id; end if;
  select * into strict v_confirmation from public.catalog_owned_human_audio_confirmations c
    where c.user_id=p_user_id and c.variant_id=p_variant_id and c.track_index=p_track_index
      and c.evidence_reference=p_evidence_reference;
  if v_confirmation.source_id is distinct from p_source_id
    or v_confirmation.title_id is distinct from v_variant.title_id
    or v_confirmation.generation_id is distinct from p_generation_id
    or v_confirmation.provider_identity_id is distinct from p_identity_id
    or v_confirmation.file_external_id is distinct from p_external_id
    or v_confirmation.language is distinct from p_language
    or v_confirmation.config_revision is distinct from p_config_revision
    or v_confirmation.source_visibility_epoch is distinct from p_source_visibility_epoch
    or v_confirmation.user_visibility_epoch is distinct from p_user_visibility_epoch
    or v_confirmation.profile_snapshot is distinct from p_profile_snapshot then
    raise exception 'Owner audio confirmation reference conflict' using errcode='PT409';
  end if;
  return v_confirmation.id;
end $function$;
revoke all on function public.record_owned_movie_human_audio_confirmation(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb,integer,text,text) from public,anon,authenticated;
grant execute on function public.record_owned_movie_human_audio_confirmation(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb,integer,text,text) to service_role;

-- Bounded physical-owner lookup. Never fan out through provider identities to
-- other accounts, through title grouping to other copies, or Selection shares.
create function public.cloud_catalog_owned_movie_human_audio_confirmations_batch(
  p_user_id uuid,p_source_id uuid,p_variant_ids uuid[]
) returns table(user_id uuid,source_id uuid,item_type text,title_id uuid,variant_id uuid,
  language text,track_index integer,method text,confirmed_at timestamptz)
language plpgsql stable security invoker set search_path='' as $function$
begin
  if p_user_id is null or p_source_id is null or p_variant_ids is null then return; end if;
  if cardinality(p_variant_ids)>200 then
    raise exception 'Too many requested owner audio variants' using errcode='22023';
  end if;
  return query
  select distinct on (c.variant_id,c.track_index)
    c.user_id,c.source_id,'movie'::text,c.title_id,c.variant_id,c.language,c.track_index,c.method,c.confirmed_at
  from (select distinct id from unnest(p_variant_ids) requested(id) where id is not null) requested
  join public.catalog_owned_human_audio_confirmations c
    on c.variant_id=requested.id and c.user_id=p_user_id and c.source_id=p_source_id
  join public.cloud_title_variants v on v.id=c.variant_id and v.user_id=c.user_id and v.source_id=c.source_id
    and v.title_id=c.title_id and v.generation_id=c.generation_id
    and v.item_type='movie' and v.external_id=c.file_external_id
    and (public.vod_language_profile_snapshot(v.codec_profile)-'probedAt')=(c.profile_snapshot-'probedAt')
  join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id
    and s.source_type='xtream' and s.deleted_at is null and s.enabled
  join public.cloud_source_catalog_heads h on h.source_id=c.source_id and h.user_id=c.user_id
    and h.active_generation_id=c.generation_id
  join public.cloud_source_lifecycle l on l.source_id=c.source_id and l.user_id=c.user_id
    and l.config_revision=c.config_revision and l.visibility_epoch=c.source_visibility_epoch
  left join public.cloud_user_catalog_visibility_epochs e on e.user_id=c.user_id
  join public.catalog_source_provider_identities i on i.user_id=c.user_id and i.source_id=c.source_id
    and i.identity_id=c.provider_identity_id and i.verified_at is not null
  where coalesce(e.visibility_epoch,1)=c.user_visibility_epoch
    and public.norva_source_catalog_visible_internal(c.source_id,c.user_id)
  order by c.variant_id,c.track_index,c.confirmed_at desc,c.id;
end $function$;
revoke all on function public.cloud_catalog_owned_movie_human_audio_confirmations_batch(uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.cloud_catalog_owned_movie_human_audio_confirmations_batch(uuid,uuid,uuid[]) to service_role;
notify pgrst,'reload schema';
commit;

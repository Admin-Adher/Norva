-- Provider stream metadata is a declaration, not a file probe or LID certificate.
-- Capture only fresh, generation-fenced responses. Never hydrate host-only caches.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create table public.catalog_owned_language_declarations (
  variant_id uuid not null references public.cloud_title_variants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.cloud_sources(id) on delete cascade,
  generation_id uuid not null,
  provider_identity_id uuid not null references public.provider_identities(id) on delete cascade,
  file_external_id text not null check(length(file_external_id) between 1 and 255),
  item_type text not null check(item_type in ('movie','episode')),
  config_revision bigint not null,
  source_visibility_epoch bigint not null,
  audio_languages text[] not null check(cardinality(audio_languages)<=32),
  method text not null check(method in ('xtream-vod-info-v1','xtream-series-info-v1')),
  payload_fingerprint text not null check(payload_fingerprint ~ '^[a-f0-9]{32}$'),
  observed_at timestamptz not null default clock_timestamp(),
  primary key(variant_id,file_external_id)
);
create index catalog_owned_language_declarations_owner_idx
  on public.catalog_owned_language_declarations(user_id,source_id,variant_id);
alter table public.catalog_owned_language_declarations enable row level security;
revoke all on public.catalog_owned_language_declarations from public,anon,authenticated,service_role;
grant select on public.catalog_owned_language_declarations to service_role;

insert into public.admin_feature_flags(key,enabled)
values('owned_provider_language_metadata_enabled',false) on conflict(key) do nothing;

-- Only named fields INSIDE audio stream objects. Not info.language, original
-- language, title text, subtitle tags or country codes. Contradictory aliases
-- within the same stream fail closed; distinct audio streams may differ.
create function public.catalog_provider_stream_audio_languages(p_payload jsonb)
returns text[] language sql immutable parallel safe set search_path='' as $f$
  with containers as (
    select value from (values(p_payload),(p_payload->'info'),(p_payload->'movie_data')) c(value)
    where jsonb_typeof(value)='object'
  ), fields as (
    select c.value->key as value from containers c
    cross join (values('audio'),('audio_tracks'),('audioTracks')) k(key)
  ), tracks as (
    select row_number() over() as n,t.value from fields f
    cross join lateral jsonb_array_elements(case jsonb_typeof(f.value)
      when 'array' then f.value when 'object' then jsonb_build_array(f.value) else '[]'::jsonb end) with ordinality t(value,ord)
    where t.ord<=32 and jsonb_typeof(t.value)='object'
  ), raw as (
    select t.n,r.value from tracks t cross join lateral (values
      (t.value->>'lang'),(t.value->>'language'),(t.value->>'language_code'),
      (t.value#>>'{tags,language}'),(t.value#>>'{tags,LANGUAGE}'),
      (t.value#>>'{tags,lang}'),(t.value#>>'{tags,LANG}')) r(value)
    where r.value ~ '^[a-zA-Z]{2,3}([_-][a-zA-Z0-9]{2,8})?$' and length(r.value)<=20
  ), codes as (
    select n,case when lower(value)='yue' then 'yue'
      else public.norva_canonical_language_code(lower(value)) end as code from raw
  ), conflicts as (select n from codes where code is not null group by n having count(distinct code)>1)
  select case when exists(select 1 from conflicts) then '{}'::text[] else
    array(select distinct code from codes where code is not null order by code limit 32) end
$f$;
revoke all on function public.catalog_provider_stream_audio_languages(jsonb) from public,anon,authenticated;
grant execute on function public.catalog_provider_stream_audio_languages(jsonb) to service_role;

-- Private writer; coordinates/fences are supplied by our server, never a UI
-- metadata field. Empty results replace stale declarations, not observations.
create function public.record_owned_movie_language_declaration(
  p_user_id uuid,p_source_id uuid,p_generation_id uuid,p_head_revision bigint,
  p_config_revision bigint,p_source_visibility_epoch bigint,p_user_visibility_epoch bigint,
  p_variant_id uuid,p_external_id text,p_identity_id uuid,p_payload jsonb
) returns integer language plpgsql security definer set search_path='' as $f$
declare v_codes text[];
begin
  -- Hold the source head/config through the write. A writer that waited behind
  -- a promotion must revalidate AFTER obtaining these locks, not use old proof.
  perform 1 from public.cloud_source_catalog_heads h
    join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
    where h.source_id=p_source_id and h.user_id=p_user_id for share of h,l;
  perform public.norva_set_catalog_delete_proof(p_source_id,p_user_id,p_generation_id,p_head_revision,
    p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch);
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>1048576 then
    raise exception 'Invalid provider metadata payload' using errcode='22023';
  end if;
  if not exists(select 1 from public.cloud_title_variants v
    join public.cloud_sources s on s.id=v.source_id and s.user_id=v.user_id and s.source_type='xtream'
    join public.catalog_source_provider_identities i on i.user_id=v.user_id and i.source_id=v.source_id
      and i.identity_id=p_identity_id and i.verified_at is not null
    where v.id=p_variant_id and v.user_id=p_user_id and v.source_id=p_source_id
      and v.generation_id=p_generation_id and v.item_type='movie' and v.external_id=p_external_id) then
    raise exception 'Owned provider file changed' using errcode='42501';
  end if;
  -- Some panels include a vod_id/stream_id. An explicit mismatch is not this file.
  if nullif(p_payload#>>'{movie_data,stream_id}','') is not null
    and p_payload#>>'{movie_data,stream_id}'<>p_external_id then
    raise exception 'Provider file identifier mismatch' using errcode='22023';
  end if;
  v_codes:=public.catalog_provider_stream_audio_languages(p_payload);
  insert into public.catalog_owned_language_declarations
    (variant_id,user_id,source_id,generation_id,provider_identity_id,file_external_id,item_type,
     config_revision,source_visibility_epoch,audio_languages,method,payload_fingerprint)
  values(p_variant_id,p_user_id,p_source_id,p_generation_id,p_identity_id,p_external_id,'movie',
     p_config_revision,p_source_visibility_epoch,v_codes,'xtream-vod-info-v1',md5(p_payload::text))
  on conflict(variant_id,file_external_id) do update set
    generation_id=excluded.generation_id,provider_identity_id=excluded.provider_identity_id,
    config_revision=excluded.config_revision,source_visibility_epoch=excluded.source_visibility_epoch,
    audio_languages=excluded.audio_languages,method=excluded.method,
    payload_fingerprint=excluded.payload_fingerprint,observed_at=clock_timestamp();
  return cardinality(v_codes);
end $f$;
revoke all on function public.record_owned_movie_language_declaration(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_owned_movie_language_declaration(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid,text,uuid,jsonb) to service_role;

-- Called inside the already fenced episode registrar, after the full inventory
-- passed coordinate/collision validation. Membership fingerprint binds this
-- exact response; matching a numeric id or a host cache is insufficient.
create function public.capture_registered_episode_language_declarations(
  p_user uuid,p_source uuid,p_generation uuid,p_config bigint,p_visibility bigint,
  p_parent text,p_payload jsonb
) returns void language sql security definer set search_path='' as $f$
  with roots as (
    select value from jsonb_each(case when jsonb_typeof(p_payload->'episodes')='object'
      then p_payload->'episodes' else '{}'::jsonb end)
    union all
    select value from jsonb_array_elements(case when jsonb_typeof(p_payload->'episodes')='array'
      then p_payload->'episodes' else '[]'::jsonb end)
  ), episodes as (
    select e.value from roots r cross join lateral jsonb_array_elements(
      case jsonb_typeof(r.value) when 'array' then r.value when 'object' then jsonb_build_array(r.value) else '[]'::jsonb end) e(value)
  ), bound as (
    select m.*,e.value from episodes e join public.catalog_series_episode_memberships m
      on m.user_id=p_user and m.source_id=p_source and m.generation_id=p_generation
        and m.parent_series_id=p_parent and m.episode_id=coalesce(e.value->>'id',e.value->>'episode_id',e.value->>'stream_id')
        and m.payload_fingerprint=md5(p_payload::text)
    join public.catalog_source_provider_identities i on i.user_id=m.user_id and i.source_id=m.source_id
      and i.identity_id=m.provider_identity_id and i.verified_at is not null
  )
  insert into public.catalog_owned_language_declarations
    (variant_id,user_id,source_id,generation_id,provider_identity_id,file_external_id,item_type,
      config_revision,source_visibility_epoch,audio_languages,method,payload_fingerprint)
  select parent_variant_id,user_id,source_id,generation_id,provider_identity_id,episode_id,'episode',
    p_config,p_visibility,case when count(distinct public.catalog_provider_stream_audio_languages(value))=1
      then (array_agg(public.catalog_provider_stream_audio_languages(value)::text))[1]::text[] else '{}'::text[] end,
    'xtream-series-info-v1',md5(p_payload::text)
  from bound group by parent_variant_id,user_id,source_id,generation_id,provider_identity_id,episode_id
  on conflict(variant_id,file_external_id) do update set
    generation_id=excluded.generation_id,provider_identity_id=excluded.provider_identity_id,
    config_revision=excluded.config_revision,source_visibility_epoch=excluded.source_visibility_epoch,
    audio_languages=excluded.audio_languages,payload_fingerprint=excluded.payload_fingerprint,
    observed_at=clock_timestamp()
$f$;
revoke all on function public.capture_registered_episode_language_declarations(uuid,uuid,uuid,bigint,bigint,text,jsonb) from public,anon,authenticated,service_role;

do $patch$
declare body text; anchor text:='  return v_episode_count;';
begin
  body:=pg_get_functiondef('public.register_catalog_series_episodes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,text,jsonb)'::regprocedure);
  if (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1
    or position('norva_set_catalog_delete_proof' in body)=0 then
    raise exception 'Episode registrar drift';
  end if;
  body:=replace(body,anchor,$code$
  perform 1 from public.cloud_source_catalog_heads h
    join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
    where h.source_id=p_source_id and h.user_id=p_user_id for share of h,l;
  perform public.norva_set_catalog_delete_proof(p_source_id,p_user_id,p_generation_id,p_head_revision,
    p_config_revision,p_source_visibility_epoch,p_user_visibility_epoch);
  perform public.capture_registered_episode_language_declarations(
    p_user_id,p_source_id,p_generation_id,p_config_revision,p_source_visibility_epoch,p_parent_series_id,p_payload);
  return v_episode_count;$code$);
  execute body;
end $patch$;

-- Effective declarations are owner/generation/config scoped. Episodes add a
-- membership/fingerprint check. No global cache or TMDB data enters this view.
create view public.cloud_catalog_owned_audio_declarations with(security_invoker=true) as
select distinct v.user_id,v.source_id,v.item_type,v.title_id,v.id as variant_id,c.language
from public.catalog_owned_language_declarations d
join public.cloud_catalog_visible_title_variants v on v.id=d.variant_id and v.user_id=d.user_id
  and v.source_id=d.source_id and v.generation_id=d.generation_id
join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
join public.cloud_source_lifecycle lifecycle on lifecycle.source_id=d.source_id and lifecycle.user_id=d.user_id
  and lifecycle.config_revision=d.config_revision and lifecycle.visibility_epoch=d.source_visibility_epoch
join public.catalog_source_provider_identities i on i.user_id=d.user_id and i.source_id=d.source_id
  and i.identity_id=d.provider_identity_id and i.verified_at is not null
cross join lateral unnest(d.audio_languages) c(language)
where exists(select 1 from public.admin_feature_flags where key='owned_provider_language_metadata_enabled' and enabled)
  and (c.language='yue' or public.norva_canonical_language_code(c.language)=c.language)
  and ((v.item_type='movie' and d.item_type='movie' and d.file_external_id=v.external_id)
    or (v.item_type='series' and d.item_type='episode' and exists(
      select 1 from public.catalog_series_episode_memberships m where m.user_id=v.user_id and m.source_id=v.source_id
        and m.generation_id=v.generation_id and m.parent_variant_id=v.id and m.parent_title_id=v.title_id
        and m.parent_series_id=v.external_id and m.provider_identity_id=d.provider_identity_id
        and m.episode_id=d.file_external_id and m.payload_fingerprint=d.payload_fingerprint)))
  and not exists(select 1 from public.cloud_title_file_language_observations o
    cross join lateral unnest(o.audio_languages) code(value)
    where o.user_id=v.user_id and o.title_id=v.title_id and o.variant_id=v.id and o.audio_observed
      and o.file_external_id=v.external_id
      and (code.value='yue' or public.norva_canonical_language_code(code.value) is not null))
  and (v.item_type='movie' or not exists(
    select 1 from public.cloud_catalog_xtream_series_episode_audio_evidence(v.user_id,v.source_id) e
    where e.variant_id=v.id));
revoke all on public.cloud_catalog_owned_audio_declarations from public,anon,authenticated;
grant select on public.cloud_catalog_owned_audio_declarations to service_role;

-- Retain the existing exact-observation rules; replace only lower-trust hints
-- for variants with a current owned technical declaration. Keep declarations
-- unfiltered for precedence, while retaining the base's indexed language path.
alter function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text)
  rename to cloud_catalog_effective_audio_languages_before_owned;
create function public.cloud_catalog_effective_audio_languages(
  p_user_id uuid,p_item_type text,p_source_id uuid,p_language text
) returns table(title_id uuid,variant_id uuid,language text)
language sql stable security invoker set search_path='' as $f$
  with declared as materialized (
    select d.title_id,d.variant_id,d.language from public.cloud_catalog_owned_audio_declarations d
    where d.user_id=p_user_id and d.item_type=p_item_type and (p_source_id is null or d.source_id=p_source_id)
  )
  select b.* from public.cloud_catalog_effective_audio_languages_before_owned(p_user_id,p_item_type,p_source_id,p_language) b
    where (p_language is null or b.language=p_language)
      and not exists(select 1 from declared d where d.variant_id=b.variant_id)
  union
  select d.* from declared d where p_language is null or d.language=p_language
$f$;
-- The replaced invoker function is owned by postgres in production. Preserve
-- that ownership even when the migration operator uses supabase_admin for DDL.
alter function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) owner to postgres;
revoke all on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) to service_role;

do $patch$
declare body text; anchor text:='exists(select 1 from public.cloud_catalog_provider_language_hints h';
begin
  body:=pg_get_functiondef('public.catalog_movie_audio_identified(uuid,uuid,uuid)'::regprocedure);
  if position(anchor in body)=0 then raise exception 'Intake membership drift'; end if;
  body:=replace(body,anchor,$code$exists(select 1 from public.cloud_catalog_owned_audio_declarations d
          where d.user_id=v.user_id and d.source_id=v.source_id and d.variant_id=v.id)
        or exists(select 1 from public.cloud_catalog_provider_language_hints h$code$);
  execute body;
end $patch$;

notify pgrst,'reload schema';
commit;

begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Published public data is stored once. An enrollment is a single fenced
-- reference, never a copy of another account's inventory or observations.
create table public.selection_shared_rollout (
 singleton boolean primary key default true check(singleton),enabled boolean not null default false
);
insert into public.selection_shared_rollout default values;
alter table public.selection_shared_rollout enable row level security;
revoke all on public.selection_shared_rollout from public,anon,authenticated;
grant select on public.selection_shared_rollout to service_role;
create table public.selection_shared_releases (
  id uuid primary key default gen_random_uuid(),
  revision text not null check(revision ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text not null check(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  counts jsonb not null default '{}'::jsonb,
  categories jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  unique(revision,manifest_sha256)
);
create table public.selection_shared_enrollments (
  source_id uuid primary key references public.cloud_sources(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  generation_id uuid not null,
  config_revision bigint not null,
  release_id uuid not null references public.selection_shared_releases(id),
  created_at timestamptz not null default now()
);
create index selection_shared_enrollments_owner_idx on public.selection_shared_enrollments(user_id,source_id);
create table public.selection_shared_languages (
 release_id uuid not null references public.selection_shared_releases(id) on delete cascade,
 item_type text not null, external_id text not null, kind text not null check(kind in ('audio','subtitle')),
 language text not null, primary key(release_id,item_type,external_id,kind,language)
);
alter table public.selection_shared_languages enable row level security;
revoke all on public.selection_shared_languages from public,anon,authenticated;
grant select on public.selection_shared_languages to service_role;

create function public.norva_selection_shared_uuid(p_key text)
returns uuid language sql immutable strict parallel safe set search_path='' as $f$
  select (substr(h,1,8)||'-'||substr(h,9,4)||'-5'||substr(h,14,3)||'-a'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
  from (select encode(sha256(convert_to(p_key,'UTF8')),'hex') h) d
$f$;

create view public.selection_shared_visible_enrollments with(security_invoker=true,security_barrier=true) as
select e.*,h.head_revision,l.visibility_epoch source_visibility_epoch,
  coalesce(v.visibility_epoch,1) user_visibility_epoch
from public.selection_shared_enrollments e
join public.cloud_catalog_visible_sources s on s.id=e.source_id and s.user_id=e.user_id
join public.cloud_source_catalog_heads h on h.source_id=e.source_id and h.user_id=e.user_id and h.active_generation_id=e.generation_id
join public.cloud_source_lifecycle l on l.source_id=e.source_id and l.user_id=e.user_id and l.config_revision=e.config_revision
join public.selection_shared_releases r on r.id=e.release_id and r.published_at is not null
left join public.cloud_user_catalog_visibility_epochs v on v.user_id=e.user_id;

create table public.selection_shared_media (
  release_id uuid not null references public.selection_shared_releases(id) on delete cascade,
  item_type text,
  external_id text,
  parent_external_id text,
  title text,
  subtitle text,
  poster_url text,
  backdrop_url text,
  metadata jsonb,
  playback_hint jsonb,
  available boolean,
  added_at bigint,
  rating_num numeric,
  release_year integer,
  dedup_key text,
  primary key(release_id,item_type,external_id)
);
create table public.selection_shared_titles (
  release_id uuid not null references public.selection_shared_releases(id) on delete cascade,
  item_type text,
  identity_key text,
  identity_source text,
  provider_tmdb_id text,
  provider_imdb_id text,
  match_status text,
  title text,
  original_title text,
  release_year integer,
  poster_url text,
  backdrop_url text,
  metadata jsonb,
  version_languages text[],
  genre_category text,
  genre_payload jsonb,
  genre_buckets text[],
  rating_num numeric,
  primary key(release_id,item_type,identity_key)
);
create table public.selection_shared_variants (
  release_id uuid not null references public.selection_shared_releases(id) on delete cascade,
  item_type text,
  external_id text,
  raw_title text,
  label text,
  language text,
  quality text,
  resolution text,
  container_extension text,
  poster_url text,
  playback_hint jsonb,
  codec_profile jsonb,
  compatibility_tier text,
  playback_cost_score integer,
  metadata jsonb,
  identity_key text not null,
  primary key(release_id,item_type,external_id)
);
alter table public.selection_shared_titles add column variant_count integer;
alter table public.selection_shared_titles add column audio_languages text[];
alter table public.selection_shared_titles add column audio_probed_at timestamp with time zone;
alter table public.selection_shared_titles add column subtitle_probed_at timestamp with time zone;
alter table public.selection_shared_titles add column audio_lang_verified_at timestamp with time zone;
alter table public.selection_shared_titles add column file_audio_languages text[];
alter table public.selection_shared_titles add column file_subtitle_languages text[];
alter table public.selection_shared_titles add column file_audio_verified_languages text[];
alter table public.selection_shared_titles add column default_external_id text;
alter table public.selection_shared_media add column file_tags jsonb not null default '{}'::jsonb;
create index selection_shared_media_parent_idx on public.selection_shared_media(release_id,item_type,parent_external_id);
create index selection_shared_variants_identity_idx on public.selection_shared_variants(release_id,item_type,identity_key);
create view public.selection_shared_visible_media with(security_invoker=true) as
select
  public.norva_selection_shared_uuid('media:'||e.source_id::text||':'||e.generation_id::text||':'||m.item_type||':'||m.external_id) as id,
  e.user_id as user_id,
  e.source_id as source_id,
  m.item_type as item_type,
  m.external_id as external_id,
  m.parent_external_id as parent_external_id,
  m.title as title,
  m.subtitle as subtitle,
  m.poster_url as poster_url,
  m.backdrop_url as backdrop_url,
  m.metadata as metadata,
  m.playback_hint as playback_hint,
  m.available as available,
  e.created_at as created_at,
  r.published_at as updated_at,
  m.added_at as added_at,
  m.rating_num as rating_num,
  m.release_year as release_year,
  null::bigint as catalog_version,
  m.dedup_key as dedup_key,
  true as is_dedup_primary,
  e.generation_id as generation_id,
  null::uuid as ingest_job_id,
  null::integer as ingest_attempt,
  null::text as ingest_lease_owner,
  null::bigint as write_head_revision,
  null::bigint as write_config_revision,
  null::bigint as write_source_visibility_epoch,
  null::bigint as write_user_visibility_epoch,
  null::uuid as projection_refresh_run_id
from public.selection_shared_visible_enrollments e join public.selection_shared_releases r on r.id=e.release_id
join public.selection_shared_media m on m.release_id=e.release_id
where not exists(select 1 from public.cloud_media_items owned where owned.user_id=e.user_id and owned.source_id=e.source_id and owned.generation_id=e.generation_id and owned.item_type=m.item_type and owned.external_id=m.external_id);
create view public.selection_shared_visible_variants with(security_invoker=true) as
select
  public.norva_selection_shared_uuid('variant:'||e.source_id::text||':'||e.generation_id::text||':'||t.item_type||':'||t.external_id) as id,
  e.user_id as user_id,
  coalesce(owned.id,public.norva_selection_shared_uuid('title:'||e.user_id::text||':'||t.item_type||':'||t.identity_key)) as title_id,
  e.source_id as source_id,
  public.norva_selection_shared_uuid('media:'||e.source_id::text||':'||e.generation_id::text||':'||t.item_type||':'||t.external_id) as media_item_id,
  t.item_type as item_type,
  t.external_id as external_id,
  t.raw_title as raw_title,
  t.label as label,
  t.language as language,
  t.quality as quality,
  t.resolution as resolution,
  t.container_extension as container_extension,
  t.poster_url as poster_url,
  t.playback_hint as playback_hint,
  t.codec_profile as codec_profile,
  t.compatibility_tier as compatibility_tier,
  t.playback_cost_score as playback_cost_score,
  null::integer as last_observed_ttff_ms,
  null::numeric(5,4) as observed_success_rate,
  t.metadata as metadata,
  e.created_at as created_at,
  r.published_at as updated_at,
  null::timestamp with time zone as audio_whisper_attempted_at,
  null::timestamp with time zone as audio_whisper_retry_at,
  null::timestamp with time zone as audio_lang_verified_at,
  null::timestamp with time zone as audio_lang_verify_retry_at,
  e.generation_id as generation_id,
  null::uuid as ingest_job_id,
  null::integer as ingest_attempt,
  null::text as ingest_lease_owner,
  null::bigint as write_head_revision,
  null::bigint as write_config_revision,
  null::bigint as write_source_visibility_epoch,
  null::bigint as write_user_visibility_epoch,
  t.identity_key as shared_identity_key
from public.selection_shared_visible_enrollments e join public.selection_shared_releases r on r.id=e.release_id
join public.selection_shared_variants t on t.release_id=e.release_id
left join public.cloud_titles owned on owned.user_id=e.user_id and owned.item_type=t.item_type and owned.identity_key=t.identity_key
where not exists(select 1 from public.cloud_title_variants real where real.user_id=e.user_id and real.source_id=e.source_id and real.generation_id=e.generation_id and real.item_type=t.item_type and real.external_id=t.external_id);
create or replace view public.cloud_catalog_visible_media_items with(security_invoker=true,security_barrier=true) as
SELECT item.id,
    item.user_id,
    item.source_id,
    item.item_type,
    item.external_id,
    item.parent_external_id,
    item.title,
    item.subtitle,
    item.poster_url,
    item.backdrop_url,
    item.metadata,
    item.playback_hint,
    item.available,
    item.created_at,
    item.updated_at,
    item.added_at,
    item.rating_num,
    item.release_year,
    item.catalog_version,
    item.dedup_key,
    item.is_dedup_primary,
    item.generation_id,
    item.ingest_job_id,
    item.ingest_attempt,
    item.ingest_lease_owner,
    item.write_head_revision,
    item.write_config_revision,
    item.write_source_visibility_epoch,
    item.write_user_visibility_epoch,
    item.projection_refresh_run_id
   FROM cloud_media_items item
     JOIN cloud_catalog_visible_sources source ON source.id = item.source_id AND source.user_id = item.user_id
     LEFT JOIN cloud_source_catalog_heads head ON head.source_id = item.source_id AND head.user_id = item.user_id
  WHERE item.generation_id IS NULL OR head.active_generation_id = item.generation_id
union all select * from public.selection_shared_visible_media;
create or replace view public.cloud_catalog_visible_title_variants with(security_invoker=true,security_barrier=true) as
SELECT variant.id,
    variant.user_id,
    variant.title_id,
    variant.source_id,
    variant.media_item_id,
    variant.item_type,
    variant.external_id,
    variant.raw_title,
    variant.label,
    variant.language,
    variant.quality,
    variant.resolution,
    variant.container_extension,
    variant.poster_url,
    variant.playback_hint,
    variant.codec_profile,
    variant.compatibility_tier,
    variant.playback_cost_score,
    variant.last_observed_ttff_ms,
    variant.observed_success_rate,
    variant.metadata,
    variant.created_at,
    variant.updated_at,
    variant.audio_whisper_attempted_at,
    variant.audio_whisper_retry_at,
    variant.audio_lang_verified_at,
    variant.audio_lang_verify_retry_at,
    variant.generation_id,
    variant.ingest_job_id,
    variant.ingest_attempt,
    variant.ingest_lease_owner,
    variant.write_head_revision,
    variant.write_config_revision,
    variant.write_source_visibility_epoch,
    variant.write_user_visibility_epoch
   FROM cloud_title_variants variant
     JOIN cloud_catalog_visible_sources source ON source.id = variant.source_id AND source.user_id = variant.user_id
     LEFT JOIN cloud_source_catalog_heads head ON head.source_id = variant.source_id AND head.user_id = variant.user_id
  WHERE variant.generation_id IS NULL OR head.active_generation_id = variant.generation_id
union all select id,user_id,title_id,source_id,media_item_id,item_type,external_id,raw_title,label,language,quality,resolution,container_extension,poster_url,playback_hint,codec_profile,compatibility_tier,playback_cost_score,last_observed_ttff_ms,observed_success_rate,metadata,created_at,updated_at,audio_whisper_attempted_at,audio_whisper_retry_at,audio_lang_verified_at,audio_lang_verify_retry_at,generation_id,ingest_job_id,ingest_attempt,ingest_lease_owner,write_head_revision,write_config_revision,write_source_visibility_epoch,write_user_visibility_epoch from public.selection_shared_visible_variants;
create view public.selection_shared_physical_titles with(security_invoker=true,security_barrier=true) as
( SELECT title.id,
    projection.user_id,
    projection.item_type,
    projection.identity_key,
    projection.identity_source,
    projection.provider_tmdb_id,
    projection.provider_imdb_id,
    projection.match_status,
    projection.title,
    projection.original_title,
    projection.release_year,
    projection.poster_url,
    projection.backdrop_url,
    projection.metadata,
    runtime.best_variant_id AS default_variant_id,
    runtime.variant_count,
    runtime.last_observed_ttff_ms,
    projection.synced_at,
    projection.catalog_created_at AS created_at,
    projection.updated_at,
    runtime.version_languages,
    runtime.file_audio_languages AS audio_languages,
    runtime.audio_probed_at,
    NULL::jsonb AS audio_tracks,
    projection.genre_category,
    projection.genre_payload,
    '[]'::jsonb AS subtitle_tracks,
    runtime.subtitle_probed_at,
    runtime.whisper_attempted_at,
    projection.year_backfill_attempted_at,
    projection.revalidate_attempted_at,
    projection.search_match_attempted_at,
    runtime.audio_lang_verified_at,
    projection.genre_buckets,
    projection.rating_num,
    runtime.file_audio_languages,
    runtime.file_subtitle_languages,
    runtime.file_audio_verified_languages,
    runtime.visible_source_ids,
    projection.poster_url IS NOT NULL AS has_poster
   FROM cloud_source_catalog_generation_candidate_titles projection
     JOIN cloud_titles title ON title.id = projection.title_id AND title.user_id = projection.user_id
     CROSS JOIN LATERAL norva_visible_catalog_title_runtime(title.id, title.user_id) runtime(best_variant_id, best_generation_id, display_generation_id, variant_count, last_observed_ttff_ms, version_languages, whisper_attempted_at, visible_source_ids, file_audio_languages, file_subtitle_languages, file_audio_verified_languages, audio_probed_at, subtitle_probed_at, audio_lang_verified_at)
  WHERE projection.generation_id = runtime.display_generation_id
  ORDER BY projection.synced_at DESC, projection.updated_at DESC)
UNION ALL
( SELECT title.id,
    title.user_id,
    title.item_type,
    title.identity_key,
    title.identity_source,
    title.provider_tmdb_id,
    title.provider_imdb_id,
    title.match_status,
    title.title,
    title.original_title,
    title.release_year,
    title.poster_url,
    title.backdrop_url,
    title.metadata,
    runtime.best_variant_id AS default_variant_id,
    runtime.variant_count,
    runtime.last_observed_ttff_ms,
    title.synced_at,
    title.created_at,
    title.updated_at,
    runtime.version_languages,
    runtime.file_audio_languages AS audio_languages,
    runtime.audio_probed_at,
    NULL::jsonb AS audio_tracks,
    title.genre_category,
    title.genre_payload,
    '[]'::jsonb AS subtitle_tracks,
    runtime.subtitle_probed_at,
    runtime.whisper_attempted_at,
    title.year_backfill_attempted_at,
    title.revalidate_attempted_at,
    title.search_match_attempted_at,
    runtime.audio_lang_verified_at,
    title.genre_buckets,
    title.rating_num,
    runtime.file_audio_languages,
    runtime.file_subtitle_languages,
    runtime.file_audio_verified_languages,
    runtime.visible_source_ids,
    title.poster_url IS NOT NULL AS has_poster
   FROM cloud_titles title
     CROSS JOIN LATERAL norva_visible_catalog_title_runtime(title.id, title.user_id) runtime(best_variant_id, best_generation_id, display_generation_id, variant_count, last_observed_ttff_ms, version_languages, whisper_attempted_at, visible_source_ids, file_audio_languages, file_subtitle_languages, file_audio_verified_languages, audio_probed_at, subtitle_probed_at, audio_lang_verified_at)
  WHERE NOT (EXISTS ( SELECT 1
           FROM cloud_source_catalog_generation_candidate_titles projection
          WHERE projection.title_id = title.id AND projection.user_id = title.user_id AND projection.generation_id = runtime.display_generation_id))
  ORDER BY title.synced_at DESC, title.updated_at DESC);
create view public.selection_shared_visible_titles with(security_invoker=true) as
select
  coalesce(owned.id,public.norva_selection_shared_uuid('title:'||e.user_id::text||':'||t.item_type||':'||t.identity_key)) as id,
  e.user_id as user_id,
  t.item_type as item_type,
  t.identity_key as identity_key,
  t.identity_source as identity_source,
  t.provider_tmdb_id as provider_tmdb_id,
  t.provider_imdb_id as provider_imdb_id,
  t.match_status as match_status,
  t.title as title,
  t.original_title as original_title,
  t.release_year as release_year,
  t.poster_url as poster_url,
  t.backdrop_url as backdrop_url,
  t.metadata as metadata,
  public.norva_selection_shared_uuid('variant:'||e.source_id::text||':'||e.generation_id::text||':'||t.item_type||':'||t.default_external_id) as default_variant_id,
  t.variant_count as variant_count,
  null::integer as last_observed_ttff_ms,
  e.created_at as synced_at,
  e.created_at as created_at,
  r.published_at as updated_at,
  t.version_languages as version_languages,
  t.audio_languages as audio_languages,
  t.audio_probed_at as audio_probed_at,
  null::jsonb as audio_tracks,
  t.genre_category as genre_category,
  t.genre_payload as genre_payload,
  '[]'::jsonb as subtitle_tracks,
  t.subtitle_probed_at as subtitle_probed_at,
  null::timestamptz as whisper_attempted_at,
  null::timestamp with time zone as year_backfill_attempted_at,
  null::timestamp with time zone as revalidate_attempted_at,
  null::timestamp with time zone as search_match_attempted_at,
  t.audio_lang_verified_at as audio_lang_verified_at,
  t.genre_buckets as genre_buckets,
  t.rating_num as rating_num,
  t.file_audio_languages as file_audio_languages,
  t.file_subtitle_languages as file_subtitle_languages,
  t.file_audio_verified_languages as file_audio_verified_languages,
 array[e.source_id] as visible_source_ids, (t.poster_url is not null) as has_poster
from public.selection_shared_visible_enrollments e join public.selection_shared_releases r on r.id=e.release_id
join public.selection_shared_titles t on t.release_id=e.release_id
left join public.cloud_titles owned on owned.user_id=e.user_id and owned.item_type=t.item_type and owned.identity_key=t.identity_key
where owned.id is null;
create or replace view public.cloud_catalog_visible_titles with(security_invoker=true,security_barrier=true) as
select * from public.selection_shared_physical_titles union all select * from public.selection_shared_visible_titles;
alter table public.selection_shared_releases enable row level security;
revoke all on public.selection_shared_releases from public,anon,authenticated;
grant select on public.selection_shared_releases to service_role;
alter table public.selection_shared_enrollments enable row level security;
revoke all on public.selection_shared_enrollments from public,anon,authenticated;
grant select on public.selection_shared_enrollments to service_role;
alter table public.selection_shared_media enable row level security;
revoke all on public.selection_shared_media from public,anon,authenticated;
grant select on public.selection_shared_media to service_role;
alter table public.selection_shared_titles enable row level security;
revoke all on public.selection_shared_titles from public,anon,authenticated;
grant select on public.selection_shared_titles to service_role;
alter table public.selection_shared_variants enable row level security;
revoke all on public.selection_shared_variants from public,anon,authenticated;
grant select on public.selection_shared_variants to service_role;
revoke all on public.selection_shared_visible_enrollments from public,anon,authenticated;
grant select on public.selection_shared_visible_enrollments to service_role;
revoke all on public.selection_shared_visible_media from public,anon,authenticated;
grant select on public.selection_shared_visible_media to service_role;
revoke all on public.selection_shared_visible_variants from public,anon,authenticated;
grant select on public.selection_shared_visible_variants to service_role;
revoke all on public.selection_shared_visible_titles from public,anon,authenticated;
grant select on public.selection_shared_visible_titles to service_role;
revoke all on public.selection_shared_physical_titles from public,anon,authenticated;
grant select on public.selection_shared_physical_titles to service_role;
revoke all on function public.norva_selection_shared_uuid(text) from public,anon,authenticated;
grant execute on function public.norva_selection_shared_uuid(text) to service_role;

-- PUBLISH_AND_ENROLL

create function public.norva_prepare_selection_shared_release(p_revision text)
returns uuid language plpgsql security definer set search_path='' as $f$
declare v_payload jsonb; v_release uuid; v_digest text; v_expected integer;
begin
  perform public.norva_credential_require_service_role();
  select payload into v_payload from public.selection_prepared_catalogs
    where revision=p_revision and expires_at>clock_timestamp() for share;
  if v_payload is null or v_payload->>'version'<>'1' or (v_payload->>'truncated')::boolean is distinct from false
    or jsonb_array_length(v_payload->'rows') not between 1 and 100000 then
    raise exception 'Complete qualified Selection manifest required' using errcode='22023';
  end if;
  v_digest:=encode(sha256(convert_to((v_payload->'rows')::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended('selection-release:'||p_revision,0));
  select id into v_release from public.selection_shared_releases where revision=p_revision and manifest_sha256=v_digest;
  if v_release is not null then return v_release; end if;
  select count(*) into v_expected from jsonb_array_elements(v_payload->'rows') raw where raw->>'item_type' in ('movie','series');
  if v_expected<>(select count(*) from jsonb_array_elements(v_payload->'rows') raw
    join public.selection_title_recipes recipe on recipe.revision=p_revision
      and recipe.raw_key=public.norva_selection_raw_recipe_key(raw) and recipe.expires_at>clock_timestamp()
    where raw->>'item_type' in ('movie','series')) then
    raise exception 'Selection title recipes are incomplete' using errcode='22023';
  end if;
  insert into public.selection_shared_releases(revision,manifest_sha256,sources)
    values(p_revision,v_digest,coalesce(v_payload->'sources','[]'::jsonb)) returning id into v_release;
  insert into public.selection_shared_media(release_id,item_type,external_id,parent_external_id,title,subtitle,
    poster_url,backdrop_url,metadata,playback_hint,available,added_at,rating_num,release_year,dedup_key)
  select v_release,m.item_type,m.external_id,m.parent_external_id,m.title,m.subtitle,m.poster_url,m.backdrop_url,
    coalesce(m.metadata,'{}'::jsonb),coalesce(m.playback_hint,'{}'::jsonb),coalesce(m.available,true),
    case when m.metadata->>'added' ~ '^[0-9]{1,12}$' then (m.metadata->>'added')::bigint end,
    null,null,null
  from jsonb_array_elements(v_payload->'rows') raw
  cross join lateral jsonb_populate_record(null::public.cloud_media_items,raw) m;
  insert into public.selection_shared_titles(release_id,item_type,identity_key,identity_source,provider_tmdb_id,
    provider_imdb_id,match_status,title,original_title,release_year,poster_url,backdrop_url,metadata,version_languages,
    genre_category,genre_payload,genre_buckets,rating_num,variant_count,audio_languages,file_audio_languages,
    file_subtitle_languages,file_audio_verified_languages)
  select distinct on(t.item_type,t.identity_key) v_release,t.item_type,t.identity_key,t.identity_source,t.provider_tmdb_id,
    t.provider_imdb_id,t.match_status,t.title,t.original_title,t.release_year,t.poster_url,t.backdrop_url,
    coalesce(t.metadata,'{}'::jsonb),coalesce(t.version_languages,'{}'::text[]),t.metadata->>'categoryName',
    t.metadata#>'{tmdb,genres}',public.norva_classify_buckets(t.metadata->>'categoryName',t.metadata#>'{tmdb,genres}'),
    case when t.metadata#>>'{tmdb,vote_average}' ~ '^[0-9]+(\.[0-9]+)?$' then (t.metadata#>>'{tmdb,vote_average}')::numeric end,
    0,'{}','{}','{}','{}'
  from jsonb_array_elements(v_payload->'rows') raw
  join public.selection_title_recipes recipe on recipe.revision=p_revision and recipe.raw_key=public.norva_selection_raw_recipe_key(raw)
  cross join lateral jsonb_populate_record(null::public.cloud_titles,recipe.title) t
  order by t.item_type,t.identity_key,recipe.raw_key;
  insert into public.selection_shared_variants(release_id,identity_key,item_type,external_id,raw_title,label,language,
    quality,resolution,container_extension,poster_url,playback_hint,codec_profile,compatibility_tier,playback_cost_score,metadata)
  select v_release,recipe.title->>'identity_key',v.item_type,v.external_id,v.raw_title,v.label,v.language,v.quality,
    v.resolution,v.container_extension,v.poster_url,coalesce(v.playback_hint,'{}'),coalesce(v.codec_profile,'{}'),
    v.compatibility_tier,v.playback_cost_score,coalesce(v.metadata,'{}')
  from jsonb_array_elements(v_payload->'rows') raw
  join public.selection_title_recipes recipe on recipe.revision=p_revision and recipe.raw_key=public.norva_selection_raw_recipe_key(raw)
  cross join lateral jsonb_populate_record(null::public.cloud_title_variants,recipe.variant) v;
  analyze public.selection_shared_media;
  analyze public.selection_shared_titles;
  analyze public.selection_shared_variants;
  update public.selection_shared_titles t set variant_count=x.n,default_external_id=x.external_id
  from (select item_type,identity_key,count(*)::integer n,min(external_id) external_id
    from public.selection_shared_variants where release_id=v_release group by item_type,identity_key) x
  where t.release_id=v_release and t.item_type=x.item_type and t.identity_key=x.identity_key;
  update public.selection_shared_media m set release_year=t.release_year,rating_num=t.rating_num,dedup_key=t.identity_key
  from public.selection_shared_variants v join public.selection_shared_titles t
    on t.release_id=v.release_id and t.item_type=v.item_type and t.identity_key=v.identity_key
  where m.release_id=v_release and v.release_id=m.release_id and v.item_type=m.item_type and v.external_id=m.external_id;
  update public.selection_shared_releases set counts=(select jsonb_object_agg(item_type,n) from
    (select item_type,count(*) n from public.selection_shared_media where release_id=v_release group by item_type) c),
    categories=(select jsonb_object_agg(item_type,n) from
    (select item_type,count(distinct parent_external_id) filter(where parent_external_id is not null) n
      from public.selection_shared_media where release_id=v_release and item_type in ('movie','series','live') group by item_type) c)
    where id=v_release;
  return v_release;
end
$f$;

-- Only the server's exact-file audit can populate an unpublished release.
-- This does not accept account history, provider credentials or a title-level
-- language guess. The URL digest prevents evidence from being moved to a new file.
create function public.norva_seed_selection_shared_tags(p_release_id uuid,p_files jsonb)
returns integer language plpgsql security definer set search_path='' as $f$
declare v_count integer;
begin
  perform public.norva_credential_require_service_role();
  if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files)>250
    or octet_length(p_files::text)>1048576 then raise exception 'Bounded file evidence required' using errcode='22023'; end if;
  perform 1 from public.selection_shared_releases where id=p_release_id and published_at is null for update;
  if not found then raise exception 'Unpublished release required' using errcode='PT409'; end if;
  update public.selection_shared_media m set file_tags=jsonb_build_object(
    'audioTracks',coalesce(f->'audioTracks','[]'::jsonb),'subtitleTracks',coalesce(f->'subtitleTracks','[]'::jsonb),
    'probedAt',f->'probedAt','hasSubtitle',coalesce(f->'hasSubtitle','false'::jsonb),'verified',false)
  from jsonb_array_elements(p_files) f
  where m.release_id=p_release_id and m.item_type in ('movie','episode') and m.external_id=f->>'externalId'
    and encode(sha256(convert_to(m.playback_hint->>'targetUrl','UTF8')),'hex')=f->>'urlSha256'
    and jsonb_typeof(f->'audioTracks')='array' and jsonb_typeof(f->'subtitleTracks')='array'
    and nullif(f->>'probedAt','') is not null;
  get diagnostics v_count=row_count;
  return v_count;
end
$f$;

create function public.norva_publish_selection_shared_release(p_release_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_result jsonb;
begin
  perform public.norva_credential_require_service_role();
  perform 1 from public.selection_shared_releases where id=p_release_id and published_at is null for update;
  if not found then raise exception 'Unpublished release required' using errcode='PT409'; end if;
  -- Later globally qualified file analyses take precedence over the static audit.
  update public.selection_shared_media m set file_tags=jsonb_build_object(
    'audioTracks',job.result->'audioTracks','subtitleTracks',job.result->'subtitleTracks',
    'hasSubtitle',coalesce(jsonb_array_length(job.result->'subtitleTracks'),0)>0,
    'probedAt',job.completed_at,'verified',coalesce((job.result->>'verified')::boolean,false))
  from public.catalog_selection_audio_jobs job
  where m.release_id=p_release_id and job.state='completed' and job.external_id=m.external_id
    and job.url_sha256=encode(sha256(convert_to(m.playback_hint->>'targetUrl','UTF8')),'hex');
  insert into public.selection_shared_languages(release_id,item_type,external_id,kind,language)
  select distinct p_release_id,case when m.item_type='episode' then 'series' else 'movie' end,
    case when m.item_type='episode' then m.parent_external_id else m.external_id end,kind,
    public.norva_canonical_language_code(coalesce(track->>'lang',track->>'language'))
  from public.selection_shared_media m cross join (values('audio'),('subtitle')) kinds(kind)
  cross join lateral jsonb_array_elements(coalesce(m.file_tags->(kind||'Tracks'),'[]')) track
  where m.release_id=p_release_id and m.item_type in ('movie','episode')
    and public.norva_canonical_language_code(coalesce(track->>'lang',track->>'language')) is not null
  on conflict do nothing;
  -- Explicit provider tags remain usable where exact-file audio is unknown.
  insert into public.selection_shared_languages(release_id,item_type,external_id,kind,language)
  select p_release_id,v.item_type,v.external_id,'audio',public.catalog_provider_language(v.metadata,v.external_id,v.raw_title)
  from public.selection_shared_variants v where v.release_id=p_release_id
    and public.catalog_provider_language(v.metadata,v.external_id,v.raw_title) is not null
    and not exists(select 1 from public.selection_shared_languages l where l.release_id=v.release_id
      and l.item_type=v.item_type and l.external_id=v.external_id and l.kind='audio')
  on conflict do nothing;
  -- Series facets aggregate exact episode evidence, without turning that union
  -- into an ordered track map for any individual episode.
  with files as materialized (
    select v.item_type,v.identity_key,m.file_tags from public.selection_shared_variants v
    join public.selection_shared_media m on m.release_id=v.release_id and m.item_type='movie' and m.external_id=v.external_id
    where v.release_id=p_release_id and v.item_type='movie'
    union all
    select v.item_type,v.identity_key,m.file_tags from public.selection_shared_variants v
    join public.selection_shared_media m on m.release_id=v.release_id and m.item_type='episode' and m.parent_external_id=v.external_id
    where v.release_id=p_release_id and v.item_type='series'
  ), summaries as (
    select item_type,identity_key,
      coalesce(array_agg(distinct public.norva_canonical_language_code(coalesce(a->>'lang',a->>'language')))
        filter(where public.norva_canonical_language_code(coalesce(a->>'lang',a->>'language')) is not null),'{}') langs,
      coalesce(array_agg(distinct public.norva_canonical_language_code(coalesce(a->>'lang',a->>'language')))
        filter(where (file_tags->>'verified')::boolean and public.norva_canonical_language_code(coalesce(a->>'lang',a->>'language')) is not null),'{}') verified_langs,
      coalesce(array_agg(distinct public.norva_canonical_language_code(coalesce(s->>'lang',s->>'language')))
        filter(where public.norva_canonical_language_code(coalesce(s->>'lang',s->>'language')) is not null),'{}') subtitle_langs,
      max((file_tags->>'probedAt')::timestamptz) probed_at
    from files left join lateral jsonb_array_elements(coalesce(file_tags->'audioTracks','[]')) a on true
      left join lateral jsonb_array_elements(coalesce(file_tags->'subtitleTracks','[]')) s on true
    group by item_type,identity_key
  ) update public.selection_shared_titles t set audio_languages=s.langs,file_audio_languages=s.langs,audio_probed_at=s.probed_at,
    file_audio_verified_languages=s.verified_langs,file_subtitle_languages=s.subtitle_langs,
    subtitle_probed_at=s.probed_at,audio_lang_verified_at=case when cardinality(s.verified_langs)>0 then s.probed_at end
    from summaries s where t.release_id=p_release_id and t.item_type=s.item_type and t.identity_key=s.identity_key;
  update public.selection_shared_releases set published_at=clock_timestamp() where id=p_release_id
    returning jsonb_build_object('releaseId',id,'revision',revision,'counts',counts) into v_result;
  return v_result;
end
$f$;

create function public.norva_activate_selection_shared_catalog(
  p_source_id uuid,p_user_id uuid,p_revision text,p_generation_id uuid,p_head_revision bigint,p_config_revision bigint,
  p_source_visibility_epoch bigint,p_user_visibility_epoch bigint
) returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_snapshot jsonb; v_release public.selection_shared_releases; v_progress jsonb; v_now timestamptz:=clock_timestamp(); v_categories jsonb;
begin
  perform public.norva_credential_require_service_role();
  if not public.norva_selection_source_identity_valid(p_source_id,p_user_id) then
    raise exception 'Canonical Selection ownership required' using errcode='42501'; end if;
  if not exists(select 1 from public.selection_shared_rollout where enabled)
    and not exists(select 1 from public.selection_shared_enrollments where source_id=p_source_id and user_id=p_user_id) then
    return jsonb_build_object('activated',false); end if;
  perform 1 from public.cloud_sources s where s.id=p_source_id and s.user_id=p_user_id for update;
  perform 1 from public.cloud_source_catalog_heads h join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
    where h.source_id=p_source_id and h.user_id=p_user_id for share of h,l;
  perform 1 from public.cloud_user_catalog_visibility_epochs e where e.user_id=p_user_id for update;
  v_snapshot:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
  if (v_snapshot->>'generationId')::uuid is distinct from p_generation_id
    or (v_snapshot->>'headRevision')::bigint is distinct from p_head_revision
    or (v_snapshot->>'configRevision')::bigint is distinct from p_config_revision
    or (v_snapshot->>'sourceVisibilityEpoch')::bigint is distinct from p_source_visibility_epoch
    or (v_snapshot->>'userVisibilityEpoch')::bigint is distinct from p_user_visibility_epoch
    or (v_snapshot->>'isCatalogVisible')::boolean is distinct from true then
    raise exception 'Selection catalogue snapshot changed' using errcode='PT409'; end if;
  select * into v_release from public.selection_shared_releases where revision=p_revision and published_at is not null
    order by published_at desc limit 1;
  if v_release.id is null then return jsonb_build_object('activated',false); end if;
  -- A release is a qualified snapshot. Do not silently retarget an existing
  -- enrollment while its physical FK bindings still refer to older files.
  -- Republishing/new enrollments may select a newer snapshot; upgrading existing
  -- members requires an explicit, qualified migration of their bound files.
  select r.* into v_release from public.selection_shared_releases r where r.id=coalesce(
    (select e.release_id from public.selection_shared_enrollments e
      where e.source_id=p_source_id and e.user_id=p_user_id and e.generation_id=p_generation_id
        and e.config_revision=p_config_revision),v_release.id);
  if exists(select 1 from public.selection_shared_enrollments e join public.cloud_sources s on s.id=e.source_id and s.user_id=e.user_id
    where e.source_id=p_source_id and e.user_id=p_user_id and e.generation_id=p_generation_id
      and e.config_revision=p_config_revision and e.release_id=v_release.id and s.sync_status='ready') then
    return jsonb_build_object('activated',true,'releaseId',v_release.id,'counts',v_release.counts); end if;
  -- Existing physical inventories keep their normal refresh semantics. This
  -- entry point is for an empty source or its already-shared enrollment.
  if exists(select 1 from public.cloud_media_items where source_id=p_source_id and user_id=p_user_id and generation_id=p_generation_id)
    and not exists(select 1 from public.selection_shared_enrollments where source_id=p_source_id and user_id=p_user_id and generation_id=p_generation_id) then
    return jsonb_build_object('activated',false); end if;
  insert into public.selection_shared_enrollments(source_id,user_id,generation_id,config_revision,release_id)
    values(p_source_id,p_user_id,p_generation_id,p_config_revision,v_release.id)
    on conflict(source_id) do update set generation_id=excluded.generation_id,config_revision=excluded.config_revision,release_id=excluded.release_id;
  v_categories:=jsonb_build_object('movies',coalesce((v_release.categories->>'movie')::int,0),
    'series',coalesce((v_release.categories->>'series')::int,0),'live',coalesce((v_release.categories->>'live')::int,0),
    'total',(select coalesce(sum(value::int),0) from jsonb_each_text(v_release.categories)));
  v_progress:=jsonb_build_object('status','ready','stage','ready','percent',100,'startedAt',v_now,'updatedAt',v_now,
    'moviesReady',true,'seriesReady',true,'liveReady',true,'browseReady',true,'usable',true,'categories',v_categories,
    'steps',jsonb_build_object('connect',jsonb_build_object('status','done'),'channels',jsonb_build_object('status','done','count',v_release.counts->'live'),
      'movies',jsonb_build_object('status','done','count',v_release.counts->'movie'),'series',jsonb_build_object('status','done','count',v_release.counts->'series'),
      'categories',jsonb_build_object('status','done','count',v_categories->'total'),'import',jsonb_build_object('status','done'),
      'finalize',jsonb_build_object('status','done')),
    'completedAt',v_now,'counts',jsonb_build_object('movies',coalesce((v_release.counts->>'movie')::int,0),
      'series',coalesce((v_release.counts->>'series')::int,0),'live',coalesce((v_release.counts->>'live')::int,0),
      'total',(select sum(value::int) from jsonb_each_text(v_release.counts))));
  update public.cloud_sources set sync_status='ready',sync_error=null,last_synced_at=v_now,
    config_hint=(coalesce(config_hint,'{}'::jsonb)-'syncCursor')||jsonb_build_object('syncProgress',v_progress)
    where id=p_source_id and user_id=p_user_id;
  perform public.norva_bump_user_catalog_visibility_epoch(p_user_id);
  return jsonb_build_object('activated',true,'releaseId',v_release.id,'counts',v_release.counts);
end
$f$;

revoke all on function public.norva_prepare_selection_shared_release(text),
 public.norva_seed_selection_shared_tags(uuid,jsonb),public.norva_publish_selection_shared_release(uuid),
 public.norva_activate_selection_shared_catalog(uuid,uuid,text,uuid,bigint,bigint,bigint,bigint) from public,anon,authenticated;
grant execute on function public.norva_prepare_selection_shared_release(text),
 public.norva_seed_selection_shared_tags(uuid,jsonb),public.norva_publish_selection_shared_release(uuid),
 public.norva_activate_selection_shared_catalog(uuid,uuid,text,uuid,bigint,bigint,bigint,bigint) to service_role;

commit;

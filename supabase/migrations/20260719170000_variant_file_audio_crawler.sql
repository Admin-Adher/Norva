-- File-scoped movie audio crawler.
--
-- A logical title may own several provider files (dub, market, platform, or
-- release variants). The former queue joined only cloud_titles.default_variant_id
-- and stamped cloud_titles.audio_probed_at after probing that one representative
-- file. Every sibling then disappeared from the queue permanently.
--
-- Candidate state now lives in cloud_title_file_language_observations, whose key
-- includes the exact variant/file. Probing variant A therefore cannot complete
-- variants B..N. Series stay excluded until their variants identify exact episode
-- files rather than a parent series id.

-- Normalize both bibliographic and terminology ISO-639-2 codes at the database
-- boundary. This also collapses historical `fr` / `fre` / `fra` observations so
-- title unions and facet counts cannot expose the same language three times.
create or replace function public.cloud_file_track_languages(p_tracks jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  select coalesce(array_agg(distinct language_code order by language_code), '{}'::text[])
  from (
    select case raw_language
      when 'alb' then 'sq' when 'sqi' then 'sq'
      when 'ara' then 'ar'
      when 'arm' then 'hy' when 'hye' then 'hy'
      when 'baq' then 'eu' when 'eus' then 'eu'
      when 'ben' then 'bn' when 'bos' then 'bs' when 'bul' then 'bg'
      when 'bur' then 'my' when 'mya' then 'my'
      when 'cat' then 'ca'
      when 'chi' then 'zh' when 'zho' then 'zh'
      when 'cze' then 'cs' when 'ces' then 'cs'
      when 'dan' then 'da'
      when 'dut' then 'nl' when 'nld' then 'nl'
      when 'eng' then 'en' when 'est' then 'et'
      when 'fil' then 'tl' when 'fin' then 'fi'
      when 'fre' then 'fr' when 'fra' then 'fr'
      when 'geo' then 'ka' when 'kat' then 'ka'
      when 'ger' then 'de' when 'deu' then 'de'
      when 'gre' then 'el' when 'ell' then 'el'
      when 'heb' then 'he' when 'hin' then 'hi' when 'hrv' then 'hr'
      when 'hun' then 'hu'
      when 'ice' then 'is' when 'isl' then 'is'
      when 'ind' then 'id' when 'ita' then 'it'
      when 'jpn' then 'ja' when 'kor' then 'ko'
      when 'lav' then 'lv' when 'lit' then 'lt'
      when 'mac' then 'mk' when 'mkd' then 'mk'
      when 'may' then 'ms' when 'msa' then 'ms'
      when 'nob' then 'no' when 'nor' then 'no'
      when 'per' then 'fa' when 'fas' then 'fa'
      when 'pol' then 'pl' when 'por' then 'pt'
      when 'rum' then 'ro' when 'ron' then 'ro'
      when 'rus' then 'ru'
      when 'slo' then 'sk' when 'slk' then 'sk'
      when 'slv' then 'sl' when 'spa' then 'es' when 'srp' then 'sr'
      when 'swe' then 'sv'
      when 'tam' then 'ta' when 'tel' then 'te' when 'tha' then 'th'
      when 'tur' then 'tr' when 'ukr' then 'uk'
      when 'urd' then 'ur' when 'vie' then 'vi'
      else raw_language
    end as language_code
    from (
      select split_part(
        replace(lower(btrim(coalesce(track->>'lang', track->>'language'))), '_', '-'),
        '-',
        1
      ) as raw_language
      from jsonb_array_elements(
        case when jsonb_typeof(p_tracks) = 'array' then p_tracks else '[]'::jsonb end
      ) tracks(track)
    ) raw
  ) canonical
  where language_code ~ '^[a-z]{2}$'
    and language_code not in ('un')
$function$;

revoke all on function public.cloud_file_track_languages(jsonb)
  from public, anon, authenticated;
grant execute on function public.cloud_file_track_languages(jsonb) to service_role;

-- Container tags are observations, not proof of the spoken language. A movie
-- enters exact-language filters and gets a certain UI label only after the
-- strict speech validator has certified every audio track in that exact file.
alter table public.cloud_title_file_language_observations
  add column if not exists audio_verified_at timestamptz,
  add column if not exists audio_verification jsonb not null default '{}'::jsonb;

create index if not exists cloud_title_file_language_observations_verified_idx
  on public.cloud_title_file_language_observations
    (user_id, title_id, audio_verified_at, variant_id);

create or replace function public.reset_cloud_file_audio_verification_on_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if new.audio_languages is distinct from old.audio_languages
     or new.audio_observed is distinct from old.audio_observed then
    new.audio_verified_at := null;
    new.audio_verification := '{}'::jsonb;
  end if;
  return new;
end
$function$;

drop trigger if exists trg_reset_cloud_file_audio_verification_on_change
  on public.cloud_title_file_language_observations;
create trigger trg_reset_cloud_file_audio_verification_on_change
before update of audio_languages, audio_observed
on public.cloud_title_file_language_observations
for each row execute function public.reset_cloud_file_audio_verification_on_change();

with normalized as (
  select
    observation.user_id,
    observation.variant_id,
    observation.file_external_id,
    public.cloud_file_track_languages(coalesce((
      select jsonb_agg(jsonb_build_object('lang', audio_language.language_code))
      from unnest(observation.audio_languages) as audio_language(language_code)
    ), '[]'::jsonb)) as audio_languages,
    public.cloud_file_track_languages(coalesce((
      select jsonb_agg(jsonb_build_object('lang', subtitle_language.language_code))
      from unnest(observation.subtitle_languages) as subtitle_language(language_code)
    ), '[]'::jsonb)) as subtitle_languages
  from public.cloud_title_file_language_observations observation
)
update public.cloud_title_file_language_observations observation
set audio_languages = normalized.audio_languages,
    subtitle_languages = normalized.subtitle_languages
from normalized
where observation.user_id = normalized.user_id
  and observation.variant_id = normalized.variant_id
  and observation.file_external_id = normalized.file_external_id
  and (
    observation.audio_languages is distinct from normalized.audio_languages
    or observation.subtitle_languages is distinct from normalized.subtitle_languages
  );

with title_keys as (
  select distinct user_id, title_id
  from public.cloud_title_file_language_observations
),
unions as (
  select
    key.user_id,
    key.title_id,
    coalesce((
      select array_agg(distinct audio_language.language_code order by audio_language.language_code)
      from public.cloud_title_file_language_observations observation
      cross join lateral unnest(observation.audio_languages) as audio_language(language_code)
      where observation.user_id = key.user_id
        and observation.title_id = key.title_id
        and observation.audio_observed
        and observation.audio_verified_at is not null
    ), '{}'::text[]) as audio_languages,
    coalesce((
      select array_agg(distinct subtitle_language.language_code order by subtitle_language.language_code)
      from public.cloud_title_file_language_observations observation
      cross join lateral unnest(observation.subtitle_languages) as subtitle_language(language_code)
      where observation.user_id = key.user_id
        and observation.title_id = key.title_id
        and observation.subtitle_observed
    ), '{}'::text[]) as subtitle_languages
  from title_keys key
)
update public.cloud_titles title
set file_audio_languages = unions.audio_languages,
    file_subtitle_languages = unions.subtitle_languages
from unions
where title.user_id = unions.user_id
  and title.id = unions.title_id
  and (
    title.file_audio_languages is distinct from unions.audio_languages
    or title.file_subtitle_languages is distinct from unions.subtitle_languages
  );

-- Replace the original observation-union helper: subtitle presence remains a
-- container fact, while audio language facets contain strict speech-verified
-- files only. This is what prevents a mistagged "French" container from
-- appearing in the French filter before Whisper has validated it.
create or replace function public.recompute_cloud_title_file_languages(
  p_user_id uuid,
  p_title_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_audio text[] := '{}'::text[];
  v_subtitles text[] := '{}'::text[];
  v_item_type text;
begin
  if p_user_id is null or p_title_id is null then return false; end if;

  perform 1
  from public.cloud_titles title
  where title.user_id = p_user_id
    and title.id = p_title_id
  for update;
  if not found then return false; end if;

  select coalesce(array_agg(distinct language_code order by language_code), '{}'::text[])
    into v_audio
  from public.cloud_title_file_language_observations observation
  join public.cloud_title_variants variant
    on variant.id = observation.variant_id
   and variant.user_id = observation.user_id
   and variant.title_id = observation.title_id
  cross join lateral unnest(observation.audio_languages) as language_code
  where observation.user_id = p_user_id
    and observation.title_id = p_title_id
    and observation.audio_observed
    and observation.audio_verified_at is not null;

  select coalesce(array_agg(distinct language_code order by language_code), '{}'::text[])
    into v_subtitles
  from public.cloud_title_file_language_observations observation
  join public.cloud_title_variants variant
    on variant.id = observation.variant_id
   and variant.user_id = observation.user_id
   and variant.title_id = observation.title_id
  cross join lateral unnest(observation.subtitle_languages) as language_code
  where observation.user_id = p_user_id
    and observation.title_id = p_title_id
    and observation.subtitle_observed;

  update public.cloud_titles title
     set file_audio_languages = v_audio,
         file_subtitle_languages = v_subtitles
   where title.user_id = p_user_id
     and title.id = p_title_id
     and (
       title.file_audio_languages is distinct from v_audio
       or title.file_subtitle_languages is distinct from v_subtitles
     )
  returning title.item_type into v_item_type;

  if v_item_type is not null then
    update public.cloud_catalog_facet_summary
       set refreshed_at = 'epoch'::timestamptz
     where user_id = p_user_id
       and item_type = v_item_type;
  end if;
  return true;
end
$function$;

revoke all on function public.recompute_cloud_title_file_languages(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.recompute_cloud_title_file_languages(uuid, uuid)
  to service_role;

create or replace function public.file_audio_backfill_candidates(
  p_user uuid,
  p_source uuid default null,
  p_item_type text default 'movie',
  p_target text default 'audio',
  p_require_tags text[] default null,
  p_untagged_only boolean default false,
  p_limit int default 25
) returns table(
  id uuid,
  default_variant_id uuid,
  provider_tmdb_id text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    title.id,
    variant.id as default_variant_id,
    title.provider_tmdb_id
  from public.cloud_title_variants variant
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  left join public.cloud_title_file_language_observations observation
    on observation.user_id = variant.user_id
   and observation.title_id = variant.title_id
   and observation.variant_id = variant.id
   and observation.file_external_id = variant.external_id
  where p_item_type = 'movie'
    and variant.item_type = 'movie'
    and variant.user_id = p_user
    and variant.title_id is not null
    and coalesce(btrim(variant.external_id), '') <> ''
    and (p_source is null or variant.source_id = p_source)
    and (
      case
        when p_target = 'subtitle' then
          not coalesce(observation.subtitle_observed, false)
        else
          not coalesce(observation.audio_observed, false)
          or observation.updated_at < now() - interval '180 days'
      end
    )
    and (
      not coalesce(p_untagged_only, false)
      or title.version_languages = '{}'::text[]
    )
    and (
      p_require_tags is null
      or coalesce(cardinality(p_require_tags), 0) = 0
      or title.version_languages && p_require_tags
    )
  order by title.release_year desc nulls last, title.id, variant.id
  limit greatest(1, least(300, coalesce(p_limit, 25)))
$function$;

comment on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, int
) is
  'Exact movie-file candidates for norva-playback audio/subtitle probing. '
  'Returns one row per unfinished variant; completing one observation never '
  'removes sibling variants from the queue.';

revoke all on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, int
) from public, anon, authenticated;
grant execute on function public.file_audio_backfill_candidates(
  uuid, uuid, text, text, text[], boolean, int
) to service_role;

-- Whisper attempts also belong to the exact movie variant. Keeping this marker
-- on cloud_titles would let one silent/pending sibling suppress every other file.
alter table public.cloud_title_variants
  add column if not exists audio_whisper_attempted_at timestamptz,
  add column if not exists audio_whisper_retry_at timestamptz,
  add column if not exists audio_lang_verified_at timestamptz,
  add column if not exists audio_lang_verify_retry_at timestamptz;

-- Speech verification is a property of the canonical provider file, not of the
-- tenant who happened to analyse it first. Reuse this timestamp and provenance
-- for every current/future owner until the 90-day recheck window expires.
alter table public.catalog_file_tracks
  add column if not exists audio_whisper_attempted_at timestamptz,
  add column if not exists audio_whisper_retry_at timestamptz,
  add column if not exists audio_whisper_verification jsonb not null default '{}'::jsonb,
  add column if not exists audio_lang_verified_at timestamptz,
  add column if not exists audio_lang_retry_at timestamptz,
  add column if not exists audio_lang_verification jsonb not null default '{}'::jsonb;

create or replace function public.catalog_audio_track_indexes(p_tracks jsonb)
returns integer[]
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  select coalesce(array_agg(distinct stream_index order by stream_index), '{}'::integer[])
  from (
    select (track->>'index')::integer as stream_index
    from jsonb_array_elements(
      case when jsonb_typeof(p_tracks) = 'array' then p_tracks else '[]'::jsonb end
    ) tracks(track)
    where coalesce(track->>'index', '') ~ '^[0-9]+$'
  ) indexed
$function$;

revoke all on function public.catalog_audio_track_indexes(jsonb)
  from public, anon, authenticated;
grant execute on function public.catalog_audio_track_indexes(jsonb) to service_role;

-- A later raw ffprobe must never overwrite a speech-certified correction with
-- the container's original bad tag. Preserve a verified ordered map while the
-- stable stream-index structure is unchanged. A genuine structural change
-- invalidates the certificate and accepts the new raw map.
create or replace function public.upsert_catalog_file_tracks(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_audio_tracks jsonb,
  p_subtitle_tracks jsonb,
  p_has_audio boolean,
  p_has_subtitle boolean
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if coalesce(btrim(p_server_host), '') = ''
     or coalesce(btrim(p_external_id), '') = ''
     or p_item_type not in ('movie', 'series') then
    return;
  end if;

  insert into public.catalog_file_tracks as cache (
    server_host, item_type, external_id,
    audio_tracks, subtitle_tracks,
    audio_probed_at, subtitle_probed_at, updated_at
  ) values (
    p_server_host,
    p_item_type,
    p_external_id,
    case when p_has_audio then coalesce(p_audio_tracks, '[]'::jsonb) else '[]'::jsonb end,
    case when p_has_subtitle then coalesce(p_subtitle_tracks, '[]'::jsonb) else '[]'::jsonb end,
    case when p_has_audio then clock_timestamp() else null end,
    case when p_has_subtitle then clock_timestamp() else null end,
    clock_timestamp()
  )
  on conflict (server_host, item_type, external_id) do update set
    audio_lang_verified_at = case
      when p_has_audio
       and public.catalog_audio_track_indexes(cache.audio_tracks)
           is distinct from public.catalog_audio_track_indexes(coalesce(p_audio_tracks, '[]'::jsonb))
        then null
      else cache.audio_lang_verified_at
    end,
    audio_lang_verification = case
      when p_has_audio
       and public.catalog_audio_track_indexes(cache.audio_tracks)
           is distinct from public.catalog_audio_track_indexes(coalesce(p_audio_tracks, '[]'::jsonb))
        then '{}'::jsonb
      else cache.audio_lang_verification
    end,
    audio_tracks = case
      when p_has_audio
       and (
         cache.audio_lang_verified_at is not null
         or cache.audio_lang_verification->>'status' in ('validating', 'pending')
       )
       and public.catalog_audio_track_indexes(cache.audio_tracks)
           = public.catalog_audio_track_indexes(coalesce(p_audio_tracks, '[]'::jsonb))
        then cache.audio_tracks
      when p_has_audio then coalesce(p_audio_tracks, '[]'::jsonb)
      else cache.audio_tracks
    end,
    subtitle_tracks = case
      when p_has_subtitle then coalesce(p_subtitle_tracks, '[]'::jsonb)
      else cache.subtitle_tracks
    end,
    audio_probed_at = case
      when p_has_audio then clock_timestamp()
      else cache.audio_probed_at
    end,
    subtitle_probed_at = case
      when p_has_subtitle then clock_timestamp()
      else cache.subtitle_probed_at
    end,
    updated_at = clock_timestamp();
end
$function$;

revoke all on function public.upsert_catalog_file_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.upsert_catalog_file_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

-- Dedicated write path for strict LID work. Unlike a raw ffprobe, this is
-- allowed to replace a previously certified language by stream index. It
-- clears the old certificate until record_catalog_file_audio_verification()
-- certifies the complete file in the same validation workflow.
create or replace function public.upsert_catalog_file_validated_tracks(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_audio_tracks jsonb,
  p_subtitle_tracks jsonb,
  p_has_audio boolean,
  p_has_subtitle boolean
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if coalesce(btrim(p_server_host), '') = ''
     or coalesce(btrim(p_external_id), '') = ''
     or p_item_type is distinct from 'movie' then
    return;
  end if;

  insert into public.catalog_file_tracks as cache (
    server_host, item_type, external_id,
    audio_tracks, subtitle_tracks,
    audio_probed_at, subtitle_probed_at,
    audio_lang_verified_at, audio_lang_verification,
    updated_at
  ) values (
    p_server_host,
    p_item_type,
    p_external_id,
    case when p_has_audio then coalesce(p_audio_tracks, '[]'::jsonb) else '[]'::jsonb end,
    case when p_has_subtitle then coalesce(p_subtitle_tracks, '[]'::jsonb) else '[]'::jsonb end,
    case when p_has_audio then clock_timestamp() else null end,
    case when p_has_subtitle then clock_timestamp() else null end,
    null,
    jsonb_build_object(
      'status', 'validating',
      'method', 'whisper-strict-consensus-v4',
      'startedAt', clock_timestamp()
    ),
    clock_timestamp()
  )
  on conflict (server_host, item_type, external_id) do update set
    audio_tracks = case
      when p_has_audio then coalesce(p_audio_tracks, '[]'::jsonb)
      else cache.audio_tracks
    end,
    subtitle_tracks = case
      when p_has_subtitle then coalesce(p_subtitle_tracks, '[]'::jsonb)
      else cache.subtitle_tracks
    end,
    audio_probed_at = case
      when p_has_audio then clock_timestamp()
      else cache.audio_probed_at
    end,
    subtitle_probed_at = case
      when p_has_subtitle then clock_timestamp()
      else cache.subtitle_probed_at
    end,
    audio_lang_verified_at = case
      when p_has_audio then null
      else cache.audio_lang_verified_at
    end,
    audio_lang_verification = case
      when p_has_audio then jsonb_build_object(
        'status', 'validating',
        'method', 'whisper-strict-consensus-v4',
        'startedAt', clock_timestamp()
      )
      else cache.audio_lang_verification
    end,
    updated_at = clock_timestamp();
end
$function$;

revoke all on function public.upsert_catalog_file_validated_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.upsert_catalog_file_validated_tracks(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

-- Tenant-exact certainty marker. The edge always calls this in addition to the
-- canonical cache marker; migration 180 extends the canonical RPC with secure
-- cross-owner fanout through server-written provider identities.
create or replace function public.mark_cloud_title_file_audio_verification(
  p_user_id uuid,
  p_variant_id uuid,
  p_file_external_id text,
  p_verified boolean,
  p_verified_at timestamptz default now(),
  p_provenance jsonb default '{}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_title_id uuid;
  v_changed integer := 0;
begin
  select variant.title_id
    into v_title_id
  from public.cloud_title_variants variant
  where variant.user_id = p_user_id
    and variant.id = p_variant_id
    and variant.item_type = 'movie'
    and variant.external_id = p_file_external_id
    and variant.title_id is not null;
  if not found then return false; end if;

  update public.cloud_title_file_language_observations observation
     set audio_verified_at = case
           when coalesce(p_verified, false)
             and observation.audio_observed
             and cardinality(observation.audio_languages) > 0
             then coalesce(p_verified_at, clock_timestamp())
           else null
         end,
         audio_verification = coalesce(p_provenance, '{}'::jsonb),
         updated_at = clock_timestamp()
   where observation.user_id = p_user_id
     and observation.title_id = v_title_id
     and observation.variant_id = p_variant_id
     and observation.file_external_id = p_file_external_id;
  get diagnostics v_changed = row_count;

  update public.cloud_title_variants variant
     set audio_lang_verified_at = case
           when coalesce(p_verified, false) then coalesce(p_verified_at, clock_timestamp())
           else null
         end,
         audio_lang_verify_retry_at = case
           when coalesce(p_verified, false) then null
           else clock_timestamp() + interval '1 day'
         end
   where variant.user_id = p_user_id
     and variant.id = p_variant_id;

  perform public.recompute_cloud_title_file_languages(p_user_id, v_title_id);
  return v_changed = 1;
end
$function$;

revoke all on function public.mark_cloud_title_file_audio_verification(
  uuid, uuid, text, boolean, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.mark_cloud_title_file_audio_verification(
  uuid, uuid, text, boolean, timestamptz, jsonb
) to service_role;

create or replace function public.record_catalog_file_audio_verification(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_verified boolean,
  p_verified_at timestamptz default now(),
  p_retry_at timestamptz default null,
  p_provenance jsonb default '{"method":"whisper-strict-consensus-v4","consensus":4}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  changed integer := 0;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type is distinct from 'movie'
     or coalesce(btrim(p_external_id), '') = '' then
    return false;
  end if;

  update public.catalog_file_tracks cache
     set audio_lang_verified_at = case
           when coalesce(p_verified, false)
             then coalesce(p_verified_at, clock_timestamp())
           else null
         end,
         audio_lang_retry_at = case
           when coalesce(p_verified, false) then null
           else coalesce(p_retry_at, clock_timestamp() + interval '1 day')
         end,
         audio_lang_verification = coalesce(p_provenance, '{}'::jsonb),
         updated_at = clock_timestamp()
   where cache.server_host = p_server_host
     and cache.item_type = p_item_type
     and cache.external_id = p_external_id;
  get diagnostics changed = row_count;
  return changed = 1;
end
$function$;

revoke all on function public.record_catalog_file_audio_verification(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_catalog_file_audio_verification(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) to service_role;

create or replace function public.record_catalog_file_audio_whisper_outcome(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_completed boolean,
  p_attempted_at timestamptz default now(),
  p_retry_at timestamptz default null,
  p_provenance jsonb default '{"method":"whisper-strict-consensus-v4","consensus":4}'::jsonb
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  changed integer := 0;
begin
  if coalesce(btrim(p_server_host), '') = ''
     or p_item_type is distinct from 'movie'
     or coalesce(btrim(p_external_id), '') = '' then
    return false;
  end if;

  update public.catalog_file_tracks cache
     set audio_whisper_attempted_at = case
           when coalesce(p_completed, false)
             then coalesce(p_attempted_at, clock_timestamp())
           else cache.audio_whisper_attempted_at
         end,
         audio_whisper_retry_at = case
           when coalesce(p_completed, false) then null
           else coalesce(p_retry_at, clock_timestamp() + interval '1 day')
         end,
         audio_whisper_verification = coalesce(p_provenance, '{}'::jsonb),
         updated_at = clock_timestamp()
   where cache.server_host = p_server_host
     and cache.item_type = p_item_type
     and cache.external_id = p_external_id;
  get diagnostics changed = row_count;
  return changed = 1;
end
$function$;

revoke all on function public.record_catalog_file_audio_whisper_outcome(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_catalog_file_audio_whisper_outcome(
  text, text, text, boolean, timestamptz, timestamptz, jsonb
) to service_role;

create index if not exists cloud_title_variants_file_whisper_queue_idx
  on public.cloud_title_variants (
    user_id,
    source_id,
    audio_whisper_attempted_at,
    audio_whisper_retry_at,
    title_id,
    id
  )
  where item_type = 'movie';

create index if not exists cloud_title_variants_file_verify_queue_idx
  on public.cloud_title_variants (
    user_id,
    source_id,
    audio_lang_verified_at,
    audio_lang_verify_retry_at,
    title_id,
    id
  )
  where item_type = 'movie';

create or replace function public.file_audio_tag_suspect_variants(
  p_user uuid,
  p_source uuid default null,
  p_limit int default 4,
  p_retry_before timestamptz default now() - interval '90 days',
  p_title_ids uuid[] default null
) returns table(
  id uuid,
  default_variant_id uuid,
  provider_tmdb_id text,
  audio_tracks jsonb,
  audio_languages text[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  with candidates as (
    select
      title.id,
      variant.id as default_variant_id,
      title.provider_tmdb_id,
      file_tracks.audio_tracks,
      public.cloud_file_track_languages(file_tracks.audio_tracks) as audio_languages,
      coalesce(nullif(variant.raw_title, ''), title.title, '') as release_name,
      greatest(
        variant.audio_lang_verified_at,
        file_tracks.audio_lang_verified_at
      ) as audio_lang_verified_at,
      greatest(
        variant.audio_lang_verify_retry_at,
        file_tracks.audio_lang_retry_at
      ) as audio_lang_retry_at
    from public.cloud_title_variants variant
    join public.cloud_titles title
      on title.id = variant.title_id
     and title.user_id = variant.user_id
     and title.item_type = variant.item_type
    join public.cloud_sources source
      on source.id = variant.source_id
     and source.user_id = variant.user_id
     and source.deleted_at is null
    left join public.catalog_provider_identities identity
      on identity.provider_key = coalesce(
        source.config_hint->>'providerKey',
        source.config_hint->>'serverHost'
      )
    join lateral (
      select
        cached.audio_tracks,
        cached.audio_lang_verified_at,
        cached.audio_lang_retry_at
      from public.catalog_file_tracks cached
      where cached.item_type = 'movie'
        and cached.external_id = variant.external_id
        and cached.audio_probed_at is not null
        and (
          cached.server_host = identity.identity_id::text
          or cached.server_host = source.config_hint->>'providerKey'
          or cached.server_host = source.config_hint->>'serverHost'
        )
      order by
        case
          when cached.server_host = identity.identity_id::text then 0
          when cached.server_host = source.config_hint->>'providerKey' then 1
          else 2
        end,
        cached.updated_at desc
      limit 1
    ) file_tracks on true
    where variant.user_id = p_user
      and variant.item_type = 'movie'
      and variant.title_id is not null
      and (p_source is null or variant.source_id = p_source)
      and (p_title_ids is null or title.id = any(p_title_ids))
  )
  select
    candidate.id,
    candidate.default_variant_id,
    candidate.provider_tmdb_id,
    candidate.audio_tracks,
    candidate.audio_languages
  from candidates candidate
  where cardinality(candidate.audio_languages) > 0
    and (
      candidate.audio_lang_verified_at is null
      or candidate.audio_lang_verified_at < p_retry_before
    )
    and (
      candidate.audio_lang_retry_at is null
      or candidate.audio_lang_retry_at <= now()
    )
  order by
    (
      cardinality(candidate.audio_languages) = 1
      and not candidate.audio_languages @> array['fr']
      and candidate.release_name !~* 'french'
    ) desc,
    candidate.id,
    candidate.default_variant_id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.file_audio_tag_suspect_variants(
  uuid, uuid, int, timestamptz, uuid[]
) from public, anon, authenticated;
grant execute on function public.file_audio_tag_suspect_variants(
  uuid, uuid, int, timestamptz, uuid[]
) to service_role;

create or replace function public.file_whisper_candidate_variants(
  p_user uuid,
  p_source uuid default null,
  p_limit int default 4,
  p_retry_before timestamptz default now() - interval '30 days'
) returns table(
  id uuid,
  default_variant_id uuid,
  provider_tmdb_id text,
  audio_tracks jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select
    title.id,
    variant.id as default_variant_id,
    title.provider_tmdb_id,
    file_tracks.audio_tracks
  from public.cloud_title_variants variant
  join public.cloud_titles title
    on title.id = variant.title_id
   and title.user_id = variant.user_id
   and title.item_type = variant.item_type
  join public.cloud_sources source
    on source.id = variant.source_id
   and source.user_id = variant.user_id
   and source.deleted_at is null
  left join public.catalog_provider_identities identity
    on identity.provider_key = coalesce(
      source.config_hint->>'providerKey',
      source.config_hint->>'serverHost'
    )
  join lateral (
    select
      cached.audio_tracks,
      cached.audio_whisper_attempted_at,
      cached.audio_whisper_retry_at
    from public.catalog_file_tracks cached
    where cached.item_type = 'movie'
      and cached.external_id = variant.external_id
      and cached.audio_probed_at is not null
      and (
        cached.server_host = identity.identity_id::text
        or cached.server_host = source.config_hint->>'providerKey'
        or cached.server_host = source.config_hint->>'serverHost'
      )
    order by
      case
        when cached.server_host = identity.identity_id::text then 0
        when cached.server_host = source.config_hint->>'providerKey' then 1
        else 2
      end,
      cached.updated_at desc
    limit 1
  ) file_tracks on true
  where variant.user_id = p_user
    and variant.item_type = 'movie'
    and variant.title_id is not null
    and (p_source is null or variant.source_id = p_source)
    and (
      greatest(
        variant.audio_whisper_attempted_at,
        file_tracks.audio_whisper_attempted_at
      ) is null
      or greatest(
        variant.audio_whisper_attempted_at,
        file_tracks.audio_whisper_attempted_at
      ) < p_retry_before
    )
    and (
      greatest(
        variant.audio_whisper_retry_at,
        file_tracks.audio_whisper_retry_at
      ) is null
      or greatest(
        variant.audio_whisper_retry_at,
        file_tracks.audio_whisper_retry_at
      ) <= now()
    )
    and exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(file_tracks.audio_tracks) = 'array'
            then file_tracks.audio_tracks
          else '[]'::jsonb
        end
      ) track
      where coalesce(
        nullif(lower(btrim(coalesce(track->>'lang', track->>'language'))), ''),
        'und'
      ) in ('und', 'un', 'mis', 'mul', 'zxx', 'nar')
    )
  order by title.release_year desc nulls last, title.id, variant.id
  limit greatest(1, least(100, coalesce(p_limit, 4)))
$function$;

revoke all on function public.file_whisper_candidate_variants(
  uuid, uuid, int, timestamptz
) from public, anon, authenticated;
grant execute on function public.file_whisper_candidate_variants(
  uuid, uuid, int, timestamptz
) to service_role;

-- A short distributed lease complements the viewer busy-lock. Busy activity
-- protects a human stream; this lease prevents two autonomous workers/crons from
-- probing the same canonical provider identity concurrently.
create table if not exists public.provider_file_probe_leases (
  identity_key text primary key,
  lease_owner text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (coalesce(btrim(identity_key), '') <> ''),
  check (coalesce(btrim(lease_owner), '') <> ''),
  check (length(identity_key) <= 300),
  check (length(lease_owner) <= 200)
);

alter table public.provider_file_probe_leases enable row level security;
revoke all on table public.provider_file_probe_leases
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.provider_file_probe_leases to service_role;

create or replace function public.claim_provider_file_probe(
  p_identity_key text,
  p_lease_owner text,
  p_ttl_seconds int default 150
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_claimed boolean := false;
  v_ttl int := greatest(30, least(900, coalesce(p_ttl_seconds, 150)));
begin
  if coalesce(btrim(p_identity_key), '') = ''
     or coalesce(btrim(p_lease_owner), '') = ''
     or length(p_identity_key) > 300
     or length(p_lease_owner) > 200 then
    return false;
  end if;

  insert into public.provider_file_probe_leases as lease (
    identity_key, lease_owner, expires_at, updated_at
  ) values (
    p_identity_key, p_lease_owner, clock_timestamp() + make_interval(secs => v_ttl),
    clock_timestamp()
  )
  on conflict (identity_key) do update
     set lease_owner = excluded.lease_owner,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at
   where lease.expires_at <= clock_timestamp()
      or lease.lease_owner = excluded.lease_owner
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end
$function$;

create or replace function public.release_provider_file_probe(
  p_identity_key text,
  p_lease_owner text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_count int := 0;
begin
  delete from public.provider_file_probe_leases
  where identity_key = p_identity_key
    and lease_owner = p_lease_owner;
  get diagnostics v_count = row_count;
  return v_count > 0;
end
$function$;

revoke all on function public.claim_provider_file_probe(text, text, int)
  from public, anon, authenticated;
revoke all on function public.release_provider_file_probe(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_provider_file_probe(text, text, int)
  to service_role;
grant execute on function public.release_provider_file_probe(text, text)
  to service_role;

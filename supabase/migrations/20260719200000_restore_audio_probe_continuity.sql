-- Restore the exact-file probe catalogue without weakening speech verification.
--
-- Migration 20260719170000 reused file_audio_languages as a strict-only union.
-- That erased 91k+ already-probed provider files from language facets while the
-- new Whisper verifier started from an intentionally empty proof ledger. Probe
-- evidence and speech proof are different facts and must have different fields:
--   * file_audio_languages          = exact-file ffprobe/container observations
--   * file_audio_verified_languages = the subset certified/corrected by Whisper

begin;

alter table public.cloud_titles
  add column if not exists file_audio_verified_languages text[] not null default '{}'::text[];

comment on column public.cloud_titles.file_audio_languages is
  'Union of exact owned provider-file audio languages observed by ffprobe/container metadata.';
comment on column public.cloud_titles.file_audio_verified_languages is
  'Subset of exact owned provider-file audio languages certified or corrected by speech validation.';

-- Release ALTER TABLE's ACCESS EXCLUSIVE lock before the historical rebuild.
-- The verified subset is not queried as a facet, so it intentionally has no
-- GIN index; maintaining one during the rebuild would add write load for no
-- current read path.
commit;

begin;

-- Preserve safely mappable historical Whisper validations. The legacy marker was
-- title-scoped. A matching language set alone cannot identify one file among a
-- grouped title, so only the exact default variant is eligible.
with legacy_titles as (
  select
    title.user_id,
    title.id as title_id,
    title.default_variant_id,
    title.audio_lang_verified_at,
    public.cloud_file_track_languages(title.audio_tracks) as verified_languages
  from public.cloud_titles title
  where title.item_type = 'movie'
    and title.audio_lang_verified_at is not null
), matching_observations as (
  select
    legacy.user_id,
    legacy.title_id,
    legacy.default_variant_id,
    legacy.audio_lang_verified_at,
    observation.variant_id,
    observation.file_external_id
  from legacy_titles legacy
  join public.cloud_title_file_language_observations observation
    on observation.user_id = legacy.user_id
   and observation.title_id = legacy.title_id
   and observation.audio_observed
   and cardinality(observation.audio_languages) > 0
   and observation.audio_languages = legacy.verified_languages
), safe_promotions as (
  select distinct on (user_id, title_id)
    user_id,
    title_id,
    variant_id,
    file_external_id,
    audio_lang_verified_at
  from matching_observations
  where variant_id = default_variant_id
  order by
    user_id,
    title_id,
    (variant_id = default_variant_id) desc,
    variant_id
)
update public.cloud_title_file_language_observations observation
   set audio_verified_at = coalesce(observation.audio_verified_at, promotion.audio_lang_verified_at),
       audio_verification = case
         when observation.audio_verified_at is not null then observation.audio_verification
         else jsonb_build_object(
           'status', 'verified',
           'method', 'legacy-whisper-title-consensus',
           'migratedAt', clock_timestamp(),
           'sourceVerifiedAt', promotion.audio_lang_verified_at
         )
       end,
       updated_at = clock_timestamp()
  from safe_promotions promotion
 where observation.user_id = promotion.user_id
   and observation.title_id = promotion.title_id
   and observation.variant_id = promotion.variant_id
   and observation.file_external_id = promotion.file_external_id;

-- Keep the variant scheduler from immediately redoing safely promoted work.
update public.cloud_title_variants variant
   set audio_lang_verified_at = observation.audio_verified_at,
       audio_lang_verify_retry_at = null
  from public.cloud_title_file_language_observations observation
 where observation.user_id = variant.user_id
   and observation.variant_id = variant.id
   and observation.file_external_id = variant.external_id
   and observation.audio_verified_at is not null
   and variant.audio_lang_verified_at is distinct from observation.audio_verified_at;

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
  v_verified_audio text[] := '{}'::text[];
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
    and observation.audio_observed;

  select coalesce(array_agg(distinct language_code order by language_code), '{}'::text[])
    into v_verified_audio
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
         file_audio_verified_languages = v_verified_audio,
         file_subtitle_languages = v_subtitles
   where title.user_id = p_user_id
     and title.id = p_title_id
     and (
       title.file_audio_languages is distinct from v_audio
       or title.file_audio_verified_languages is distinct from v_verified_audio
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

-- One set-based rebuild restores every current account and also clears stale
-- unions for titles whose exact observation disappeared.
with affected_titles as (
  select observation.user_id, observation.title_id
  from public.cloud_title_file_language_observations observation
  union
  select title.user_id, title.id
  from public.cloud_titles title
  where cardinality(title.file_audio_languages) > 0
     or cardinality(title.file_audio_verified_languages) > 0
     or cardinality(title.file_subtitle_languages) > 0
), audio_unions as (
  select
    observation.user_id,
    observation.title_id,
    array_agg(distinct language_code order by language_code) as languages
  from public.cloud_title_file_language_observations observation
  join public.cloud_title_variants variant
    on variant.id = observation.variant_id
   and variant.user_id = observation.user_id
   and variant.title_id = observation.title_id
  cross join lateral unnest(observation.audio_languages) as language_code
  where observation.audio_observed
  group by observation.user_id, observation.title_id
), verified_audio_unions as (
  select
    observation.user_id,
    observation.title_id,
    array_agg(distinct language_code order by language_code) as languages
  from public.cloud_title_file_language_observations observation
  join public.cloud_title_variants variant
    on variant.id = observation.variant_id
   and variant.user_id = observation.user_id
   and variant.title_id = observation.title_id
  cross join lateral unnest(observation.audio_languages) as language_code
  where observation.audio_observed
    and observation.audio_verified_at is not null
  group by observation.user_id, observation.title_id
), subtitle_unions as (
  select
    observation.user_id,
    observation.title_id,
    array_agg(distinct language_code order by language_code) as languages
  from public.cloud_title_file_language_observations observation
  join public.cloud_title_variants variant
    on variant.id = observation.variant_id
   and variant.user_id = observation.user_id
   and variant.title_id = observation.title_id
  cross join lateral unnest(observation.subtitle_languages) as language_code
  where observation.subtitle_observed
  group by observation.user_id, observation.title_id
), recomputed as (
  select
    affected.user_id,
    affected.title_id,
    coalesce(audio.languages, '{}'::text[]) as audio_languages,
    coalesce(verified.languages, '{}'::text[]) as verified_audio_languages,
    coalesce(subtitles.languages, '{}'::text[]) as subtitle_languages
  from affected_titles affected
  left join audio_unions audio
    on audio.user_id = affected.user_id
   and audio.title_id = affected.title_id
  left join verified_audio_unions verified
    on verified.user_id = affected.user_id
   and verified.title_id = affected.title_id
  left join subtitle_unions subtitles
    on subtitles.user_id = affected.user_id
   and subtitles.title_id = affected.title_id
)
update public.cloud_titles title
   set file_audio_languages = recomputed.audio_languages,
       file_audio_verified_languages = recomputed.verified_audio_languages,
       file_subtitle_languages = recomputed.subtitle_languages
  from recomputed
 where title.user_id = recomputed.user_id
   and title.id = recomputed.title_id
   and (
     title.file_audio_languages is distinct from recomputed.audio_languages
     or title.file_audio_verified_languages is distinct from recomputed.verified_audio_languages
     or title.file_subtitle_languages is distinct from recomputed.subtitle_languages
   );

-- A deployment must fail instead of silently collapsing a user's facets again.
do $function$
declare
  v_expected bigint;
  v_actual bigint;
  v_invalid_verified bigint;
begin
  select count(distinct (observation.user_id, observation.title_id))
    into v_expected
  from public.cloud_title_file_language_observations observation
  join public.cloud_titles title
    on title.user_id = observation.user_id
   and title.id = observation.title_id
  where observation.audio_observed
    and cardinality(observation.audio_languages) > 0
    and title.variant_count > 0;

  select count(*)
    into v_actual
  from public.cloud_titles title
  where title.variant_count > 0
    and cardinality(title.file_audio_languages) > 0;

  select count(*)
    into v_invalid_verified
  from public.cloud_titles title
  where not title.file_audio_verified_languages <@ title.file_audio_languages;

  if v_actual <> v_expected then
    raise exception
      'Audio facet continuity check failed: expected % titles, rebuilt %',
      v_expected, v_actual;
  end if;
  if v_invalid_verified > 0 then
    raise exception
      'Audio verification integrity check failed: % strict unions exceed probe unions',
      v_invalid_verified;
  end if;
end
$function$;

update public.cloud_catalog_facet_summary
   set refreshed_at = 'epoch'::timestamptz;

commit;

-- Exact, non-monotone per-file language evidence for tenant VOD catalogs.
--
-- Absolute track indexes belong to one provider file, while a logical title may
-- own many files (or, for a series, many episode files behind one parent variant).
-- Persist every observed file separately, then derive title filter/facet arrays
-- from the observations that are still attached to an owned variant.

alter table public.cloud_titles
  add column if not exists file_audio_languages text[] not null default '{}'::text[],
  add column if not exists file_subtitle_languages text[] not null default '{}'::text[];

create index if not exists cloud_titles_file_audio_languages_gin
  on public.cloud_titles using gin (file_audio_languages);
create index if not exists cloud_titles_file_subtitle_languages_gin
  on public.cloud_titles using gin (file_subtitle_languages);

-- Composite unique indexes let the observation FKs enforce tenant + title
-- consistency, rather than relying only on globally unique UUIDs.
create unique index if not exists cloud_titles_user_id_id_uidx
  on public.cloud_titles (user_id, id);
create unique index if not exists cloud_title_variants_user_title_id_id_uidx
  on public.cloud_title_variants (user_id, title_id, id);

create table if not exists public.cloud_title_file_language_observations (
  user_id uuid not null,
  title_id uuid not null,
  variant_id uuid not null,
  file_external_id text not null check (btrim(file_external_id) <> ''),
  audio_languages text[] not null default '{}'::text[],
  subtitle_languages text[] not null default '{}'::text[],
  audio_observed boolean not null default false,
  subtitle_observed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, variant_id, file_external_id),
  constraint cloud_title_file_language_observations_title_fk
    foreign key (user_id, title_id)
    references public.cloud_titles (user_id, id)
    on update cascade on delete cascade,
  constraint cloud_title_file_language_observations_variant_fk
    foreign key (user_id, title_id, variant_id)
    references public.cloud_title_variants (user_id, title_id, id)
    on update cascade on delete cascade,
  constraint cloud_title_file_language_observations_audio_state_ck
    check (audio_observed or cardinality(audio_languages) = 0),
  constraint cloud_title_file_language_observations_subtitle_state_ck
    check (subtitle_observed or cardinality(subtitle_languages) = 0)
);

create index if not exists cloud_title_file_language_observations_title_idx
  on public.cloud_title_file_language_observations (user_id, title_id);

alter table public.cloud_title_file_language_observations enable row level security;
revoke all on table public.cloud_title_file_language_observations
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.cloud_title_file_language_observations to service_role;

drop trigger if exists trg_cloud_title_file_language_observations_updated_at
  on public.cloud_title_file_language_observations;
create trigger trg_cloud_title_file_language_observations_updated_at
before update on public.cloud_title_file_language_observations
for each row execute function public.norva_set_updated_at();

-- One canonical language parser for every write path. Empty observed results are
-- meaningful: they replace prior evidence and therefore remove stale languages.
create or replace function public.cloud_file_track_languages(p_tracks jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  select coalesce(array_agg(language_code order by language_code), '{}'::text[])
  from (
    select distinct lower(btrim(coalesce(track->>'lang', track->>'language'))) as language_code
    from jsonb_array_elements(
      case when jsonb_typeof(p_tracks) = 'array' then p_tracks else '[]'::jsonb end
    ) as tracks(track)
  ) normalized
  where language_code ~ '^[a-z]{2,3}$'
    and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
$function$;

revoke all on function public.cloud_file_track_languages(jsonb)
  from public, anon, authenticated;
grant execute on function public.cloud_file_track_languages(jsonb) to service_role;

-- Serialize recomputations on the title row. This prevents two concurrent file
-- probes from each publishing a union that omits the other's uncommitted write.
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
  from public.cloud_titles t
  where t.user_id = p_user_id and t.id = p_title_id
  for update;
  if not found then return false; end if;

  select coalesce(array_agg(distinct language_code order by language_code), '{}'::text[])
    into v_audio
  from public.cloud_title_file_language_observations o
  join public.cloud_title_variants v
    on v.id = o.variant_id
   and v.user_id = o.user_id
   and v.title_id = o.title_id
  cross join lateral unnest(o.audio_languages) as language_code
  where o.user_id = p_user_id
    and o.title_id = p_title_id
    and o.audio_observed;

  select coalesce(array_agg(distinct language_code order by language_code), '{}'::text[])
    into v_subtitles
  from public.cloud_title_file_language_observations o
  join public.cloud_title_variants v
    on v.id = o.variant_id
   and v.user_id = o.user_id
   and v.title_id = o.title_id
  cross join lateral unnest(o.subtitle_languages) as language_code
  where o.user_id = p_user_id
    and o.title_id = p_title_id
    and o.subtitle_observed;

  update public.cloud_titles t
     set file_audio_languages = v_audio,
         file_subtitle_languages = v_subtitles
   where t.user_id = p_user_id
     and t.id = p_title_id
     and (
       t.file_audio_languages is distinct from v_audio
       or t.file_subtitle_languages is distinct from v_subtitles
     )
  returning t.item_type into v_item_type;

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

-- Remove the obsolete monotone overload if this migration is replayed over an
-- environment that briefly received the earlier draft.
drop function if exists public.merge_cloud_title_file_languages(
  uuid, uuid, jsonb, jsonb, boolean, boolean
);

-- Replace whichever side was actually observed, preserve the other side, then
-- rebuild the title union from all still-owned exact files.
create or replace function public.merge_cloud_title_file_languages(
  p_user_id uuid,
  p_title_id uuid,
  p_variant_id uuid,
  p_file_external_id text,
  p_audio_tracks jsonb,
  p_subtitle_tracks jsonb,
  p_has_audio boolean,
  p_has_subtitle boolean
) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_item_type text;
  v_variant_external_id text;
  v_audio text[] := '{}'::text[];
  v_subtitles text[] := '{}'::text[];
begin
  if p_user_id is null or p_title_id is null or p_variant_id is null
     or coalesce(btrim(p_file_external_id), '') = '' then
    raise exception 'Exact file coordinates are required'
      using errcode = '22023';
  end if;

  select v.item_type, v.external_id
    into v_item_type, v_variant_external_id
  from public.cloud_title_variants v
  join public.cloud_titles t
    on t.id = v.title_id
   and t.user_id = v.user_id
   and t.item_type = v.item_type
  where v.id = p_variant_id
    and v.user_id = p_user_id
    and v.title_id = p_title_id
    and t.id = p_title_id
  for update of t;

  if not found then
    raise exception 'Variant is not owned by the requested tenant/title'
      using errcode = '42501';
  end if;

  -- Movie variants name the exact provider file. A series variant names its
  -- parent series; p_file_external_id is therefore allowed to name an episode.
  if v_item_type = 'movie'
     and v_variant_external_id is distinct from p_file_external_id then
    raise exception 'Movie file id does not match the owned variant'
      using errcode = '22023';
  end if;

  if not coalesce(p_has_audio, false)
     and not coalesce(p_has_subtitle, false) then
    return;
  end if;

  if coalesce(p_has_audio, false) then
    v_audio := public.cloud_file_track_languages(p_audio_tracks);
  end if;
  if coalesce(p_has_subtitle, false) then
    v_subtitles := public.cloud_file_track_languages(p_subtitle_tracks);
  end if;

  insert into public.cloud_title_file_language_observations as observation (
    user_id, title_id, variant_id, file_external_id,
    audio_languages, subtitle_languages,
    audio_observed, subtitle_observed, updated_at
  ) values (
    p_user_id, p_title_id, p_variant_id, p_file_external_id,
    v_audio, v_subtitles,
    coalesce(p_has_audio, false), coalesce(p_has_subtitle, false), now()
  )
  on conflict (user_id, variant_id, file_external_id) do update set
    title_id = excluded.title_id,
    audio_languages = case
      when excluded.audio_observed then excluded.audio_languages
      else observation.audio_languages
    end,
    subtitle_languages = case
      when excluded.subtitle_observed then excluded.subtitle_languages
      else observation.subtitle_languages
    end,
    audio_observed = observation.audio_observed or excluded.audio_observed,
    subtitle_observed = observation.subtitle_observed or excluded.subtitle_observed,
    updated_at = now();

  perform public.recompute_cloud_title_file_languages(p_user_id, p_title_id);
end
$function$;

revoke all on function public.merge_cloud_title_file_languages(
  uuid, uuid, uuid, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.merge_cloud_title_file_languages(
  uuid, uuid, uuid, text, jsonb, jsonb, boolean, boolean
) to service_role;

-- Trusted global file-cache fanout is movie-only: movie variant ids are exact
-- file ids. Each owner receives a replaceable observation. Legacy ordered maps
-- are updated only when no real sibling variant exists (never via variant_count).
create or replace function public.fanout_file_tracks_to_users(
  p_server_host text,
  p_item_type text,
  p_external_id text,
  p_audio_tracks jsonb,
  p_subtitle_tracks jsonb,
  p_has_audio boolean,
  p_has_subtitle boolean
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_owner record;
  v_count integer := 0;
  v_audio text[] := '{}'::text[];
begin
  if coalesce(btrim(p_server_host), '') = ''
     or coalesce(btrim(p_external_id), '') = ''
     or p_item_type is distinct from 'movie'
     or (
       not coalesce(p_has_audio, false)
       and not coalesce(p_has_subtitle, false)
     ) then
    return 0;
  end if;

  if coalesce(p_has_audio, false) then
    v_audio := public.cloud_file_track_languages(p_audio_tracks);
  end if;

  for v_owner in
    select distinct
      v.user_id,
      v.title_id,
      v.id as variant_id,
      v.external_id
    from public.cloud_title_variants v
    join public.cloud_sources s
      on s.id = v.source_id
     and s.user_id = v.user_id
    left join public.catalog_provider_identities cpi
      on cpi.provider_key = coalesce(
        s.config_hint->>'providerKey',
        s.config_hint->>'serverHost'
      )
    where v.item_type = 'movie'
      and v.external_id = p_external_id
      and v.title_id is not null
      and (
        coalesce(
          s.config_hint->>'providerKey',
          s.config_hint->>'serverHost'
        ) = p_server_host
        or cpi.identity_id::text = p_server_host
      )
    order by v.user_id, v.title_id, v.id
  loop
    perform public.merge_cloud_title_file_languages(
      v_owner.user_id,
      v_owner.title_id,
      v_owner.variant_id,
      v_owner.external_id,
      p_audio_tracks,
      p_subtitle_tracks,
      coalesce(p_has_audio, false),
      coalesce(p_has_subtitle, false)
    );

    update public.cloud_titles t
       set audio_tracks = case
             when coalesce(p_has_audio, false)
               then case
                 when jsonb_typeof(p_audio_tracks) = 'array'
                   then p_audio_tracks
                 else '[]'::jsonb
               end
             else t.audio_tracks
           end,
           audio_languages = case
             when coalesce(p_has_audio, false) then v_audio
             else t.audio_languages
           end,
           audio_probed_at = case
             when coalesce(p_has_audio, false) then now()
             else t.audio_probed_at
           end,
           subtitle_tracks = case
             when coalesce(p_has_subtitle, false)
               then case
                 when jsonb_typeof(p_subtitle_tracks) = 'array'
                   then p_subtitle_tracks
                 else '[]'::jsonb
               end
             else t.subtitle_tracks
           end,
           subtitle_probed_at = case
             when coalesce(p_has_subtitle, false) then now()
             else t.subtitle_probed_at
           end
     where t.user_id = v_owner.user_id
       and t.id = v_owner.title_id
       and t.item_type = 'movie'
       and not exists (
         select 1
         from public.cloud_title_variants sibling
         where sibling.user_id = v_owner.user_id
           and sibling.title_id = v_owner.title_id
           and sibling.id <> v_owner.variant_id
       );

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$function$;

revoke all on function public.fanout_file_tracks_to_users(
  text, text, text, jsonb, jsonb, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.fanout_file_tracks_to_users(
  text, text, text, jsonb, jsonb, boolean, boolean
) to service_role;

-- Hydrate newly projected movie variants from the trusted cross-user cache.
-- All observation writes are set-local; title unions are recomputed only after
-- the batch has finished so a grouped title is updated once.
create or replace function public.hydrate_cloud_title_file_languages(
  p_user_id uuid,
  p_source_id uuid,
  p_server_key text,
  p_item_type text,
  p_external_ids text[]
) returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_file record;
  v_title_id uuid;
  v_title_ids uuid[] := '{}'::uuid[];
  v_count integer := 0;
begin
  if p_user_id is null
     or p_source_id is null
     or coalesce(btrim(p_server_key), '') = ''
     or p_item_type is distinct from 'movie' then
    return 0;
  end if;

  for v_file in
    select
      v.user_id,
      v.title_id,
      v.id as variant_id,
      v.external_id,
      ft.audio_tracks,
      ft.subtitle_tracks,
      ft.audio_probed_at is not null as audio_observed,
      ft.subtitle_probed_at is not null as subtitle_observed
    from public.cloud_title_variants v
    join public.catalog_file_tracks ft
      on ft.server_host = p_server_key
     and ft.item_type = v.item_type
     and ft.external_id = v.external_id
    where v.user_id = p_user_id
      and v.source_id = p_source_id
      and v.item_type = 'movie'
      and v.title_id is not null
      and (p_external_ids is null or v.external_id = any(p_external_ids))
      and (ft.audio_probed_at is not null or ft.subtitle_probed_at is not null)
    order by v.title_id, v.id
  loop
    insert into public.cloud_title_file_language_observations as observation (
      user_id, title_id, variant_id, file_external_id,
      audio_languages, subtitle_languages,
      audio_observed, subtitle_observed, updated_at
    ) values (
      v_file.user_id,
      v_file.title_id,
      v_file.variant_id,
      v_file.external_id,
      case when v_file.audio_observed
        then public.cloud_file_track_languages(v_file.audio_tracks)
        else '{}'::text[]
      end,
      case when v_file.subtitle_observed
        then public.cloud_file_track_languages(v_file.subtitle_tracks)
        else '{}'::text[]
      end,
      v_file.audio_observed,
      v_file.subtitle_observed,
      now()
    )
    on conflict (user_id, variant_id, file_external_id) do update set
      title_id = excluded.title_id,
      audio_languages = case
        when excluded.audio_observed then excluded.audio_languages
        else observation.audio_languages
      end,
      subtitle_languages = case
        when excluded.subtitle_observed then excluded.subtitle_languages
        else observation.subtitle_languages
      end,
      audio_observed = observation.audio_observed or excluded.audio_observed,
      subtitle_observed = observation.subtitle_observed or excluded.subtitle_observed,
      updated_at = now();

    if not (v_file.title_id = any(v_title_ids)) then
      v_title_ids := array_append(v_title_ids, v_file.title_id);
    end if;
    v_count := v_count + 1;
  end loop;

  foreach v_title_id in array v_title_ids
  loop
    perform public.recompute_cloud_title_file_languages(p_user_id, v_title_id);
  end loop;

  return v_count;
end
$function$;

revoke all on function public.hydrate_cloud_title_file_languages(
  uuid, uuid, text, text, text[]
) from public, anon, authenticated;
grant execute on function public.hydrate_cloud_title_file_languages(
  uuid, uuid, text, text, text[]
) to service_role;

-- Backfill the existing trusted cache into tenant observations. Production has
-- ~92,532 movie variants matching an exact cache row; keep this fully set-based.
with matching_files as (
  select
    v.user_id,
    v.title_id,
    v.id as variant_id,
    v.external_id,
    cached.audio_tracks,
    cached.subtitle_tracks,
    cached.audio_probed_at,
    cached.subtitle_probed_at
  from public.cloud_title_variants v
  join public.cloud_sources source
    on source.id = v.source_id
   and source.user_id = v.user_id
  left join public.catalog_provider_identities identity
    on identity.provider_key = coalesce(
      source.config_hint->>'providerKey',
      source.config_hint->>'serverHost'
    )
  join lateral (
    select
      ft.audio_tracks,
      ft.subtitle_tracks,
      ft.audio_probed_at,
      ft.subtitle_probed_at
    from public.catalog_file_tracks ft
    where ft.item_type = 'movie'
      and ft.external_id = v.external_id
      and (
        ft.server_host = identity.identity_id::text
        or ft.server_host = source.config_hint->>'providerKey'
        or ft.server_host = source.config_hint->>'serverHost'
      )
      and (ft.audio_probed_at is not null or ft.subtitle_probed_at is not null)
    order by
      case
        when ft.server_host = identity.identity_id::text then 0
        when ft.server_host = source.config_hint->>'providerKey' then 1
        else 2
      end,
      ft.updated_at desc
    limit 1
  ) cached on true
  where v.item_type = 'movie'
    and v.title_id is not null
)
insert into public.cloud_title_file_language_observations as observation (
  user_id, title_id, variant_id, file_external_id,
  audio_languages, subtitle_languages,
  audio_observed, subtitle_observed, updated_at
)
select
  file.user_id,
  file.title_id,
  file.variant_id,
  file.external_id,
  case when file.audio_probed_at is not null
    then public.cloud_file_track_languages(file.audio_tracks)
    else '{}'::text[]
  end,
  case when file.subtitle_probed_at is not null
    then public.cloud_file_track_languages(file.subtitle_tracks)
    else '{}'::text[]
  end,
  file.audio_probed_at is not null,
  file.subtitle_probed_at is not null,
  now()
from matching_files file
on conflict (user_id, variant_id, file_external_id) do update set
  title_id = excluded.title_id,
  audio_languages = case
    when excluded.audio_observed then excluded.audio_languages
    else observation.audio_languages
  end,
  subtitle_languages = case
    when excluded.subtitle_observed then excluded.subtitle_languages
    else observation.subtitle_languages
  end,
  audio_observed = observation.audio_observed or excluded.audio_observed,
  subtitle_observed = observation.subtitle_observed or excluded.subtitle_observed,
  updated_at = now();

-- Bulk recompute only titles with evidence (plus any stale non-empty draft
-- arrays), while explicitly joining observations back to their live variants.
with audio_unions as (
  select
    o.user_id,
    o.title_id,
    array_agg(distinct language_code order by language_code) as languages
  from public.cloud_title_file_language_observations o
  join public.cloud_title_variants v
    on v.id = o.variant_id
   and v.user_id = o.user_id
   and v.title_id = o.title_id
  cross join lateral unnest(o.audio_languages) as language_code
  where o.audio_observed
  group by o.user_id, o.title_id
),
subtitle_unions as (
  select
    o.user_id,
    o.title_id,
    array_agg(distinct language_code order by language_code) as languages
  from public.cloud_title_file_language_observations o
  join public.cloud_title_variants v
    on v.id = o.variant_id
   and v.user_id = o.user_id
   and v.title_id = o.title_id
  cross join lateral unnest(o.subtitle_languages) as language_code
  where o.subtitle_observed
  group by o.user_id, o.title_id
),
affected_titles as (
  select distinct o.user_id, o.title_id
  from public.cloud_title_file_language_observations o
  join public.cloud_title_variants v
    on v.id = o.variant_id
   and v.user_id = o.user_id
   and v.title_id = o.title_id
  union
  select t.user_id, t.id
  from public.cloud_titles t
  where cardinality(t.file_audio_languages) > 0
     or cardinality(t.file_subtitle_languages) > 0
),
recomputed as (
  select
    affected.user_id,
    affected.title_id,
    coalesce(audio.languages, '{}'::text[]) as audio_languages,
    coalesce(subtitles.languages, '{}'::text[]) as subtitle_languages
  from affected_titles affected
  left join audio_unions audio
    on audio.user_id = affected.user_id
   and audio.title_id = affected.title_id
  left join subtitle_unions subtitles
    on subtitles.user_id = affected.user_id
   and subtitles.title_id = affected.title_id
)
update public.cloud_titles title
   set file_audio_languages = recomputed.audio_languages,
       file_subtitle_languages = recomputed.subtitle_languages
  from recomputed
 where title.user_id = recomputed.user_id
   and title.id = recomputed.title_id
   and (
     title.file_audio_languages is distinct from recomputed.audio_languages
     or title.file_subtitle_languages is distinct from recomputed.subtitle_languages
   );

-- Keep derived unions correct when a variant/observation is removed or moved.
-- Language updates themselves go through the service-only RPCs above.
create or replace function public.recompute_cloud_title_file_languages_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_cloud_title_file_languages(old.user_id, old.title_id);
    return old;
  end if;

  if old.user_id is distinct from new.user_id
     or old.title_id is distinct from new.title_id then
    perform public.recompute_cloud_title_file_languages(old.user_id, old.title_id);
    perform public.recompute_cloud_title_file_languages(new.user_id, new.title_id);
  end if;
  return new;
end
$function$;

revoke all on function public.recompute_cloud_title_file_languages_lifecycle()
  from public, anon, authenticated;
grant execute on function public.recompute_cloud_title_file_languages_lifecycle()
  to service_role;

drop trigger if exists trg_cloud_title_file_language_observations_delete
  on public.cloud_title_file_language_observations;
create trigger trg_cloud_title_file_language_observations_delete
after delete on public.cloud_title_file_language_observations
for each row execute function public.recompute_cloud_title_file_languages_lifecycle();

drop trigger if exists trg_cloud_title_file_language_observations_move
  on public.cloud_title_file_language_observations;
create trigger trg_cloud_title_file_language_observations_move
after update of user_id, title_id, variant_id, file_external_id
on public.cloud_title_file_language_observations
for each row execute function public.recompute_cloud_title_file_languages_lifecycle();

-- A deferred parent-variant trigger is the final lifecycle guard. It runs after
-- FK cascades have removed/moved observation rows, so the old title cannot keep
-- a language from a source/variant that no longer exists.
drop trigger if exists trg_cloud_title_variants_file_languages_lifecycle
  on public.cloud_title_variants;
drop trigger if exists trg_cloud_title_variants_file_languages_delete
  on public.cloud_title_variants;
create constraint trigger trg_cloud_title_variants_file_languages_delete
after delete on public.cloud_title_variants
deferrable initially deferred
for each row execute function public.recompute_cloud_title_file_languages_lifecycle();

drop trigger if exists trg_cloud_title_variants_file_languages_move
  on public.cloud_title_variants;
create constraint trigger trg_cloud_title_variants_file_languages_move
after update on public.cloud_title_variants
deferrable initially deferred
for each row
when (
  old.user_id is distinct from new.user_id
  or old.title_id is distinct from new.title_id
)
execute function public.recompute_cloud_title_file_languages_lifecycle();

-- Facet summaries count exact per-file unions, never a representative stream
-- map or a globally inherited TMDB language.
create or replace function public.cloud_refresh_facet_summary(
  p_user_id uuid,
  p_item_type text
) returns void
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_counts jsonb;
  v_audio text[];
  v_version text[];
  v_audio_counts jsonb;
  v_sub_counts jsonb;
begin
  select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
    into v_counts
  from (
    select bucket, count(*)::bigint as n
    from public.cloud_titles t
    cross join lateral unnest(
      coalesce(t.genre_buckets, array['autres'])
    ) as bucket
    where t.user_id = p_user_id
      and t.item_type = p_item_type
      and t.variant_count > 0
      and bucket <> 'autres'
    group by bucket
  ) genre_counts;

  select
    coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb),
    coalesce(array_agg(language_code order by language_code), '{}'::text[])
    into v_audio_counts, v_audio
  from (
    select language_code, count(distinct t.id)::bigint as n
    from public.cloud_titles t
    cross join lateral unnest(
      coalesce(t.file_audio_languages, '{}'::text[])
    ) as language_code
    where t.user_id = p_user_id
      and t.item_type = p_item_type
      and t.variant_count > 0
      and language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ) audio_counts;

  select coalesce(
    array_agg(distinct lower(version_language)),
    '{}'::text[]
  )
    into v_version
  from public.cloud_titles t
  cross join lateral unnest(
    coalesce(t.version_languages, '{}'::text[])
  ) as version_language
  where t.user_id = p_user_id
    and t.item_type = p_item_type
    and t.variant_count > 0
    and version_language is not null;

  select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
    into v_sub_counts
  from (
    select language_code, count(distinct t.id)::bigint as n
    from public.cloud_titles t
    cross join lateral unnest(
      coalesce(t.file_subtitle_languages, '{}'::text[])
    ) as language_code
    where t.user_id = p_user_id
      and t.item_type = p_item_type
      and t.variant_count > 0
      and language_code ~ '^[a-z]{2,3}$'
      and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
    group by language_code
  ) subtitle_counts;

  insert into public.cloud_catalog_facet_summary (
    user_id,
    item_type,
    genre_bucket_counts,
    audio_langs,
    version_tags,
    audio_lang_counts,
    subtitle_lang_counts,
    refreshed_at
  ) values (
    p_user_id,
    p_item_type,
    v_counts,
    coalesce(v_audio, '{}'::text[]),
    coalesce(v_version, '{}'::text[]),
    coalesce(v_audio_counts, '{}'::jsonb),
    coalesce(v_sub_counts, '{}'::jsonb),
    now()
  )
  on conflict (user_id, item_type) do update set
    genre_bucket_counts = excluded.genre_bucket_counts,
    audio_langs = excluded.audio_langs,
    version_tags = excluded.version_tags,
    audio_lang_counts = excluded.audio_lang_counts,
    subtitle_lang_counts = excluded.subtitle_lang_counts,
    refreshed_at = excluded.refreshed_at;
end
$function$;

-- O(1) for fresh summaries; invalidated/missing rows fall back to live exact
-- counts without forcing a mass refresh inside this migration.
create or replace function public.cloud_exact_language_counts(
  p_user_id uuid,
  p_item_type text
) returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $function$
declare
  v_audio_counts jsonb;
  v_sub_counts jsonb;
begin
  select summary.audio_lang_counts, summary.subtitle_lang_counts
    into v_audio_counts, v_sub_counts
  from public.cloud_catalog_facet_summary summary
  where summary.user_id = p_user_id
    and summary.item_type = p_item_type
    and summary.refreshed_at >= now() - interval '30 minutes';

  if not found then
    select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
      into v_audio_counts
    from (
      select language_code, count(distinct t.id)::bigint as n
      from public.cloud_titles t
      cross join lateral unnest(
        coalesce(t.file_audio_languages, '{}'::text[])
      ) as language_code
      where t.user_id = p_user_id
        and t.item_type = p_item_type
        and t.variant_count > 0
        and language_code ~ '^[a-z]{2,3}$'
        and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
      group by language_code
    ) audio_counts;

    select coalesce(jsonb_object_agg(language_code, n), '{}'::jsonb)
      into v_sub_counts
    from (
      select language_code, count(distinct t.id)::bigint as n
      from public.cloud_titles t
      cross join lateral unnest(
        coalesce(t.file_subtitle_languages, '{}'::text[])
      ) as language_code
      where t.user_id = p_user_id
        and t.item_type = p_item_type
        and t.variant_count > 0
        and language_code ~ '^[a-z]{2,3}$'
        and language_code not in ('un', 'und', 'mul', 'zxx', 'mis', 'nar')
      group by language_code
    ) subtitle_counts;
  end if;

  return jsonb_build_object(
    'audio', coalesce(v_audio_counts, '{}'::jsonb),
    'subtitles', coalesce(v_sub_counts, '{}'::jsonb)
  );
end
$function$;

revoke all on function public.cloud_refresh_facet_summary(uuid, text)
  from public, anon, authenticated;
grant execute on function public.cloud_refresh_facet_summary(uuid, text)
  to service_role;
revoke all on function public.cloud_exact_language_counts(uuid, text)
  from public, anon, authenticated;
grant execute on function public.cloud_exact_language_counts(uuid, text)
  to service_role;

-- Seven rows in production today. Invalidate only: callers either use the live
-- exact fallback or refresh on demand. Never run cloud_refresh_all_* here.
update public.cloud_catalog_facet_summary
   set refreshed_at = 'epoch'::timestamptz;

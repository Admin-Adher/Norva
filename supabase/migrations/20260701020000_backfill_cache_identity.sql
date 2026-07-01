-- Phase B backfill: move the cross-user caches from the volatile fingerprint key (providerKey / legacy
-- host) onto the stable identity id, MERGING the fragments of one panel (e.g. Opplex + Ferran's 4 keys)
-- into a single shared cache. Keeps the most-complete row per file. Idempotent (after the merge no mapped
-- fingerprint rows remain, so a re-run is a no-op).
--
-- ORDER: run this AFTER the norva-playback deploy that makes resolveSourceIdentity return the identity id.
-- Running earlier only means a brief re-probe window (caches degrade to "probe again", never break), and
-- getGeneratedSubtitle has a raw-fingerprint read fallback for the transition.
--
-- Rows keyed by a hostname that is NOT a known fingerprint (the vod-title-projection tmdb/imdb sub-cache)
-- are intentionally left as-is — that is the scoped Phase B.2 follow-up.

-- ---- catalog_file_tracks: fingerprint -> identity ----
with mapping as (
  select provider_key, identity_id::text as idkey
  from public.catalog_provider_identities where identity_id is not null
),
ranked as (
  select m.idkey, ft.item_type, ft.external_id,
    ft.audio_tracks, ft.subtitle_tracks, ft.audio_probed_at, ft.subtitle_probed_at,
    ft.provider_tmdb_id, ft.provider_imdb_id, ft.ids_resolved_at, ft.updated_at,
    row_number() over (
      partition by m.idkey, ft.item_type, ft.external_id
      order by ((ft.audio_probed_at is not null)::int + (ft.subtitle_probed_at is not null)::int
                + (ft.ids_resolved_at is not null)::int) desc,
               ft.updated_at desc nulls last
    ) as rn
  from public.catalog_file_tracks ft
  join mapping m on m.provider_key = ft.server_host
)
insert into public.catalog_file_tracks
  (server_host, item_type, external_id, audio_tracks, subtitle_tracks, audio_probed_at,
   subtitle_probed_at, provider_tmdb_id, provider_imdb_id, ids_resolved_at, updated_at)
select idkey, item_type, external_id, audio_tracks, subtitle_tracks, audio_probed_at,
       subtitle_probed_at, provider_tmdb_id, provider_imdb_id, ids_resolved_at, updated_at
from ranked where rn = 1
on conflict (server_host, item_type, external_id) do update set
  audio_tracks       = coalesce(catalog_file_tracks.audio_tracks, excluded.audio_tracks),
  subtitle_tracks    = coalesce(catalog_file_tracks.subtitle_tracks, excluded.subtitle_tracks),
  audio_probed_at    = coalesce(catalog_file_tracks.audio_probed_at, excluded.audio_probed_at),
  subtitle_probed_at = coalesce(catalog_file_tracks.subtitle_probed_at, excluded.subtitle_probed_at),
  provider_tmdb_id   = coalesce(catalog_file_tracks.provider_tmdb_id, excluded.provider_tmdb_id),
  provider_imdb_id   = coalesce(catalog_file_tracks.provider_imdb_id, excluded.provider_imdb_id),
  ids_resolved_at    = coalesce(catalog_file_tracks.ids_resolved_at, excluded.ids_resolved_at),
  updated_at         = greatest(catalog_file_tracks.updated_at, excluded.updated_at);

with mapping as (
  select provider_key from public.catalog_provider_identities where identity_id is not null
)
delete from public.catalog_file_tracks ft using mapping m where ft.server_host = m.provider_key;

-- ---- catalog_generated_subtitles: fingerprint -> identity ----
with mapping as (
  select provider_key, identity_id::text as idkey
  from public.catalog_provider_identities where identity_id is not null
),
ranked as (
  select m.idkey, gs.item_type, gs.external_id, gs.kind, gs.lang,
    gs.status, gs.vtt, gs.source_lang, gs.audio_sec, gs.segments, gs.error, gs.job_id,
    gs.created_at, gs.updated_at,
    row_number() over (
      partition by m.idkey, gs.item_type, gs.external_id, gs.kind, gs.lang
      order by (gs.status = 'ready') desc, (gs.vtt is not null) desc, gs.updated_at desc nulls last
    ) as rn
  from public.catalog_generated_subtitles gs
  join mapping m on m.provider_key = gs.provider_key
)
insert into public.catalog_generated_subtitles
  (provider_key, item_type, external_id, kind, lang, status, vtt, source_lang, audio_sec, segments, error, job_id, created_at, updated_at)
select idkey, item_type, external_id, kind, lang, status, vtt, source_lang, audio_sec, segments, error, job_id, created_at, updated_at
from ranked where rn = 1
on conflict (provider_key, item_type, external_id, kind, lang) do update set
  status      = case when excluded.status = 'ready' then excluded.status else catalog_generated_subtitles.status end,
  vtt         = coalesce(catalog_generated_subtitles.vtt, excluded.vtt),
  source_lang = coalesce(catalog_generated_subtitles.source_lang, excluded.source_lang),
  audio_sec   = coalesce(catalog_generated_subtitles.audio_sec, excluded.audio_sec),
  segments    = coalesce(catalog_generated_subtitles.segments, excluded.segments),
  updated_at  = greatest(catalog_generated_subtitles.updated_at, excluded.updated_at);

with mapping as (
  select provider_key from public.catalog_provider_identities where identity_id is not null
)
delete from public.catalog_generated_subtitles gs using mapping m where gs.provider_key = m.provider_key;

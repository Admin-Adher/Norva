-- Cross-user track-map cache, keyed by the PROVIDER FILE (server_host + external_id +
-- item_type) — NOT tmdb, because the absolute ffmpeg stream indices are a property of the
-- exact file (two rips of the same title differ). When ANY user (or the crawl) probes a
-- file, the map is stored here and fanned out to EVERY user owning that file, so they get
-- the tracks with zero re-probe. Service-role only.
create table if not exists public.catalog_file_tracks (
  server_host text not null,
  item_type text not null,
  external_id text not null,
  audio_tracks jsonb not null default '[]'::jsonb,
  subtitle_tracks jsonb not null default '[]'::jsonb,
  audio_probed_at timestamptz,
  subtitle_probed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (server_host, item_type, external_id)
);
alter table public.catalog_file_tracks enable row level security;
revoke all on public.catalog_file_tracks from anon, authenticated;

-- Store/refresh a file's track map (race-safe). p_has_* lets the audio and subtitle halves
-- be written independently (a probe may resolve one but not the other).
create or replace function public.upsert_catalog_file_tracks(
  p_server_host text, p_item_type text, p_external_id text,
  p_audio_tracks jsonb, p_subtitle_tracks jsonb,
  p_has_audio boolean, p_has_subtitle boolean
) returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_server_host,'') = '' or coalesce(p_external_id,'') = '' then return; end if;
  if p_item_type not in ('movie','series') then return; end if;
  insert into catalog_file_tracks as c
    (server_host, item_type, external_id, audio_tracks, subtitle_tracks, audio_probed_at, subtitle_probed_at, updated_at)
  values (p_server_host, p_item_type, p_external_id,
    case when p_has_audio then coalesce(p_audio_tracks,'[]'::jsonb) else '[]'::jsonb end,
    case when p_has_subtitle then coalesce(p_subtitle_tracks,'[]'::jsonb) else '[]'::jsonb end,
    case when p_has_audio then now() else null end,
    case when p_has_subtitle then now() else null end,
    now())
  on conflict (server_host, item_type, external_id) do update set
    audio_tracks       = case when p_has_audio    then coalesce(p_audio_tracks,'[]'::jsonb)    else c.audio_tracks end,
    subtitle_tracks    = case when p_has_subtitle then coalesce(p_subtitle_tracks,'[]'::jsonb) else c.subtitle_tracks end,
    audio_probed_at    = case when p_has_audio    then now() else c.audio_probed_at end,
    subtitle_probed_at = case when p_has_subtitle then now() else c.subtitle_probed_at end,
    updated_at = now();
end; $$;
revoke all on function public.upsert_catalog_file_tracks(text,text,text,jsonb,jsonb,boolean,boolean) from anon, authenticated;

-- Push a file's track map to EVERY user owning that file (same provider host + external_id),
-- filling ONLY users who lack it (never overwrites a user's own probe). Returns rows filled.
create or replace function public.fanout_file_tracks_to_users(
  p_server_host text, p_item_type text, p_external_id text,
  p_audio_tracks jsonb, p_subtitle_tracks jsonb,
  p_has_audio boolean, p_has_subtitle boolean
) returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if coalesce(p_server_host,'') = '' or coalesce(p_external_id,'') = '' then return 0; end if;
  with owners as (
    select distinct v.user_id, v.title_id
    from cloud_title_variants v
    join cloud_sources s on s.id = v.source_id and s.user_id = v.user_id
    where v.item_type = p_item_type
      and v.external_id = p_external_id
      and (s.config_hint->>'serverHost') = p_server_host
      and v.title_id is not null
  )
  update cloud_titles t set
    audio_tracks = case when p_has_audio and t.audio_probed_at is null then coalesce(p_audio_tracks,'[]'::jsonb) else t.audio_tracks end,
    audio_languages = case when p_has_audio and t.audio_probed_at is null then
      coalesce((select array_agg(distinct lang order by lang)
                from (select e->>'lang' as lang from jsonb_array_elements(coalesce(p_audio_tracks,'[]'::jsonb)) e) s
                where lang ~ '^[a-z]{2}$'), '{}'::text[])
      else t.audio_languages end,
    audio_probed_at = case when p_has_audio and t.audio_probed_at is null then now() else t.audio_probed_at end,
    subtitle_tracks = case when p_has_subtitle and t.subtitle_probed_at is null then coalesce(p_subtitle_tracks,'[]'::jsonb) else t.subtitle_tracks end,
    subtitle_probed_at = case when p_has_subtitle and t.subtitle_probed_at is null then now() else t.subtitle_probed_at end
  from owners o
  where t.user_id = o.user_id and t.id = o.title_id
    and ((p_has_audio and t.audio_probed_at is null) or (p_has_subtitle and t.subtitle_probed_at is null));
  get diagnostics v_count = row_count;
  return v_count;
end; $$;
revoke all on function public.fanout_file_tracks_to_users(text,text,text,jsonb,jsonb,boolean,boolean) from anon, authenticated;

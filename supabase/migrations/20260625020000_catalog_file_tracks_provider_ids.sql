-- Cross-user reuse for onboarding: cache the get_vod_info result (provider tmdb/imdb id per
-- file) alongside the track map. When a 2nd user syncs the SAME provider, the projection
-- reads these instead of re-calling get_vod_info per movie — the single biggest onboarding
-- cost after TMDB. ids_resolved_at marks "looked up" (even if the file has no id) so it isn't
-- re-fetched. Same file key (server_host, item_type, external_id), service-role only.
alter table public.catalog_file_tracks
  add column if not exists provider_tmdb_id text,
  add column if not exists provider_imdb_id text,
  add column if not exists ids_resolved_at timestamptz;

create or replace function public.upsert_catalog_file_ids(
  p_server_host text, p_item_type text, p_external_id text,
  p_tmdb_id text, p_imdb_id text
) returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_server_host,'') = '' or coalesce(p_external_id,'') = '' then return; end if;
  if p_item_type not in ('movie','series') then return; end if;
  insert into catalog_file_tracks as c (server_host, item_type, external_id, provider_tmdb_id, provider_imdb_id, ids_resolved_at, updated_at)
  values (p_server_host, p_item_type, p_external_id, nullif(p_tmdb_id,''), nullif(p_imdb_id,''), now(), now())
  on conflict (server_host, item_type, external_id) do update set
    provider_tmdb_id = coalesce(nullif(p_tmdb_id,''), c.provider_tmdb_id),
    provider_imdb_id = coalesce(nullif(p_imdb_id,''), c.provider_imdb_id),
    ids_resolved_at = now(),
    updated_at = now();
end; $$;
revoke all on function public.upsert_catalog_file_ids(text,text,text,text,text) from anon, authenticated;

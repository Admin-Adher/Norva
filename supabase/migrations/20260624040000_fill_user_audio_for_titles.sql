-- Batch-scoped catalog-first fill, called from the projection (vod-title-projection.ts)
-- at sync time: inherit already-known audio languages from the global cache for JUST the
-- titles being projected (no provider hit). A new user of a provider another user already
-- crawled gets languages instantly instead of waiting ~days for the crawl. Scoped to the
-- batch's tmdb ids so the sync stays fast. Service-role only.
create or replace function public.fill_user_audio_for_titles(p_user_id uuid, p_tmdb_ids text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.cloud_titles ct
     set audio_languages = c.audio_languages
    from public.catalog_titles c
   where ct.user_id = p_user_id
     and ct.audio_languages = '{}'
     and ct.provider_tmdb_id = any(p_tmdb_ids)
     and c.item_type = ct.item_type
     and c.provider_tmdb_id = ct.provider_tmdb_id
     and c.audio_languages <> '{}';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.fill_user_audio_for_titles(uuid, text[]) from public;
revoke all on function public.fill_user_audio_for_titles(uuid, text[]) from anon;
revoke all on function public.fill_user_audio_for_titles(uuid, text[]) from authenticated;
grant execute on function public.fill_user_audio_for_titles(uuid, text[]) to service_role;

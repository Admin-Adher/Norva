-- (1) Crawl progression. The audio crawl filters audio_languages='{}' but never advanced
-- past genuinely-untagged titles — it re-probed the same front of the queue forever, so
-- coverage stalled. Track when a title was last probed; the crawl skips recently-probed
-- titles and moves on. A 30d retry window recovers from transient provider failures.
alter table public.cloud_titles
  add column if not exists audio_probed_at timestamptz;

-- (2) Catalog-first fill = the scale dedup. A file's languages are a property of the
-- file, identical for every user of that provider. Once ANY user's crawl probes a title
-- into catalog_titles, every other user gets it here for free — no provider hit, no
-- re-probe, no added rate-limit pressure. This is "probe once globally, share to all".
create or replace function public.fill_user_audio_from_catalog(
  p_user_id uuid, p_item_type text, p_limit int default 5000
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  with todo as (
    select ct.id, c.audio_languages as langs
    from public.cloud_titles ct
    join public.catalog_titles c using (item_type, provider_tmdb_id)
    where ct.user_id = p_user_id and ct.item_type = p_item_type
      and ct.audio_languages = '{}' and c.audio_languages <> '{}'
    limit greatest(p_limit, 0)
  )
  update public.cloud_titles ct
     set audio_languages = todo.langs
    from todo
   where ct.id = todo.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.fill_user_audio_from_catalog(uuid, text, int) from public;
revoke all on function public.fill_user_audio_from_catalog(uuid, text, int) from anon;
revoke all on function public.fill_user_audio_from_catalog(uuid, text, int) from authenticated;
grant execute on function public.fill_user_audio_from_catalog(uuid, text, int) to service_role;

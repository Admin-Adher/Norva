-- Scale-readiness: fold audio_languages into the global title cache (catalog_titles),
-- so at scale a file's languages are probed/stored ONCE for all users instead of per-user.
-- Additive + reversible: nothing reads this column yet (the read cutover is flag-OFF).
-- Idempotent so it is safe to (re)apply against an environment that already has it.

alter table public.catalog_titles
  add column if not exists audio_languages text[] not null default '{}'::text[];

create index if not exists catalog_titles_audio_languages_gin
  on public.catalog_titles using gin (audio_languages);

-- Race-free union-merge: the dedup/sort happens IN SQL under the row lock, so concurrent
-- crawlers / many users hitting the same title never clobber each other (no JS
-- read-modify-write). Sentinel-guarded ('0'/'tt0+' is never a real identity); codes
-- filtered to ISO-639-1 (2-letter), matching the menu/facets convention.
create or replace function public.merge_catalog_title_audio(
  p_item_type text,
  p_provider_tmdb_id text,
  p_codes text[]
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_provider_tmdb_id is null or p_provider_tmdb_id = '' or p_provider_tmdb_id ~ '^(tt)?0+$' then
    return; -- no-match sentinel: never a real identity
  end if;
  insert into public.catalog_titles (item_type, provider_tmdb_id, audio_languages, updated_at)
  values (
    p_item_type,
    p_provider_tmdb_id,
    (select coalesce(array_agg(distinct c order by c), '{}')
       from unnest(coalesce(p_codes, '{}')) c
      where c ~ '^[a-z]{2}$'),
    now()
  )
  on conflict (item_type, provider_tmdb_id) do update
    set audio_languages = (
          select coalesce(array_agg(distinct c order by c), '{}')
          from unnest(public.catalog_titles.audio_languages || excluded.audio_languages) c
        ),
        updated_at = now();
end;
$$;

-- Service-role surface only (matches catalog_titles' RLS posture). revoke-from-public
-- also strips service_role's implicit grant, so grant it back explicitly; anon/auth denied.
revoke all on function public.merge_catalog_title_audio(text, text, text[]) from public;
revoke all on function public.merge_catalog_title_audio(text, text, text[]) from anon;
revoke all on function public.merge_catalog_title_audio(text, text, text[]) from authenticated;
grant execute on function public.merge_catalog_title_audio(text, text, text[]) to service_role;

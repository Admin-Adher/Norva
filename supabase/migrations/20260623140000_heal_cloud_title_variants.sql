-- Self-healing variant materialisation. The "titles" finalisation phase is
-- client-driven and can stop early, leaving verified titles without playable
-- variants (so they vanish from genre rails — e.g. all series ended up with
-- variant_count = 0). This function deterministically creates any MISSING
-- variant by linking a media item to its verified title via the tmdb identity
-- key (no TMDB API calls), idempotently. norva-source-sync calls it at sync
-- completion so the gap can never persist.
create or replace function public.heal_cloud_title_variants(p_user_id uuid, p_source_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  inserted integer;
begin
  insert into public.cloud_title_variants
    (user_id, title_id, source_id, item_type, external_id, raw_title,
     poster_url, container_extension, playback_hint, metadata)
  select
    m.user_id, t.id, m.source_id, m.item_type, m.external_id, m.title,
    m.poster_url,
    coalesce(nullif(m.playback_hint->>'container',''),
             case when m.item_type='movie' then 'mp4' else '' end),
    coalesce(m.playback_hint, '{}'::jsonb),
    jsonb_strip_nulls(jsonb_build_object(
      'categoryName',   m.subtitle,
      'providerTmdbId', m.playback_hint->>'providerTmdbId',
      'identityKey',    t.identity_key,
      'healed',         true
    ))
  from public.cloud_media_items m
  join public.cloud_titles t
    on t.user_id = m.user_id
   and t.item_type = m.item_type
   and t.identity_key = 'tmdb:' || (m.playback_hint->>'providerTmdbId')
  where m.user_id = p_user_id
    and m.source_id = p_source_id
    and coalesce(m.playback_hint->>'providerTmdbId','0') not in ('', '0')
    and t.match_status = 'provider_verified'
  on conflict (source_id, item_type, external_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke execute on function public.heal_cloud_title_variants(uuid, uuid) from public, anon, authenticated;

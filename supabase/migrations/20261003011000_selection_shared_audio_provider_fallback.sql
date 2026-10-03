begin;
set local lock_timeout='3s';
set local statement_timeout='45s';

-- An inconclusive speech analysis is not evidence against an explicit provider
-- tag. Keep the existing provider fallback without calling it verified audio.
do $patch$
declare definition text; anchor text:='    changed:=changed+1;';
begin
  definition:=pg_get_functiondef('public.norva_refresh_selection_shared_audio(text[],integer)'::regprocedure);
  if strpos(definition,anchor)=0 then raise exception 'Shared audio function drift';end if;
  definition:=replace(definition,anchor,$insert$
    insert into public.selection_shared_languages(release_id,item_type,external_id,kind,language)
    select f.release_id,'movie',v.external_id,'audio',
      public.catalog_provider_language(v.metadata,v.external_id,v.raw_title)
    from public.selection_shared_variants v where v.release_id=f.release_id
      and v.item_type='movie' and v.external_id=f.external_id
      and public.catalog_provider_language(v.metadata,v.external_id,v.raw_title) is not null
      and not exists(select 1 from public.selection_shared_languages l
        where l.release_id=f.release_id and l.item_type='movie'
          and l.external_id=f.external_id and l.kind='audio');
    changed:=changed+1;$insert$);
  execute definition;
end $patch$;

-- Repair already refreshed files, using only the same explicit provider
-- declarations accepted when the shared release was originally published.
do $repair$
declare owner uuid; changed integer;
begin
  insert into public.selection_shared_languages(release_id,item_type,external_id,kind,language)
  select v.release_id,'movie',v.external_id,'audio',
    public.catalog_provider_language(v.metadata,v.external_id,v.raw_title)
  from public.selection_shared_variants v
  join public.selection_shared_releases r on r.id=v.release_id and r.published_at is not null
  join public.selection_shared_media m on m.release_id=v.release_id
    and m.item_type='movie' and m.external_id=v.external_id
  where v.item_type='movie' and m.available
    and m.playback_hint->>'targetUrl'=v.playback_hint->>'targetUrl'
    and public.catalog_provider_language(v.metadata,v.external_id,v.raw_title) is not null
    and not exists(select 1 from public.selection_shared_languages l
      where l.release_id=v.release_id and l.item_type='movie'
        and l.external_id=v.external_id and l.kind='audio')
    and not exists(select 1 from jsonb_array_elements(coalesce(m.file_tags->'audioTracks','[]')) t
      where public.norva_canonical_language_code(coalesce(t->>'lang',t->>'language')) is not null)
  on conflict do nothing;
  get diagnostics changed=row_count;
  if changed>0 then
    for owner in select distinct user_id from public.selection_shared_visible_enrollments order by user_id loop
      perform public.norva_bump_user_catalog_visibility_epoch(owner);
      delete from public.cloud_catalog_facet_summary where user_id=owner;
    end loop;
  end if;
  raise notice 'Restored % explicit provider language declarations',changed;
end $repair$;
notify pgrst,'reload schema';
commit;

begin;
set local lock_timeout='3s';
set local statement_timeout='45s';

-- Completed exact-file analyses must reach the common catalogue too. The old
-- hydration only reached materialized owner rows; an unplayed shared card stayed
-- on the original snapshot forever. Publish only the existing certified binding.
create function public.norva_refresh_selection_shared_audio(
  p_external_ids text[],p_limit integer default 250
) returns jsonb language plpgsql security definer set search_path='' set jit=off as $f$
declare f record; binding jsonb; tags jsonb; changed integer:=0; owner uuid;
  affected uuid[]:='{}'; keys text[]:='{}'; releases uuid[]:='{}';
begin
  perform public.norva_credential_require_service_role();
  if p_limit is null or p_limit not between 1 and 250
    or coalesce(cardinality(p_external_ids),0)>250 then
    raise exception 'Bounded Selection audio files required' using errcode='22023'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('selection-shared-audio-publication-v1',0)) then
    raise exception 'Selection audio publication busy' using errcode='55P03'; end if;
  for f in
    select m.release_id,m.external_id,m.file_tags,j.url_sha256,j.profile,j.result,j.completed_at,v.identity_key
    from public.selection_shared_media m
    join public.selection_shared_releases r on r.id=m.release_id and r.published_at is not null
    join public.selection_shared_variants v on v.release_id=m.release_id and v.item_type='movie' and v.external_id=m.external_id
    join public.catalog_selection_audio_jobs j on j.external_id=m.external_id and j.state='completed'
      and j.url_sha256=encode(sha256(convert_to(m.playback_hint->>'targetUrl','UTF8')),'hex')
    where m.item_type='movie' and m.available and m.playback_hint->>'targetUrl'=v.playback_hint->>'targetUrl'
      and (p_external_ids is null or m.external_id=any(p_external_ids))
      and (m.file_tags->>'analysisCompletedAt' is distinct from j.completed_at::text)
      and (nullif(m.file_tags->>'probedAt','') is null or (m.file_tags->>'probedAt')::timestamptz<=j.completed_at)
    order by j.completed_at,m.release_id,m.external_id limit p_limit for update of m
  loop
    binding:=public.selection_audio_publication_binding(f.profile,f.result,f.external_id,f.url_sha256);
    -- No receipts, transcript, owner identity or provider URL enters public tags.
    tags:=jsonb_build_object('audioTracks',f.result->'audioTracks','subtitleTracks',f.result->'subtitleTracks',
      'hasSubtitle',jsonb_array_length(f.result->'subtitleTracks')>0,'probedAt',f.completed_at,
      'verified',(f.result->>'verified')::boolean,'analysisCompletedAt',f.completed_at::text);
    update public.selection_shared_media set file_tags=tags
      where release_id=f.release_id and item_type='movie' and external_id=f.external_id;
    delete from public.selection_shared_languages
      where release_id=f.release_id and item_type='movie' and external_id=f.external_id;
    insert into public.selection_shared_languages(release_id,item_type,external_id,kind,language)
    select distinct f.release_id,'movie',f.external_id,kind,
      public.norva_canonical_language_code(coalesce(t->>'lang',t->>'language'))
    from (values('audio'),('subtitle')) kinds(kind)
    cross join lateral jsonb_array_elements(f.result->(kind||'Tracks')) t
    where public.norva_canonical_language_code(coalesce(t->>'lang',t->>'language')) is not null;
    changed:=changed+1;
    affected:=array_append(affected,f.release_id);keys:=array_append(keys,f.identity_key);
    releases:=array_append(releases,f.release_id);
  end loop;
  -- Roll up all versions of each affected card, never an ordered track map from
  -- one physical file onto another. A conclusive empty map removes stale tags.
  with selected as (select distinct a.rel,a.key from unnest(affected,keys) a(rel,key)),
  summaries as (
    select s.rel,s.key,
      coalesce(array_agg(distinct public.norva_canonical_language_code(coalesce(a->>'lang',a->>'language')))
        filter(where public.norva_canonical_language_code(coalesce(a->>'lang',a->>'language')) is not null),'{}') langs,
      coalesce(array_agg(distinct public.norva_canonical_language_code(coalesce(a->>'lang',a->>'language')))
        filter(where m.file_tags->>'verified'='true' and public.norva_canonical_language_code(coalesce(a->>'lang',a->>'language')) is not null),'{}') verified,
      coalesce(array_agg(distinct public.norva_canonical_language_code(coalesce(b->>'lang',b->>'language')))
        filter(where public.norva_canonical_language_code(coalesce(b->>'lang',b->>'language')) is not null),'{}') subtitles,
      max((m.file_tags->>'probedAt')::timestamptz) at
    from selected s join public.selection_shared_variants v on v.release_id=s.rel and v.item_type='movie' and v.identity_key=s.key
    join public.selection_shared_media m on m.release_id=v.release_id and m.item_type='movie' and m.external_id=v.external_id
    left join lateral jsonb_array_elements(coalesce(m.file_tags->'audioTracks','[]')) a on true
    left join lateral jsonb_array_elements(coalesce(m.file_tags->'subtitleTracks','[]')) b on true
    group by s.rel,s.key
  ) update public.selection_shared_titles t set audio_languages=s.langs,file_audio_languages=s.langs,
    file_audio_verified_languages=s.verified,file_subtitle_languages=s.subtitles,audio_probed_at=s.at,
    subtitle_probed_at=s.at,audio_lang_verified_at=case when cardinality(s.verified)>0 then s.at end
    from summaries s where t.release_id=s.rel and t.item_type='movie' and t.identity_key=s.key;
  if changed>0 then
    for owner in select distinct user_id from public.selection_shared_visible_enrollments
        where release_id=any(releases) order by user_id loop
      perform public.norva_bump_user_catalog_visibility_epoch(owner);
      delete from public.cloud_catalog_facet_summary where user_id=owner;
    end loop;
  end if;
  return jsonb_build_object('updatedFiles',changed,'updatedTitles',(select count(*) from
    (select distinct a.rel,a.key from unnest(affected,keys) a(rel,key)) q));
end $f$;
revoke all on function public.norva_refresh_selection_shared_audio(text[],integer) from public,anon,authenticated;
grant execute on function public.norva_refresh_selection_shared_audio(text[],integer) to service_role;

-- Reuse the durable pending flag: a failed publication cannot acknowledge a job.
create or replace function public.ack_selection_audio_hydration(p_external_id text,p_url_sha256 text)
returns boolean language plpgsql volatile security definer set search_path='' as $f$
declare n integer;
begin
  perform public.norva_credential_require_service_role();
  if not exists(select 1 from public.catalog_selection_audio_jobs where external_id=p_external_id
    and url_sha256=p_url_sha256 and state='completed' and hydration_pending) then return false; end if;
  perform public.norva_refresh_selection_shared_audio(array[p_external_id],250);
  update public.catalog_selection_audio_jobs set hydration_pending=false,updated_at=clock_timestamp()
    where external_id=p_external_id and url_sha256=p_url_sha256 and state='completed' and hydration_pending;
  get diagnostics n=row_count;
  return n=1;
end $f$;
revoke all on function public.ack_selection_audio_hydration(text,text) from public,anon,authenticated;
grant execute on function public.ack_selection_audio_hydration(text,text) to service_role;
notify pgrst,'reload schema';
commit;

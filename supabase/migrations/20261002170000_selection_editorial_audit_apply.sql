begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- An operator-reviewed public TMDB receipt can repair an association without
-- changing file identity, ownership, playback routing or per-owner inventories.
create function public.norva_apply_selection_editorial_audit(p_release uuid,p_manifest text,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path='' set jit=off as $f$
declare r public.selection_shared_releases; t public.selection_shared_titles;
 x jsonb; editorial jsonb; next_md jsonb; next_id text; rejected jsonb;
 next_poster text; next_backdrop text; next_year int; next_original text; next_genres jsonb;
 n int:=0; owned_n int:=0; batch_owned int; v_owner uuid; quarantined int:=0;
begin
 perform public.norva_credential_require_service_role();
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 100
   or octet_length(p_changes::text)>8388608 then raise exception 'Bounded audit required' using errcode='22023'; end if;
 if (select count(*) from jsonb_array_elements(p_changes)) <>
    (select count(distinct (v->>'itemType',v->>'identityKey')) from jsonb_array_elements(p_changes) v) then
   raise exception 'Duplicate audit identity' using errcode='22023'; end if;
 select * into r from public.selection_shared_releases where id=p_release;
 if not found or r.published_at is null or r.manifest_sha256 is distinct from p_manifest then
   raise exception 'Selection audit release changed' using errcode='PT409'; end if;
 -- Serialize with current source writers before inspecting physical bindings.
 perform 1 from public.cloud_source_catalog_heads h where exists(select 1 from public.selection_shared_visible_enrollments e
   where e.release_id=p_release and e.user_id=h.user_id and e.source_id=h.source_id)
   order by h.user_id,h.source_id for update;
 -- Source activation takes its head before the release: use the same order.
 select * into r from public.selection_shared_releases where id=p_release for update;
 if not found or r.published_at is null or r.manifest_sha256 is distinct from p_manifest then
   raise exception 'Selection audit release changed' using errcode='PT409'; end if;
 for x in select v from jsonb_array_elements(p_changes) v order by v->>'itemType',v->>'identityKey' loop
   if coalesce(x->>'itemType','') not in ('movie','series') or coalesce(x->>'action','') not in ('verified','quarantine') then
     raise exception 'Invalid audit action' using errcode='22023'; end if;
   select * into t from public.selection_shared_titles where release_id=p_release
     and item_type=x->>'itemType' and identity_key=x->>'identityKey' for update;
   if not found or t.title is distinct from x->>'expectedTitle' or t.provider_tmdb_id is distinct from x->>'expectedId'
     or t.poster_url is distinct from x->>'expectedPoster' or t.metadata is distinct from x->'expectedMetadata' then
     raise exception 'Selection audit input changed' using errcode='PT409'; end if;
   editorial:=public.norva_selection_public_editorial_metadata(x->'editorial');
   next_id:=x->>'tmdbId';
   if x->>'action'='verified' and (next_id is null or next_id !~ '^[1-9][0-9]*$'
     or editorial#>>'{tmdb,id}' is distinct from next_id or editorial#>>'{tmdbValidation,valid}' is distinct from 'true'
     or coalesce(public.safe_numeric(editorial#>>'{tmdbValidation,confidence}'),0)<0.9
     or coalesce(x->>'evidence','') not in ('existing_id_exact_alias','unique_exact_title','unique_exact_title_year','source_poster_confirmed',
       'unique_spacing_or_portuguese_alias','unique_source_filename_alias','exact_title_unique_file_duration')) then
     raise exception 'Unverified editorial receipt' using errcode='22023'; end if;
   if x->>'action'='quarantine' and (next_id is not null or t.provider_tmdb_id is null
     or x->>'evidence' is distinct from 'old_id_rejected') then
     raise exception 'Invalid quarantine receipt' using errcode='22023'; end if;
   rejected:=coalesce(t.metadata#>'{tmdbSearchReview,rejectedTmdbIds}','[]');
   if jsonb_typeof(rejected)<>'array' then rejected:='[]'; end if;
   if t.provider_tmdb_id is not null and t.provider_tmdb_id is distinct from next_id
     and not rejected @> jsonb_build_array(t.provider_tmdb_id) then
     rejected:=rejected||jsonb_build_array(t.provider_tmdb_id); end if;
   if x->>'action'='verified' and rejected @> jsonb_build_array(next_id) then
     raise exception 'Previously rejected identity requires separate review' using errcode='22023'; end if;
   next_md:=(coalesce(t.metadata,'{}')-'tmdb'-'i18n'-'tmdbValidation')||editorial
     ||jsonb_build_object('tmdbSearchReview',jsonb_build_object('rejectedTmdbIds',rejected,
       'reason',x->>'evidence','reviewedAt',statement_timestamp()));
   next_poster:=nullif(x->>'poster',''); next_backdrop:=nullif(x->>'backdrop','');
   if next_poster is not null and next_poster !~ '^https?://' then raise exception 'Invalid poster URL'; end if;
   if next_backdrop is not null and next_backdrop !~ '^https?://' then raise exception 'Invalid backdrop URL'; end if;
   next_year:=nullif(x->>'year','')::int; next_original:=coalesce(nullif(x->>'originalTitle',''),t.title);
   next_genres:=coalesce(editorial#>'{tmdb,genres}','[]');
   if x->>'action'='verified' then
     insert into public.catalog_titles(item_type,provider_tmdb_id,title,original_title,release_year,poster_url,backdrop_url,metadata,enriched_at,updated_at,i18n_attempted_at)
       values(t.item_type,next_id,coalesce(editorial#>>'{tmdb,title}',t.title),next_original,next_year,
         next_poster,next_backdrop,editorial,statement_timestamp(),statement_timestamp(),statement_timestamp())
       on conflict(item_type,provider_tmdb_id) do update set title=excluded.title,original_title=excluded.original_title,
         release_year=excluded.release_year,poster_url=coalesce(excluded.poster_url,public.catalog_titles.poster_url),
         backdrop_url=coalesce(excluded.backdrop_url,public.catalog_titles.backdrop_url),
         metadata=(coalesce(public.catalog_titles.metadata,'{}')-'tmdb'-'i18n'-'tmdbValidation')||excluded.metadata,
         enriched_at=excluded.enriched_at,updated_at=excluded.updated_at,i18n_attempted_at=excluded.i18n_attempted_at;
   else quarantined:=quarantined+1; end if;
   update public.selection_shared_titles set provider_tmdb_id=next_id,
     match_status=case when next_id is null then 'unmatched' else 'provider_verified' end,
     original_title=next_original,release_year=next_year,poster_url=next_poster,backdrop_url=next_backdrop,
     metadata=next_md,genre_payload=next_genres,genre_buckets=public.norva_classify_buckets(t.genre_category,next_genres),
     rating_num=public.safe_numeric(editorial#>>'{tmdb,vote_average}')
     where release_id=p_release and item_type=t.item_type and identity_key=t.identity_key;
   n:=n+1;
   -- Repair an existing owner binding only when ALL its current variants are
   -- this exact public Selection title. Mixed/private/manual titles are skipped.
   with eligible as materialized (
     select distinct ct.id,ct.user_id from public.cloud_titles ct
     join public.cloud_title_variants cv on cv.title_id=ct.id and cv.user_id=ct.user_id
     join public.selection_shared_visible_enrollments e on e.user_id=cv.user_id and e.source_id=cv.source_id
       and e.generation_id=cv.generation_id and e.release_id=p_release
     join public.selection_shared_variants sv on sv.release_id=e.release_id and sv.item_type=cv.item_type
       and sv.external_id=cv.external_id and sv.identity_key=t.identity_key
     where ct.item_type=t.item_type and ct.match_status is distinct from 'manual'
       and ct.provider_tmdb_id is not distinct from t.provider_tmdb_id
       and ((cv.item_type='movie' and nullif(cv.playback_hint->>'targetUrl','') is not null
         and cv.playback_hint->>'targetUrl'=sv.playback_hint->>'targetUrl')
       or (cv.item_type='series' and exists(select 1 from public.cloud_media_items ep join public.selection_shared_media se
         on se.release_id=e.release_id and se.item_type='episode' and se.external_id=ep.external_id
         and se.parent_external_id=sv.external_id and se.playback_hint->>'targetUrl'=ep.playback_hint->>'targetUrl'
         where ep.user_id=e.user_id and ep.source_id=e.source_id and ep.generation_id=e.generation_id
           and ep.item_type='episode' and ep.parent_external_id=cv.external_id
           and nullif(ep.playback_hint->>'targetUrl','') is not null)))
       and not exists(select 1 from public.cloud_title_variants other
         join public.cloud_source_catalog_heads h on h.user_id=other.user_id and h.source_id=other.source_id
           and h.active_generation_id=other.generation_id
         left join public.selection_shared_visible_enrollments oe on oe.user_id=other.user_id and oe.source_id=other.source_id
           and oe.generation_id=other.generation_id and oe.release_id=p_release
         left join public.selection_shared_variants os on os.release_id=oe.release_id and os.item_type=other.item_type
           and os.external_id=other.external_id and os.identity_key=t.identity_key
         where other.user_id=ct.user_id and other.title_id=ct.id
           and (os.external_id is null or (other.item_type='movie' and
             (nullif(other.playback_hint->>'targetUrl','') is null or other.playback_hint->>'targetUrl' is distinct from os.playback_hint->>'targetUrl'))))
   ) update public.cloud_titles ct set provider_tmdb_id=next_id,
     match_status=case when next_id is null then 'unmatched' else 'provider_verified' end,
     original_title=next_original,release_year=next_year,poster_url=next_poster,backdrop_url=next_backdrop,
     metadata=(coalesce(ct.metadata,'{}')-'tmdb'-'i18n'-'tmdbValidation')||editorial||jsonb_build_object('tmdbSearchReview',next_md->'tmdbSearchReview'),
     genre_payload=next_genres,genre_buckets=public.norva_classify_buckets(ct.genre_category,next_genres),
     rating_num=public.safe_numeric(editorial#>>'{tmdb,vote_average}'),updated_at=statement_timestamp()
     from eligible where ct.id=eligible.id and ct.user_id=eligible.user_id;
   get diagnostics batch_owned=row_count; owned_n:=owned_n+batch_owned;
 end loop;
 if n>0 then
   update public.selection_shared_releases set editorial_updated_at=clock_timestamp() where id=p_release;
   for v_owner in select distinct user_id from public.selection_shared_visible_enrollments where release_id=p_release order by user_id loop
     perform public.norva_bump_user_catalog_visibility_epoch(v_owner);
     delete from public.cloud_catalog_facet_summary where user_id=v_owner;
   end loop;
 end if;
 return jsonb_build_object('updatedTitles',n,'ownedBindings',owned_n,'quarantined',quarantined);
end $f$;
revoke all on function public.norva_apply_selection_editorial_audit(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.norva_apply_selection_editorial_audit(uuid,text,jsonb) to service_role;

-- Reuse of a legacy "valid" flag must not undo a quarantine or trust a partial
-- homonym. Keep the original ownership/file/year fences of the writer.
do $guards$
declare d text; needle text;
begin
 select pg_get_functiondef('public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid)'::regprocedure) into d;
 needle:='and c.metadata#>>''{tmdb,id}''=c.provider_tmdb_id';
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Editorial writer contract drift'; end if;
 d:=replace(d,needle,needle||' and (coalesce(public.safe_numeric(c.metadata#>>''{tmdbValidation,confidence}''),0)>=0.9
   or c.metadata#>>''{tmdbValidation,reason}''=''poster_path_confirmed'')
   and not coalesce(t.metadata#>''{tmdbSearchReview,rejectedTmdbIds}'',''[]''::jsonb) @> jsonb_build_array(c.provider_tmdb_id)');
 execute d;
end $guards$;
notify pgrst,'reload schema';
commit;

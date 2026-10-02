begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Old canonical Selection sources have physical inventories rather than a
-- shared enrollment. Refresh those exact public-file bindings too; ownership,
-- generation, manual/private titles, tracks and playback hints stay intact.
create function public.norva_refresh_selection_owned_editorial(p_user uuid,p_source uuid,p_generation uuid,p_limit int default 100)
returns jsonb language plpgsql security definer set search_path='' set jit=off as $f$
declare snap jsonb; n int; r public.selection_shared_releases;
 previous_context text:=current_setting('norva.selection_owned_editorial_context',true);
begin
 perform public.norva_credential_require_service_role();
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'Bounded owner refresh required' using errcode='22023'; end if;
 if not public.norva_selection_source_identity_valid(p_source,p_user) then
   raise exception 'Canonical Selection ownership required' using errcode='42501'; end if;
 perform 1 from public.cloud_sources where id=p_source and user_id=p_user for share;
 perform 1 from public.cloud_source_catalog_heads h join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
   where h.source_id=p_source and h.user_id=p_user for update of h,l;
 snap:=public.norva_get_catalog_write_snapshot(p_source,p_user);
 if snap->>'generationId' is distinct from p_generation::text or snap->>'isCatalogVisible' is distinct from 'true' then
   raise exception 'Selection owner snapshot changed' using errcode='PT409'; end if;
 select * into r from public.selection_shared_releases where published_at is not null order by published_at desc limit 1 for share;
 if not found then raise exception 'Published Selection required' using errcode='PT409'; end if;
 -- Public metadata is already in the common cache. Bypass the legacy mirror
 -- and its self-thinning only for this checked owner/source/generation batch;
 -- otherwise the mirror discards private fields and rewrites every replay.
 perform set_config('norva.selection_owned_editorial_context',jsonb_build_object(
   'userId',p_user,'sourceId',p_source,'generationId',p_generation)::text,true);
 with eligible as materialized (
   select distinct on(ct.id) ct.id,ct.user_id,t.provider_tmdb_id next_id,
     case when t.provider_tmdb_id is null then 'unmatched' else 'provider_verified' end next_status,
     t.original_title,t.release_year,t.poster_url,t.backdrop_url,
     (coalesce(ct.metadata,'{}')-'tmdb'-'i18n'-'tmdbValidation')||public.norva_selection_public_editorial_metadata(t.metadata)
       ||jsonb_build_object('tmdbSearchReview',coalesce(t.metadata->'tmdbSearchReview','{}')||jsonb_build_object('rejectedTmdbIds',
         coalesce((select jsonb_agg(rejected order by rejected) from (
           select distinct rejected from jsonb_array_elements_text(
             coalesce(t.metadata#>'{tmdbSearchReview,rejectedTmdbIds}','[]')||
             case when jsonb_typeof(ct.metadata#>'{tmdbSearchReview,rejectedTmdbIds}')='array'
               then ct.metadata#>'{tmdbSearchReview,rejectedTmdbIds}' else '[]'::jsonb end||
             case when ct.provider_tmdb_id is not null and ct.provider_tmdb_id is distinct from t.provider_tmdb_id
               then jsonb_build_array(ct.provider_tmdb_id) else '[]'::jsonb end) as rejected
           where rejected ~ '^[1-9][0-9]*$') retained),'[]'::jsonb))) next_md,
     t.genre_payload,public.norva_classify_buckets(ct.genre_category,t.genre_payload) genre_buckets,t.rating_num
   from public.cloud_title_variants v join public.cloud_titles ct on ct.user_id=v.user_id and ct.id=v.title_id and ct.item_type=v.item_type
   join public.selection_shared_variants sv on sv.release_id=r.id and sv.item_type=v.item_type and sv.external_id=v.external_id
   join public.selection_shared_titles t on t.release_id=sv.release_id and t.item_type=sv.item_type and t.identity_key=sv.identity_key
   where v.user_id=p_user and v.source_id=p_source and v.generation_id=p_generation
     and ct.match_status is distinct from 'manual' and t.metadata?'tmdbSearchReview'
     and ((t.provider_tmdb_id ~ '^[1-9][0-9]*$' and t.metadata#>>'{tmdbValidation,valid}'='true'
       and t.metadata#>>'{tmdb,id}'=t.provider_tmdb_id and coalesce(public.safe_numeric(t.metadata#>>'{tmdbValidation,confidence}'),0)>=0.9)
     or (t.provider_tmdb_id is null and t.metadata#>>'{tmdbSearchReview,reason}'='old_id_rejected'
       and t.metadata#>'{tmdbSearchReview,rejectedTmdbIds}' @> jsonb_build_array(ct.provider_tmdb_id)))
     and ((v.item_type='movie' and nullif(v.playback_hint->>'targetUrl','') is not null
       and v.playback_hint->>'targetUrl'=sv.playback_hint->>'targetUrl')
     or (v.item_type='series' and exists(select 1 from public.cloud_media_items ep join public.selection_shared_media se
       on se.release_id=r.id and se.item_type='episode' and se.external_id=ep.external_id and se.parent_external_id=sv.external_id
       and se.playback_hint->>'targetUrl'=ep.playback_hint->>'targetUrl'
       where ep.user_id=p_user and ep.source_id=p_source and ep.generation_id=p_generation
         and ep.item_type='episode' and ep.parent_external_id=v.external_id and nullif(ep.playback_hint->>'targetUrl','') is not null)))
     and not exists(select 1 from public.cloud_title_variants other join public.cloud_source_catalog_heads h
       on h.source_id=other.source_id and h.user_id=other.user_id and h.active_generation_id=other.generation_id
       left join public.selection_shared_variants os on os.release_id=r.id and os.item_type=other.item_type
         and os.external_id=other.external_id and os.identity_key=t.identity_key
       where other.user_id=ct.user_id and other.title_id=ct.id and
         (other.source_id<>p_source or os.external_id is null or (other.item_type='movie' and
           (nullif(other.playback_hint->>'targetUrl','') is null or other.playback_hint->>'targetUrl' is distinct from os.playback_hint->>'targetUrl'))))
   order by ct.id,v.external_id
 ), pending as materialized (
   select e.* from eligible e join public.cloud_titles ct on ct.user_id=e.user_id and ct.id=e.id
   where (ct.provider_tmdb_id,ct.match_status,ct.original_title,ct.release_year,ct.poster_url,ct.backdrop_url,ct.metadata,ct.genre_payload,ct.genre_buckets,ct.rating_num)
     is distinct from (e.next_id,e.next_status,e.original_title,e.release_year,e.poster_url,e.backdrop_url,e.next_md,e.genre_payload,e.genre_buckets,e.rating_num)
   order by e.id limit p_limit
 ), changes as (
   update public.cloud_titles ct set provider_tmdb_id=e.next_id,original_title=e.original_title,release_year=e.release_year,
     poster_url=e.poster_url,backdrop_url=e.backdrop_url,metadata=e.next_md,genre_payload=e.genre_payload,genre_buckets=e.genre_buckets,
     rating_num=e.rating_num,match_status=e.next_status,updated_at=statement_timestamp()
   from pending e where ct.id=e.id and ct.user_id=e.user_id returning ct.id
 ) select count(*) into n from changes;
 perform set_config('norva.selection_owned_editorial_context',coalesce(previous_context,''),true);
 if n>0 then
   perform public.norva_bump_user_catalog_visibility_epoch(p_user);
   delete from public.cloud_catalog_facet_summary where user_id=p_user;
 end if;
 return jsonb_build_object('updatedTitles',n);
exception when others then
 perform set_config('norva.selection_owned_editorial_context',coalesce(previous_context,''),true);
 raise;
end $f$;

do $mirror$
declare d text; needle text:=E'\nbegin\n'; guard text;
begin
 select pg_get_functiondef('public.cloud_titles_mirror_to_catalog()'::regprocedure) into d;
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Mirror contract drift'; end if;
 guard:=$g$
  if coalesce(current_setting('norva.selection_owned_editorial_context',true),'')<>'' then
    perform public.norva_credential_require_service_role();
    declare ctx jsonb:=current_setting('norva.selection_owned_editorial_context',true)::jsonb;
    begin
      if jsonb_typeof(ctx)<>'object' or (select count(*) from jsonb_object_keys(ctx))<>3
        or not public.norva_selection_source_identity_valid((ctx->>'sourceId')::uuid,(ctx->>'userId')::uuid)
        or exists(select 1 from changed c where c.user_id is distinct from (ctx->>'userId')::uuid
          or not exists(select 1 from public.cloud_title_variants v join public.cloud_source_catalog_heads h
            on h.source_id=v.source_id and h.user_id=v.user_id and h.active_generation_id=v.generation_id
            where v.user_id=c.user_id and v.title_id=c.id and v.source_id=(ctx->>'sourceId')::uuid
              and v.generation_id=(ctx->>'generationId')::uuid)) then
        raise exception 'Selection mirror owner context is not current' using errcode='42501';
      end if;
    end;
    return null;
  end if;
$g$;
 execute replace(d,needle,needle||guard);
end $mirror$;

create table public.selection_owned_editorial_refresh_cursors(
 source_id uuid primary key references public.cloud_sources(id) on delete cascade,
 last_checked_at timestamptz not null default '-infinity');
alter table public.selection_owned_editorial_refresh_cursors enable row level security;
revoke all on public.selection_owned_editorial_refresh_cursors from public,anon,authenticated;
grant select,insert,update,delete on public.selection_owned_editorial_refresh_cursors to service_role;

create function public.norva_refresh_selection_owned_editorial_all(p_per_source int default 100,p_sources int default 20)
returns jsonb language plpgsql security definer set search_path='' set jit=off as $f$
declare s record; snap jsonb; receipt jsonb; n int:=0; seen int:=0; skipped int:=0;
begin
 perform public.norva_credential_require_service_role();
 if p_per_source is null or p_per_source not between 1 and 500 or p_sources is null or p_sources not between 1 and 100 then
   raise exception 'Bounded source refresh required' using errcode='22023'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('selection-owned-editorial-refresh',0)) then return jsonb_build_object('busy',true,'updatedTitles',0); end if;
 insert into public.selection_owned_editorial_refresh_cursors(source_id)
   select s.id from public.cloud_sources s join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
   where s.enabled and s.source_type='m3u' and h.active_generation_id is not null
     and public.norva_selection_source_identity_valid(s.id,s.user_id) on conflict do nothing;
 for s in select s.id,s.user_id from public.cloud_sources s join public.selection_owned_editorial_refresh_cursors c on c.source_id=s.id
   where s.enabled and s.source_type='m3u' and public.norva_selection_source_identity_valid(s.id,s.user_id)
   order by c.last_checked_at,s.id limit p_sources loop
   begin
     snap:=public.norva_get_catalog_write_snapshot(s.id,s.user_id);
     if snap->>'isCatalogVisible'='true' and snap->>'generationId' is not null then
       receipt:=public.norva_refresh_selection_owned_editorial(s.user_id,s.id,(snap->>'generationId')::uuid,p_per_source);
       n:=n+(receipt->>'updatedTitles')::int; seen:=seen+1;
     else skipped:=skipped+1; end if;
   exception when sqlstate 'PT409' then skipped:=skipped+1; end;
   update public.selection_owned_editorial_refresh_cursors set last_checked_at=statement_timestamp() where source_id=s.id;
 end loop;
 return jsonb_build_object('updatedTitles',n,'sources',seen,'hiddenOrChanged',skipped);
end $f$;

-- Apply the same trust/rejection gate before the maintenance LIMIT; otherwise
-- weak legacy cache records could occupy every slot and starve a later update.
do $gate$
declare d text; needle text;
begin
 select pg_get_functiondef('public.norva_refresh_selection_shared_editorial_from_cache(int)'::regprocedure) into d;
 needle:='and c.metadata#>>''{tmdb,id}''=c.provider_tmdb_id';
 if length(d)-length(replace(d,needle,''))<>length(needle) then raise exception 'Maintenance contract drift'; end if;
 d:=replace(d,needle,needle||' and (coalesce(public.safe_numeric(c.metadata#>>''{tmdbValidation,confidence}''),0)>=0.9
   or c.metadata#>>''{tmdbValidation,reason}''=''poster_path_confirmed'')
   and not coalesce(t.metadata#>''{tmdbSearchReview,rejectedTmdbIds}'',''[]''::jsonb) @> jsonb_build_array(c.provider_tmdb_id)');
 execute d;
end $gate$;
revoke all on function public.norva_refresh_selection_owned_editorial(uuid,uuid,uuid,int),
 public.norva_refresh_selection_owned_editorial_all(int,int) from public,anon,authenticated;
grant execute on function public.norva_refresh_selection_owned_editorial(uuid,uuid,uuid,int),
 public.norva_refresh_selection_owned_editorial_all(int,int) to service_role;
notify pgrst,'reload schema';
commit;

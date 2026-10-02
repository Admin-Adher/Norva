begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- File manifests and owner bindings remain pinned. Editorial fields can be
-- refreshed independently from the already validated, public TMDB cache.
alter table public.selection_shared_releases add column editorial_updated_at timestamptz;

create or replace function public.norva_selection_shared_publish_guard()
returns trigger language plpgsql set search_path='' as $f$
begin
 if old.published_at is not null then
   if (to_jsonb(new)-'editorial_updated_at') is distinct from (to_jsonb(old)-'editorial_updated_at') then
     raise exception 'Published Selection releases are immutable' using errcode='PT409'; end if;
   return new;
 end if;
 if new.published_at is not null and (select count(*) from public.selection_shared_live_variants where release_id=new.id)
   <>coalesce((new.counts->>'live')::int,0) then
   raise exception 'Selection live projection incomplete' using errcode='PT409'; end if;
 return new;
end $f$;

create function public.norva_selection_public_editorial_metadata(p_metadata jsonb)
returns jsonb language sql immutable parallel safe set search_path='' as $f$
 select jsonb_strip_nulls(jsonb_build_object(
   'tmdb',(select jsonb_object_agg(k,v) from jsonb_each(case when jsonb_typeof(p_metadata->'tmdb')='object' then p_metadata->'tmdb' else '{}' end) x(k,v)
     where k=any(array['id','title','name','original_title','original_name','overview','genres','runtime',
       'vote_average','release_date','first_air_date','poster_path','backdrop_path','status','confidence','matched'])
       and v<>'null'::jsonb and v<>'""'::jsonb),
   'i18n',(select jsonb_object_agg(lang,loc) from (
     select k lang,(select jsonb_object_agg(f,value) from jsonb_each(v) y(f,value)
       where f in ('title','overview') and jsonb_typeof(value)='string' and value<>'""'::jsonb) loc
     from jsonb_each(case when jsonb_typeof(p_metadata->'i18n')='object' then p_metadata->'i18n' else '{}' end) x(k,v)
     where k ~ '^[a-z]{2}(-[A-Za-z]{2,4})?$' and jsonb_typeof(v)='object'
   ) locales where loc is not null),
   'tmdbValidation',(select jsonb_object_agg(k,v) from jsonb_each(case when jsonb_typeof(p_metadata->'tmdbValidation')='object' then p_metadata->'tmdbValidation' else '{}' end) x(k,v)
     where k in ('valid','reason','title','year','confidence'))
 ))
$f$;

create function public.norva_merge_selection_editorial_metadata(p_base jsonb,p_public jsonb)
returns jsonb language sql immutable parallel safe set search_path='' as $f$
 select (case when jsonb_typeof(p_base)='object' then p_base else '{}' end) || jsonb_build_object(
   'tmdb',(case when jsonb_typeof(p_base->'tmdb')='object' then p_base->'tmdb' else '{}' end)
     ||(case when jsonb_typeof(p_public->'tmdb')='object' then p_public->'tmdb' else '{}' end),
   'i18n',coalesce((select jsonb_object_agg(k,
     (case when jsonb_typeof(p_base->'i18n'->k)='object' then p_base->'i18n'->k else '{}' end)
       ||(case when jsonb_typeof(p_public->'i18n'->k)='object' then p_public->'i18n'->k else '{}' end))
     from (select jsonb_object_keys(case when jsonb_typeof(p_base->'i18n')='object' then p_base->'i18n' else '{}' end) k
       union select jsonb_object_keys(case when jsonb_typeof(p_public->'i18n')='object' then p_public->'i18n' else '{}' end) k) langs),'{}'),
   'tmdbValidation',coalesce(p_public->'tmdbValidation',p_base->'tmdbValidation','{}'))
$f$;

create function public.norva_refresh_selection_shared_editorial(
 p_release_id uuid,p_manifest_sha256 text,p_item_type text,p_identity_keys text[],
 p_donor_user_id uuid default null,p_donor_source_id uuid default null,p_donor_generation_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' set jit=off as $f$
declare v_release public.selection_shared_releases; snap jsonb; n int; conflicts int; ambiguous int;
  v_owner uuid; started timestamptz:=clock_timestamp();
begin
 perform public.norva_credential_require_service_role();
 if p_item_type is null or p_item_type not in ('movie','series') or p_release_id is null or p_manifest_sha256 is null
   or p_identity_keys is null or cardinality(p_identity_keys) not between 1 and 500
   or array_position(p_identity_keys,null) is not null
   or cardinality(p_identity_keys)<>(select count(distinct k) from unnest(p_identity_keys) k)
   or ((p_donor_user_id is null)::int+(p_donor_source_id is null)::int+(p_donor_generation_id is null)::int) not in (0,3) then
   raise exception 'Bounded qualified Selection editorial batch required' using errcode='22023'; end if;
 if p_donor_source_id is not null then
   if not public.norva_selection_source_identity_valid(p_donor_source_id,p_donor_user_id) then
     raise exception 'Canonical donor ownership required' using errcode='42501'; end if;
   perform 1 from public.cloud_sources where id=p_donor_source_id and user_id=p_donor_user_id for share;
   perform 1 from public.cloud_source_catalog_heads h join public.cloud_source_lifecycle l
     on l.source_id=h.source_id and l.user_id=h.user_id
     where h.source_id=p_donor_source_id and h.user_id=p_donor_user_id for share of h,l;
   snap:=public.norva_get_catalog_write_snapshot(p_donor_source_id,p_donor_user_id);
   if snap->>'generationId' is distinct from p_donor_generation_id::text or snap->>'isCatalogVisible' is distinct from 'true' then
     raise exception 'Selection donor snapshot changed' using errcode='PT409'; end if;
 end if;
 select * into v_release from public.selection_shared_releases where id=p_release_id for update;
 if v_release.id is null or v_release.published_at is null or v_release.manifest_sha256 is distinct from p_manifest_sha256 then
   raise exception 'Selection release changed' using errcode='PT409'; end if;
 -- The donor supplies only an existing identity association for an identical
 -- public file. Display data comes exclusively from catalog_titles, never from
 -- another account's metadata, preferences, probes or playback state.
 with matches as materialized (
   select sv.identity_key,t.provider_tmdb_id
   from public.selection_shared_variants sv
   join public.cloud_catalog_visible_title_variants v on v.source_id=p_donor_source_id and v.user_id=p_donor_user_id
     and v.generation_id=p_donor_generation_id and v.item_type=sv.item_type and v.external_id=sv.external_id
   join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
   where sv.release_id=p_release_id and sv.item_type=p_item_type and sv.identity_key=any(p_identity_keys)
     and t.match_status in ('provider_verified','matched','manual') and t.provider_tmdb_id ~ '^[1-9][0-9]*$'
     and t.metadata#>>'{tmdbValidation,valid}'='true' and t.metadata#>>'{tmdb,id}'=t.provider_tmdb_id
     and ((p_item_type='movie' and nullif(sv.playback_hint->>'targetUrl','') is not null
         and sv.playback_hint->>'targetUrl'=v.playback_hint->>'targetUrl')
       or (p_item_type='series' and exists (
         select 1 from public.cloud_catalog_visible_media_items ep
         join public.selection_shared_media se on se.release_id=sv.release_id and se.item_type='episode'
           and se.external_id=ep.external_id and se.parent_external_id=sv.external_id
           and se.playback_hint->>'targetUrl'=ep.playback_hint->>'targetUrl'
         where ep.user_id=v.user_id and ep.source_id=v.source_id and ep.generation_id=v.generation_id
           and ep.item_type='episode' and ep.parent_external_id=v.external_id
           and nullif(ep.playback_hint->>'targetUrl','') is not null)))
 ), associations as materialized (
   select identity_key,min(provider_tmdb_id) id,count(distinct provider_tmdb_id) n
   from matches group by identity_key
 ), eligible as materialized (
   select t.*,c.original_title c_original_title,c.release_year c_release_year,
     c.poster_url c_poster_url,c.backdrop_url c_backdrop_url,
     public.norva_merge_selection_editorial_metadata(t.metadata,
       public.norva_selection_public_editorial_metadata(c.metadata)) next_metadata,
     c.provider_tmdb_id next_id
   from public.selection_shared_titles t left join associations a using(identity_key)
   join public.catalog_titles c on c.item_type=t.item_type and c.provider_tmdb_id=coalesce(a.id,t.provider_tmdb_id)
   where t.release_id=p_release_id and t.item_type=p_item_type and t.identity_key=any(p_identity_keys)
     and (a.n=1 or (a.n is null and t.match_status in ('provider_verified','matched','manual')
       and t.metadata#>>'{tmdbValidation,valid}'='true' and t.metadata#>>'{tmdb,id}'=t.provider_tmdb_id))
     and (t.provider_tmdb_id is null or t.provider_tmdb_id=c.provider_tmdb_id)
     and c.provider_tmdb_id ~ '^[1-9][0-9]*$' and c.metadata#>>'{tmdbValidation,valid}'='true'
     and c.metadata#>>'{tmdb,id}'=c.provider_tmdb_id
 ), changes as (
   update public.selection_shared_titles t set provider_tmdb_id=x.next_id,match_status='provider_verified',
     original_title=coalesce(x.c_original_title,t.original_title),release_year=coalesce(x.c_release_year,t.release_year),
     poster_url=coalesce(nullif(x.c_poster_url,''),t.poster_url),backdrop_url=coalesce(nullif(x.c_backdrop_url,''),t.backdrop_url),
     metadata=x.next_metadata,genre_payload=coalesce(x.next_metadata#>'{tmdb,genres}',t.genre_payload),
     genre_buckets=public.norva_classify_buckets(t.genre_category,coalesce(x.next_metadata#>'{tmdb,genres}',t.genre_payload)),
     rating_num=coalesce(public.safe_numeric(x.next_metadata#>>'{tmdb,vote_average}'),t.rating_num)
   from eligible x where t.release_id=x.release_id and t.item_type=x.item_type and t.identity_key=x.identity_key
     and (t.provider_tmdb_id,t.match_status,t.original_title,t.release_year,t.poster_url,t.backdrop_url,t.metadata,t.genre_payload,t.genre_buckets,t.rating_num)
       is distinct from (x.next_id,'provider_verified',coalesce(x.c_original_title,t.original_title),coalesce(x.c_release_year,t.release_year),
       coalesce(nullif(x.c_poster_url,''),t.poster_url),coalesce(nullif(x.c_backdrop_url,''),t.backdrop_url),x.next_metadata,
       coalesce(x.next_metadata#>'{tmdb,genres}',t.genre_payload),
       public.norva_classify_buckets(t.genre_category,coalesce(x.next_metadata#>'{tmdb,genres}',t.genre_payload)),
       coalesce(public.safe_numeric(x.next_metadata#>>'{tmdb,vote_average}'),t.rating_num))
   returning t.identity_key
 ) select (select count(*) from changes),
   (select count(*) from associations a join public.selection_shared_titles t using(identity_key)
     where t.release_id=p_release_id and t.item_type=p_item_type and a.n=1 and t.provider_tmdb_id is not null and t.provider_tmdb_id<>a.id),
   (select count(*) from associations a where a.n>1) into n,conflicts,ambiguous;
 if n>0 then
   update public.selection_shared_releases set editorial_updated_at=clock_timestamp() where id=p_release_id;
   for v_owner in select distinct user_id from public.selection_shared_visible_enrollments where release_id=p_release_id order by user_id loop
     perform public.norva_bump_user_catalog_visibility_epoch(v_owner);
     delete from public.cloud_catalog_facet_summary where user_id=v_owner;
   end loop;
 end if;
 return jsonb_build_object('updatedTitles',n,'conflictingIds',conflicts,'ambiguousIds',ambiguous,
   'releaseId',p_release_id,'elapsedMs',1000*extract(epoch from clock_timestamp()-started));
end $f$;

-- Routine maintenance refreshes only already verified public identities. It
-- neither guesses associations nor creates another customer's inventory.
create function public.norva_refresh_selection_shared_editorial_from_cache(p_limit int default 250)
returns jsonb language plpgsql security definer set search_path='' set jit=off as $f$
declare batch record; receipt jsonb; total int:=0; batches int:=0;
begin
 perform public.norva_credential_require_service_role();
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'Bounded editorial maintenance required' using errcode='22023'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('selection-shared-editorial-cache-refresh',0)) then
   return jsonb_build_object('updatedTitles',0,'busy',true); end if;
 for batch in
   with pending as materialized (
     select t.release_id,r.manifest_sha256,t.item_type,t.identity_key
     from public.selection_shared_titles t join public.selection_shared_releases r on r.id=t.release_id and r.published_at is not null
     join public.catalog_titles c on c.item_type=t.item_type and c.provider_tmdb_id=t.provider_tmdb_id
     cross join lateral (select public.norva_merge_selection_editorial_metadata(t.metadata,
       public.norva_selection_public_editorial_metadata(c.metadata)) metadata) next
     where t.match_status in ('provider_verified','matched','manual') and t.provider_tmdb_id ~ '^[1-9][0-9]*$'
       and t.metadata#>>'{tmdbValidation,valid}'='true' and t.metadata#>>'{tmdb,id}'=t.provider_tmdb_id
       and c.metadata#>>'{tmdbValidation,valid}'='true' and c.metadata#>>'{tmdb,id}'=c.provider_tmdb_id
       and (t.match_status,t.original_title,t.release_year,t.poster_url,t.backdrop_url,t.metadata,t.genre_payload,t.genre_buckets,t.rating_num)
         is distinct from ('provider_verified',coalesce(c.original_title,t.original_title),coalesce(c.release_year,t.release_year),
         coalesce(nullif(c.poster_url,''),t.poster_url),coalesce(nullif(c.backdrop_url,''),t.backdrop_url),next.metadata,
         coalesce(next.metadata#>'{tmdb,genres}',t.genre_payload),
         public.norva_classify_buckets(t.genre_category,coalesce(next.metadata#>'{tmdb,genres}',t.genre_payload)),
         coalesce(public.safe_numeric(next.metadata#>>'{tmdb,vote_average}'),t.rating_num))
     order by r.published_at desc,t.item_type,t.identity_key limit p_limit
   ) select release_id,manifest_sha256,item_type,array_agg(identity_key order by identity_key) keys
     from pending group by release_id,manifest_sha256,item_type order by release_id,item_type
 loop
   receipt:=public.norva_refresh_selection_shared_editorial(batch.release_id,batch.manifest_sha256,batch.item_type,batch.keys);
   total:=total+(receipt->>'updatedTitles')::int; batches:=batches+1;
 end loop;
 return jsonb_build_object('updatedTitles',total,'batches',batches);
end $f$;

-- Bound files must use the same refreshed editorial fields as unplayed cards.
-- This is a read overlay, not an owner inventory rewrite. Conflicting owned
-- identities, changed file URLs and inactive/foreign enrollments are excluded.
create view public.selection_shared_bound_editorial with(security_invoker=true,security_barrier=true) as
with candidates as (
 select e.user_id,owned.id title_id,t.provider_tmdb_id,t.original_title,t.release_year,t.poster_url,t.backdrop_url,
   public.norva_selection_public_editorial_metadata(t.metadata) metadata,t.genre_payload,t.genre_buckets,t.rating_num,
   r.published_at,r.editorial_updated_at
 from public.selection_shared_visible_enrollments e
 join public.selection_shared_releases r on r.id=e.release_id
 join public.cloud_title_variants v on v.user_id=e.user_id and v.source_id=e.source_id and v.generation_id=e.generation_id
 join public.cloud_titles owned on owned.user_id=v.user_id and owned.id=v.title_id and owned.item_type=v.item_type
 join public.selection_shared_variants sv on sv.release_id=e.release_id and sv.item_type=v.item_type and sv.external_id=v.external_id
 join public.selection_shared_titles t on t.release_id=sv.release_id and t.item_type=sv.item_type and t.identity_key=sv.identity_key
 where t.match_status in ('provider_verified','matched','manual') and t.metadata#>>'{tmdbValidation,valid}'='true'
   and t.provider_tmdb_id ~ '^[1-9][0-9]*$' and t.metadata#>>'{tmdb,id}'=t.provider_tmdb_id
   and (owned.provider_tmdb_id is null or owned.provider_tmdb_id=t.provider_tmdb_id)
   and ((v.item_type='movie' and nullif(v.playback_hint->>'targetUrl','') is not null
       and v.playback_hint->>'targetUrl'=sv.playback_hint->>'targetUrl')
     or (v.item_type='series' and exists (
       select 1 from public.cloud_catalog_visible_media_items ep join public.selection_shared_media se
         on se.release_id=e.release_id and se.item_type='episode' and se.external_id=ep.external_id
           and se.parent_external_id=sv.external_id and se.playback_hint->>'targetUrl'=ep.playback_hint->>'targetUrl'
       where ep.user_id=e.user_id and ep.source_id=e.source_id and ep.generation_id=e.generation_id
         and ep.item_type='episode' and ep.parent_external_id=v.external_id and nullif(ep.playback_hint->>'targetUrl','') is not null)))
), consistent as (
 select *,min(provider_tmdb_id) over(partition by user_id,title_id) lo,
   max(provider_tmdb_id) over(partition by user_id,title_id) hi from candidates
)
select distinct on(user_id,title_id) user_id,title_id,provider_tmdb_id,original_title,release_year,poster_url,backdrop_url,
 metadata,genre_payload,genre_buckets,rating_num
from consistent where lo=hi order by user_id,title_id,coalesce(editorial_updated_at,published_at) desc;

-- Generate the existing view's column list from its own contract, changing
-- editorial columns only. Preserve ownership, file/language scope and routing.
do $migration$
declare columns text; definition text;
begin
 select string_agg(case
   when attname in ('provider_tmdb_id','original_title','release_year','poster_url','backdrop_url','genre_payload','genre_buckets','rating_num')
     then format('coalesce(e.%1$I,p.%1$I) as %1$I',attname)
   when attname='match_status' then 'case when e.title_id is not null then ''provider_verified'' else p.match_status end as match_status'
   when attname='metadata' then 'case when e.title_id is not null then public.norva_merge_selection_editorial_metadata(p.metadata,e.metadata) else p.metadata end as metadata'
   when attname='has_poster' then 'coalesce(e.poster_url,p.poster_url) is not null as has_poster'
   else format('p.%I',attname) end,',' order by attnum) into columns
 from pg_attribute where attrelid='public.selection_shared_physical_titles'::regclass and attnum>0 and not attisdropped;
 execute 'create or replace view public.cloud_catalog_visible_titles with(security_invoker=true,security_barrier=true) as '
   ||'select '||columns||' from public.selection_shared_physical_titles p left join public.selection_shared_bound_editorial e '
   ||'on e.user_id=p.user_id and e.title_id=p.id union all select * from public.selection_shared_visible_titles';
 select pg_get_viewdef('public.selection_shared_visible_titles'::regclass,true) into definition;
 if position('r.published_at AS updated_at' in definition)=0 then raise exception 'Shared title timestamp contract drift'; end if;
 execute 'create or replace view public.selection_shared_visible_titles with(security_invoker=true) as '
   ||replace(definition,'r.published_at AS updated_at','coalesce(r.editorial_updated_at,r.published_at) AS updated_at');
end $migration$;

alter function public.norva_get_visible_catalog_titles_by_ids(uuid,uuid[],bigint)
 rename to norva_get_visible_catalog_titles_before_shared_editorial;
revoke all on function public.norva_get_visible_catalog_titles_before_shared_editorial(uuid,uuid[],bigint) from public,anon,authenticated;
grant execute on function public.norva_get_visible_catalog_titles_before_shared_editorial(uuid,uuid[],bigint) to service_role;
create function public.norva_get_visible_catalog_titles_by_ids(p_user_id uuid,p_title_ids uuid[],p_expected_visibility_epoch bigint)
returns jsonb language plpgsql stable security definer set search_path='' set jit=off as $f$
declare result jsonb; items jsonb;
begin
 result:=public.norva_get_visible_catalog_titles_before_shared_editorial(p_user_id,p_title_ids,p_expected_visibility_epoch);
 if not public.norva_selection_shared_active(p_user_id) then return result; end if;
 select coalesce(jsonb_agg(case when e.title_id is null then x else x||jsonb_build_object(
   'provider_tmdb_id',e.provider_tmdb_id,'match_status','provider_verified',
   'original_title',coalesce(e.original_title,x->>'original_title'),'release_year',coalesce(to_jsonb(e.release_year),x->'release_year'),
   'poster_url',coalesce(e.poster_url,x->>'poster_url'),'backdrop_url',coalesce(e.backdrop_url,x->>'backdrop_url'),
   'metadata',public.norva_merge_selection_editorial_metadata(x->'metadata',e.metadata),
   'genre_payload',coalesce(e.genre_payload,x->'genre_payload'),'genre_buckets',coalesce(to_jsonb(e.genre_buckets),x->'genre_buckets'),
   'rating_num',coalesce(to_jsonb(e.rating_num),x->'rating_num'),
   'overlay_catalog_metadata',case when nullif(x->>'overlay_generation_id','') is not null
     then public.norva_merge_selection_editorial_metadata(x->'overlay_catalog_metadata',e.metadata) else x->'overlay_catalog_metadata' end
 ) end order by ord),'[]') into items
 from jsonb_array_elements(result->'items') with ordinality j(x,ord)
 left join public.selection_shared_bound_editorial e on e.user_id=p_user_id and e.title_id=(x->>'id')::uuid
   and x->>'user_id'=p_user_id::text and (x->>'provider_tmdb_id' is null or x->>'provider_tmdb_id'=e.provider_tmdb_id);
 if octet_length(items::text)>8388608 then raise exception 'Catalog hydration response exceeds bound' using errcode='54000'; end if;
 return jsonb_set(result,'{items}',items);
end $f$;

revoke all on function public.norva_selection_public_editorial_metadata(jsonb),
 public.norva_merge_selection_editorial_metadata(jsonb,jsonb),
 public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid),
 public.norva_refresh_selection_shared_editorial_from_cache(int),
 public.norva_get_visible_catalog_titles_by_ids(uuid,uuid[],bigint) from public,anon,authenticated;
grant execute on function public.norva_selection_public_editorial_metadata(jsonb),
 public.norva_merge_selection_editorial_metadata(jsonb,jsonb),
 public.norva_refresh_selection_shared_editorial(uuid,text,text,text[],uuid,uuid,uuid),
 public.norva_refresh_selection_shared_editorial_from_cache(int),
 public.norva_get_visible_catalog_titles_by_ids(uuid,uuid[],bigint) to service_role;
revoke all on public.selection_shared_bound_editorial from public,anon,authenticated;
grant select on public.selection_shared_bound_editorial to service_role;
notify pgrst,'reload schema';
commit;

begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create function public.norva_selection_shared_active(p_user_id uuid)
returns boolean language sql stable set search_path='' as $f$
 select exists(select 1 from public.selection_shared_visible_enrollments where user_id=p_user_id)
$f$;

alter function public.norva_get_visible_catalog_titles_by_ids(uuid,uuid[],bigint)
 rename to norva_get_visible_catalog_titles_before_shared;
create function public.norva_get_visible_catalog_titles_by_ids(p_user_id uuid,p_title_ids uuid[],p_expected_visibility_epoch bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare v_result jsonb; v_items jsonb;
begin
  -- The original hydrator enforces service ownership, bounds and epoch checks,
  -- and retains candidate overlays for the owner's ordinary providers.
  v_result:=public.norva_get_visible_catalog_titles_before_shared(p_user_id,p_title_ids,p_expected_visibility_epoch);
  if not public.norva_selection_shared_active(p_user_id) then return v_result; end if;
  with shared as materialized (
      select t.id,to_jsonb(t)||jsonb_build_object('base_updated_at',t.updated_at,'overlay_catalog_metadata',null,
        'best_generation_id',e.generation_id,'display_generation_id',e.generation_id,'overlay_generation_id',null)
        item
      from public.selection_shared_visible_titles t
      join public.selection_shared_visible_enrollments e on e.user_id=t.user_id and e.source_id=t.visible_source_ids[1]
      where t.user_id=p_user_id and t.id=any(p_title_ids)
  ), entries as (
    select (value->>'id')::uuid id,value item from jsonb_array_elements(v_result->'items')
    union all select id,item from shared
  ) select coalesce(jsonb_agg(item order by array_position(p_title_ids,id)),'[]') into v_items from entries;
  if octet_length(v_items::text)>8388608 then raise exception 'Catalog hydration response exceeds bound' using errcode='54000'; end if;
  return jsonb_set(v_result,'{items}',v_items);
end
$f$;

alter function public.norva_select_catalog_title_ordered_page(uuid,text,text,integer,integer,jsonb,bigint)
 rename to norva_select_catalog_title_page_before_shared;
-- Reuse the existing bounded/indexed physical selector when an account has
-- other large providers. Add private merge keys without changing its public
-- predecessor's result or scanning every physical title runtime.
do $migration$
declare definition text; anchor text:='''id'', v_row.title_id,';
begin
 definition:=pg_get_functiondef('public.norva_select_catalog_title_page_before_shared(uuid,text,text,integer,integer,jsonb,bigint)'::regprocedure);
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>2 then
   raise exception 'Physical selector merge-key drift'; end if;
 definition:=replace(definition,'FUNCTION public.norva_select_catalog_title_page_before_shared(',
   'FUNCTION public.norva_selection_shared_physical_page(');
 definition:=replace(definition,anchor,anchor||'
   ''sort1'',v_row.sort_1,''sort2'',v_row.sort_2,''branch'',v_row.branch,
   ''projectionGenerationId'',v_row.projection_generation_id,');
 execute definition;
end
$migration$;
revoke all on function public.norva_selection_shared_physical_page(uuid,text,text,integer,integer,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.norva_selection_shared_physical_page(uuid,text,text,integer,integer,jsonb,bigint) to service_role;
create function public.norva_select_catalog_title_ordered_page(p_user_id uuid,p_item_type text,p_mode text,
 p_limit integer default 100,p_scan_limit integer default 500,p_cursor jsonb default null,p_expected_visibility_epoch bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare v_epoch bigint; v_rows jsonb; v_count integer; v_last jsonb; v_cursor jsonb; v_physical jsonb; v_physical_cursor jsonb;
begin
  perform public.norva_credential_require_service_role();
  if not public.norva_selection_shared_active(p_user_id) then
    return public.norva_select_catalog_title_page_before_shared(p_user_id,p_item_type,p_mode,p_limit,p_scan_limit,p_cursor,p_expected_visibility_epoch);
  end if;
  perform public.norva_credential_lock_account(p_user_id);
  if p_user_id is null or p_item_type not in ('movie','series') or p_mode not in ('home_verified','home_recent')
    or p_limit is null or p_limit not between 1 and 300 or p_scan_limit is null or p_scan_limit not between p_limit and 1000 then
    raise exception 'Invalid catalog page arguments' using errcode='22023'; end if;
  select visibility_epoch into v_epoch from public.cloud_user_catalog_visibility_epochs where user_id=p_user_id;
  v_epoch:=coalesce(v_epoch,1);
  if p_expected_visibility_epoch is distinct from v_epoch then raise exception 'Catalog visibility changed' using errcode='PT409'; end if;
  if p_cursor is not null and (p_cursor->>'contract' is distinct from 'selection-shared-page-v1'
    or p_cursor->>'userId' is distinct from p_user_id::text or p_cursor->>'itemType' is distinct from p_item_type
    or p_cursor->>'mode' is distinct from p_mode or (p_cursor->>'visibilityEpoch')::bigint is distinct from v_epoch
    or nullif(p_cursor->>'sort1','') is null or nullif(p_cursor->>'sort2','') is null or nullif(p_cursor->>'titleId','') is null) then
    raise exception 'Catalog cursor mismatch' using errcode='22023'; end if;
  if p_cursor is not null then
    v_physical_cursor:=p_cursor||jsonb_build_object('branch',coalesce((p_cursor->>'branch')::int,1),
      'projectionGenerationId',p_cursor->'projectionGenerationId');
  end if;
  v_physical:=public.norva_selection_shared_physical_page(p_user_id,p_item_type,p_mode,p_limit,p_scan_limit,v_physical_cursor,p_expected_visibility_epoch);
  with candidates as (
    select t.id,case when p_mode='home_recent' then t.created_at else t.synced_at end sort1,
      case when p_mode='home_recent' then t.synced_at else t.updated_at end sort2,1 branch,null::uuid as "projectionGenerationId"
    from public.selection_shared_visible_titles t where t.user_id=p_user_id and t.item_type=p_item_type
      and (p_mode<>'home_verified' or t.match_status='provider_verified')
  ), page as (
    select * from candidates c where p_cursor is null
      or c.sort1<(p_cursor->>'sort1')::timestamptz
      or (c.sort1=(p_cursor->>'sort1')::timestamptz and c.sort2<(p_cursor->>'sort2')::timestamptz)
      or (c.sort1=(p_cursor->>'sort1')::timestamptz and c.sort2=(p_cursor->>'sort2')::timestamptz and c.id>(p_cursor->>'titleId')::uuid)
    order by sort1 desc,sort2 desc,id limit p_limit+1
  ), merged as (
    select * from page union all
    select (x->>'id')::uuid,(x->>'sort1')::timestamptz,(x->>'sort2')::timestamptz,(x->>'branch')::int,
      (x->>'projectionGenerationId')::uuid from jsonb_array_elements(v_physical->'items') x
  ), bounded as (select * from merged order by sort1 desc,sort2 desc,id limit p_limit+1)
  select coalesce(jsonb_agg(to_jsonb(bounded) order by sort1 desc,sort2 desc,id),'[]'),count(*) into v_rows,v_count from bounded;
  if v_count>p_limit or (v_physical->>'complete')::boolean is not true then
    if v_count>p_limit then v_rows:=v_rows-p_limit; end if;
    v_last:=v_rows->(jsonb_array_length(v_rows)-1);
    if v_last is null then v_last:=(v_physical->'nextCursor')||jsonb_build_object('id',v_physical->'nextCursor'->'titleId'); end if;
    v_cursor:=jsonb_build_object('contract','selection-shared-page-v1','userId',p_user_id,'itemType',p_item_type,
      'mode',p_mode,'visibilityEpoch',v_epoch,'titleId',v_last->'id','sort1',v_last->'sort1','sort2',v_last->'sort2',
      'branch',coalesce(v_last->'branch','1'::jsonb),'projectionGenerationId',v_last->'projectionGenerationId');
  end if;
  return jsonb_build_object('contract','catalog-title-selector-v2','mode',p_mode,'visibilityEpoch',v_epoch,
    'items',v_rows,'returnedTitles',jsonb_array_length(v_rows),'inspectedTitles',jsonb_array_length(v_rows),
    'scanLimit',p_scan_limit,'complete',v_cursor is null,'nextCursor',v_cursor);
end
$f$;

-- Read-only RPCs that previously bypassed the visible views must include the
-- shared inventory. Their ownership, source, generation and paging predicates
-- remain in place. Do not rewrite writers or their physical FK checks.
do $migration$
declare p record; definition text; updated text; arguments text; signature text; header text; expression text; owner_argument text;
begin
 for p in select oid,proname,proargnames,pronargs,proretset from pg_proc where pronamespace='public'::regnamespace and proname in (
   'list_media_items_deduped','search_media_items',
   'cloud_catalog_visible_title_language_page') loop
   definition:=pg_get_functiondef(p.oid);
   updated:=replace(replace(replace(definition,
     'public.cloud_media_items ', 'public.cloud_catalog_visible_media_items '),
     'public.cloud_title_variants ', 'public.cloud_catalog_visible_title_variants '),
     'public.cloud_titles ', 'public.cloud_catalog_visible_titles ');
   if updated=definition then raise exception 'Shared read consumer drift: %',p.proname; end if;
   signature:=pg_get_function_identity_arguments(p.oid);
   select string_agg(quote_ident(name),',' order by ord) into arguments
     from unnest(p.proargnames[1:p.pronargs]) with ordinality x(name,ord);
   owner_argument:=quote_ident(p.proargnames[1]);
   execute format('alter function public.%I(%s) rename to %I',p.proname,signature,p.proname||'_physical');
   execute replace(updated,'FUNCTION public.'||p.proname||'(','FUNCTION public.'||p.proname||'_shared(');
   header:=replace(split_part(definition,'AS $function$',1),'LANGUAGE sql','LANGUAGE plpgsql');
   expression:=case when p.proretset then 'return query select * from ' else 'return ' end;
   execute header||format('AS $wrapper$ begin
     if public.norva_selection_shared_active(%s) then %spublic.%I(%s);
     else %spublic.%I(%s); end if; end $wrapper$',
     owner_argument,expression,p.proname||'_shared',arguments,expression,p.proname||'_physical',arguments);
   execute format('revoke all on function public.%I(%s),public.%I(%s) from public,anon,authenticated',
     p.proname,signature,p.proname||'_shared',signature);
   execute format('grant execute on function public.%I(%s),public.%I(%s) to service_role',
     p.proname,signature,p.proname||'_shared',signature);
 end loop;
end
$migration$;

alter function public.cloud_genre_bucket_counts(uuid,text,uuid) rename to cloud_genre_counts_before_shared;
create function public.cloud_genre_bucket_counts(p_user_id uuid,p_item_type text,p_source_id uuid default null)
returns table(bucket text,n bigint) language plpgsql stable security definer set search_path='' as $f$
begin
 perform public.norva_credential_require_service_role();
 if not public.norva_selection_shared_active(p_user_id) then
   return query select * from public.cloud_genre_counts_before_shared(p_user_id,p_item_type,p_source_id); return; end if;
 return query select b,count(*) from public.cloud_catalog_visible_titles t
 cross join lateral unnest(coalesce(t.genre_buckets,array['autres'])) b
 where t.user_id=p_user_id and t.item_type=p_item_type and (p_source_id is null or p_source_id=any(t.visible_source_ids))
 group by b;
end
$f$;
revoke all on function public.cloud_genre_bucket_counts(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.cloud_genre_bucket_counts(uuid,text,uuid) to service_role;

alter function public.norva_get_genre_rail_candidates(uuid,text,bigint) rename to norva_genre_candidates_before_shared;
create function public.norva_get_genre_rail_candidates(p_user_id uuid,p_item_type text,p_expected_visibility_epoch bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $f$
declare v_epoch bigint; v_candidates jsonb;
begin
 perform public.norva_credential_require_service_role();
 if not public.norva_selection_shared_active(p_user_id) then
   return public.norva_genre_candidates_before_shared(p_user_id,p_item_type,p_expected_visibility_epoch); end if;
 if p_user_id is null or p_item_type not in ('movie','series') or p_expected_visibility_epoch is null then
   raise exception 'Invalid genre arguments' using errcode='22023'; end if;
 select visibility_epoch into v_epoch from public.cloud_user_catalog_visibility_epochs where user_id=p_user_id;
 if v_epoch is distinct from p_expected_visibility_epoch then raise exception 'Catalog visibility changed' using errcode='PT409'; end if;
 with ranked as (
   select t.id,t.genre_buckets,t.created_at,bucket,
     row_number() over(partition by bucket order by t.created_at desc,t.id) ordinal
   from public.cloud_catalog_visible_titles t cross join lateral unnest(t.genre_buckets) bucket
   where t.user_id=p_user_id and t.item_type=p_item_type
 ), buckets as (
   select bucket,jsonb_agg(jsonb_build_object('id',id,'genreBuckets',genre_buckets,'createdAt',created_at) order by ordinal) items
   from ranked where ordinal<=150 group by bucket
 ) select coalesce(jsonb_object_agg(bucket,items),'{}') into v_candidates from buckets;
 return jsonb_build_object('contract','catalog-genre-rail-candidates-v1','visibilityEpoch',v_epoch,
   'refreshedAt',now(),'candidates',v_candidates);
end
$f$;
revoke all on function public.norva_get_genre_rail_candidates(uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.norva_get_genre_rail_candidates(uuid,text,bigint) to service_role;

create function public.norva_selection_shared_languages(p_user_id uuid,p_item_type text,p_source_id uuid,p_kind text,p_language text)
returns table(title_id uuid,variant_id uuid,language text) language sql stable set search_path='' set jit=off as $f$
 select distinct coalesce(t.id,public.norva_selection_shared_uuid('title:'||e.user_id::text||':'||v.item_type||':'||v.identity_key)),
   coalesce(owned.id,public.norva_selection_shared_uuid('variant:'||e.source_id::text||':'||e.generation_id::text||':'||v.item_type||':'||v.external_id)),l.language
 from public.selection_shared_visible_enrollments e
 join public.selection_shared_languages l on l.release_id=e.release_id and l.item_type=p_item_type and l.kind=p_kind
 join public.selection_shared_variants v on v.release_id=l.release_id and v.item_type=l.item_type and v.external_id=l.external_id
 left join public.cloud_titles t on t.user_id=e.user_id and t.item_type=v.item_type and t.identity_key=v.identity_key
 left join public.cloud_title_variants owned on owned.user_id=e.user_id and owned.source_id=e.source_id and owned.generation_id=e.generation_id
   and owned.item_type=v.item_type and owned.external_id=v.external_id
 where e.user_id=p_user_id and (p_source_id is null or e.source_id=p_source_id) and (p_language is null or l.language=p_language)
   and not exists(select 1 from public.cloud_title_file_language_observations o where o.user_id=e.user_id and o.variant_id=owned.id
     and o.file_external_id=v.external_id and case when p_kind='audio' then o.audio_observed else o.subtitle_observed end)
$f$;

alter function public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text) rename to cloud_catalog_effective_audio_before_shared;
create function public.cloud_catalog_effective_audio_languages(p_user_id uuid,p_item_type text,p_source_id uuid,p_language text)
returns table(title_id uuid,variant_id uuid,language text) language sql stable set search_path='' set jit=off as $f$
 select * from public.cloud_catalog_effective_audio_before_shared(p_user_id,p_item_type,p_source_id,p_language)
 union select * from public.norva_selection_shared_languages(p_user_id,p_item_type,p_source_id,'audio',p_language)
$f$;
alter function public.cloud_catalog_effective_subtitle_languages(uuid,text,uuid,text) rename to cloud_catalog_effective_subtitle_before_shared;
create function public.cloud_catalog_effective_subtitle_languages(p_user_id uuid,p_item_type text,p_source_id uuid,p_language text default null)
returns table(title_id uuid,variant_id uuid,language text) language sql stable set search_path='' set jit=off as $f$
 select * from public.cloud_catalog_effective_subtitle_before_shared(p_user_id,p_item_type,p_source_id,p_language)
 union select * from public.norva_selection_shared_languages(p_user_id,p_item_type,p_source_id,'subtitle',p_language)
$f$;

-- Legacy short ISO filters must also see the public-file languages; newer
-- catalog-* filters already call the effective language helpers above.
alter function public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text)
 rename to cloud_catalog_visible_language_ids_before_shared;
create function public.cloud_catalog_visible_title_ids_by_source_languages(p_user_id uuid,p_item_type text,p_source_id uuid,
 p_audio_language text default null,p_subtitle_language text default null)
returns table(title_id uuid) language sql stable set search_path='' as $f$
 select * from public.cloud_catalog_visible_language_ids_before_shared(p_user_id,p_item_type,p_source_id,p_audio_language,p_subtitle_language)
 union
 select distinct a.title_id from public.norva_selection_shared_languages(p_user_id,p_item_type,p_source_id,'audio',
   regexp_replace(p_audio_language,'^(catalog|provider)-','')) a
 where p_audio_language is not null and (p_subtitle_language is null or exists(
   select 1 from public.norva_selection_shared_languages(p_user_id,p_item_type,p_source_id,'subtitle',
     regexp_replace(p_subtitle_language,'^catalog-','')) s where s.variant_id=a.variant_id and s.title_id=a.title_id))
 union
 select distinct s.title_id from public.norva_selection_shared_languages(p_user_id,p_item_type,p_source_id,'subtitle',
   regexp_replace(p_subtitle_language,'^catalog-','')) s where p_audio_language is null and p_subtitle_language is not null
$f$;

revoke all on function public.norva_selection_shared_languages(uuid,text,uuid,text,text),
 public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text),public.cloud_catalog_effective_subtitle_languages(uuid,text,uuid,text),
 public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.norva_selection_shared_languages(uuid,text,uuid,text,text),
 public.cloud_catalog_effective_audio_languages(uuid,text,uuid,text),public.cloud_catalog_effective_subtitle_languages(uuid,text,uuid,text),
 public.cloud_catalog_visible_title_ids_by_source_languages(uuid,text,uuid,text,text) to service_role;

revoke all on function public.norva_selection_shared_active(uuid),
 public.norva_get_visible_catalog_titles_by_ids(uuid,uuid[],bigint),
 public.norva_select_catalog_title_ordered_page(uuid,text,text,integer,integer,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.norva_selection_shared_active(uuid),
 public.norva_get_visible_catalog_titles_by_ids(uuid,uuid[],bigint),
 public.norva_select_catalog_title_ordered_page(uuid,text,text,integer,integer,jsonb,bigint) to service_role;
-- The physical-only counter's disabled nested-loop planner setting is costly
-- for a shared membership. Keep it for existing accounts and use the ordinary
-- planner for the small shared relation.
alter function public.norva_catalog_movie_audio_language_counts(uuid,uuid) rename to norva_movie_audio_counts_before_shared;
create function public.norva_catalog_movie_audio_language_counts(p_user_id uuid,p_source_id uuid)
returns jsonb language plpgsql stable set search_path='' set jit=off as $f$
declare result jsonb;
begin
 if not public.norva_selection_shared_active(p_user_id) then
   return public.norva_movie_audio_counts_before_shared(p_user_id,p_source_id); end if;
 select coalesce(jsonb_object_agg(language,n),'{}') into result from (
   select language,count(distinct title_id) n from public.cloud_catalog_effective_audio_languages(p_user_id,'movie',p_source_id,null)
   group by language
 ) counts;
 return result;
end
$f$;
create or replace function public.cloud_catalog_unidentified_audio_variants(p_user_id uuid,p_item_type text,p_source_id uuid)
returns table(title_id uuid,variant_id uuid) language sql stable set search_path='' set jit=off as $f$
 with visible as materialized (
   select v.title_id,v.id from public.cloud_catalog_visible_title_variants v where v.user_id=p_user_id
     and v.item_type=p_item_type and p_item_type in ('movie','series') and (p_source_id is null or v.source_id=p_source_id)
 ), known as materialized (
   select e.title_id,e.variant_id from public.cloud_catalog_effective_audio_languages(p_user_id,p_item_type,p_source_id,null) e
 ) select title_id,id from visible except select title_id,variant_id from known
$f$;
revoke all on function public.norva_catalog_movie_audio_language_counts(uuid,uuid) from public,anon,authenticated;
grant execute on function public.norva_catalog_movie_audio_language_counts(uuid,uuid) to service_role;
commit;

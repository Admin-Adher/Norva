begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Internal maintenance evidence, never exposed to anonymous or user clients.
create table public.norva_catalog_tmdb_merge_audit (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check(item_type in ('movie','series')),
  provider_tmdb_id text not null check(provider_tmdb_id ~ '^[1-9][0-9]*$'),
  canonical_title_id uuid,
  title_ids uuid[] not null default '{}',
  state text not null check(state in ('merged','review','retry')),
  reason text,
  sqlstate text,
  variants_moved integer not null default 0,
  titles_consolidated integer not null default 0,
  preservation_proof jsonb,
  attempts integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key(user_id,item_type,provider_tmdb_id)
);
alter table public.norva_catalog_tmdb_merge_audit enable row level security;
revoke all on public.norva_catalog_tmdb_merge_audit from public,anon,authenticated,service_role;
grant all on public.norva_catalog_tmdb_merge_audit to postgres,supabase_admin;

-- Per-group before/after proof. Hashes contain no URLs or credentials. Exclude
-- only the parent pointers and timestamps this operation intentionally changes.
create function public.norva_catalog_tmdb_file_proof(p_user_id uuid,p_title_ids uuid[])
returns jsonb language sql stable security invoker set search_path='' as $function$
  with variants as materialized (
    select v.id,encode(sha256(convert_to((to_jsonb(v)-array['title_id','updated_at'])::text,'UTF8')),'hex') digest
    from public.cloud_title_variants v where v.user_id=p_user_id and v.title_id=any(p_title_ids)
  ), observations as (
    select o.variant_id,o.file_external_id,
      encode(sha256(convert_to((to_jsonb(o)-array['title_id','updated_at'])::text,'UTF8')),'hex') digest
    from public.cloud_title_file_language_observations o
    where o.user_id=p_user_id and o.variant_id in(select id from variants)
  ), episodes as (
    select e.source_id,e.generation_id,e.parent_series_id,e.episode_id,
      encode(sha256(convert_to((to_jsonb(e)-array['parent_title_id','updated_at'])::text,'UTF8')),'hex') digest
    from public.catalog_series_episode_memberships e
    where e.user_id=p_user_id and e.parent_variant_id in(select id from variants)
  ), inventory as (
    select i.source_id,i.generation_id,i.parent_series_id,
      encode(sha256(convert_to((to_jsonb(i)-array['parent_title_id','updated_at'])::text,'UTF8')),'hex') digest
    from public.catalog_series_inventory_state i
    where i.user_id=p_user_id and i.parent_variant_id in(select id from variants)
  ) select jsonb_build_object(
    'variants',(select count(*) from variants),
    'variantDigest',(select encode(sha256(convert_to(coalesce(string_agg(digest,'' order by id),''),'UTF8')),'hex') from variants),
    'observations',(select count(*) from observations),
    'observationDigest',(select encode(sha256(convert_to(coalesce(string_agg(digest,'' order by variant_id,file_external_id),''),'UTF8')),'hex') from observations),
    'episodes',(select count(*) from episodes),
    'episodeDigest',(select encode(sha256(convert_to(coalesce(string_agg(digest,'' order by source_id,generation_id,parent_series_id,episode_id),''),'UTF8')),'hex') from episodes),
    'inventories',(select count(*) from inventory),
    'inventoryDigest',(select encode(sha256(convert_to(coalesce(string_agg(digest,'' order by source_id,generation_id,parent_series_id),''),'UTF8')),'hex') from inventory),
    'ratings',(select count(*) from public.cloud_title_ratings where user_id=p_user_id and title_id=any(p_title_ids)),
    'ratingOperations',(select count(*) from public.cloud_title_rating_operations where user_id=p_user_id and title_id=any(p_title_ids)),
    'titleParents',(select count(*) from public.cloud_titles where user_id=p_user_id and id=any(p_title_ids))
  )
$function$;
revoke all on function public.norva_catalog_tmdb_file_proof(uuid,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.norva_catalog_tmdb_file_proof(uuid,uuid[]) to postgres,supabase_admin;

-- This is a database-maintenance entry point, not a public RPC. It deliberately
-- remains INVOKER: the cron owner already has the required row-lock privileges.
create function public.norva_merge_validated_tmdb_group(
  p_user_id uuid,p_item_type text,p_tmdb_id text
) returns jsonb language plpgsql security invoker
set search_path='' set lock_timeout='2s' set max_parallel_workers_per_gather=0
as $function$
declare
  v_ids uuid[]; v_locked_ids uuid[]; v_canonical uuid;
  v_verified boolean; v_years integer; v_count integer;
  v_source record; v_snapshot record; v_moved_ids uuid[];
  v_moved integer:=0; v_expected integer; v_observed integer;
  v_reason text; v_state text; v_existing_key uuid;
  v_proof jsonb;
begin
  if p_user_id is null or p_item_type is null or p_item_type not in ('movie','series')
     or p_tmdb_id is null or p_tmdb_id !~ '^[1-9][0-9]*$' then
    raise exception 'invalid catalogue merge identity' using errcode='22023';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(
    'catalog-tmdb-merge:'||p_user_id::text||':'||p_item_type||':'||p_tmdb_id,0)) then
    return jsonb_build_object('state','retry','reason','locked','variantsMoved',0);
  end if;

  select array_agg(t.id order by t.id),count(*),
    bool_and(t.match_status='provider_verified' and coalesce(t.metadata#>>'{tmdbValidation,valid}','false')='true'),
    count(distinct t.release_year)
  into v_ids,v_count,v_verified,v_years
  from public.cloud_titles t
  where t.user_id=p_user_id and t.item_type=p_item_type and t.provider_tmdb_id=p_tmdb_id
    and exists(select 1 from public.cloud_catalog_visible_title_variants v
      where v.title_id=t.id and v.user_id=t.user_id);
  if v_count<2 then return jsonb_build_object('state','noop','variantsMoved',0,'titlesConsolidated',0); end if;
  if not coalesce(v_verified,false) then v_reason:='validation_incomplete';
  elsif v_years>1 then v_reason:='release_year_conflict'; end if;

  if v_reason is not null then
    insert into public.norva_catalog_tmdb_merge_audit(user_id,item_type,provider_tmdb_id,title_ids,state,reason)
    values(p_user_id,p_item_type,p_tmdb_id,v_ids,'review',v_reason)
    on conflict(user_id,item_type,provider_tmdb_id) do update set
      title_ids=excluded.title_ids,state=excluded.state,reason=excluded.reason,
      attempts=norva_catalog_tmdb_merge_audit.attempts+1,updated_at=now();
    return jsonb_build_object('state','review','reason',v_reason,'variantsMoved',0);
  end if;

  begin
    -- Follow the source writer lock order and freeze every active source head
    -- involved in this work before locking its logical title rows.
    for v_source in
      select distinct v.source_id from public.cloud_catalog_visible_title_variants v
      where v.user_id=p_user_id and v.title_id=any(v_ids) order by v.source_id
    loop
      perform 1 from public.cloud_sources s where s.id=v_source.source_id and s.user_id=p_user_id for share;
      perform 1 from public.cloud_source_catalog_heads h
        join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
        where h.source_id=v_source.source_id and h.user_id=p_user_id for share of h,l;
    end loop;
    perform 1 from public.cloud_user_catalog_visibility_epochs e where e.user_id=p_user_id for share;
    perform pg_advisory_xact_lock(hashtextextended('title-rating-title:'||p_user_id::text||':'||id::text,0))
      from unnest(v_ids) id order by id;
    perform 1 from public.cloud_titles t where t.user_id=p_user_id and t.id=any(v_ids) order by t.id for update;

    select array_agg(t.id order by t.id),
      bool_and(t.match_status='provider_verified' and coalesce(t.metadata#>>'{tmdbValidation,valid}','false')='true'),
      count(distinct t.release_year)
    into v_locked_ids,v_verified,v_years
    from public.cloud_titles t
    where t.user_id=p_user_id and t.item_type=p_item_type and t.provider_tmdb_id=p_tmdb_id
      and exists(select 1 from public.cloud_catalog_visible_title_variants v
        where v.title_id=t.id and v.user_id=t.user_id);
    if v_locked_ids is distinct from v_ids or not coalesce(v_verified,false) or v_years>1 then
      raise exception 'catalogue merge eligibility changed' using errcode='PT409';
    end if;
    select t.id into v_canonical from public.cloud_titles t
      where t.user_id=p_user_id and t.id=any(v_ids)
      order by (t.identity_key='tmdb:'||p_tmdb_id) desc,
        (t.identity_source='provider_tmdb') desc,(t.poster_url is not null) desc,
        (t.release_year is not null) desc,t.created_at,t.id limit 1;
    v_proof:=public.norva_catalog_tmdb_file_proof(p_user_id,v_ids);

    for v_source in
      select distinct v.source_id,v.generation_id from public.cloud_catalog_visible_title_variants v
      where v.user_id=p_user_id and v.title_id=any(v_ids) and v.title_id<>v_canonical
      order by v.source_id,v.generation_id
    loop
      select h.active_generation_id,h.head_revision,l.config_revision,
        l.visibility_epoch source_epoch,coalesce(e.visibility_epoch,1) user_epoch
      into strict v_snapshot from public.cloud_source_catalog_heads h
      join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
      left join public.cloud_user_catalog_visibility_epochs e on e.user_id=h.user_id
      where h.source_id=v_source.source_id and h.user_id=p_user_id;
      if v_source.generation_id is distinct from v_snapshot.active_generation_id
         or not public.norva_source_catalog_visible_internal(v_source.source_id,p_user_id) then
        raise exception 'catalogue merge source changed' using errcode='PT409';
      end if;
      select count(*) into v_expected from public.cloud_catalog_visible_title_variants v
        where v.user_id=p_user_id and v.source_id=v_source.source_id
          and v.generation_id=v_source.generation_id and v.title_id=any(v_ids) and v.title_id<>v_canonical;
      with changed as (
        update public.cloud_title_variants v set title_id=v_canonical,
          write_head_revision=v_snapshot.head_revision,write_config_revision=v_snapshot.config_revision,
          write_source_visibility_epoch=v_snapshot.source_epoch,write_user_visibility_epoch=v_snapshot.user_epoch
        where v.user_id=p_user_id and v.source_id=v_source.source_id
          and v.generation_id=v_source.generation_id and v.title_id=any(v_ids) and v.title_id<>v_canonical
        returning v.id
      ) select array_agg(id),count(*) into v_moved_ids,v_observed from changed;
      if v_observed<>v_expected then raise exception 'catalogue merge row count changed' using errcode='PT409'; end if;
      v_moved:=v_moved+v_observed;

      -- Per-file language observations follow the existing composite FK's
      -- ON UPDATE CASCADE. Series inventories use separate title pointers.
      -- Refresh each statement's epoch after the variant display trigger.
      if p_item_type='series' then
        update public.catalog_series_episode_memberships m set parent_title_id=v_canonical,
          write_head_revision=h.head_revision,write_config_revision=l.config_revision,
          write_source_visibility_epoch=l.visibility_epoch,write_user_visibility_epoch=coalesce(e.visibility_epoch,1)
        from public.cloud_source_catalog_heads h
        join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
        left join public.cloud_user_catalog_visibility_epochs e on e.user_id=h.user_id
        where h.source_id=v_source.source_id and h.user_id=p_user_id
          and m.user_id=p_user_id and m.source_id=h.source_id and m.generation_id=h.active_generation_id
          and m.parent_variant_id=any(v_moved_ids) and m.parent_title_id<>v_canonical;
        update public.catalog_series_inventory_state m set parent_title_id=v_canonical,
          write_head_revision=h.head_revision,write_config_revision=l.config_revision,
          write_source_visibility_epoch=l.visibility_epoch,write_user_visibility_epoch=coalesce(e.visibility_epoch,1)
        from public.cloud_source_catalog_heads h
        join public.cloud_source_lifecycle l on l.source_id=h.source_id and l.user_id=h.user_id
        left join public.cloud_user_catalog_visibility_epochs e on e.user_id=h.user_id
        where h.source_id=v_source.source_id and h.user_id=p_user_id
          and m.user_id=p_user_id and m.source_id=h.source_id and m.generation_id=h.active_generation_id
          and m.parent_variant_id=any(v_moved_ids) and m.parent_title_id<>v_canonical;
      end if;
    end loop;

    -- Preserve every rating row and its causal ordering, matching the existing
    -- logical-title merge contract without deleting its old FK parent.
    with profile_state as (
      select profile_id,max(server_revision)+1 revision,
        (array_agg(rating order by server_revision desc,updated_at desc,id desc))[1] rating
      from public.cloud_title_ratings where user_id=p_user_id and title_id=any(v_ids)
      group by profile_id
    ) update public.cloud_title_ratings r set title_id=v_canonical,rating=s.rating,
      server_revision=s.revision,last_operation_id=null,updated_at=now()
      from profile_state s where r.user_id=p_user_id and r.title_id=any(v_ids)
        and r.profile_id is not distinct from s.profile_id;
    update public.cloud_title_rating_operations set title_id=v_canonical
      where user_id=p_user_id and title_id=any(v_ids) and title_id<>v_canonical;

    -- Never delete siblings: retired generations, candidate projections and
    -- saved history can still reference them. Only current visible membership
    -- determines whether their card appears in the catalogue.
    select id into v_existing_key from public.cloud_titles
      where user_id=p_user_id and item_type=p_item_type and identity_key='tmdb:'||p_tmdb_id;
    if v_existing_key is null or v_existing_key=v_canonical then
      update public.cloud_titles set identity_key='tmdb:'||p_tmdb_id,identity_source='provider_tmdb'
        where user_id=p_user_id and id=v_canonical;
    end if;
    perform public.norva_bump_user_catalog_visibility_epoch(p_user_id);
    update public.cloud_catalog_facet_summary set refreshed_at='epoch'::timestamptz
      where user_id=p_user_id and item_type=p_item_type;
    if public.norva_catalog_tmdb_file_proof(p_user_id,v_ids) is distinct from v_proof then
      raise exception 'catalogue merge file preservation failed' using errcode='23514';
    end if;
    if (select count(distinct title_id) from public.cloud_catalog_visible_title_variants
        where user_id=p_user_id and title_id=any(v_ids))<>1 then
      raise exception 'catalogue merge did not converge' using errcode='PT409';
    end if;
    insert into public.norva_catalog_tmdb_merge_audit
      (user_id,item_type,provider_tmdb_id,canonical_title_id,title_ids,state,variants_moved,titles_consolidated,preservation_proof)
    values(p_user_id,p_item_type,p_tmdb_id,v_canonical,v_ids,'merged',v_moved,v_count-1,v_proof)
    on conflict(user_id,item_type,provider_tmdb_id) do update set
      canonical_title_id=excluded.canonical_title_id,
      title_ids=(select array_agg(distinct id order by id) from unnest(norva_catalog_tmdb_merge_audit.title_ids||excluded.title_ids) id),
      state='merged',reason=null,sqlstate=null,
      variants_moved=norva_catalog_tmdb_merge_audit.variants_moved+excluded.variants_moved,
      titles_consolidated=norva_catalog_tmdb_merge_audit.titles_consolidated+excluded.titles_consolidated,
      preservation_proof=excluded.preservation_proof,
      attempts=norva_catalog_tmdb_merge_audit.attempts+1,updated_at=now();
    return jsonb_build_object('state','merged','canonicalTitleId',v_canonical,
      'variantsMoved',v_moved,'titlesConsolidated',v_count-1);
  exception when others then
    get stacked diagnostics v_state=returned_sqlstate;
    if current_setting('norva.catalog_merge_debug',true)='on' then raise; end if;
    -- Roll back the whole group, then retain a safe diagnostic outside its
    -- savepoint. No provider responses or URLs enter this audit record.
    insert into public.norva_catalog_tmdb_merge_audit
      (user_id,item_type,provider_tmdb_id,title_ids,state,reason,sqlstate)
    values(p_user_id,p_item_type,p_tmdb_id,v_ids,'retry','merge_failed',v_state)
    on conflict(user_id,item_type,provider_tmdb_id) do update set
      state='retry',reason='merge_failed',sqlstate=excluded.sqlstate,
      attempts=norva_catalog_tmdb_merge_audit.attempts+1,updated_at=now();
    raise warning 'catalogue TMDB merge deferred (SQLSTATE %)',v_state;
    return jsonb_build_object('state','retry','reason','merge_failed','sqlstate',v_state,'variantsMoved',0);
  end;
end
$function$;
revoke all on function public.norva_merge_validated_tmdb_group(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.norva_merge_validated_tmdb_group(uuid,text,text) to postgres,supabase_admin;

create or replace function public.norva_canonicalize_titles_for_user(p_user_id uuid,p_limit integer default null)
returns integer language plpgsql security invoker set search_path='' set max_parallel_workers_per_gather=0
as $function$
declare v_group record; v_result jsonb; v_merged integer:=0;
begin
  if not pg_try_advisory_xact_lock(4200043) then return 0; end if;
  for v_group in
    with membership as materialized (
      select distinct v.user_id,v.title_id from public.cloud_catalog_visible_title_variants v
      where v.item_type in ('movie','series') and (p_user_id is null or v.user_id=p_user_id)
    ), groups as (
      select t.user_id,t.item_type,t.provider_tmdb_id
      from membership m join public.cloud_titles t on t.id=m.title_id and t.user_id=m.user_id
      where t.provider_tmdb_id ~ '^[1-9][0-9]*$' and t.item_type in ('movie','series')
      group by t.user_id,t.item_type,t.provider_tmdb_id
      having count(*)>1 and count(distinct t.release_year)<=1
        and bool_and(t.match_status='provider_verified' and coalesce(t.metadata#>>'{tmdbValidation,valid}','false')='true')
    ) select g.* from groups g left join public.norva_catalog_tmdb_merge_audit a
      using(user_id,item_type,provider_tmdb_id)
    where a.state is distinct from 'retry' or a.updated_at<now()-interval '5 minutes'
    order by a.updated_at nulls first,g.user_id,g.item_type,g.provider_tmdb_id
    limit greatest(1,least(coalesce(p_limit,50),300))
  loop
    v_result:=public.norva_merge_validated_tmdb_group(v_group.user_id,v_group.item_type,v_group.provider_tmdb_id);
    if v_result->>'state'='merged' then v_merged:=v_merged+(v_result->>'titlesConsolidated')::integer; end if;
  end loop;
  return v_merged;
end
$function$;
revoke all on function public.norva_canonicalize_titles_for_user(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.norva_canonicalize_titles_for_user(uuid,integer) to postgres,supabase_admin;

-- Keep the existing overnight reconciliation; also repair bounded batches
-- after daytime enrichment. This job does not invoke the heavy poster/media pass.
select cron.schedule('norva-catalog-tmdb-merge','7-59/10 * * * *',
  $$set statement_timeout='90s'; select public.norva_canonicalize_titles_for_user(null,50);$$);
notify pgrst,'reload schema';
commit;

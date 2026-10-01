begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create table public.selection_title_recipes (
  revision text not null check(revision ~ '^[a-f0-9]{64}$'),
  raw_key text not null check(raw_key ~ '^[a-f0-9]{64}$'),
  title jsonb not null,
  variant jsonb not null,
  expires_at timestamptz not null,
  primary key(revision,raw_key)
);
alter table public.selection_title_recipes enable row level security;
revoke all on public.selection_title_recipes from public,anon,authenticated;
grant select,insert,update,delete on public.selection_title_recipes to service_role;

create function public.norva_selection_raw_recipe_key(p_raw jsonb)
returns text language sql immutable parallel safe set search_path='' as $f$
  select encode(sha256(convert_to(jsonb_object_agg(k,coalesce(p_raw->k,'null'::jsonb))::text,'UTF8')),'hex')
  from unnest(array['item_type','external_id','parent_external_id','title','subtitle','poster_url',
    'backdrop_url','metadata','playback_hint','available']) k
$f$;

-- Only server-computed recipes for exact entries in the currently qualified
-- public manifest are admitted. No source/account/row ID is cached.
create function public.norva_cache_selection_title_recipes(p_revision text,p_recipes jsonb)
returns integer language plpgsql security invoker set search_path='' as $f$
declare v_count integer;
begin
  perform public.norva_credential_require_service_role();
  if jsonb_typeof(p_recipes) is distinct from 'array' or jsonb_array_length(p_recipes)>500 then
    raise exception 'Bounded public title recipes required' using errcode='22023';
  end if;
  with manifest as materialized (
    select public.norva_selection_raw_recipe_key(raw) raw_key
    from public.selection_prepared_catalogs c cross join lateral jsonb_array_elements(c.payload->'rows') raw
    where c.revision=p_revision
  ), recipes as (
    select public.norva_selection_raw_recipe_key(r->'raw') raw_key,
      (select jsonb_object_agg(k,r->'title'->k) from unnest(array['item_type','identity_key','identity_source',
        'provider_tmdb_id','provider_imdb_id','match_status','title','original_title','release_year','poster_url',
        'backdrop_url','metadata','version_languages']) k where r->'title' ? k) title,
      (select jsonb_object_agg(k,r->'variant'->k) from unnest(array['item_type','external_id','raw_title','label',
        'language','quality','resolution','container_extension','poster_url','playback_hint','codec_profile',
        'compatibility_tier','playback_cost_score','metadata']) k where r->'variant' ? k) variant
    from jsonb_array_elements(p_recipes) r
    where r->'raw'->>'item_type' in ('movie','series')
      and r->'raw'->>'item_type'=r->'title'->>'item_type'
      and r->'raw'->>'item_type'=r->'variant'->>'item_type'
      and r->'raw'->>'external_id'=r->'variant'->>'external_id'
      and r->'title'->>'identity_key'=r->'variant'->'metadata'->>'identityKey'
  )
  insert into public.selection_title_recipes(revision,raw_key,title,variant,expires_at)
  select distinct on(r.raw_key) p_revision,r.raw_key,r.title,r.variant,clock_timestamp()+interval '24 hours'
  from recipes r join manifest m using(raw_key)
  on conflict(revision,raw_key) do update set title=excluded.title,variant=excluded.variant,expires_at=excluded.expires_at;
  get diagnostics v_count=row_count;
  return v_count;
end
$f$;

create function public.norva_apply_selection_title_recipes(
  p_source_id uuid,p_user_id uuid,p_generation_id uuid,p_head_revision bigint,p_config_revision bigint,
  p_source_visibility_epoch bigint,p_user_visibility_epoch bigint,p_item_ids uuid[],p_revision text
) returns jsonb language plpgsql security invoker set search_path='' as $f$
declare v_snapshot jsonb; v_recipes jsonb; v_count integer; v_titles integer; v_epoch bigint;
begin
  perform public.norva_credential_require_service_role();
  if not public.norva_selection_source_identity_valid(p_source_id,p_user_id)
    or cardinality(p_item_ids) not between 1 and 500 or p_item_ids is null
    or cardinality(p_item_ids)<>(select count(distinct id) from unnest(p_item_ids) id) then
    raise exception 'Bounded owned Selection batch required' using errcode='22023';
  end if;
  perform 1 from public.cloud_sources s where s.id=p_source_id and s.user_id=p_user_id for share;
  perform 1 from public.cloud_source_catalog_heads h join public.cloud_source_lifecycle l
    on l.user_id=h.user_id and l.source_id=h.source_id
    where h.source_id=p_source_id and h.user_id=p_user_id for share of h,l;
  perform 1 from public.cloud_user_catalog_visibility_epochs e where e.user_id=p_user_id for update;
  v_snapshot:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
  if (v_snapshot->>'generationId')::uuid is distinct from p_generation_id
    or (v_snapshot->>'headRevision')::bigint is distinct from p_head_revision
    or (v_snapshot->>'configRevision')::bigint is distinct from p_config_revision
    or (v_snapshot->>'sourceVisibilityEpoch')::bigint is distinct from p_source_visibility_epoch
    or (v_snapshot->>'userVisibilityEpoch')::bigint is distinct from p_user_visibility_epoch
    or (v_snapshot->>'isCatalogVisible')::boolean is distinct from true then
    raise exception 'Selection catalogue snapshot changed' using errcode='PT409';
  end if;
  if (select count(*) from public.cloud_media_items m where m.id=any(p_item_ids)
      and m.user_id=p_user_id and m.source_id=p_source_id and m.generation_id=p_generation_id
      and m.item_type in ('movie','series') and m.available)<>cardinality(p_item_ids) then
    raise exception 'Selection batch contains unavailable or foreign files' using errcode='PT409';
  end if;
  -- Exact cached members are rebound; changed/expired members remain explicit
  -- misses for normal computation. Foreign members abort before any write.
  select jsonb_agg(jsonb_build_object('media',m.id,'title',r.title,'variant',r.variant)) into v_recipes
  from public.cloud_media_items m join public.selection_title_recipes r
    on r.revision=p_revision and r.raw_key=public.norva_selection_raw_recipe_key(to_jsonb(m))
      and r.expires_at>clock_timestamp()
  where m.id=any(p_item_ids) and m.user_id=p_user_id and m.source_id=p_source_id
    and m.generation_id=p_generation_id and m.item_type in ('movie','series') and m.available;
  if coalesce(jsonb_array_length(v_recipes),0)=0 then
    return jsonb_build_object('reused',false);
  end if;

  insert into public.cloud_titles as existing(user_id,item_type,identity_key,identity_source,provider_tmdb_id,
    provider_imdb_id,match_status,title,original_title,release_year,poster_url,backdrop_url,metadata,version_languages,synced_at)
  select distinct on(t.item_type,t.identity_key) p_user_id,t.item_type,t.identity_key,t.identity_source,t.provider_tmdb_id,
    t.provider_imdb_id,t.match_status,t.title,t.original_title,t.release_year,t.poster_url,t.backdrop_url,
    coalesce(t.metadata,'{}'::jsonb),coalesce(t.version_languages,'{}'::text[]),clock_timestamp()
  from jsonb_array_elements(v_recipes) r
  cross join lateral jsonb_populate_record(null::public.cloud_titles,r->'title') t
  on conflict(user_id,item_type,identity_key) do update set
    identity_source=excluded.identity_source,provider_tmdb_id=excluded.provider_tmdb_id,
    provider_imdb_id=excluded.provider_imdb_id,match_status=excluded.match_status,title=excluded.title,
    original_title=excluded.original_title,release_year=excluded.release_year,poster_url=excluded.poster_url,
    backdrop_url=excluded.backdrop_url,metadata=excluded.metadata,version_languages=excluded.version_languages,synced_at=excluded.synced_at;
  get diagnostics v_titles=row_count;
  -- Title writes can advance only this account's display epoch. Authority is
  -- locked for the transaction, and normal row/statement guards still execute.
  v_snapshot:=public.norva_get_catalog_write_snapshot(p_source_id,p_user_id);
  v_epoch:=(v_snapshot->>'userVisibilityEpoch')::bigint;
  insert into public.cloud_title_variants(user_id,title_id,source_id,media_item_id,item_type,external_id,
    raw_title,label,language,quality,resolution,container_extension,poster_url,playback_hint,codec_profile,
    compatibility_tier,playback_cost_score,metadata,generation_id,write_head_revision,write_config_revision,
    write_source_visibility_epoch,write_user_visibility_epoch)
  select p_user_id,t.id,p_source_id,(r->>'media')::uuid,v.item_type,v.external_id,v.raw_title,v.label,
    v.language,v.quality,v.resolution,v.container_extension,v.poster_url,v.playback_hint,v.codec_profile,
    v.compatibility_tier,v.playback_cost_score,v.metadata,p_generation_id,p_head_revision,p_config_revision,
    p_source_visibility_epoch,v_epoch
  from jsonb_array_elements(v_recipes) r
  cross join lateral jsonb_populate_record(null::public.cloud_title_variants,r->'variant') v
  join public.cloud_titles t on t.user_id=p_user_id and t.item_type=v.item_type
    and t.identity_key=r->'title'->>'identity_key'
  on conflict(source_id,generation_id,item_type,external_id) do update set
    title_id=excluded.title_id,media_item_id=excluded.media_item_id,raw_title=excluded.raw_title,
    label=excluded.label,language=excluded.language,quality=excluded.quality,resolution=excluded.resolution,
    container_extension=excluded.container_extension,poster_url=excluded.poster_url,playback_hint=excluded.playback_hint,
    codec_profile=excluded.codec_profile,compatibility_tier=excluded.compatibility_tier,playback_cost_score=excluded.playback_cost_score,
    metadata=excluded.metadata,write_head_revision=excluded.write_head_revision,write_config_revision=excluded.write_config_revision,
    write_source_visibility_epoch=excluded.write_source_visibility_epoch,write_user_visibility_epoch=excluded.write_user_visibility_epoch;
  get diagnostics v_count=row_count;
  if v_count<>jsonb_array_length(v_recipes) then raise exception 'Incomplete Selection recipe binding'; end if;
  return jsonb_build_object('reused',true,'titles',v_titles,'variants',v_count,
    'itemIds',(select jsonb_agg(r->>'media') from jsonb_array_elements(v_recipes) r));
end
$f$;

revoke all on function public.norva_selection_raw_recipe_key(jsonb),
  public.norva_cache_selection_title_recipes(text,jsonb),
  public.norva_apply_selection_title_recipes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid[],text)
  from public,anon,authenticated;
grant execute on function public.norva_selection_raw_recipe_key(jsonb),
  public.norva_cache_selection_title_recipes(text,jsonb),
  public.norva_apply_selection_title_recipes(uuid,uuid,uuid,bigint,bigint,bigint,bigint,uuid[],text)
  to service_role;
commit;

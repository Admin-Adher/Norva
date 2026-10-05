begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Same truth predicates and admission guards. Avoid expensive declaration
-- evaluation when exact observations already establish a language, and remove
-- ineligible featured candidates before evaluating the remaining truth predicate.

do $guard$ begin
 if md5(replace(pg_get_functiondef('public.catalog_movie_audio_identified(uuid,uuid,uuid)'::regprocedure),chr(13),'')) <> 'd98aecdc507ffab4717951cdc59b3e70' then
 raise exception 'Audio selection function drift: catalog_movie_audio_identified';
 end if;
end $guard$;
CREATE OR REPLACE FUNCTION public.catalog_movie_audio_identified(p_user uuid, p_source uuid, p_variant uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
select exists(
    select 1 from public.cloud_catalog_visible_title_variants v
    join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
    where v.id=p_variant and v.user_id=p_user and v.source_id=p_source and v.item_type='movie'
      and case
        when exists(select 1 from public.cloud_title_file_language_observations o
          cross join lateral unnest(o.audio_languages) lang(code)
          where o.user_id=v.user_id and o.title_id=v.title_id and o.variant_id=v.id
            and o.file_external_id=v.external_id and o.audio_observed
            and (lang.code='yue' or public.norva_canonical_language_code(lang.code) is not null)) then true
        when exists(select 1 from public.cloud_catalog_provider_language_hints h
          where h.variant_id=v.id and h.user_id=v.user_id and h.source_id=v.source_id
            and h.title_id=v.title_id and h.item_type='movie') then true
        else exists(select 1 from public.cloud_catalog_owned_audio_declarations_exact_movie(v.user_id,v.source_id,v.id) d
          where d.user_id=v.user_id and d.source_id=v.source_id and d.variant_id=v.id)
      end
  )
$function$;

do $guard$ begin
 if md5(replace(pg_get_functiondef('public.claim_catalog_provider_audio_metadata(uuid,uuid)'::regprocedure),chr(13),'')) <> 'ac9a06db5a466636d64fe54d91f6f58e' then
 raise exception 'Audio selection function drift: claim_catalog_provider_audio_metadata';
 end if;
end $guard$;
CREATE OR REPLACE FUNCTION public.claim_catalog_provider_audio_metadata(p_user uuid, p_source uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 g uuid; identity_id uuid; config bigint; visibility bigint;
 cursor_row public.catalog_provider_audio_metadata_sweeps%rowtype;
 ids uuid[]; candidate record; retry_id uuid; token uuid:=gen_random_uuid();
 scanned_count integer; retry_turn boolean:=false; featured_turn boolean:=false;
begin
 perform public.norva_credential_require_service_role();
 if exists(select 1 from public.admin_feature_flags where key='enrichment_paused' and enabled)
  or not public.catalog_owned_language_metadata_enabled_for_source(p_user,p_source)
  or not public.norva_source_catalog_visible_internal(p_source,p_user) then
  return jsonb_build_object('skipped','metadata-not-eligible','hasMore',false);
 end if;
 select h.active_generation_id,i.identity_id,l.config_revision,l.visibility_epoch into g,identity_id,config,visibility
 from public.cloud_sources s join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
 join public.cloud_source_lifecycle l on l.source_id=s.id and l.user_id=s.user_id
 join public.catalog_source_provider_identities i on i.source_id=s.id and i.user_id=s.user_id and i.verified_at is not null
 join auth.users u on u.id=s.user_id and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
 where s.id=p_source and s.user_id=p_user and s.source_type='xtream' and s.enabled and s.deleted_at is null and s.sync_status='ready';
 if g is null then return jsonb_build_object('skipped','metadata-source-unavailable','hasMore',false); end if;
 if not pg_try_advisory_xact_lock(hashtextextended('provider-audio-metadata:'||p_source::text,0)) then
  return jsonb_build_object('skipped','metadata-busy','hasMore',true);
 end if;
 -- Capacity admission is retried by the dispatcher. Never wait behind another
 -- lane while holding the per-source lock and consume the RPC's whole budget.
 if not pg_try_advisory_xact_lock(hashtextextended('catalog-language-admission',0)) then
  return jsonb_build_object('skipped','metadata-capacity','hasMore',true);
 end if;
 if not public.catalog_language_metadata_available_for_source(p_user,p_source)
  or exists(select 1 from public.catalog_provider_audio_metadata_retries where source_id=p_source and lease_until>now())
  or not exists(select 1 from public.catalog_language_metadata_capacity c where c.singleton and c.expires_at>now()
    and c.max_workers>(select count(*) from public.catalog_provider_audio_metadata_retries where lease_until>now())
      +(select count(*) from public.catalog_vod_language_intake where state='leased' and lease_until>now())) then
  return jsonb_build_object('skipped','metadata-capacity','hasMore',true);
 end if;
 insert into public.catalog_provider_audio_metadata_sweeps(source_id,user_id,generation_id,config_revision,visibility_epoch)
 values(p_source,p_user,g,config,visibility)
 on conflict(source_id) do update set user_id=excluded.user_id,generation_id=excluded.generation_id,
  config_revision=excluded.config_revision,visibility_epoch=excluded.visibility_epoch,after_variant_id=null,
  next_scan_at=now(),updated_at=now()
 where catalog_provider_audio_metadata_sweeps.generation_id is distinct from excluded.generation_id
  or catalog_provider_audio_metadata_sweeps.config_revision is distinct from excluded.config_revision
  or catalog_provider_audio_metadata_sweeps.visibility_epoch is distinct from excluded.visibility_epoch;
 select * into strict cursor_row from public.catalog_provider_audio_metadata_sweeps where source_id=p_source for update;
 with featured_candidates as materialized (
   select v.*,featured.display_rank,featured.seen_at from public.cloud_title_variants v
   join public.catalog_featured_language_titles featured on featured.user_id=v.user_id and featured.title_id=v.title_id
   where featured.expires_at>now() and v.user_id=p_user and v.source_id=p_source and v.generation_id=g
     and v.item_type='movie' and v.external_id ~ '^[0-9]+$'
 ), metadata_eligible as materialized (
 select v.*  from featured_candidates v
 where not exists(select 1 from public.catalog_owned_language_declarations d where d.variant_id=v.id
   and d.user_id=p_user and d.source_id=p_source and d.generation_id=g and d.provider_identity_id=identity_id
   and d.file_external_id=v.external_id and d.config_revision=config and d.source_visibility_epoch=visibility)
  and not exists(select 1 from public.catalog_provider_audio_metadata_retries q where q.variant_id=v.id
   and q.generation_id=g and q.config_revision=config and q.visibility_epoch=visibility
   and (q.next_attempt_at>now() or q.lease_until>now()))
)
 select v.id,v.external_id into candidate from metadata_eligible v
 where not public.catalog_movie_audio_identified(p_user,p_source,v.id)
 order by v.display_rank,v.seen_at desc,v.id limit 1;
 featured_turn:=candidate.id is not null;
 if not featured_turn then
 select q.variant_id into retry_id from public.catalog_provider_audio_metadata_retries q
 join public.cloud_title_variants v on v.id=q.variant_id and v.user_id=p_user and v.source_id=p_source and v.generation_id=g
 where q.user_id=p_user and q.source_id=p_source and q.generation_id=g and q.config_revision=config
  and q.visibility_epoch=visibility and q.next_attempt_at<=now() and (q.lease_until is null or q.lease_until<=now())
 order by q.next_attempt_at,q.variant_id limit 1;
 retry_turn:=retry_id is not null and (cursor_row.next_scan_at>now() or mod(cursor_row.processed,4)=3);
 if retry_turn then ids:=array[retry_id];
 elsif cursor_row.next_scan_at>now() then return jsonb_build_object('skipped','metadata-sweep-resting','hasMore',false);
 else
  select array_agg(id order by id) into ids from (select v.id from public.cloud_title_variants v
   where v.user_id=p_user and v.source_id=p_source and v.generation_id=g and v.item_type='movie'
    and (cursor_row.after_variant_id is null or v.id>cursor_row.after_variant_id) order by v.id limit 32) page;
 end if;
 else ids:=array[candidate.id];
 end if;
 scanned_count:=coalesce(cardinality(ids),0);
 if scanned_count=0 then
  update public.catalog_provider_audio_metadata_sweeps set after_variant_id=null,next_scan_at=now()+interval '6 hours',
   cycles=cycles+1,updated_at=now() where source_id=p_source;
  return jsonb_build_object('scanned',0,'hasMore',false,'exhausted',true);
 end if;
 select v.id,v.external_id into candidate from public.cloud_title_variants v
 where v.id=any(ids) and v.user_id=p_user and v.source_id=p_source and v.generation_id=g
  and v.item_type='movie' and v.external_id ~ '^[0-9]+$'
  and not public.catalog_movie_audio_identified(p_user,p_source,v.id)
  and not exists(select 1 from public.catalog_owned_language_declarations d where d.variant_id=v.id
   and d.user_id=p_user and d.source_id=p_source and d.generation_id=g and d.provider_identity_id=identity_id
   and d.file_external_id=v.external_id and d.config_revision=config and d.source_visibility_epoch=visibility)
  and not exists(select 1 from public.catalog_provider_audio_metadata_retries q where q.variant_id=v.id
   and q.generation_id=g and q.config_revision=config and q.visibility_epoch=visibility
   and (q.next_attempt_at>now() or q.lease_until>now()))
 order by v.id limit 1;
 if not retry_turn and not featured_turn then
  scanned_count:=coalesce(array_position(ids,candidate.id),scanned_count);
  update public.catalog_provider_audio_metadata_sweeps set after_variant_id=ids[scanned_count],
   scanned=scanned+scanned_count,updated_at=now() where source_id=p_source;
 end if;
 if candidate.id is null then
  if retry_turn then delete from public.catalog_provider_audio_metadata_retries where variant_id=retry_id; end if;
  return jsonb_build_object('scanned',scanned_count,'hasMore',true);
 end if;
 insert into public.catalog_provider_audio_metadata_retries(variant_id,user_id,source_id,generation_id,config_revision,visibility_epoch,
  lease_token,lease_until,next_attempt_at,last_code)
 values(candidate.id,p_user,p_source,g,config,visibility,token,now()+interval '3 minutes',now()+interval '4 minutes','metadata-started')
 on conflict(variant_id) do update set generation_id=excluded.generation_id,config_revision=excluded.config_revision,
  visibility_epoch=excluded.visibility_epoch,lease_token=excluded.lease_token,lease_until=excluded.lease_until,
  next_attempt_at=excluded.next_attempt_at,last_code=excluded.last_code,updated_at=now(),
  attempts=case when catalog_provider_audio_metadata_retries.generation_id=excluded.generation_id
    and catalog_provider_audio_metadata_retries.config_revision=excluded.config_revision
    then catalog_provider_audio_metadata_retries.attempts else 0 end;
 return jsonb_build_object('variantId',candidate.id,'itemId',candidate.external_id,'identityKey',identity_id,
  'generationId',g,'leaseToken',token,'scanned',scanned_count,'hasMore',true);
end $function$;

notify pgrst,'reload schema';
commit;

-- Cheap supplier declarations have their own cursor. An inconclusive speech
-- analysis must never quarantine a metadata lookup for a different file.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create table public.catalog_provider_audio_metadata_sweeps (
 source_id uuid primary key references public.cloud_sources(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 generation_id uuid not null,
 config_revision bigint not null,
 visibility_epoch bigint not null,
 after_variant_id uuid,
 next_scan_at timestamptz not null default now(),
 scanned bigint not null default 0,
 processed bigint not null default 0,
 identified bigint not null default 0,
 inconclusive bigint not null default 0,
 cycles bigint not null default 0,
 updated_at timestamptz not null default now()
);
create table public.catalog_provider_audio_metadata_retries (
 variant_id uuid primary key references public.cloud_title_variants(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 source_id uuid not null references public.cloud_sources(id) on delete cascade,
 generation_id uuid not null,
 config_revision bigint not null,
 visibility_epoch bigint not null,
 attempts integer not null default 0 check(attempts between 0 and 3),
 next_attempt_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 last_code text,
 updated_at timestamptz not null default now()
);
create index catalog_provider_audio_metadata_retry_due on public.catalog_provider_audio_metadata_retries(source_id,next_attempt_at,variant_id);
create index catalog_provider_audio_metadata_lease on public.catalog_provider_audio_metadata_retries(lease_until) where lease_token is not null;
alter table public.catalog_provider_audio_metadata_sweeps enable row level security;
alter table public.catalog_provider_audio_metadata_retries enable row level security;
revoke all on public.catalog_provider_audio_metadata_sweeps,public.catalog_provider_audio_metadata_retries from public,anon,authenticated,service_role;
grant select on public.catalog_provider_audio_metadata_sweeps,public.catalog_provider_audio_metadata_retries to service_role;

create function public.claim_catalog_provider_audio_metadata(p_user uuid,p_source uuid)
returns jsonb language plpgsql security definer set search_path='' as $f$
declare
 g uuid; identity_id uuid; config bigint; visibility bigint;
 cursor_row public.catalog_provider_audio_metadata_sweeps%rowtype;
 ids uuid[]; candidate record; retry_id uuid; token uuid:=gen_random_uuid();
 scanned_count integer; retry_turn boolean:=false;
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
 perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));
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
    and (cursor_row.after_variant_id is null or v.id>cursor_row.after_variant_id) order by v.id limit 256) page;
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
 if not retry_turn then
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
end $f$;

create function public.finish_catalog_provider_audio_metadata(p_user uuid,p_source uuid,p_variant uuid,p_token uuid,
 p_outcome text,p_code text,p_transport_uncertain boolean default false)
returns boolean language plpgsql security definer set search_path='' as $f$
declare row_data public.catalog_provider_audio_metadata_retries%rowtype;
begin
 perform public.norva_credential_require_service_role();
 if p_outcome is null or p_code is null or p_outcome not in ('identified','inconclusive','deferred','failed') or p_code !~ '^[a-z0-9_-]{1,100}$' then
  raise exception 'Invalid metadata outcome' using errcode='22023';
 end if;
 select * into row_data from public.catalog_provider_audio_metadata_retries
 where variant_id=p_variant and user_id=p_user and source_id=p_source and lease_token=p_token and lease_until>now() for update;
 if not found then return false; end if;
 update public.catalog_provider_audio_metadata_sweeps set processed=processed+1,
  identified=identified+case when p_outcome='identified' then 1 else 0 end,
  inconclusive=inconclusive+case when p_outcome='inconclusive' then 1 else 0 end,updated_at=now()
 where source_id=p_source and user_id=p_user and generation_id=row_data.generation_id
  and config_revision=row_data.config_revision and visibility_epoch=row_data.visibility_epoch;
 if p_outcome in ('identified','inconclusive') then
  delete from public.catalog_provider_audio_metadata_retries where variant_id=p_variant;
 else
  update public.catalog_provider_audio_metadata_retries set lease_token=null,
   lease_until=case when p_transport_uncertain then lease_until else null end,
   attempts=least(3,attempts+case when p_outcome='failed' then 1 else 0 end),
   next_attempt_at=now()+case when p_outcome='deferred' then interval '5 minutes'
    when attempts>=2 then interval '7 days' when attempts=1 then interval '6 hours' else interval '1 hour' end,
   last_code=p_code,updated_at=now() where variant_id=p_variant;
 end if;
 return true;
end $f$;
revoke all on function public.claim_catalog_provider_audio_metadata(uuid,uuid),
 public.finish_catalog_provider_audio_metadata(uuid,uuid,uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_catalog_provider_audio_metadata(uuid,uuid),
 public.finish_catalog_provider_audio_metadata(uuid,uuid,uuid,uuid,text,text,boolean) to service_role;

-- Both intake families share the admission budget. Preserve the old gates.
create or replace function public.catalog_language_metadata_available_for_source(p_user uuid,p_source uuid)
returns boolean language sql volatile security definer set search_path='' as $f$
 select public.catalog_language_metadata_enabled_for_source(p_user,p_source) and
  coalesce((select c.expires_at>clock_timestamp() and c.max_workers>
   (select count(*) from public.catalog_vod_language_intake q where q.state='leased' and q.lease_until>clock_timestamp())
   +(select count(*) from public.catalog_provider_audio_metadata_retries q where q.lease_until>clock_timestamp())
   from public.catalog_language_metadata_capacity c where c.singleton),false)
$f$;

-- A cheap metadata turn precedes each existing lane. A full cycle is now 24
-- turns; the 12 original lanes keep their order and their provider guards.
do $patch$
declare d text;
begin
 d:=pg_get_functiondef('public.finish_catalog_enrichment_source(uuid,uuid,boolean,integer,boolean,jsonb)'::regprocedure);
 if position('mod(schedule.dispatch_count, 12)' in d)=0 or position('current_lane = 11' in d)=0 then
  raise exception 'Enrichment rotation drift';
 end if;
 d:=replace(d,'mod(schedule.dispatch_count, 12)',
  'case when p_result->>''fleetRotationProtocol''=''2'' then case when mod(schedule.dispatch_count,2)=0 then -1 else mod(schedule.dispatch_count/2,12) end else mod(schedule.dispatch_count,12) end');
 execute d;
end $patch$;
notify pgrst,'reload schema';
commit;

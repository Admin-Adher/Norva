begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Materialize the small displayed-card set before expensive per-file evidence
-- checks. Eligibility, provider admission, retries and leases remain unchanged.

do $guard$ begin
 if btrim(pg_get_functiondef('public.claim_catalog_vod_language_file(uuid,uuid)'::regprocedure),E' \n\r')<>btrim($before$CREATE OR REPLACE FUNCTION public.claim_catalog_vod_language_file(p_user uuid, p_source uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_generation uuid;
  v_identity text;
  v_cursor public.catalog_vod_language_sweeps%rowtype;
  v_row record;
  v_page uuid[];
  v_scanned integer:=0;
  v_token uuid:=gen_random_uuid();
  v_retry boolean:=false;
  v_unknown boolean;
  v_featured boolean:=false;
  v_after uuid;
  v_next timestamptz;
begin
  if not exists(select 1 from public.admin_feature_flags where key='automatic_vod_language_fleet_enabled' and enabled)
    or exists(select 1 from public.admin_feature_flags where key='enrichment_paused' and enabled)
    or not exists(select 1 from public.admin_feature_flags where key='audio_lid_enabled' and enabled) then
    return jsonb_build_object('skipped','automatic-language-disabled');
  end if;
  if not public.norva_source_catalog_visible_internal(p_source,p_user)
    or not exists(select 1 from auth.users where id=p_user and deleted_at is null and (banned_until is null or banned_until<=now())) then
    return jsonb_build_object('skipped','source-not-visible');
  end if;
  select h.active_generation_id,coalesce(i.identity_id::text,'source:'||s.id::text)
    into v_generation,v_identity
  from public.cloud_sources s join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
  left join public.catalog_source_provider_identities i on i.source_id=s.id and i.user_id=s.user_id and i.verified_at is not null
  where s.id=p_source and s.user_id=p_user and s.enabled and s.deleted_at is null and s.sync_status='ready';
  if v_generation is null then return jsonb_build_object('skipped','catalogue-not-ready'); end if;
  -- Advisory transaction lock makes cursor creation/claim atomic even on the
  -- first tick. SKIP LOCKED avoids waiting behind a second source dispatcher.
  if not pg_try_advisory_xact_lock(hashtextextended('vod-language-intake:'||p_source::text,0)) then
    return jsonb_build_object('skipped','intake-busy');
  end if;
  insert into public.catalog_vod_language_sweeps(source_id,user_id,generation_id)
  values(p_source,p_user,v_generation)
  on conflict(source_id) do update set user_id=excluded.user_id,generation_id=excluded.generation_id,
    after_variant_id=null,next_scan_at=now(),unknown_after_variant_id=null,unknown_next_scan_at=now(),priority_ticks=0,updated_at=now()
  where catalog_vod_language_sweeps.generation_id is distinct from excluded.generation_id
     or catalog_vod_language_sweeps.user_id is distinct from excluded.user_id;
  select * into v_cursor from public.catalog_vod_language_sweeps where source_id=p_source for update;

  -- One exact-file network operation per source claim; a lost HTTP response
  -- keeps its lease for longer than the provider request/cleanup deadline.
  if exists(select 1 from public.catalog_vod_language_intake q where q.source_id=p_source
    and q.state='leased' and q.lease_until>now()) then
    return jsonb_build_object('skipped','intake-busy');
  end if;
  update public.catalog_vod_language_intake set attempts=least(3,attempts+1),
    state=case when attempts>=2 then 'failed' else 'deferred' end,
    lease_token=null,lease_until=null,next_attempt_at=case when attempts>=2 then null else now()+interval '1 hour' end,
    last_code='lost-intake-lease',updated_at=now()
  where source_id=p_source and state='leased' and lease_until<=now();
  if not exists(select 1 from public.admin_feature_flags where key='adaptive_language_admission_enabled' and enabled) then
    return jsonb_build_object('skipped','automatic-admission-paused','hasMore',true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));
  if public.catalog_language_metadata_enabled_for_source(p_user,p_source) then
    if not public.catalog_language_metadata_available_for_source(p_user,p_source) then
      return jsonb_build_object('skipped','metadata-capacity','hasMore',true);
    end if;
  else
  if not public.catalog_language_queue_available(v_identity) then
    return jsonb_build_object('skipped','automatic-queue-full','hasMore',true);
  end if;
  if not public.catalog_language_execution_available() then
    return jsonb_build_object('skipped','server-capacity','hasMore',true);
  end if;
  end if;

  v_unknown:=true;
  select v.id,v.external_id,c.observed_profile_fingerprint into v_row
  from public.cloud_title_variants v
  join public.catalog_featured_language_titles featured on featured.user_id=v.user_id and featured.title_id=v.title_id
  left join public.catalog_file_tracks c on c.server_host=v_identity and c.item_type='movie' and c.external_id=v.external_id
  left join public.catalog_vod_language_intake q on q.variant_id=v.id
  where featured.expires_at>now() and v.source_id=p_source and v.user_id=p_user and v.generation_id=v_generation
    and v.item_type='movie' and btrim(v.external_id)<>''
    and public.catalog_movie_audio_identified(p_user,p_source,v.id) is distinct from v_unknown
    and (q.variant_id is null or q.identity_key<>v_identity or
      (c.observed_profile_fingerprint is not null and q.profile_fingerprint is distinct from c.observed_profile_fingerprint) or
      (q.attempts<3 and ((q.state='deferred' and q.next_attempt_at<=now()) or (q.state='leased' and q.lease_until<=now()))))
    and c.audio_lang_verified_at is null
    and (c.audio_lang_retry_at is null or c.audio_lang_retry_at<=now())
    and (v_unknown or c.audio_probed_at is null or jsonb_typeof(c.audio_tracks) is distinct from 'array'
      or jsonb_array_length(case when jsonb_typeof(c.audio_tracks)='array' then c.audio_tracks else '[]'::jsonb end)=0
      or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(c.audio_tracks)='array' then c.audio_tracks else '[]'::jsonb end) t
        where public.norva_canonical_language_code(coalesce(t->>'lang',t->>'language')) is null))
    and not exists(select 1 from public.catalog_file_audio_validation_jobs j
      where j.identity_key=v_identity and j.item_type='movie' and j.external_id=v.external_id
        and (j.quarantined_at is not null or j.state in ('queued','running','retry_wait','finalizing')
          or c.observed_profile_fingerprint is null or j.profile_fingerprint=c.observed_profile_fingerprint))
  order by featured.display_rank,featured.seen_at desc,v.id limit 1;
  v_featured:=v_row.id is not null;
  if not v_featured then
  -- Nine unknown-first pages for one validation page. Separate cursors prevent
  -- tagged UUIDs from starving unknowns, or a validation pass skipping them.
  -- A resting lane yields to the other; retries/quarantines are never reset.
  v_unknown:=mod(v_cursor.priority_ticks,10)<>9;
  if v_unknown and v_cursor.unknown_next_scan_at>now() and v_cursor.next_scan_at<=now() then
    v_unknown:=false;
  elsif not v_unknown and v_cursor.next_scan_at>now() and v_cursor.unknown_next_scan_at<=now() then
    v_unknown:=true;
  end if;
  v_after:=case when v_unknown then v_cursor.unknown_after_variant_id else v_cursor.after_variant_id end;
  v_next:=case when v_unknown then v_cursor.unknown_next_scan_at else v_cursor.next_scan_at end;
  update public.catalog_vod_language_sweeps set priority_ticks=priority_ticks+1 where source_id=p_source;

  -- Expired/deferred attempts get a fair turn, but cannot monopolise a sweep:
  -- alternate them with fresh pages whenever a fresh page is due.
  select array_agg(q.variant_id order by q.next_attempt_at nulls first,q.variant_id) into v_page
  from (select variant_id,next_attempt_at from public.catalog_vod_language_intake
    where source_id=p_source and user_id=p_user and generation_id=v_generation and identity_key=v_identity
      and public.catalog_movie_audio_identified(p_user,p_source,variant_id) is distinct from v_unknown
      and attempts<3 and ((state='deferred' and next_attempt_at<=now()) or (state='leased' and lease_until<=now()))
    order by next_attempt_at nulls first,variant_id limit 1) q;
  v_retry:=coalesce(cardinality(v_page),0)>0 and (v_next>now() or mod(v_cursor.scanned,2)=1);
  if not v_retry then
    if v_next>now() then return jsonb_build_object('skipped','sweep-resting'); end if;
    select array_agg(q.id order by q.id) into v_page from (
      select v.id from public.cloud_title_variants v
      where v.source_id=p_source and v.user_id=p_user and v.generation_id=v_generation
        and v.item_type='movie' and (v_after is null or v.id>v_after)
      order by v.id limit 256
    ) q;
  end if;
  else
    v_page:=array[v_row.id];
  end if;
  v_scanned:=coalesce(cardinality(v_page),0);
  if v_scanned=0 then
    update public.catalog_vod_language_sweeps set
      unknown_after_variant_id=case when v_unknown then null else unknown_after_variant_id end,
      unknown_next_scan_at=case when v_unknown then now()+interval '6 hours' else unknown_next_scan_at end,
      after_variant_id=case when not v_unknown then null else after_variant_id end,
      next_scan_at=case when not v_unknown then now()+interval '6 hours' else next_scan_at end,
      cycles=cycles+1,updated_at=now() where source_id=p_source;
    return jsonb_build_object('scanned',0,'hasMore',true,'lane',case when v_unknown then 'unknown' else 'validation' end);
  end if;
  select v.id,v.external_id,c.observed_profile_fingerprint into v_row
  from public.cloud_title_variants v
  left join public.catalog_file_tracks c on c.server_host=v_identity and c.item_type='movie' and c.external_id=v.external_id
  left join public.catalog_vod_language_intake q on q.variant_id=v.id
  where v.id=any(v_page) and v.source_id=p_source and v.user_id=p_user and v.generation_id=v_generation
    and v.item_type='movie' and btrim(v.external_id)<>''
    and public.catalog_movie_audio_identified(p_user,p_source,v.id) is distinct from v_unknown
    and (q.variant_id is null or q.identity_key<>v_identity or
      (c.observed_profile_fingerprint is not null and q.profile_fingerprint is distinct from c.observed_profile_fingerprint) or
      (q.attempts<3 and ((q.state='deferred' and q.next_attempt_at<=now()) or (q.state='leased' and q.lease_until<=now()))))
    and c.audio_lang_verified_at is null
    and (c.audio_lang_retry_at is null or c.audio_lang_retry_at<=now())
    and (v_unknown or c.audio_probed_at is null or jsonb_typeof(c.audio_tracks) is distinct from 'array'
      or jsonb_array_length(case when jsonb_typeof(c.audio_tracks)='array' then c.audio_tracks else '[]'::jsonb end)=0
      or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(c.audio_tracks)='array' then c.audio_tracks else '[]'::jsonb end) t
        where public.norva_canonical_language_code(coalesce(t->>'lang',t->>'language')) is null))
    and not exists(select 1 from public.catalog_file_audio_validation_jobs j
      where j.identity_key=v_identity and j.item_type='movie' and j.external_id=v.external_id
        and (j.quarantined_at is not null or j.state in ('queued','running','retry_wait','finalizing')
          or c.observed_profile_fingerprint is null or j.profile_fingerprint=c.observed_profile_fingerprint))
  order by v.id limit 1;
  if not v_retry and v_row.id is not null then v_scanned:=array_position(v_page,v_row.id); end if;
  if not v_retry and not v_featured then
    update public.catalog_vod_language_sweeps set
      unknown_after_variant_id=case when v_unknown then coalesce(v_row.id,v_page[v_scanned]) else unknown_after_variant_id end,
      after_variant_id=case when not v_unknown then coalesce(v_row.id,v_page[v_scanned]) else after_variant_id end,
      scanned=scanned+case when v_row.id is null then v_scanned else array_position(v_page,v_row.id) end,
      updated_at=now() where source_id=p_source;
  else
    update public.catalog_vod_language_sweeps set scanned=scanned+1,updated_at=now() where source_id=p_source;
  end if;
  if v_row.id is null then
    if v_retry then
      update public.catalog_vod_language_intake set state='unsupported',last_code='satisfied-or-ineligible',
        next_attempt_at=null,updated_at=now() where variant_id=any(v_page) and state='deferred';
    end if;
    return jsonb_build_object('scanned',v_scanned,'hasMore',true);
  end if;
  insert into public.catalog_vod_language_intake(variant_id,user_id,source_id,generation_id,identity_key,external_id,profile_fingerprint,state,lease_token,lease_until)
  values(v_row.id,p_user,p_source,v_generation,v_identity,v_row.external_id,v_row.observed_profile_fingerprint,'leased',v_token,now()+interval '20 minutes')
  on conflict(variant_id) do update set state='leased',lease_token=excluded.lease_token,lease_until=excluded.lease_until,
    attempts=case when catalog_vod_language_intake.identity_key<>excluded.identity_key
      or catalog_vod_language_intake.profile_fingerprint is distinct from excluded.profile_fingerprint then 0
      else catalog_vod_language_intake.attempts end,
    profile_fingerprint=excluded.profile_fingerprint,
    identity_key=excluded.identity_key,generation_id=excluded.generation_id,next_attempt_at=null,updated_at=now();
  return jsonb_build_object('variantId',v_row.id,'itemId',v_row.external_id,'identityKey',v_identity,'generationId',v_generation,
    'leaseToken',v_token,'scanned',v_scanned,'hasMore',true,'lane',case when v_unknown then 'unknown' else 'validation' end);
end
$function$$before$,E' \n\r') then
 raise exception 'Featured language candidate function drift: claim_catalog_vod_language_file';
 end if;
end $guard$;
CREATE OR REPLACE FUNCTION public.claim_catalog_vod_language_file(p_user uuid, p_source uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_generation uuid;
  v_identity text;
  v_cursor public.catalog_vod_language_sweeps%rowtype;
  v_row record;
  v_page uuid[];
  v_scanned integer:=0;
  v_token uuid:=gen_random_uuid();
  v_retry boolean:=false;
  v_unknown boolean;
  v_featured boolean:=false;
  v_after uuid;
  v_next timestamptz;
begin
  if not exists(select 1 from public.admin_feature_flags where key='automatic_vod_language_fleet_enabled' and enabled)
    or exists(select 1 from public.admin_feature_flags where key='enrichment_paused' and enabled)
    or not exists(select 1 from public.admin_feature_flags where key='audio_lid_enabled' and enabled) then
    return jsonb_build_object('skipped','automatic-language-disabled');
  end if;
  if not public.norva_source_catalog_visible_internal(p_source,p_user)
    or not exists(select 1 from auth.users where id=p_user and deleted_at is null and (banned_until is null or banned_until<=now())) then
    return jsonb_build_object('skipped','source-not-visible');
  end if;
  select h.active_generation_id,coalesce(i.identity_id::text,'source:'||s.id::text)
    into v_generation,v_identity
  from public.cloud_sources s join public.cloud_source_catalog_heads h on h.source_id=s.id and h.user_id=s.user_id
  left join public.catalog_source_provider_identities i on i.source_id=s.id and i.user_id=s.user_id and i.verified_at is not null
  where s.id=p_source and s.user_id=p_user and s.enabled and s.deleted_at is null and s.sync_status='ready';
  if v_generation is null then return jsonb_build_object('skipped','catalogue-not-ready'); end if;
  -- Advisory transaction lock makes cursor creation/claim atomic even on the
  -- first tick. SKIP LOCKED avoids waiting behind a second source dispatcher.
  if not pg_try_advisory_xact_lock(hashtextextended('vod-language-intake:'||p_source::text,0)) then
    return jsonb_build_object('skipped','intake-busy');
  end if;
  insert into public.catalog_vod_language_sweeps(source_id,user_id,generation_id)
  values(p_source,p_user,v_generation)
  on conflict(source_id) do update set user_id=excluded.user_id,generation_id=excluded.generation_id,
    after_variant_id=null,next_scan_at=now(),unknown_after_variant_id=null,unknown_next_scan_at=now(),priority_ticks=0,updated_at=now()
  where catalog_vod_language_sweeps.generation_id is distinct from excluded.generation_id
     or catalog_vod_language_sweeps.user_id is distinct from excluded.user_id;
  select * into v_cursor from public.catalog_vod_language_sweeps where source_id=p_source for update;

  -- One exact-file network operation per source claim; a lost HTTP response
  -- keeps its lease for longer than the provider request/cleanup deadline.
  if exists(select 1 from public.catalog_vod_language_intake q where q.source_id=p_source
    and q.state='leased' and q.lease_until>now()) then
    return jsonb_build_object('skipped','intake-busy');
  end if;
  update public.catalog_vod_language_intake set attempts=least(3,attempts+1),
    state=case when attempts>=2 then 'failed' else 'deferred' end,
    lease_token=null,lease_until=null,next_attempt_at=case when attempts>=2 then null else now()+interval '1 hour' end,
    last_code='lost-intake-lease',updated_at=now()
  where source_id=p_source and state='leased' and lease_until<=now();
  if not exists(select 1 from public.admin_feature_flags where key='adaptive_language_admission_enabled' and enabled) then
    return jsonb_build_object('skipped','automatic-admission-paused','hasMore',true);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-language-admission',0));
  if public.catalog_language_metadata_enabled_for_source(p_user,p_source) then
    if not public.catalog_language_metadata_available_for_source(p_user,p_source) then
      return jsonb_build_object('skipped','metadata-capacity','hasMore',true);
    end if;
  else
  if not public.catalog_language_queue_available(v_identity) then
    return jsonb_build_object('skipped','automatic-queue-full','hasMore',true);
  end if;
  if not public.catalog_language_execution_available() then
    return jsonb_build_object('skipped','server-capacity','hasMore',true);
  end if;
  end if;

  v_unknown:=true;
  with featured_candidates as materialized (
    select v.*,featured.display_rank,featured.seen_at from public.cloud_title_variants v
    join public.catalog_featured_language_titles featured on featured.user_id=v.user_id and featured.title_id=v.title_id
    where featured.expires_at>now() and v.source_id=p_source and v.user_id=p_user and v.generation_id=v_generation
      and v.item_type='movie' and btrim(v.external_id)<>''
  )
  select v.id,v.external_id,c.observed_profile_fingerprint into v_row
  from featured_candidates v
  left join public.catalog_file_tracks c on c.server_host=v_identity and c.item_type='movie' and c.external_id=v.external_id
  left join public.catalog_vod_language_intake q on q.variant_id=v.id
  where public.catalog_movie_audio_identified(p_user,p_source,v.id) is distinct from v_unknown
    and (q.variant_id is null or q.identity_key<>v_identity or
      (c.observed_profile_fingerprint is not null and q.profile_fingerprint is distinct from c.observed_profile_fingerprint) or
      (q.attempts<3 and ((q.state='deferred' and q.next_attempt_at<=now()) or (q.state='leased' and q.lease_until<=now()))))
    and c.audio_lang_verified_at is null
    and (c.audio_lang_retry_at is null or c.audio_lang_retry_at<=now())
    and (v_unknown or c.audio_probed_at is null or jsonb_typeof(c.audio_tracks) is distinct from 'array'
      or jsonb_array_length(case when jsonb_typeof(c.audio_tracks)='array' then c.audio_tracks else '[]'::jsonb end)=0
      or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(c.audio_tracks)='array' then c.audio_tracks else '[]'::jsonb end) t
        where public.norva_canonical_language_code(coalesce(t->>'lang',t->>'language')) is null))
    and not exists(select 1 from public.catalog_file_audio_validation_jobs j
      where j.identity_key=v_identity and j.item_type='movie' and j.external_id=v.external_id
        and (j.quarantined_at is not null or j.state in ('queued','running','retry_wait','finalizing')
          or c.observed_profile_fingerprint is null or j.profile_fingerprint=c.observed_profile_fingerprint))
  order by v.display_rank,v.seen_at desc,v.id limit 1;
  v_featured:=v_row.id is not null;
  if not v_featured then
  -- Nine unknown-first pages for one validation page. Separate cursors prevent
  -- tagged UUIDs from starving unknowns, or a validation pass skipping them.
  -- A resting lane yields to the other; retries/quarantines are never reset.
  v_unknown:=mod(v_cursor.priority_ticks,10)<>9;
  if v_unknown and v_cursor.unknown_next_scan_at>now() and v_cursor.next_scan_at<=now() then
    v_unknown:=false;
  elsif not v_unknown and v_cursor.next_scan_at>now() and v_cursor.unknown_next_scan_at<=now() then
    v_unknown:=true;
  end if;
  v_after:=case when v_unknown then v_cursor.unknown_after_variant_id else v_cursor.after_variant_id end;
  v_next:=case when v_unknown then v_cursor.unknown_next_scan_at else v_cursor.next_scan_at end;
  update public.catalog_vod_language_sweeps set priority_ticks=priority_ticks+1 where source_id=p_source;

  -- Expired/deferred attempts get a fair turn, but cannot monopolise a sweep:
  -- alternate them with fresh pages whenever a fresh page is due.
  select array_agg(q.variant_id order by q.next_attempt_at nulls first,q.variant_id) into v_page
  from (select variant_id,next_attempt_at from public.catalog_vod_language_intake
    where source_id=p_source and user_id=p_user and generation_id=v_generation and identity_key=v_identity
      and public.catalog_movie_audio_identified(p_user,p_source,variant_id) is distinct from v_unknown
      and attempts<3 and ((state='deferred' and next_attempt_at<=now()) or (state='leased' and lease_until<=now()))
    order by next_attempt_at nulls first,variant_id limit 1) q;
  v_retry:=coalesce(cardinality(v_page),0)>0 and (v_next>now() or mod(v_cursor.scanned,2)=1);
  if not v_retry then
    if v_next>now() then return jsonb_build_object('skipped','sweep-resting'); end if;
    select array_agg(q.id order by q.id) into v_page from (
      select v.id from public.cloud_title_variants v
      where v.source_id=p_source and v.user_id=p_user and v.generation_id=v_generation
        and v.item_type='movie' and (v_after is null or v.id>v_after)
      order by v.id limit 256
    ) q;
  end if;
  else
    v_page:=array[v_row.id];
  end if;
  v_scanned:=coalesce(cardinality(v_page),0);
  if v_scanned=0 then
    update public.catalog_vod_language_sweeps set
      unknown_after_variant_id=case when v_unknown then null else unknown_after_variant_id end,
      unknown_next_scan_at=case when v_unknown then now()+interval '6 hours' else unknown_next_scan_at end,
      after_variant_id=case when not v_unknown then null else after_variant_id end,
      next_scan_at=case when not v_unknown then now()+interval '6 hours' else next_scan_at end,
      cycles=cycles+1,updated_at=now() where source_id=p_source;
    return jsonb_build_object('scanned',0,'hasMore',true,'lane',case when v_unknown then 'unknown' else 'validation' end);
  end if;
  select v.id,v.external_id,c.observed_profile_fingerprint into v_row
  from public.cloud_title_variants v
  left join public.catalog_file_tracks c on c.server_host=v_identity and c.item_type='movie' and c.external_id=v.external_id
  left join public.catalog_vod_language_intake q on q.variant_id=v.id
  where v.id=any(v_page) and v.source_id=p_source and v.user_id=p_user and v.generation_id=v_generation
    and v.item_type='movie' and btrim(v.external_id)<>''
    and public.catalog_movie_audio_identified(p_user,p_source,v.id) is distinct from v_unknown
    and (q.variant_id is null or q.identity_key<>v_identity or
      (c.observed_profile_fingerprint is not null and q.profile_fingerprint is distinct from c.observed_profile_fingerprint) or
      (q.attempts<3 and ((q.state='deferred' and q.next_attempt_at<=now()) or (q.state='leased' and q.lease_until<=now()))))
    and c.audio_lang_verified_at is null
    and (c.audio_lang_retry_at is null or c.audio_lang_retry_at<=now())
    and (v_unknown or c.audio_probed_at is null or jsonb_typeof(c.audio_tracks) is distinct from 'array'
      or jsonb_array_length(case when jsonb_typeof(c.audio_tracks)='array' then c.audio_tracks else '[]'::jsonb end)=0
      or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(c.audio_tracks)='array' then c.audio_tracks else '[]'::jsonb end) t
        where public.norva_canonical_language_code(coalesce(t->>'lang',t->>'language')) is null))
    and not exists(select 1 from public.catalog_file_audio_validation_jobs j
      where j.identity_key=v_identity and j.item_type='movie' and j.external_id=v.external_id
        and (j.quarantined_at is not null or j.state in ('queued','running','retry_wait','finalizing')
          or c.observed_profile_fingerprint is null or j.profile_fingerprint=c.observed_profile_fingerprint))
  order by v.id limit 1;
  if not v_retry and v_row.id is not null then v_scanned:=array_position(v_page,v_row.id); end if;
  if not v_retry and not v_featured then
    update public.catalog_vod_language_sweeps set
      unknown_after_variant_id=case when v_unknown then coalesce(v_row.id,v_page[v_scanned]) else unknown_after_variant_id end,
      after_variant_id=case when not v_unknown then coalesce(v_row.id,v_page[v_scanned]) else after_variant_id end,
      scanned=scanned+case when v_row.id is null then v_scanned else array_position(v_page,v_row.id) end,
      updated_at=now() where source_id=p_source;
  else
    update public.catalog_vod_language_sweeps set scanned=scanned+1,updated_at=now() where source_id=p_source;
  end if;
  if v_row.id is null then
    if v_retry then
      update public.catalog_vod_language_intake set state='unsupported',last_code='satisfied-or-ineligible',
        next_attempt_at=null,updated_at=now() where variant_id=any(v_page) and state='deferred';
    end if;
    return jsonb_build_object('scanned',v_scanned,'hasMore',true);
  end if;
  insert into public.catalog_vod_language_intake(variant_id,user_id,source_id,generation_id,identity_key,external_id,profile_fingerprint,state,lease_token,lease_until)
  values(v_row.id,p_user,p_source,v_generation,v_identity,v_row.external_id,v_row.observed_profile_fingerprint,'leased',v_token,now()+interval '20 minutes')
  on conflict(variant_id) do update set state='leased',lease_token=excluded.lease_token,lease_until=excluded.lease_until,
    attempts=case when catalog_vod_language_intake.identity_key<>excluded.identity_key
      or catalog_vod_language_intake.profile_fingerprint is distinct from excluded.profile_fingerprint then 0
      else catalog_vod_language_intake.attempts end,
    profile_fingerprint=excluded.profile_fingerprint,
    identity_key=excluded.identity_key,generation_id=excluded.generation_id,next_attempt_at=null,updated_at=now();
  return jsonb_build_object('variantId',v_row.id,'itemId',v_row.external_id,'identityKey',v_identity,'generationId',v_generation,
    'leaseToken',v_token,'scanned',v_scanned,'hasMore',true,'lane',case when v_unknown then 'unknown' else 'validation' end);
end
$function$;

do $guard$ begin
 if btrim(pg_get_functiondef('public.claim_catalog_provider_audio_metadata(uuid,uuid)'::regprocedure),E' \n\r')<>btrim($before$CREATE OR REPLACE FUNCTION public.claim_catalog_provider_audio_metadata(p_user uuid, p_source uuid)
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
 select v.id,v.external_id into candidate from public.cloud_title_variants v
 join public.catalog_featured_language_titles featured on featured.user_id=v.user_id and featured.title_id=v.title_id
 where featured.expires_at>now() and v.user_id=p_user and v.source_id=p_source and v.generation_id=g
  and v.item_type='movie' and v.external_id ~ '^[0-9]+$'
  and not public.catalog_movie_audio_identified(p_user,p_source,v.id)
  and not exists(select 1 from public.catalog_owned_language_declarations d where d.variant_id=v.id
   and d.user_id=p_user and d.source_id=p_source and d.generation_id=g and d.provider_identity_id=identity_id
   and d.file_external_id=v.external_id and d.config_revision=config and d.source_visibility_epoch=visibility)
  and not exists(select 1 from public.catalog_provider_audio_metadata_retries q where q.variant_id=v.id
   and q.generation_id=g and q.config_revision=config and q.visibility_epoch=visibility
   and (q.next_attempt_at>now() or q.lease_until>now()))
 order by featured.display_rank,featured.seen_at desc,v.id limit 1;
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
end $function$$before$,E' \n\r') then
 raise exception 'Featured language candidate function drift: claim_catalog_provider_audio_metadata';
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
 with featured_candidates as materialized (
   select v.*,featured.display_rank,featured.seen_at from public.cloud_title_variants v
   join public.catalog_featured_language_titles featured on featured.user_id=v.user_id and featured.title_id=v.title_id
   where featured.expires_at>now() and v.user_id=p_user and v.source_id=p_source and v.generation_id=g
     and v.item_type='movie' and v.external_id ~ '^[0-9]+$'
 )
 select v.id,v.external_id into candidate from featured_candidates v
 where not public.catalog_movie_audio_identified(p_user,p_source,v.id)
  and not exists(select 1 from public.catalog_owned_language_declarations d where d.variant_id=v.id
   and d.user_id=p_user and d.source_id=p_source and d.generation_id=g and d.provider_identity_id=identity_id
   and d.file_external_id=v.external_id and d.config_revision=config and d.source_visibility_epoch=visibility)
  and not exists(select 1 from public.catalog_provider_audio_metadata_retries q where q.variant_id=v.id
   and q.generation_id=g and q.config_revision=config and q.visibility_epoch=visibility
   and (q.next_attempt_at>now() or q.lease_until>now()))
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

-- Unknown-first automatic intake, with an independent 10% validation lane.
-- No network/admission switch, attempt budget or quarantine is changed.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

alter table public.catalog_vod_language_sweeps
  add column unknown_after_variant_id uuid,
  add column unknown_next_scan_at timestamptz not null default now(),
  add column priority_ticks bigint not null default 0 check(priority_ticks>=0);

-- Indexed exact-variant complement of the MOVIE catalogue facet. Subtitles,
-- TMDB, parent-series caches and raw country tags are deliberately not evidence.
create function public.catalog_movie_audio_identified(p_user uuid,p_source uuid,p_variant uuid)
returns boolean language sql stable security invoker set search_path='' as $f$
  select exists(
    select 1 from public.cloud_catalog_visible_title_variants v
    join public.cloud_titles t on t.id=v.title_id and t.user_id=v.user_id and t.item_type=v.item_type
    where v.id=p_variant and v.user_id=p_user and v.source_id=p_source and v.item_type='movie'
      and (
        exists(select 1 from public.cloud_catalog_provider_language_hints h
          where h.variant_id=v.id and h.user_id=v.user_id and h.source_id=v.source_id
            and h.title_id=v.title_id and h.item_type='movie')
        or exists(select 1 from public.cloud_title_file_language_observations o
          cross join lateral unnest(o.audio_languages) lang(code)
          where o.user_id=v.user_id and o.title_id=v.title_id and o.variant_id=v.id
            and o.file_external_id=v.external_id and o.audio_observed
            and (lang.code='yue' or public.norva_canonical_language_code(lang.code) is not null))
      )
  )
$f$;
revoke all on function public.catalog_movie_audio_identified(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.catalog_movie_audio_identified(uuid,uuid,uuid) to service_role;

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
  if public.catalog_language_metadata_lane_enabled() then
    if not public.catalog_language_metadata_available() then
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
  if not v_retry then
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
$function$
;
notify pgrst,'reload schema';
commit;

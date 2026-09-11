-- Bounded, automatic movie-language intake for every active source, including
-- future imports. This feeds the existing strict worker; no model, certificate
-- threshold, quarantine, provider budget or existing cron is relaxed.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

create table public.catalog_vod_language_sweeps (
  source_id uuid primary key references public.cloud_sources(id) on delete cascade,
  user_id uuid not null,
  generation_id uuid not null,
  after_variant_id uuid,
  next_scan_at timestamptz not null default now(),
  cycles bigint not null default 0 check(cycles>=0),
  scanned bigint not null default 0 check(scanned>=0),
  updated_at timestamptz not null default now(),
  foreign key(user_id,source_id) references public.cloud_sources(user_id,id) on delete cascade
);
create table public.catalog_vod_language_intake (
  variant_id uuid primary key references public.cloud_title_variants(id) on delete cascade,
  user_id uuid not null,
  source_id uuid not null,
  generation_id uuid not null,
  identity_key text not null,
  external_id text not null,
  profile_fingerprint text check(profile_fingerprint is null or profile_fingerprint ~ '^[a-f0-9]{64}$'),
  state text not null check(state in ('leased','deferred','queued','identified','verified','unsupported','failed')),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz,
  attempts integer not null default 0 check(attempts between 0 and 3),
  last_code text check(last_code is null or last_code ~ '^[a-z0-9_-]{1,100}$'),
  updated_at timestamptz not null default now(),
  foreign key(user_id,source_id) references public.cloud_sources(user_id,id) on delete cascade,
  check((state='leased' and lease_token is not null and lease_until is not null)
     or (state<>'leased' and lease_token is null and lease_until is null))
);
create index catalog_vod_language_intake_due_idx
  on public.catalog_vod_language_intake(source_id,generation_id,next_attempt_at,variant_id)
  where state in ('deferred','leased');
-- The older partial index covers only active jobs. Whole-history suppression
-- and the existing daily quota must also stay bounded as the fleet grows.
create index catalog_file_audio_validation_jobs_history_idx
  on public.catalog_file_audio_validation_jobs(identity_key,item_type,external_id)
  include(profile_fingerprint,state,quarantined_at);
create index catalog_file_audio_validation_jobs_daily_idx
  on public.catalog_file_audio_validation_jobs(requested_by,created_at desc);
alter table public.catalog_vod_language_sweeps enable row level security;
alter table public.catalog_vod_language_intake enable row level security;
revoke all on public.catalog_vod_language_sweeps,public.catalog_vod_language_intake from public,anon,authenticated;
grant select,insert,update,delete on public.catalog_vod_language_sweeps,public.catalog_vod_language_intake to service_role;

-- Deployment activation is a separate, guarded step after the new Edge code
-- and SQL tests pass. No public role can activate the switch.
insert into public.admin_feature_flags(key,enabled) values('automatic_vod_language_fleet_enabled',false)
on conflict(key) do nothing;

create function public.claim_catalog_vod_language_file(p_user uuid,p_source uuid)
returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  v_generation uuid;
  v_identity text;
  v_cursor public.catalog_vod_language_sweeps%rowtype;
  v_row record;
  v_page uuid[];
  v_scanned integer:=0;
  v_token uuid:=gen_random_uuid();
  v_retry boolean:=false;
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
  left join public.catalog_source_provider_identities i on i.source_id=s.id and i.user_id=s.user_id
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
    after_variant_id=null,next_scan_at=now(),updated_at=now()
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
  -- Already queued strict jobs are never reset, including quarantines. Before
  -- downloading another file, honour the existing 2-active/20-per-day budget.
  if (select count(*) from public.catalog_file_audio_validation_jobs j where j.requested_by=p_user
      and j.state in ('queued','running','retry_wait','finalizing'))>=2
    or (select count(*) from public.catalog_file_audio_validation_jobs j where j.requested_by=p_user
      and j.created_at>now()-interval '24 hours')>=20 then
    return jsonb_build_object('skipped','language-quota','hasMore',true);
  end if;

  -- Expired/deferred attempts get a fair turn, but cannot monopolise a sweep:
  -- alternate them with fresh pages whenever a fresh page is due.
  select array_agg(q.variant_id order by q.next_attempt_at nulls first,q.variant_id) into v_page
  from (select variant_id,next_attempt_at from public.catalog_vod_language_intake
    where source_id=p_source and user_id=p_user and generation_id=v_generation and identity_key=v_identity
      and attempts<3 and ((state='deferred' and next_attempt_at<=now()) or (state='leased' and lease_until<=now()))
    order by next_attempt_at nulls first,variant_id limit 1) q;
  v_retry:=coalesce(cardinality(v_page),0)>0 and (v_cursor.next_scan_at>now() or mod(v_cursor.scanned,2)=1);
  if not v_retry then
    if v_cursor.next_scan_at>now() then return jsonb_build_object('skipped','sweep-resting'); end if;
    select array_agg(q.id order by q.id) into v_page from (
      select v.id from public.cloud_title_variants v
      where v.source_id=p_source and v.user_id=p_user and v.generation_id=v_generation
        and v.item_type='movie' and (v_cursor.after_variant_id is null or v.id>v_cursor.after_variant_id)
      order by v.id limit 256
    ) q;
  end if;
  v_scanned:=coalesce(cardinality(v_page),0);
  if v_scanned=0 then
    update public.catalog_vod_language_sweeps set after_variant_id=null,next_scan_at=now()+interval '6 hours',
      cycles=cycles+1,updated_at=now() where source_id=p_source;
    return jsonb_build_object('scanned',0,'hasMore',false,'exhausted',true);
  end if;
  select v.id,v.external_id,c.observed_profile_fingerprint into v_row
  from public.cloud_title_variants v
  left join public.catalog_file_tracks c on c.server_host=v_identity and c.item_type='movie' and c.external_id=v.external_id
  left join public.catalog_vod_language_intake q on q.variant_id=v.id
  where v.id=any(v_page) and v.source_id=p_source and v.user_id=p_user and v.generation_id=v_generation
    and v.item_type='movie' and btrim(v.external_id)<>''
    and (q.variant_id is null or q.identity_key<>v_identity or
      (c.observed_profile_fingerprint is not null and q.profile_fingerprint is distinct from c.observed_profile_fingerprint) or
      (q.attempts<3 and ((q.state='deferred' and q.next_attempt_at<=now()) or (q.state='leased' and q.lease_until<=now()))))
    and c.audio_lang_verified_at is null
    and (c.audio_lang_retry_at is null or c.audio_lang_retry_at<=now())
    and (c.audio_probed_at is null or jsonb_typeof(c.audio_tracks) is distinct from 'array'
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
    update public.catalog_vod_language_sweeps set after_variant_id=coalesce(v_row.id,v_page[v_scanned]),
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
  return jsonb_build_object('variantId',v_row.id,'itemId',v_row.external_id,'identityKey',v_identity,
    'leaseToken',v_token,'scanned',v_scanned,'hasMore',true);
end
$fn$;

create function public.finish_catalog_vod_language_file(
  p_user uuid,p_source uuid,p_variant uuid,p_lease_token uuid,p_outcome text,p_code text,p_attempted boolean default false
) returns boolean language plpgsql security definer set search_path='' as $fn$
declare v_attempts integer;
begin
  if p_outcome not in ('deferred','queued','identified','verified','unsupported','failed')
    or p_code is null or p_code !~ '^[a-z0-9_-]{1,100}$' or p_attempted is null then
    raise exception 'Invalid language intake outcome' using errcode='22023';
  end if;
  select least(3,attempts+case when p_attempted then 1 else 0 end) into v_attempts
  from public.catalog_vod_language_intake where variant_id=p_variant and user_id=p_user and source_id=p_source
    and state='leased' and lease_token=p_lease_token and lease_until>now() for update;
  if not found then return false; end if;
  update public.catalog_vod_language_intake set
    state=case when p_outcome in ('failed','deferred') and v_attempts>=3 then 'failed'
      when p_outcome='failed' then 'deferred' else p_outcome end,
    attempts=v_attempts,lease_token=null,lease_until=null,
    profile_fingerprint=(select observed_profile_fingerprint from public.catalog_file_tracks c
      where c.server_host=catalog_vod_language_intake.identity_key and c.item_type='movie'
        and c.external_id=catalog_vod_language_intake.external_id),
    next_attempt_at=case when p_outcome='deferred' and v_attempts<3 then now()+interval '5 minutes'
      when p_outcome='failed' and v_attempts<3 then now()+make_interval(secs=>3600*v_attempts) else null end,
    last_code=p_code,updated_at=now()
  where variant_id=p_variant and user_id=p_user and source_id=p_source and lease_token=p_lease_token;
  return true;
end
$fn$;

revoke all on function public.claim_catalog_vod_language_file(uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_catalog_vod_language_file(uuid,uuid,uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.claim_catalog_vod_language_file(uuid,uuid),
  public.finish_catalog_vod_language_file(uuid,uuid,uuid,uuid,text,text,boolean) to service_role;

-- Source-local certification for previously unseen providers. A source:UUID
-- key is server-derived and never shared across accounts. Existing canonical
-- identities continue to use exactly the same cache, fingerprints and guards.
-- Guarded replacements preserve every newer runtime check and function ACL.
do $patch$
declare target regprocedure; definition text; old text; new text;
begin
  target:='public.start_automatic_catalog_file_audio_validation_job(uuid,uuid,uuid,text,text,text,integer[],jsonb,text,timestamptz,bigint,jsonb,boolean)'::regprocedure;
  definition:=pg_get_functiondef(target);
  old:=$old$    join public.catalog_source_provider_identities identity
      on identity.source_id = source.id
     and identity.user_id = source.user_id
     and identity.identity_id::text = btrim(p_identity_key)
    where variant.id = p_variant_id$old$;
  new:=$new$    left join public.catalog_source_provider_identities identity
      on identity.source_id = source.id
     and identity.user_id = source.user_id
    where coalesce(identity.identity_id::text,'source:'||source.id::text)=btrim(p_identity_key)
      and variant.id = p_variant_id$new$;
  if position(old in definition)=0 then raise exception 'Automatic source binding drifted'; end if;
  definition:=replace(definition,old,new);
  old:='  with expired as (';
  new:=$new$  -- Run under the existing per-user and exact-file advisory locks.
  -- Automatic intake never revives quarantines or completed attempts against
  -- the same observed bytes. A genuinely changed profile is a new assessment.
  if exists(select 1 from public.catalog_file_audio_validation_jobs prior
    where prior.identity_key=btrim(p_identity_key) and prior.item_type=p_item_type
      and prior.external_id=btrim(p_external_id)
      and (prior.quarantined_at is not null or (prior.state in ('failed','cancelled','expired')
        and prior.profile_fingerprint=p_profile_fingerprint))) then
    return jsonb_build_object('busy',true,'code','LANGUAGE_VALIDATION_PRIOR_OUTCOME_PRESERVED');
  end if;
  with expired as ($new$;
  if position(old in definition)=0 then raise exception 'Automatic admission lock drifted'; end if;
  execute replace(definition,old,new);

  target:='public.finalize_catalog_file_audio_validation_job(uuid,text,text,timestamptz,bigint,integer[])'::regprocedure;
  definition:=pg_get_functiondef(target);
  old:=$old$  if not found then
    raise exception 'Exact language validation provider identity changed'
      using errcode = 'PT409';
  end if;$old$;
  new:=$new$  if not found and not (v_job.item_type='movie'
    and v_job.identity_key='source:'||v_job.source_id::text
    and not exists(select 1 from public.catalog_source_provider_identities
      where source_id=v_job.source_id and user_id=v_job.requested_by)) then
    raise exception 'Exact language validation provider identity changed' using errcode='PT409';
  end if;$new$;
  if position(old in definition)=0 then raise exception 'Finalizer source binding drifted'; end if;
  definition:=replace(definition,old,new);
  -- Exclusive source lock also blocks a concurrent new identity FK insertion.
  old:=$old$    and source.sync_status = 'ready'
  for share;$old$;
  if position(old in definition)=0 then raise exception 'Finalizer source lock drifted'; end if;
  execute replace(definition,old,replace(old,'for share;','for update;'));

  target:='public.observe_catalog_file_profile(uuid,uuid,uuid,text,text,text,jsonb,jsonb,jsonb,boolean,boolean)'::regprocedure;
  definition:=pg_get_functiondef(target);
  old:=$old$  select identity.identity_id::text into v_identity
  from public.catalog_source_provider_identities identity
  join public.cloud_catalog_visible_title_variants variant
    on variant.source_id=identity.source_id and variant.user_id=identity.user_id
  where identity.source_id=p_source_id and identity.user_id=p_user_id
    and identity.verified_at is not null and variant.id=p_variant_id;$old$;
  new:=$new$  select coalesce(identity.identity_id::text,'source:'||variant.source_id::text) into v_identity
  from public.cloud_catalog_visible_title_variants variant
  left join public.catalog_source_provider_identities identity
    on variant.source_id=identity.source_id and variant.user_id=identity.user_id
  where variant.source_id=p_source_id and variant.user_id=p_user_id and variant.id=p_variant_id
    and (identity.verified_at is not null or (p_item_type='movie' and identity.identity_id is null));$new$;
  if position(old in definition)=0 then raise exception 'Observation source binding drifted'; end if;
  definition:=replace(definition,old,new);
  old:=$old$  if not found then raise exception 'Observed provider identity changed' using errcode='PT409'; end if;$old$;
  new:=$new$  if not found and not (p_item_type='movie' and v_identity='source:'||p_source_id::text
    and not exists(select 1 from public.catalog_source_provider_identities where source_id=p_source_id and user_id=p_user_id)) then
    raise exception 'Observed provider identity changed' using errcode='PT409';
  end if;$new$;
  if position(old in definition)=0 then raise exception 'Observation identity barrier drifted'; end if;
  definition:=replace(definition,old,new);
  old:='and source.user_id=p_user_id and source.deleted_at is null and source.enabled for share;';
  if position(old in definition)=0 then raise exception 'Observation source lock drifted'; end if;
  definition:=replace(definition,old,replace(old,'for share;','for update;'));
  old:='  -- These established RPCs propagate canonical data, not the raw arguments.';
  new:=$new$  -- A private source has no identity-registry row and therefore must
  -- clear its own old certificate separately from the canonical-owner loop.
  if v_changed and p_item_type='movie' and v_identity='source:'||p_source_id::text then
    for v_owner in
      select variant.user_id,variant.title_id,variant.id as variant_id,
        head.head_revision,lifecycle.config_revision,
        lifecycle.visibility_epoch as source_visibility_epoch,epoch.visibility_epoch as user_visibility_epoch
      from public.cloud_title_variants variant
      join public.cloud_source_catalog_heads head on head.source_id=variant.source_id and head.user_id=variant.user_id
        and head.active_generation_id=variant.generation_id
      join public.cloud_source_lifecycle lifecycle on lifecycle.source_id=variant.source_id and lifecycle.user_id=variant.user_id
      join public.cloud_user_catalog_visibility_epochs epoch on epoch.user_id=variant.user_id
      where variant.id=p_variant_id and variant.source_id=p_source_id and variant.user_id=p_user_id
        and variant.item_type='movie' and variant.external_id=p_external_id
      for share of head,lifecycle,epoch
    loop
      update public.cloud_title_file_language_observations set audio_languages='{}'::text[],subtitle_languages='{}'::text[],
        audio_observed=false,subtitle_observed=false,audio_verified_at=null,audio_verification=v_provenance,updated_at=clock_timestamp()
      where user_id=p_user_id and variant_id=p_variant_id and file_external_id=p_external_id;
      update public.cloud_title_variants set audio_lang_verified_at=null,audio_lang_verify_retry_at=null,
        write_head_revision=v_owner.head_revision,write_config_revision=v_owner.config_revision,
        write_source_visibility_epoch=v_owner.source_visibility_epoch,write_user_visibility_epoch=v_owner.user_visibility_epoch
      where id=p_variant_id and user_id=p_user_id and source_id=p_source_id;
      update public.cloud_titles title set audio_tracks='[]'::jsonb,audio_languages='{}'::text[],audio_probed_at=null,
        subtitle_tracks='[]'::jsonb,subtitle_probed_at=null
      where title.id=v_owner.title_id and title.user_id=p_user_id and title.item_type='movie'
        and not exists(select 1 from public.cloud_catalog_visible_title_variants sibling
          where sibling.user_id=p_user_id and sibling.title_id=v_owner.title_id and sibling.id<>p_variant_id);
      perform public.recompute_cloud_title_file_languages(p_user_id,v_owner.title_id);
      v_reset_owners:=v_reset_owners+1;
    end loop;
  end if;
  -- These established RPCs propagate canonical data, not the raw arguments.$new$;
  if position(old in definition)=0 then raise exception 'Observation private reset point drifted'; end if;
  execute replace(definition,old,new);
end
$patch$;
notify pgrst,'reload schema';
commit;

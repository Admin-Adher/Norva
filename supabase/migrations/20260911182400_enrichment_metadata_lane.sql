begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

-- Keep the existing durable intake, cursor and exact-file history guards. This
-- is a second resource budget, not a duplicate queue or a reset of old work.
create table public.catalog_language_metadata_capacity (
  singleton boolean primary key default true check(singleton),
  max_workers integer not null check(max_workers between 0 and 2),
  reason text not null check(reason in ('capacity-unavailable','viewer-priority','foreground-work',
    'resource-pressure','background-occupied','capacity-available','metadata-lane-disabled','network-occupied')),
  observed_at timestamptz not null,
  expires_at timestamptz not null
);
alter table public.catalog_language_metadata_capacity enable row level security;
revoke all on public.catalog_language_metadata_capacity from public,anon,authenticated;
grant select on public.catalog_language_metadata_capacity to service_role;
create index catalog_vod_language_metadata_active_idx
  on public.catalog_vod_language_intake(lease_until) where state='leased';
insert into public.admin_feature_flags(key,enabled) values('language_metadata_lane_enabled',false)
on conflict(key) do nothing;

create function public.catalog_language_metadata_lane_enabled()
returns boolean language sql stable security definer set search_path='' as $fn$
  select exists(select 1 from public.admin_feature_flags where key='language_metadata_lane_enabled' and enabled)
$fn$;

create function public.report_catalog_language_metadata_capacity(p_max_workers integer,p_reason text,p_observed_at timestamptz)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
  if p_max_workers is null or p_max_workers not between 0 and 2
    or p_observed_at is null or p_observed_at<clock_timestamp()-interval '15 seconds'
    or p_observed_at>clock_timestamp()+interval '5 seconds'
    or p_reason is null or p_reason not in ('capacity-unavailable','viewer-priority','foreground-work',
      'resource-pressure','background-occupied','capacity-available','metadata-lane-disabled','network-occupied')
    then return false; end if;
  insert into public.catalog_language_metadata_capacity(singleton,max_workers,reason,observed_at,expires_at)
    values(true,p_max_workers,p_reason,p_observed_at,least(clock_timestamp(),p_observed_at)+interval '10 seconds')
  on conflict(singleton) do update set max_workers=excluded.max_workers,reason=excluded.reason,
    observed_at=excluded.observed_at,expires_at=excluded.expires_at
  where excluded.observed_at>catalog_language_metadata_capacity.observed_at;
  return found or exists(select 1 from public.catalog_language_metadata_capacity
    where singleton and observed_at=p_observed_at and max_workers=p_max_workers
      and reason=p_reason and expires_at>clock_timestamp());
end $fn$;

-- Call only under catalog-language-admission, shared with the legacy worker.
-- Inference jobs do not consume this short metadata lane. The Gateway still
-- serializes each real account and limits metadata + captures together to two.
create function public.catalog_language_metadata_available()
returns boolean language sql volatile security definer set search_path='' as $fn$
  select public.catalog_language_metadata_lane_enabled() and
    coalesce((select c.expires_at>clock_timestamp() and c.max_workers>
      (select count(*) from public.catalog_vod_language_intake q
       where q.state='leased' and q.lease_until>clock_timestamp())
      from public.catalog_language_metadata_capacity c where c.singleton),false)
$fn$;

do $patch$
declare d text; old text; replacement text;
begin
  d:=pg_get_functiondef('public.claim_catalog_vod_language_file(uuid,uuid)'::regprocedure);
  old:=$old$  if not public.catalog_language_queue_available(v_identity) then
    return jsonb_build_object('skipped','automatic-queue-full','hasMore',true);
  end if;
  if not public.catalog_language_execution_available() then
    return jsonb_build_object('skipped','server-capacity','hasMore',true);
  end if;$old$;
  if (length(d)-length(replace(d,old,'')))/length(old)<>1 then
    raise exception 'Metadata intake admission block drifted';
  end if;
  replacement:=$new$  if public.catalog_language_metadata_lane_enabled() then
    if not public.catalog_language_metadata_available() then
      return jsonb_build_object('skipped','metadata-capacity','hasMore',true);
    end if;
  else
$new$||old||E'\n  end if;';
  execute replace(d,old,replacement);

  -- A local network admission refusal happened before provider I/O. Undo only
  -- this journaled attempt, with the same owner/token CAS as viewer preemption;
  -- keep every earlier no-progress strike and every quarantine unchanged.
  d:=pg_get_functiondef('public.finish_catalog_file_audio_validation_provider_attempt(uuid,text,uuid,text,integer)'::regprocedure);
  old:='v_outcome not in (''no_progress'', ''viewer_preempted'')';
  if position(old in d)=0 then raise exception 'Provider attempt outcome guard drifted'; end if;
  d:=replace(d,old,'v_outcome not in (''no_progress'', ''viewer_preempted'', ''admission_deferred'')');
  old:='if v_outcome = ''viewer_preempted'' then';
  if position(old in d)=0 then raise exception 'Provider attempt no-I/O branch drifted'; end if;
  d:=replace(d,old,'if v_outcome in (''viewer_preempted'', ''admission_deferred'') then');
  old:='return jsonb_build_object(''settled'', true, ''quarantined'', false, ''viewerPreempted'', true);';
  if position(old in d)=0 then raise exception 'Provider attempt result drifted'; end if;
  execute replace(d,old,'return jsonb_build_object(''settled'', true, ''quarantined'', false,
    ''viewerPreempted'', v_outcome = ''viewer_preempted'', ''admissionDeferred'', v_outcome = ''admission_deferred'');');
end $patch$;

-- Selection uses its own durable retry ledger. Return a local admission debit
-- without going through finish_selection_audio_job's provider-failure budget.
create function public.defer_selection_audio_admission(p_external_id text,p_url_sha256 text,p_lease_token uuid)
returns boolean language plpgsql volatile security definer set search_path='' as $fn$
begin
  update public.catalog_selection_audio_jobs set state='retry_wait',
    attempt_count=greatest(0,attempt_count-1),next_attempt_at=clock_timestamp()+interval '30 seconds',
    error_code='SELECTION_AUDIO_CAPACITY_BUSY',lease_token=null,lease_until=null,updated_at=clock_timestamp()
    where external_id=p_external_id and url_sha256=p_url_sha256 and state='running'
      and lease_token=p_lease_token and lease_until>clock_timestamp();
  return found;
end $fn$;

revoke all on function public.catalog_language_metadata_lane_enabled(),
  public.report_catalog_language_metadata_capacity(integer,text,timestamptz),
  public.catalog_language_metadata_available(),public.defer_selection_audio_admission(text,text,uuid) from public,anon,authenticated;
grant execute on function public.catalog_language_metadata_lane_enabled(),
  public.report_catalog_language_metadata_capacity(integer,text,timestamptz),
  public.catalog_language_metadata_available(),public.defer_selection_audio_admission(text,text,uuid) to service_role;
-- The patched claim retains its installed owner/ACL, visibility/auth checks,
-- retry budget, provider-file history and quarantine predicates unchanged.
commit;

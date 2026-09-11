begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

insert into public.admin_feature_flags(key,enabled) values('selection_capture_pipeline_enabled',false)
on conflict(key) do nothing;
create function public.selection_audio_capture_pipeline_enabled()
returns boolean language sql stable security definer set search_path='' as $f$
  select public.catalog_language_capture_pipeline_enabled()
    and exists(select 1 from public.admin_feature_flags where key='selection_capture_pipeline_enabled' and enabled)
$f$;

-- No provider identity is invented for Selection. The Gateway network slot is
-- already drained when this is called. Keep the independent WORK lease for
-- crash-safe compute/checkpointing; it is not a provider socket/host permit.
create table public.catalog_selection_audio_captures (
  job_id uuid not null references public.catalog_selection_audio_jobs(id) on delete cascade,
  stream_index integer not null check(stream_index between 0 and 128),
  window_ordinal integer not null check(window_ordinal between 1 and 6),
  profile_fingerprint text not null check(profile_fingerprint ~ '^[a-f0-9]{64}$'),
  audio_sha256 text not null check(audio_sha256 ~ '^[a-f0-9]{64}$'),
  release_token uuid not null default gen_random_uuid(),
  expires_at timestamptz not null,
  primary key(job_id,stream_index,window_ordinal)
);
alter table public.catalog_selection_audio_captures enable row level security;
alter table public.catalog_selection_audio_captures force row level security;
revoke all on public.catalog_selection_audio_captures from public,anon,authenticated,service_role;
grant select on public.catalog_selection_audio_captures to service_role;
create index catalog_selection_audio_captures_expiry_idx on public.catalog_selection_audio_captures(expires_at);

create function public.checkpoint_selection_audio_capture(
  p_external_id text,p_url_sha256 text,p_lease_token uuid,p_stream_index integer,p_window_ordinal integer,
  p_profile_fingerprint text,p_audio_sha256 text,p_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path='' as $f$
declare
  j public.catalog_selection_audio_jobs%rowtype; v_release uuid; v_now timestamptz;
  v_position integer; v_windows integer;
begin
  perform public.norva_credential_require_service_role();
  if not public.selection_audio_capture_pipeline_enabled() then return null; end if;
  if coalesce(p_audio_sha256,'') !~ '^[a-f0-9]{64}$' or coalesce(p_profile_fingerprint,'') !~ '^[a-f0-9]{64}$'
    or p_stream_index is null or p_stream_index not between 0 and 128 or p_window_ordinal is null
    or p_window_ordinal not between 1 and 6 or p_expires_at is null then return null; end if;
  select * into j from public.catalog_selection_audio_jobs where external_id=p_external_id and url_sha256=p_url_sha256 for update;
  v_now:=clock_timestamp();
  if not found or j.state<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<=v_now
    or p_expires_at<=v_now or p_expires_at>v_now+interval '2 hours'
    or j.profile->>'fingerprint' is distinct from p_profile_fingerprint
    or j.profile->>'externalId' is distinct from p_external_id
    or j.profile->>'urlSha256' is distinct from p_url_sha256
    or jsonb_typeof(j.profile->'audioTracks') is distinct from 'array'
    or jsonb_typeof(j.progress->'receipts') is distinct from 'array'
    or coalesce(j.progress->>'trackPosition','') !~ '^[0-9]{1,2}$'
    or jsonb_typeof(j.profile->'durationSeconds') is distinct from 'number' then return null; end if;
  v_position:=(j.progress->>'trackPosition')::integer;
  v_windows:=case when (j.profile->>'durationSeconds')::numeric>=120 then 6 else 4 end;
  if j.profile->'audioTracks'->v_position->>'index' is distinct from p_stream_index::text
    or jsonb_array_length(j.progress->'receipts')+1<>p_window_ordinal or p_window_ordinal>v_windows
    or jsonb_array_length(public.selection_audio_job_owners(p_external_id,p_url_sha256))=0 then return null; end if;
  insert into public.catalog_selection_audio_captures(job_id,stream_index,window_ordinal,profile_fingerprint,audio_sha256,expires_at)
    values(j.id,p_stream_index,p_window_ordinal,p_profile_fingerprint,p_audio_sha256,p_expires_at)
  on conflict(job_id,stream_index,window_ordinal) do update set
    profile_fingerprint=excluded.profile_fingerprint,audio_sha256=excluded.audio_sha256,expires_at=excluded.expires_at,
    release_token=case when catalog_selection_audio_captures.profile_fingerprint=excluded.profile_fingerprint
      and catalog_selection_audio_captures.audio_sha256=excluded.audio_sha256
      and catalog_selection_audio_captures.expires_at>v_now then catalog_selection_audio_captures.release_token else gen_random_uuid() end
  returning release_token into v_release;
  return v_release;
end $f$;

-- Local handoff/inference failures retry inside the private excerpt's 30-minute
-- lifetime. Keep the existing attempt ceiling: no reset of terminal failures,
-- no retry-budget refund after a real capture, no indefinite local-error loop.
create function public.defer_selection_audio_capture(p_external_id text,p_url_sha256 text,p_lease_token uuid)
returns boolean language plpgsql security definer set search_path='' as $f$
declare v_count integer; v_now timestamptz:=clock_timestamp();
begin
  perform public.norva_credential_require_service_role();
  if not public.selection_audio_capture_pipeline_enabled() then return false; end if;
  update public.catalog_selection_audio_jobs set
    state=case when attempt_count<8 then 'retry_wait' else 'failed' end,
    error_code='SELECTION_AUDIO_CAPTURE_LOCAL_RETRY',next_attempt_at=v_now+interval '30 seconds',
    completed_at=case when attempt_count<8 then null else v_now end,
    lease_token=null,lease_until=null,updated_at=v_now
  where external_id=p_external_id and url_sha256=p_url_sha256 and state='running'
    and lease_token=p_lease_token and lease_until>v_now;
  get diagnostics v_count=row_count;
  return v_count=1;
end $f$;

revoke all on function public.selection_audio_capture_pipeline_enabled(),
  public.checkpoint_selection_audio_capture(text,text,uuid,integer,integer,text,text,timestamptz),
  public.defer_selection_audio_capture(text,text,uuid) from public,anon,authenticated;
grant execute on function public.selection_audio_capture_pipeline_enabled(),
  public.checkpoint_selection_audio_capture(text,text,uuid,integer,integer,text,text,timestamptz),
  public.defer_selection_audio_capture(text,text,uuid) to service_role;
commit;

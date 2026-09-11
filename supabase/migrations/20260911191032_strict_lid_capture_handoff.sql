begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

insert into public.admin_feature_flags(key,enabled) values('language_capture_pipeline_enabled',false)
on conflict(key) do nothing;
create function public.catalog_language_capture_pipeline_enabled()
returns boolean language sql stable security definer set search_path='' as $f$
  select exists(select 1 from public.admin_feature_flags where key='language_capture_pipeline_enabled' and enabled)
$f$;

-- No audio, URLs, secrets or transcripts. Only the private expiring buffer's
-- exact-file receipt. Job retention/FK cleanup also removes these checkpoints.
create table public.catalog_file_audio_captures (
  job_id uuid not null references public.catalog_file_audio_validation_jobs(id) on delete cascade,
  stream_index integer not null check(stream_index between 0 and 128),
  window_ordinal integer not null check(window_ordinal between 1 and 6),
  profile_fingerprint text not null check(profile_fingerprint ~ '^[a-f0-9]{64}$'),
  source_url_hash text not null check(source_url_hash ~ '^[a-f0-9]{64}$'),
  audio_sha256 text not null check(audio_sha256 ~ '^[a-f0-9]{64}$'),
  release_token uuid not null default gen_random_uuid(),
  expires_at timestamptz not null,
  primary key(job_id,stream_index,window_ordinal)
);
alter table public.catalog_file_audio_captures enable row level security;
alter table public.catalog_file_audio_captures force row level security;
revoke all on public.catalog_file_audio_captures from public,anon,authenticated;
grant select on public.catalog_file_audio_captures to service_role;
create index catalog_file_audio_captures_expiry_idx on public.catalog_file_audio_captures(expires_at);

create function public.checkpoint_catalog_file_audio_capture(
  p_job_id uuid,p_lease_owner text,p_stream_index integer,p_window_ordinal integer,
  p_profile_fingerprint text,p_source_url_hash text,p_audio_sha256 text,p_expires_at timestamptz,
  p_provider_account_hash text,p_provider_lease_owner text,p_attempt_token uuid
) returns uuid language plpgsql security definer set search_path='' as $f$
declare
  j public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz;
  v_release uuid;
begin
  if not public.catalog_language_capture_pipeline_enabled() then return null; end if;
  if p_job_id is null or coalesce(btrim(p_lease_owner),'')='' or coalesce(p_source_url_hash,'') !~ '^[a-f0-9]{64}$'
    or coalesce(p_audio_sha256,'') !~ '^[a-f0-9]{64}$' or coalesce(p_profile_fingerprint,'') !~ '^[a-f0-9]{64}$'
    or p_expires_at is null or p_expires_at <= clock_timestamp() or p_expires_at > clock_timestamp()+interval '2 hours'
    or ((p_attempt_token is null) <> (p_provider_lease_owner is null))
    or ((p_attempt_token is null) <> (p_provider_account_hash is null)) then return null; end if;
  -- Match foreground lock order: provider BEFORE exact job. A viewer may
  -- preempt the claim; the capture remains reusable but cannot release theirs.
  if p_attempt_token is not null then
    if p_provider_account_hash !~ '^[a-f0-9]{64}$' then return null; end if;
    perform pg_advisory_xact_lock(hashtextextended('provider-session:'||p_provider_account_hash,0));
  end if;
  select * into j from public.catalog_file_audio_validation_jobs where id=p_job_id;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('catalog-file-audio-validation:'||j.identity_key||':'||j.item_type||':'||j.external_id,0));
  select * into j from public.catalog_file_audio_validation_jobs where id=p_job_id for update;
  v_now := clock_timestamp();
  if not found or j.state<>'running' or j.lease_owner is distinct from btrim(p_lease_owner)
    or j.lease_expires_at<=v_now or j.quarantined_at is not null
    or j.profile_fingerprint is distinct from p_profile_fingerprint
    or j.expected_audio_indices[j.next_track_position+1] is distinct from p_stream_index
    or j.strict_lid_window_position+1 is distinct from p_window_ordinal
    or j.strict_lid_window_protocol is distinct from 1
    or j.strict_lid_window_count not in (4,6) or p_window_ordinal>j.strict_lid_window_count
    or p_expires_at<=v_now then return null; end if;
  if p_attempt_token is not null then
    if j.provider_attempt_token is distinct from p_attempt_token
      or not exists(select 1 from public.provider_account_language_validation_leases
        where provider_account_hash=p_provider_account_hash and lease_owner=p_provider_lease_owner and expires_at>v_now)
      or not exists(select 1 from public.provider_file_probe_leases
        where identity_key=j.identity_key and lease_owner=p_provider_lease_owner and expires_at>v_now)
      then return null; end if;
  end if;
  insert into public.catalog_file_audio_captures(job_id,stream_index,window_ordinal,profile_fingerprint,
    source_url_hash,audio_sha256,expires_at)
    values(j.id,p_stream_index,p_window_ordinal,p_profile_fingerprint,p_source_url_hash,p_audio_sha256,p_expires_at)
  on conflict(job_id,stream_index,window_ordinal) do update set
    profile_fingerprint=excluded.profile_fingerprint,source_url_hash=excluded.source_url_hash,
    audio_sha256=excluded.audio_sha256,expires_at=excluded.expires_at,
    release_token=case when catalog_file_audio_captures.profile_fingerprint=excluded.profile_fingerprint
      and catalog_file_audio_captures.source_url_hash=excluded.source_url_hash
      and catalog_file_audio_captures.audio_sha256=excluded.audio_sha256
      and catalog_file_audio_captures.expires_at>v_now then catalog_file_audio_captures.release_token else gen_random_uuid() end
  returning release_token into v_release;
  -- Capturing an exact complete window is real acquisition progress, NOT a
  -- language vote. It clears only this owned job's provider no-progress streak.
  update public.catalog_file_audio_validation_jobs set provider_attempt_token=null,provider_attempt_started_at=null,
    consecutive_provider_no_progress_count=0,updated_at=v_now where id=j.id;
  if p_attempt_token is not null then
    delete from public.provider_file_probe_leases where identity_key=j.identity_key and lease_owner=p_provider_lease_owner;
    delete from public.provider_account_language_validation_leases
      where provider_account_hash=p_provider_account_hash and lease_owner=p_provider_lease_owner;
  end if;
  return v_release;
end $f$;

revoke all on function public.catalog_language_capture_pipeline_enabled(),
  public.checkpoint_catalog_file_audio_capture(uuid,text,integer,integer,text,text,text,timestamptz,text,text,uuid)
  from public,anon,authenticated;
grant execute on function public.catalog_language_capture_pipeline_enabled(),
  public.checkpoint_catalog_file_audio_capture(uuid,text,integer,integer,text,text,text,timestamptz,text,text,uuid)
  to service_role;
commit;

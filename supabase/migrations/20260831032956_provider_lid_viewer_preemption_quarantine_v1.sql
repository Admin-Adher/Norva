-- Bound real provider I/O for strict audio language validation and make
-- foreground playback authoritative on a mono-session provider account.
--
-- attempt_count is a worker scheduling counter and is deliberately retained
-- for diagnostics. The counters below advance only immediately before a real
-- Gateway/provider attempt. A persisted window/track checkpoint resets the
-- consecutive no-progress counter.

alter table public.catalog_file_audio_validation_jobs
  add column if not exists provider_attempt_count integer not null default 0,
  add column if not exists consecutive_provider_no_progress_count integer not null default 0,
  add column if not exists provider_attempt_token uuid,
  add column if not exists provider_attempt_started_at timestamptz,
  add column if not exists last_provider_progress_at timestamptz,
  add column if not exists quarantined_at timestamptz;

alter table public.catalog_file_audio_validation_jobs
  drop constraint if exists catalog_file_audio_validation_jobs_provider_attempt_count_check,
  drop constraint if exists catalog_file_audio_validation_jobs_provider_no_progress_count_check,
  drop constraint if exists catalog_file_audio_validation_jobs_provider_attempt_pair_check,
  drop constraint if exists catalog_file_audio_validation_jobs_provider_no_progress_lte_attempts_check,
  drop constraint if exists catalog_file_audio_validation_jobs_quarantine_state_check;

alter table public.catalog_file_audio_validation_jobs
  add constraint catalog_file_audio_validation_jobs_provider_attempt_count_check
    check (provider_attempt_count between 0 and 4096),
  add constraint catalog_file_audio_validation_jobs_provider_no_progress_count_check
    check (consecutive_provider_no_progress_count between 0 and 64),
  add constraint catalog_file_audio_validation_jobs_provider_attempt_pair_check
    check (
      (provider_attempt_token is null and provider_attempt_started_at is null)
      or (provider_attempt_token is not null and provider_attempt_started_at is not null)
    ),
  add constraint catalog_file_audio_validation_jobs_provider_no_progress_lte_attempts_check
    check (consecutive_provider_no_progress_count <= provider_attempt_count),
  add constraint catalog_file_audio_validation_jobs_quarantine_state_check
    check (quarantined_at is null or state = 'failed');

comment on column public.catalog_file_audio_validation_jobs.provider_attempt_count is
  'Count of real Gateway/provider attempts, incremented immediately before provider I/O.';
comment on column public.catalog_file_audio_validation_jobs.consecutive_provider_no_progress_count is
  'Crash-safe count of real provider attempts since the last persisted window or track checkpoint.';
comment on column public.catalog_file_audio_validation_jobs.quarantined_at is
  'Terminal quarantine timestamp after the bounded consecutive provider no-progress budget is exhausted.';

-- Immutable-enough operational evidence for a viewer taking priority over a
-- background validation. The lease owner is hashed; no provider URL, token or
-- credential is retained.
create table if not exists public.provider_account_language_validation_preemptions (
  id bigint generated always as identity primary key,
  provider_account_hash text not null
    check (provider_account_hash ~ '^[0-9a-f]{64}$'),
  playback_session_id uuid not null,
  playback_user_id uuid not null,
  playback_source_id uuid not null,
  validation_lease_owner_sha256 text not null
    check (validation_lease_owner_sha256 ~ '^[0-9a-f]{64}$'),
  validation_lease_expires_at timestamptz not null,
  preempted_at timestamptz not null default clock_timestamp(),
  purge_after timestamptz not null default (clock_timestamp() + interval '30 days'),
  check (purge_after > preempted_at)
);

alter table public.provider_account_language_validation_preemptions enable row level security;
alter table public.provider_account_language_validation_preemptions force row level security;
revoke all on table public.provider_account_language_validation_preemptions
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.provider_account_language_validation_preemptions to service_role;

create index if not exists provider_account_language_validation_preemptions_lookup_idx
  on public.provider_account_language_validation_preemptions
  (provider_account_hash, preempted_at desc);
create index if not exists provider_account_language_validation_preemptions_retention_idx
  on public.provider_account_language_validation_preemptions (purge_after);

-- A successful strict window or completed audio-track checkpoint is the only
-- event that proves provider progress. Reset the no-progress budget in the
-- same transaction as that checkpoint, without duplicating the large existing
-- checkpoint RPC bodies.
create or replace function public.norva_reset_audio_validation_provider_no_progress_on_checkpoint()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.strict_lid_window_position > old.strict_lid_window_position
     or new.next_track_position > old.next_track_position then
    new.consecutive_provider_no_progress_count := 0;
    new.provider_attempt_token := null;
    new.provider_attempt_started_at := null;
    new.last_provider_progress_at := clock_timestamp();
  end if;
  return new;
end
$function$;

drop trigger if exists norva_audio_validation_provider_progress_checkpoint
  on public.catalog_file_audio_validation_jobs;
create trigger norva_audio_validation_provider_progress_checkpoint
before update of strict_lid_window_position, next_track_position
on public.catalog_file_audio_validation_jobs
for each row
execute function public.norva_reset_audio_validation_provider_no_progress_on_checkpoint();

revoke all on function public.norva_reset_audio_validation_provider_no_progress_on_checkpoint()
  from public, anon, authenticated;

create or replace function public.norva_quarantine_audio_validation_provider_no_progress(
  p_job_id uuid,
  p_error_code text default 'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED'
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_retry_at timestamptz := v_now + interval '24 hours';
  v_code text := left(upper(regexp_replace(
    coalesce(p_error_code, 'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED'),
    '[^A-Z0-9_]+', '_', 'g'
  )), 64);
begin
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found or v_job.state in ('verified', 'failed', 'expired', 'cancelled') then
    return false;
  end if;

  if not public.record_catalog_file_audio_verification(
    v_job.identity_key,
    'movie',
    v_job.external_id,
    false,
    v_now,
    v_retry_at,
    jsonb_build_object(
      'protocol', 3,
      'status', 'failed',
      'method', 'whisper-strict-consensus-v4',
      'reason', lower(v_code),
      'completedTracks', v_job.next_track_position,
      'trackCount', cardinality(v_job.expected_audio_indices),
      'providerAttempts', v_job.provider_attempt_count,
      'consecutiveProviderNoProgress', v_job.consecutive_provider_no_progress_count,
      'quarantinedAt', v_now,
      'retryAt', v_retry_at
    )
  ) then
    raise exception 'Unable to persist language validation quarantine'
      using errcode = 'PT409';
  end if;

  -- The durable job lease and the provider/file transport leases intentionally
  -- use different owners. Remove only transport owners that embed this exact
  -- job UUID; never release another validation or foreground session.
  delete from public.provider_account_language_validation_leases
  where lease_owner like 'language-validation-track:' || v_job.id::text || ':%';
  delete from public.provider_file_probe_leases
  where lease_owner like 'language-validation-track:' || v_job.id::text || ':%';

  update public.catalog_file_audio_validation_jobs
     set state = 'failed',
         error_code = v_code,
         retry_at = v_retry_at,
         lease_owner = null,
         lease_expires_at = null,
         queue_expires_at = null,
         provider_attempt_token = null,
         provider_attempt_started_at = null,
         quarantined_at = v_now,
         purge_after = v_now + interval '30 days',
         updated_at = v_now
   where id = v_job.id;
  return true;
end
$function$;

revoke all on function public.norva_quarantine_audio_validation_provider_no_progress(uuid, text)
  from public, anon, authenticated;
grant execute on function public.norva_quarantine_audio_validation_provider_no_progress(uuid, text)
  to service_role;

-- Called only immediately before the Edge worker opens a Gateway/provider
-- attempt. Counting first makes a worker crash fail-safe instead of granting
-- an unbounded invisible retry.
create or replace function public.begin_catalog_file_audio_validation_provider_attempt(
  p_job_id uuid,
  p_lease_owner text,
  p_provider_account_hash text,
  p_provider_lease_owner text,
  p_stream_index integer,
  p_window_ordinal integer,
  p_max_consecutive_no_progress integer default 4
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_limit integer := greatest(1, least(16, coalesce(p_max_consecutive_no_progress, 4)));
  v_token uuid := gen_random_uuid();
begin
  if p_job_id is null
     or coalesce(btrim(p_lease_owner), '') = ''
     or coalesce(btrim(p_provider_lease_owner), '') = ''
     or p_provider_account_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':movie:' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.state <> 'running'
     or v_job.lease_owner is distinct from btrim(p_lease_owner)
     or v_job.lease_expires_at <= v_now
     or p_stream_index is distinct from v_job.expected_audio_indices[v_job.next_track_position + 1]
     or p_window_ordinal is distinct from v_job.strict_lid_window_position + 1
     or p_window_ordinal > v_job.strict_lid_window_count
     or not exists (
       select 1
       from public.provider_account_language_validation_leases lease
       where lease.provider_account_hash = p_provider_account_hash
         and lease.lease_owner = btrim(p_provider_lease_owner)
         and lease.expires_at > v_now
     ) then
    return null;
  end if;

  if v_job.consecutive_provider_no_progress_count >= v_limit then
    perform public.norva_quarantine_audio_validation_provider_no_progress(
      v_job.id,
      'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED'
    );
    return jsonb_build_object('allowed', false, 'quarantined', true);
  end if;

  update public.catalog_file_audio_validation_jobs
     set provider_attempt_count = provider_attempt_count + 1,
         consecutive_provider_no_progress_count = consecutive_provider_no_progress_count + 1,
         provider_attempt_token = v_token,
         provider_attempt_started_at = v_now,
         updated_at = v_now
   where id = v_job.id;

  return jsonb_build_object(
    'allowed', true,
    'quarantined', false,
    'attemptToken', v_token,
    'providerAttemptCount', v_job.provider_attempt_count + 1,
    'consecutiveProviderNoProgress', v_job.consecutive_provider_no_progress_count + 1,
    'maxConsecutiveProviderNoProgress', v_limit
  );
end
$function$;

revoke all on function public.begin_catalog_file_audio_validation_provider_attempt(
  uuid, text, text, text, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.begin_catalog_file_audio_validation_provider_attempt(
  uuid, text, text, text, integer, integer, integer
) to service_role;

create or replace function public.finish_catalog_file_audio_validation_provider_attempt(
  p_job_id uuid,
  p_lease_owner text,
  p_attempt_token uuid,
  p_outcome text,
  p_max_consecutive_no_progress integer default 4
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job public.catalog_file_audio_validation_jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  v_limit integer := greatest(1, least(16, coalesce(p_max_consecutive_no_progress, 4)));
  v_outcome text := lower(coalesce(btrim(p_outcome), ''));
begin
  if p_job_id is null or p_attempt_token is null
     or v_outcome not in ('no_progress', 'viewer_preempted') then
    return null;
  end if;
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'catalog-file-audio-validation:' || v_job.identity_key || ':movie:' || v_job.external_id,
    0
  ));
  select job.* into v_job
  from public.catalog_file_audio_validation_jobs job
  where job.id = p_job_id
  for update;
  if not found
     or v_job.state not in ('running', 'finalizing')
     or v_job.lease_owner is distinct from btrim(p_lease_owner)
     or v_job.provider_attempt_token is distinct from p_attempt_token then
    return null;
  end if;

  if v_outcome = 'viewer_preempted' then
    update public.catalog_file_audio_validation_jobs
       set consecutive_provider_no_progress_count = greatest(
             0, consecutive_provider_no_progress_count - 1
           ),
           provider_attempt_token = null,
           provider_attempt_started_at = null,
           updated_at = v_now
     where id = v_job.id;
    return jsonb_build_object('settled', true, 'quarantined', false, 'viewerPreempted', true);
  end if;

  update public.catalog_file_audio_validation_jobs
     set provider_attempt_token = null,
         provider_attempt_started_at = null,
         updated_at = v_now
   where id = v_job.id;
  if v_job.consecutive_provider_no_progress_count >= v_limit then
    perform public.norva_quarantine_audio_validation_provider_no_progress(
      v_job.id,
      'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED'
    );
    return jsonb_build_object('settled', true, 'quarantined', true, 'viewerPreempted', false);
  end if;
  return jsonb_build_object('settled', true, 'quarantined', false, 'viewerPreempted', false);
end
$function$;

revoke all on function public.finish_catalog_file_audio_validation_provider_attempt(
  uuid, text, uuid, text, integer
) from public, anon, authenticated;
grant execute on function public.finish_catalog_file_audio_validation_provider_attempt(
  uuid, text, uuid, text, integer
) to service_role;

create or replace function public.provider_account_language_validation_lease_is_current(
  p_provider_account_hash text,
  p_lease_owner text
) returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.provider_account_language_validation_leases lease
    where lease.provider_account_hash = p_provider_account_hash
      and lease.lease_owner = btrim(p_lease_owner)
      and lease.expires_at > clock_timestamp()
  )
$function$;

revoke all on function public.provider_account_language_validation_lease_is_current(text, text)
  from public, anon, authenticated;
grant execute on function public.provider_account_language_validation_lease_is_current(text, text)
  to service_role;

-- Foreground playback wins atomically. The common provider advisory lock
-- prevents a new language-validation claim from racing with this preemption.
create or replace function public.claim_cloud_playback_session(
  p_session_id uuid,
  p_user_id uuid,
  p_source_id uuid,
  p_device_id uuid,
  p_item_type text,
  p_item_id text,
  p_mode text,
  p_status text,
  p_target_url_hash text,
  p_provider_account_hash text,
  p_stream_mime text,
  p_playback_hint jsonb,
  p_expires_at timestamptz
) returns table(new_session_id uuid, superseded_session_ids uuid[])
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_superseded uuid[] := '{}'::uuid[];
  v_validation_owner text;
  v_validation_expires_at timestamptz;
  v_validation_job_id uuid;
begin
  if p_session_id is null or p_user_id is null
     or p_source_id is null
     or p_provider_account_hash is null
     or p_provider_account_hash !~ '^[0-9a-f]{64}$'
     or nullif(p_item_type, '') is null
     or nullif(p_item_id, '') is null
     or p_mode is null or p_mode not in ('direct', 'relay', 'transcode')
     or p_status is null or p_status not in ('pending', 'ready')
     or p_expires_at is null
     or p_expires_at <= v_now then
    raise exception 'invalid playback session claim' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-session:' || p_provider_account_hash, 0)
  );
  v_now := clock_timestamp();
  if p_expires_at <= v_now then
    raise exception 'invalid playback session claim' using errcode = '22023';
  end if;

  perform public.norva_assert_source_catalog_visible_locked(p_source_id, p_user_id);

  select lease.lease_owner, lease.expires_at
    into v_validation_owner, v_validation_expires_at
  from public.provider_account_language_validation_leases lease
  where lease.provider_account_hash = p_provider_account_hash
    and lease.expires_at > v_now
  for update;

  if v_validation_owner is not null then
    delete from public.provider_account_language_validation_leases lease
    where lease.provider_account_hash = p_provider_account_hash
      and lease.lease_owner = v_validation_owner;

    -- The durable worker owner format embeds the job UUID. Clear its exact-file
    -- lease and park the job immediately; this closes the crash window where a
    -- preempted worker never gets to acknowledge the Gateway response.
    begin
      v_validation_job_id := substring(
        v_validation_owner from
        '^language-validation-track:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):'
      )::uuid;
    exception when others then
      v_validation_job_id := null;
    end;
    delete from public.provider_file_probe_leases
    where lease_owner = v_validation_owner;
    if v_validation_job_id is not null then
      update public.catalog_file_audio_validation_jobs job
         set state = 'retry_wait',
             error_code = 'LANGUAGE_VALIDATION_VIEWER_PREEMPTED',
             retry_at = v_now + interval '5 minutes',
             lease_owner = null,
             lease_expires_at = null,
             queue_expires_at = null,
             consecutive_provider_no_progress_count = case
               when job.provider_attempt_token is null
                 then job.consecutive_provider_no_progress_count
               else greatest(0, job.consecutive_provider_no_progress_count - 1)
             end,
             provider_attempt_token = null,
             provider_attempt_started_at = null,
             updated_at = v_now
       where job.id = v_validation_job_id
         and job.state in ('running', 'finalizing');
    end if;
  end if;

  select coalesce(array_agg(session.id order by session.created_at), '{}'::uuid[])
    into v_superseded
  from public.cloud_playback_sessions session
  where session.provider_account_hash = p_provider_account_hash
    and session.status in ('pending', 'ready');

  update public.cloud_playback_sessions session
  set status = 'expired',
      expires_at = least(session.expires_at, v_now),
      superseded_at = v_now,
      updated_at = v_now
  where session.id = any(v_superseded);

  insert into public.cloud_playback_sessions (
    id, user_id, source_id, device_id, item_type, item_id, mode, status,
    target_url_hash, provider_account_hash, stream_mime, playback_hint, expires_at
  ) values (
    p_session_id, p_user_id, p_source_id, p_device_id, p_item_type, p_item_id,
    p_mode, p_status, p_target_url_hash, p_provider_account_hash, p_stream_mime,
    coalesce(p_playback_hint, '{}'::jsonb), p_expires_at
  );

  if v_validation_owner is not null then
    insert into public.provider_account_language_validation_preemptions (
      provider_account_hash,
      playback_session_id,
      playback_user_id,
      playback_source_id,
      validation_lease_owner_sha256,
      validation_lease_expires_at,
      preempted_at,
      purge_after
    ) values (
      p_provider_account_hash,
      p_session_id,
      p_user_id,
      p_source_id,
      pg_catalog.encode(extensions.digest(v_validation_owner, 'sha256'), 'hex'),
      v_validation_expires_at,
      v_now,
      v_now + interval '30 days'
    );
  end if;

  return query select p_session_id, v_superseded;
end
$function$;

revoke all on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) to service_role;

comment on function public.claim_cloud_playback_session(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text, text, jsonb, timestamptz
) is 'Atomically supersedes prior playback and preempts any active background language-validation lease for the same provider account.';

-- One-time quarantine of the incident row. This is intentionally an update,
-- never a delete: the failed job and its reason remain auditable.
do $block$
declare
  v_job_id constant uuid := '5df2bccb-cae4-47fb-97f1-95c1efdc95b3';
  v_now timestamptz := clock_timestamp();
begin
  if exists (
    select 1 from public.catalog_file_audio_validation_jobs job
    where job.id = v_job_id
      and job.state in ('queued', 'running', 'retry_wait', 'finalizing')
  ) then
    update public.catalog_file_tracks cache
       set audio_lang_verified_at = null,
           audio_lang_retry_at = v_now + interval '24 hours',
           audio_lang_verification = jsonb_build_object(
             'protocol', 3,
             'status', 'failed',
             'method', 'whisper-strict-consensus-v4',
             'reason', 'language_validation_no_progress_quarantined',
             'jobId', v_job_id,
             'quarantinedAt', v_now,
             'retryAt', v_now + interval '24 hours'
           ),
           updated_at = v_now
      from public.catalog_file_audio_validation_jobs job
     where job.id = v_job_id
       and cache.server_host = job.identity_key
       and cache.item_type = job.item_type
       and cache.external_id = job.external_id;

    update public.catalog_file_audio_validation_jobs
       set state = 'failed',
           error_code = 'LANGUAGE_VALIDATION_NO_PROGRESS_QUARANTINED',
           retry_at = v_now + interval '24 hours',
           lease_owner = null,
           lease_expires_at = null,
           queue_expires_at = null,
           provider_attempt_token = null,
           provider_attempt_started_at = null,
           quarantined_at = v_now,
           purge_after = v_now + interval '30 days',
           updated_at = v_now
     where id = v_job_id;
  end if;

  delete from public.provider_account_language_validation_leases
  where lease_owner like 'language-validation-track:' || v_job_id::text || ':%';
  delete from public.provider_file_probe_leases
  where lease_owner like 'language-validation-track:' || v_job_id::text || ':%';
end
$block$;

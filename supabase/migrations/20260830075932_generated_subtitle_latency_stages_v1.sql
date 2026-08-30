-- Persist the first occurrence of every latency milestone in the generated
-- subtitle pipeline.  These timestamps deliberately live on the durable job
-- row: a tab can close, reconnect or change device without losing the server
-- side latency evidence.
alter table public.catalog_generated_subtitles
  add column if not exists requested_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists enqueued_at timestamptz,
  add column if not exists extraction_started_at timestamptz,
  add column if not exists whisper_started_at timestamptz,
  add column if not exists first_vtt_at timestamptz,
  add column if not exists ready_at timestamptz;

comment on column public.catalog_generated_subtitles.requested_at is
  'First viewer/service request timestamp for the current durable job.';
comment on column public.catalog_generated_subtitles.resolved_at is
  'Playback target resolution completed for the current durable job.';
comment on column public.catalog_generated_subtitles.enqueued_at is
  'Media gateway accepted the current durable job.';
comment on column public.catalog_generated_subtitles.extraction_started_at is
  'Gateway started audio extraction for the current durable job.';
comment on column public.catalog_generated_subtitles.whisper_started_at is
  'Gateway started Whisper for the current durable job.';
comment on column public.catalog_generated_subtitles.first_vtt_at is
  'First non-empty partial WebVTT was durably stored for the current job.';
comment on column public.catalog_generated_subtitles.ready_at is
  'Final ready WebVTT was durably stored for the current job.';

-- Recreate the existing claim RPC with the same public signature so the
-- currently deployed Edge revision remains compatible throughout rollout.
-- A reclaimed row must lose every milestone from its previous attempt in the
-- SAME statement that installs the new job id.  Otherwise a concurrent reader
-- can briefly mistake an old enqueued_at/stage/VTT for proof that the new job
-- already exists in the gateway queue.
create or replace function public.claim_generated_subtitle_job(
  p_provider_key text,
  p_item_type text,
  p_external_id text,
  p_kind text,
  p_lang text,
  p_new_job_id uuid,
  p_processing_ttl_ms bigint,
  p_force boolean,
  p_claimed_by uuid default null
) returns table (job_id uuid, status text, won boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job uuid;
  v_status text;
begin
  insert into public.catalog_generated_subtitles (
    provider_key, item_type, external_id, kind, lang, status, job_id,
    vtt, source_lang, audio_sec, segments, error, stage, updated_at,
    claimed_by, requested_at, resolved_at, enqueued_at,
    extraction_started_at, whisper_started_at, first_vtt_at, ready_at
  ) values (
    p_provider_key, p_item_type, p_external_id, p_kind, p_lang,
    'processing', p_new_job_id,
    null, null, null, null, null, null, now(),
    p_claimed_by, clock_timestamp(), clock_timestamp(), null,
    null, null, null, null
  )
  on conflict (provider_key, item_type, external_id, kind, lang) do update
    set status = 'processing',
        job_id = p_new_job_id,
        vtt = null,
        source_lang = null,
        audio_sec = null,
        segments = null,
        error = null,
        stage = null,
        updated_at = now(),
        claimed_by = p_claimed_by,
        requested_at = clock_timestamp(),
        resolved_at = clock_timestamp(),
        enqueued_at = null,
        extraction_started_at = null,
        whisper_started_at = null,
        first_vtt_at = null,
        ready_at = null
    where p_force
       or (catalog_generated_subtitles.status <> 'ready'
           and (catalog_generated_subtitles.status <> 'processing'
                or catalog_generated_subtitles.updated_at
                     < now() - make_interval(secs => p_processing_ttl_ms::double precision / 1000.0)))
  returning catalog_generated_subtitles.job_id, catalog_generated_subtitles.status
    into v_job, v_status;

  if v_job is not null then
    return query select v_job, v_status, true;
  else
    return query
      select c.job_id, c.status, false
      from public.catalog_generated_subtitles c
      where c.provider_key = p_provider_key
        and c.item_type = p_item_type
        and c.external_id = p_external_id
        and c.kind = p_kind
        and c.lang = p_lang;
  end if;
end;
$$;

revoke all on function public.claim_generated_subtitle_job(text,text,text,text,text,uuid,bigint,boolean,uuid) from public;
revoke all on function public.claim_generated_subtitle_job(text,text,text,text,text,uuid,bigint,boolean,uuid) from anon;
revoke all on function public.claim_generated_subtitle_job(text,text,text,text,text,uuid,bigint,boolean,uuid) from authenticated;
grant execute on function public.claim_generated_subtitle_job(text,text,text,text,text,uuid,bigint,boolean,uuid) to service_role;

create or replace function public.mark_generated_subtitle_stage(
  p_job_id uuid,
  p_stage text,
  p_at timestamptz default clock_timestamp()
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_job_id is null then
    return false;
  end if;

  if p_stage not in ('queued', 'deferred', 'extracting', 'transcribing', 'first_vtt') then
    raise exception 'unsupported generated subtitle stage: %', p_stage
      using errcode = '22023';
  end if;

  update public.catalog_generated_subtitles
  set
    stage = case when p_stage = 'first_vtt' then 'transcribing' else p_stage end,
    enqueued_at = case
      when p_stage in ('queued', 'deferred') then coalesce(enqueued_at, p_at)
      else enqueued_at
    end,
    extraction_started_at = case
      when p_stage = 'extracting' then coalesce(extraction_started_at, p_at)
      else extraction_started_at
    end,
    whisper_started_at = case
      when p_stage = 'transcribing' then coalesce(whisper_started_at, p_at)
      else whisper_started_at
    end,
    first_vtt_at = case
      when p_stage = 'first_vtt' then coalesce(first_vtt_at, p_at)
      else first_vtt_at
    end,
    updated_at = p_at
  where job_id = p_job_id
    and status = 'processing';

  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.mark_generated_subtitle_stage(uuid, text, timestamptz) from public;
revoke all on function public.mark_generated_subtitle_stage(uuid, text, timestamptz) from anon;
revoke all on function public.mark_generated_subtitle_stage(uuid, text, timestamptz) from authenticated;
grant execute on function public.mark_generated_subtitle_stage(uuid, text, timestamptz) to service_role;

-- The client records the end-to-end point that server-only instrumentation
-- cannot see: the first AI cue actually active in the viewer. Keep the table
-- constraint exactly aligned with norva-playback's explicit event allowlist.
alter table public.cloud_playback_events
  drop constraint if exists cloud_playback_events_event_type_check;

alter table public.cloud_playback_events
  add constraint cloud_playback_events_event_type_check
  check (event_type = any (array[
    'session_created','play_requested','play_started','first_frame',
    'pause','resume','ended','abandoned','playback_error','gateway_error','seek',
    'subtitle_first_cue'
  ]::text[]));

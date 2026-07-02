-- Crons ↔ pregen coordination (subtitle-failures audit 2026-07-02, fix #3).
--
-- Root cause proven second-exact on the 01/07 super8k failures: the pregen job's gateway ffmpeg
-- (residential proxy IP) opened its provider connection WHILE a relay probe batch (Cloudflare IP)
-- of the same account's night cron was running → the single-slot panel refused the 2nd connection
-- ("user_multi_ip") and the job burned. The 00:20/25/30 enqueue stagger only staggers the ENQUEUE;
-- the gateway's concurrency-1 queue executes jobs 15-50 min later, in the middle of the cron grid.
--
-- Two coordination directions, both fail-open:
--  (a) enrichment ticks SKIP an account while a pregen/OCR job claimed by that account is in
--      flight → needs to know WHICH account a processing row belongs to: `claimed_by` (set by
--      claim_generated_subtitle_job). The gate clears when the callback lands (status flips) or
--      when the stale-processing reaper acts (2 h), matching PREGEN_ACTIVE_TTL_MS edge-side.
--  (b) the gateway polls norva-playback/pregen-gate before opening a job's provider connection
--      and defers while a tick ran in the last ~2.5 min → needs the tick heartbeat table below
--      (one upsert per provider-touching dimension run).

-- (b) tick heartbeat — service-role only (RLS on, no policies).
create table if not exists public.enrichment_tick_heartbeat (
  user_id uuid primary key,
  ticked_at timestamptz not null default now()
);
alter table public.enrichment_tick_heartbeat enable row level security;

-- (a) who claimed the in-flight job (= whose provider credentials its ffmpeg uses).
alter table public.catalog_generated_subtitles add column if not exists claimed_by uuid;
create index if not exists idx_gensubs_claimed_processing
  on public.catalog_generated_subtitles (claimed_by)
  where status = 'processing';

-- Claim RPC + p_claimed_by. The default keeps the previously-deployed edge (8-arg calls) working
-- during rollout; the old signature is dropped so the two can't ambiguously coexist.
drop function if exists public.claim_generated_subtitle_job(text,text,text,text,text,uuid,bigint,boolean);
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
set search_path = public
as $$
declare
  v_job uuid;
  v_status text;
begin
  insert into public.catalog_generated_subtitles
    (provider_key, item_type, external_id, kind, lang, status, job_id, error, updated_at, claimed_by)
  values
    (p_provider_key, p_item_type, p_external_id, p_kind, p_lang, 'processing', p_new_job_id, null, now(), p_claimed_by)
  on conflict (provider_key, item_type, external_id, kind, lang) do update
    set status = 'processing', job_id = p_new_job_id, error = null, updated_at = now(),
        claimed_by = p_claimed_by
    where p_force
       or (catalog_generated_subtitles.status <> 'ready'
           and (catalog_generated_subtitles.status <> 'processing'
                or catalog_generated_subtitles.updated_at
                     < now() - make_interval(secs => p_processing_ttl_ms::double precision / 1000.0)))
  returning catalog_generated_subtitles.job_id, catalog_generated_subtitles.status
    into v_job, v_status;

  if v_job is not null then
    -- We inserted a fresh row or took over a dead/forced one → this caller owns the job.
    return query select v_job, v_status, true;
  else
    -- Conflict update was skipped: a fresh 'ready'/'processing' row already exists. Return it so
    -- the caller reuses the incumbent job instead of enqueueing a duplicate.
    return query
      select c.job_id, c.status, false
      from public.catalog_generated_subtitles c
      where c.provider_key = p_provider_key and c.item_type = p_item_type
        and c.external_id = p_external_id and c.kind = p_kind and c.lang = p_lang;
  end if;
end;
$$;

revoke all on function public.claim_generated_subtitle_job(text,text,text,text,text,uuid,bigint,boolean,uuid) from anon, authenticated;

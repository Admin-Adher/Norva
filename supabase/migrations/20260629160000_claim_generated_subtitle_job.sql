-- Phase 3 (3a): atomic claim for the AI-subtitle async job, so concurrent triggers for the same
-- title (two viewers of the same panel, or a re-click racing the poll) can't both enqueue a
-- transcription onto the single-slot gateway. The ON CONFLICT ... DO UPDATE ... WHERE makes the
-- "take over the row" decision atomic: exactly one caller wins and gets back its job_id; the
-- losers get the incumbent row's job_id/status and skip the gateway POST.
--
-- A row is claimable when it is NOT already 'ready' and NOT currently held by a still-fresh
-- 'processing' job (older-than-TTL processing rows are treated as dead and re-claimed). p_force
-- bypasses both guards for an explicit redo.
create or replace function public.claim_generated_subtitle_job(
  p_provider_key text,
  p_item_type text,
  p_external_id text,
  p_kind text,
  p_lang text,
  p_new_job_id uuid,
  p_processing_ttl_ms bigint,
  p_force boolean
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
    (provider_key, item_type, external_id, kind, lang, status, job_id, error, updated_at)
  values
    (p_provider_key, p_item_type, p_external_id, p_kind, p_lang, 'processing', p_new_job_id, null, now())
  on conflict (provider_key, item_type, external_id, kind, lang) do update
    set status = 'processing', job_id = p_new_job_id, error = null, updated_at = now()
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

revoke all on function public.claim_generated_subtitle_job(text,text,text,text,text,uuid,bigint,boolean) from anon, authenticated;

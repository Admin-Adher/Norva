-- Fix reap_deleted_sources(): remove the internal COMMITs that pg_cron rejects.
--
-- BUG (2026-07-07): the reaper batched its deletes with COMMIT between batches. In
-- this instance pg_cron raises "invalid transaction termination at COMMIT" when the
-- job actually reaches the delete loop, so every run fails (82 fails / 0 success in
-- 90 min once imports stopped masking it via the early `syncing` return). Net: soft-
-- deleted sources (e.g. the duplicate Ninja: ~285k media_items + ~234k variants) were
-- never drained -> data stayed ~doubled and the box stayed strained.
--
-- FIX: no internal COMMIT. Each call deletes a BOUNDED budget of rows in ONE
-- transaction (pg_cron commits the whole job at the end), then returns. The per-minute
-- cron drains incrementally (budget rows/minute) without a giant transaction and
-- without transaction-control inside the procedure. Same advisory-lock + skip-while-
-- syncing guards. Deletes the source row only once all its children are gone.

create or replace procedure public.reap_deleted_sources()
 language plpgsql
 set search_path to 'public'
as $procedure$
declare
  sid    uuid;
  n      int;
  -- Small budget on purpose: cloud_media_items carries ~11 indexes, so each deleted
  -- row is expensive (index maintenance). 10k/call keeps every delete under the
  -- statement_timeout on the small IO-bound box; the per-minute cron drains steadily.
  budget int := 10000;
begin
  if not pg_try_advisory_lock(hashtext('reap_deleted_sources')) then return; end if;

  if exists (select 1 from public.cloud_sources where sync_status = 'syncing' and deleted_at is null) then
    perform pg_advisory_unlock(hashtext('reap_deleted_sources')); return;  -- wait for imports to finish
  end if;

  for sid in
    select id from public.cloud_sources where deleted_at is not null order by deleted_at
  loop
    delete from public.cloud_media_items
      where ctid in (select ctid from public.cloud_media_items where source_id = sid limit budget);
    get diagnostics n = row_count; budget := budget - n;
    if budget <= 0 then exit; end if;

    delete from public.cloud_title_variants
      where ctid in (select ctid from public.cloud_title_variants where source_id = sid limit budget);
    get diagnostics n = row_count; budget := budget - n;
    if budget <= 0 then exit; end if;

    delete from public.cloud_live_variants
      where ctid in (select ctid from public.cloud_live_variants where source_id = sid limit budget);
    get diagnostics n = row_count; budget := budget - n;
    if budget <= 0 then exit; end if;

    delete from public.cloud_live_logical_channels
      where ctid in (select ctid from public.cloud_live_logical_channels where source_id = sid limit budget);
    get diagnostics n = row_count; budget := budget - n;
    if budget <= 0 then exit; end if;

    -- Children fully drained for this source -> remove the light tables + the source row.
    if not exists (select 1 from public.cloud_media_items          where source_id = sid)
       and not exists (select 1 from public.cloud_title_variants    where source_id = sid)
       and not exists (select 1 from public.cloud_live_variants     where source_id = sid)
       and not exists (select 1 from public.cloud_live_logical_channels where source_id = sid) then
      delete from public.cloud_title_overrides where source_id = sid;
      delete from public.cloud_favorites       where source_id = sid;
      delete from public.cloud_sources         where id = sid;
    end if;
    -- budget still positive -> loop continues to the next soft-deleted source
  end loop;

  perform pg_advisory_unlock(hashtext('reap_deleted_sources'));
end
$procedure$;

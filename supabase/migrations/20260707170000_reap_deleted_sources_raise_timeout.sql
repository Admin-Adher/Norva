-- reap_deleted_sources(): let each bounded batch finish instead of rolling back.
--
-- FOLLOW-UP to 20260707160000 (COMMIT-free + 10k budget). At 10k/call the reaper
-- succeeds in ~45s most of the time, but under box contention a single 10k delete
-- on cloud_media_items (~11 indexes) occasionally crosses the role's 120s
-- statement_timeout. Because the whole call is ONE transaction, a timeout rolls
-- the entire batch back: zero rows drained AND 120s of IO wasted exactly when the
-- box is busiest -> the next run is slower too (negative feedback). Progress stalls.
--
-- FIX: raise statement_timeout to 600s FOR THIS PROCEDURE ONLY (function-local SET,
-- restored on exit). Each 10k batch is still bounded by `limit budget`, so this is
-- not "unbounded" -- worst case is a slow-but-finite delete that now COMMITS its
-- progress instead of being killed. Every run drains rows; the box never wastes a
-- full timeout on a rollback. Budget stays 10k. Everything else identical.

create or replace procedure public.reap_deleted_sources()
 language plpgsql
 set search_path to 'public'
 set statement_timeout to '600s'
as $procedure$
declare
  sid    uuid;
  n      int;
  -- cloud_media_items carries ~11 indexes, so each deleted row is expensive
  -- (index maintenance). 10k/call keeps the transaction a sane size; the raised
  -- statement_timeout (see SET above) guarantees the batch commits even under load.
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

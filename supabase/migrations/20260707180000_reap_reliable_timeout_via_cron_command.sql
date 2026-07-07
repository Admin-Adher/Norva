-- Make reap_deleted_sources() actually finish: set the statement_timeout at the
-- CRON-COMMAND level (not inside the procedure), and shrink the batch.
--
-- WHY the previous fix (20260707170000) did NOT work: a `SET statement_timeout`
-- INSIDE a procedure does not re-arm the timer of the enclosing top-level `CALL`
-- statement — Postgres arms statement_timeout once, when the CALL begins, from the
-- session value (the postgres role's 120s here). So every run still died at 120.0s.
--
-- Verified fix: statement_timeout IS re-armed per top-level statement in a
-- multi-statement command. Confirmed empirically:
--   `set statement_timeout to '2s'; select pg_sleep(5);`  -> cancels at 2s.
-- So the cron command must be `set statement_timeout to '900s'; call ...;` — the
-- CALL then runs with 900s and a bounded batch always COMMITS its progress.
--
-- Also: drop the per-call budget 10000 -> 5000. The box is small and IO-bound and
-- was contended enough that a 10k delete crossed 120s; a smaller batch finishes
-- faster, holds the advisory lock + row locks for less time, and is gentler on the
-- other crons (admin-dashboard-refresh / facet-summary-refresh were timing out from
-- the same contention). Every-minute schedule still drains ~300k/hr.
--
-- The procedure goes back to a clean COMMIT-free body with NO function-local
-- statement_timeout (that clause was inert and misleading).

create or replace procedure public.reap_deleted_sources()
 language plpgsql
 set search_path to 'public'
as $procedure$
declare
  sid    uuid;
  n      int;
  budget int := 5000;
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
  end loop;

  perform pg_advisory_unlock(hashtext('reap_deleted_sources'));
end
$procedure$;

-- Reschedule the cron by name (upsert) so its command lifts the statement_timeout
-- for the CALL. This is what actually keeps runs from dying at 120s.
select cron.schedule(
  'norva-reap-deleted-sources',
  '* * * * *',
  $cmd$set statement_timeout to '900s'; call public.reap_deleted_sources();$cmd$
);

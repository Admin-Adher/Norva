-- Fix "Remove account" for large providers. deleteSource used to delete the whole child cascade
-- (~600k rows for a big Xtream panel: cloud_media_items + cloud_title_variants [per-row rollup
-- trigger] + live tables) SYNCHRONOUSLY in the request, which blows past the edge timeout, so the
-- final cloud_sources delete is never reached and the account stays in the list.
--
-- New model: the button SOFT-deletes (sets deleted_at) — instant, one row — so the source vanishes
-- from the user's list immediately, and a background reaper cron drains the child data in committed
-- batches (small locks/WAL, friendly to concurrent syncs), then removes the source row (FK cascade
-- mops up stragglers). The reusable GLOBAL scan cache (catalog_titles / catalog_file_tracks, keyed
-- by tmdb id / host — no user_id) is never touched: only this user's per-user copy is removed.

alter table public.cloud_sources add column if not exists deleted_at timestamptz;

-- Small partial index so the reaper's scan for pending deletions is an index scan.
create index if not exists cloud_sources_deleted_idx
  on public.cloud_sources (deleted_at)
  where deleted_at is not null;

-- Reaper: drain each soft-deleted source's per-user rows in committed batches, then delete the
-- source row. Procedure (not function) so it can COMMIT per batch. Idempotent — safe to run
-- concurrently and safe to re-run after a partial pass. Biggest tables first; the 5k variant batch
-- keeps the per-row rollup trigger cost bounded per commit.
create or replace procedure public.reap_deleted_sources()
language plpgsql
set search_path to 'public'
as $proc$
declare
  ids uuid[];
  sid uuid;
  n   int;
begin
  -- One drainer at a time: a big source can take several minutes, longer than the 1-minute cron
  -- interval, and we don't want overlapping runs thrashing the same rows. Session-level lock is
  -- auto-released when the pg_cron worker backend ends, so it can't leak even on error.
  if not pg_try_advisory_lock(hashtext('reap_deleted_sources')) then return; end if;

  -- Defer while any live import is running: the drain's per-row rollup-trigger deletes contend with
  -- an import's title-building (and its admission slot). A removed source is already hidden from the
  -- user, so its drain can wait for an idle window instead of fighting a fresh import.
  if exists (select 1 from public.cloud_sources where sync_status = 'syncing' and deleted_at is null) then
    perform pg_advisory_unlock(hashtext('reap_deleted_sources')); return;
  end if;

  select array_agg(id) into ids
  from (select id from public.cloud_sources where deleted_at is not null order by deleted_at limit 10) x;
  if ids is null then perform pg_advisory_unlock(hashtext('reap_deleted_sources')); return; end if;

  foreach sid in array ids loop
    loop
      delete from public.cloud_media_items
      where ctid in (select ctid from public.cloud_media_items where source_id = sid limit 20000);
      get diagnostics n = row_count; commit; exit when n = 0;
    end loop;

    loop
      delete from public.cloud_title_variants
      where ctid in (select ctid from public.cloud_title_variants where source_id = sid limit 5000);
      get diagnostics n = row_count; commit; exit when n = 0;
    end loop;

    loop
      delete from public.cloud_live_variants
      where ctid in (select ctid from public.cloud_live_variants where source_id = sid limit 20000);
      get diagnostics n = row_count; commit; exit when n = 0;
    end loop;

    loop
      delete from public.cloud_live_logical_channels
      where ctid in (select ctid from public.cloud_live_logical_channels where source_id = sid limit 20000);
      get diagnostics n = row_count; commit; exit when n = 0;
    end loop;

    delete from public.cloud_title_overrides where source_id = sid; commit;
    delete from public.cloud_favorites where source_id = sid; commit;
    delete from public.cloud_sources where id = sid; commit;  -- cascade clears any stragglers
  end loop;

  perform pg_advisory_unlock(hashtext('reap_deleted_sources'));
end
$proc$;

-- Drain every minute; a no-op (single cheap index probe) when nothing is pending.
select cron.schedule('norva-reap-deleted-sources', '* * * * *', 'call public.reap_deleted_sources();');
